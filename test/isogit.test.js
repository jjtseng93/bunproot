// `bunproot --git` against the system git, command for command, in a scratch
// directory.  Every step runs the same command line through both, compares
// what they print, and then asks the system git to describe both repositories
// so the on-disk result is compared independently of what either printed.
//
// Needs `git` on PATH and the locked isomorphic-git already installed under
// tools/isomorphic-git (the port prompts before installing it, and a test
// must not answer prompts).  Nothing here touches a real remote: push, fetch
// and pull go to bare repositories created below in the scratch directory
// and served by a local git-http-backend, and the one contact with github.com
// is a read-only clone, skipped when the host is unreachable.  HOME is
// redirected to the scratch directory, so no real credentials are in reach.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PROOT=resolve(import.meta.dir,"../proot.js");
const BUN=Bun.which("bun")||process.argv0;
const SYSTEM_GIT=Bun.which("git");
const INSTALLED=existsSync(resolve(import.meta.dir,"../tools/isomorphic-git/node_modules/isomorphic-git/package.json"));
const BUNMSH="https://github.com/jjtseng93/bunmsh";

const scratch=mkdtempSync(join(tmpdir(),"isogit-"));
const home=join(scratch,"home");
const roots={ sys:join(scratch,"sys"), iso:join(scratch,"iso") };
let clock=1700000000;

function environment(step) {
  const date=`${clock+step} +0000`;
  return {
    ...process.env, HOME:home, XDG_CONFIG_HOME:join(home,".config"), LC_ALL:"C", LANG:"C", TZ:"UTC",
    GIT_CONFIG_NOSYSTEM:"1", GIT_TERMINAL_PROMPT:"0",
    GIT_AUTHOR_NAME:"Test Author", GIT_AUTHOR_EMAIL:"author@example.com",
    GIT_COMMITTER_NAME:"Test Committer", GIT_COMMITTER_EMAIL:"committer@example.com",
    GIT_AUTHOR_DATE:date, GIT_COMMITTER_DATE:date,
    LD_PRELOAD:"",
  };
}

// The port colours and decorates its output whether or not it is piped, where
// Git only does so on a terminal; ask it for Git's terminal-sensing defaults
// so both sides print plain text into these pipes.  A later `-c` wins, so a
// step can still turn colour on for both.
function launch(side,cwd,args,step) {
  const cmd=side==="sys"?[SYSTEM_GIT,...args]:[BUN,PROOT,"--git","-c","color.ui=auto","-c","log.decorate=auto",...args];
  const result=Bun.spawnSync({ cmd, cwd, env:environment(step), stdin:"ignore", stdout:"pipe", stderr:"pipe" });
  const scrub=(text)=>text.toString().split(roots.sys).join("<root>").split(roots.iso).join("<root>");
  return { stdout:scrub(result.stdout), stderr:scrub(result.stderr), status:result.exitCode };
}

let step=0;
// Runs one command line through both implementations, in the same relative
// directory of each worktree, with the same fixed timestamps.
function both(args,{ cwd="" }={}) {
  step++;
  return {
    sys:launch("sys",join(roots.sys,cwd),args,step),
    iso:launch("iso",join(roots.iso,cwd),args,step),
  };
}
function same(args,options) {
  const { sys,iso }=both(args,options);
  const label=`git ${args.join(" ")}`;
  expect({ label, status:iso.status, stdout:iso.stdout }).toEqual({ label, status:sys.status, stdout:sys.stdout });
  return { sys,iso };
}
// Both agree and both succeeded; for steps where agreeing on a failure would
// hide a broken fixture.
function ok(args,options) {
  const result=same(args,options);
  expect({ label:`git ${args.join(" ")}`, status:result.sys.status, stderr:result.sys.stderr }).toMatchObject({ status:0 });
  return result;
}
// The system git's view of both repositories, which is the comparison that
// matters: identical commits, trees, refs and index regardless of output.
function crossCheck(cwd="") {
  const describe=(root)=>{
    const run=(...args)=>launch("sys",join(root,cwd),args,0).stdout;
    // The port follows Git 2.48 in creating refs/remotes/<remote>/HEAD on
    // fetch; an older system Git does not, so that ref is left out.
    return {
      status:run("status","--porcelain"),
      refs:run("show-ref").split("\n").filter((line)=>!/ refs\/remotes\/[^ ]+\/HEAD$/.test(line)).join("\n"),
      index:run("ls-files","-s"),
      history:run("log","--all","--format=%H %P %T %an %ae %at %cn %ce %ct%n%B"),
      head:run("rev-parse","HEAD"),
    };
  };
  expect(describe(roots.iso)).toEqual(describe(roots.sys));
}
function write(relative,content) {
  for (const root of Object.values(roots)) {
    mkdirSync(dirname(join(root,relative)),{ recursive:true });
    writeFileSync(join(root,relative),content);
  }
}
function remove(relative) {
  for (const root of Object.values(roots)) rmSync(join(root,relative),{ recursive:true, force:true });
}
function read(relative) {
  return Object.fromEntries(Object.entries(roots).map(([side,root])=>[side,readFileSync(join(root,relative),"utf8")]));
}

// A smart-HTTP server for the push/pull steps: git-http-backend over CGI.
// It runs as a separate process because the clients are spawned
// synchronously, and a server inside this process could never answer them.
const SERVER=String.raw`
const { ISOGIT_ROOT:root, ISOGIT_GIT:git }=process.env;
const server=Bun.serve({ port:0, hostname:"127.0.0.1", async fetch(request) {
  const url=new URL(request.url);
  let body=request.method==="POST"?new Uint8Array(await request.arrayBuffer()):undefined;
  let encoding=request.headers.get("content-encoding")??"";
  if (body && encoding==="gzip") { try { body=Bun.gunzipSync(body); encoding=""; } catch {} }
  const env={
    ...process.env, GIT_PROJECT_ROOT:root, GIT_HTTP_EXPORT_ALL:"1", GATEWAY_INTERFACE:"CGI/1.1", SERVER_PROTOCOL:"HTTP/1.1",
    REQUEST_METHOD:request.method, PATH_INFO:url.pathname, QUERY_STRING:url.search.slice(1), REMOTE_ADDR:"127.0.0.1",
    CONTENT_TYPE:request.headers.get("content-type")??"", CONTENT_LENGTH:body?String(body.length):"",
    HTTP_CONTENT_ENCODING:encoding, HTTP_GIT_PROTOCOL:request.headers.get("git-protocol")??"",
  };
  const backend=Bun.spawn({ cmd:[git,"http-backend"], env, stdin:body??"ignore", stdout:"pipe", stderr:"ignore" });
  const output=Buffer.from(await new Response(backend.stdout).arrayBuffer());
  const split=output.indexOf("\r\n\r\n");
  const headers=new Headers();
  let status=200;
  for (const line of output.subarray(0,split).toString().split("\r\n")) {
    const colon=line.indexOf(":");
    const name=line.slice(0,colon), value=line.slice(colon+1).trim();
    if (name.toLowerCase()==="status") status=parseInt(value); else headers.append(name,value);
  }
  return new Response(output.subarray(split+4),{ status,headers });
} });
console.log(server.port);
`;
async function serve(root) {
  const child=Bun.spawn({ cmd:[BUN,"-e",SERVER], stdout:"pipe", stderr:"inherit", env:{ ...process.env, LD_PRELOAD:"", ISOGIT_ROOT:root, ISOGIT_GIT:SYSTEM_GIT } });
  const reader=child.stdout.getReader();
  let text="";
  while (!text.includes("\n")) {
    const { value,done }=await reader.read();
    if (done) throw new Error("the http-backend server exited before reporting its port");
    text+=Buffer.from(value).toString();
  }
  return { port:Number(text.trim()), stop:()=>child.kill() };
}

const READY=SYSTEM_GIT && INSTALLED;
// Each step spawns two processes, so a case is dozens of launches.
const SLOW=120000;
const it=READY?(name,fn,timeout=SLOW)=>test(name,fn,timeout):test.skip;
if (!READY) console.warn("isogit: needs git on PATH and tools/isomorphic-git installed; skipping");

beforeAll(()=>{
  mkdirSync(join(home,".config","git"),{ recursive:true });
  writeFileSync(join(home,".gitconfig"),"[init]\n\tdefaultBranch = main\n[user]\n\tname = Global Name\n\temail = global@example.com\n");
  for (const root of Object.values(roots)) mkdirSync(root,{ recursive:true });
});
afterAll(()=>{ rmSync(scratch,{ recursive:true, force:true }); });

describe("bunproot --git matches the system git",()=>{
  it("init, status and rev-parse in an empty repository",()=>{
    same(["init","."]);
    same(["status"]);
    same(["status","--porcelain"]);
    same(["status","-sb"]);
    same(["rev-parse","--is-inside-work-tree"]);
    same(["rev-parse","--show-toplevel"]);
    same(["rev-parse","--git-dir"]);
    same(["branch","--show-current"]);
    same(["config","--local","core.bare"]);
    same(["config","user.name"]);
    expect(both(["log"]).iso.status).toBe(both(["log"]).sys.status);
    crossCheck();
  });

  it("add and the first commit",()=>{
    write("a.txt","hello\n");
    write("dir/nested/b.txt","one\ntwo\n");
    write(".gitignore","*.log\nbuild/\n");
    write("debug.log","ignored\n");
    write("build/out","ignored\n");
    same(["status"]);
    same(["status","--porcelain"]);
    same(["add","a.txt"]);
    same(["status"]);
    same(["status","-s"]);
    same(["ls-files"]);
    same(["commit","-m","first commit"]);
    same(["log"]);
    same(["log","--oneline"]);
    same(["rev-parse","HEAD"]);
    same(["cat-file","-t","HEAD"]);
    same(["cat-file","-p","HEAD"]);
    same(["cat-file","-p","HEAD^{tree}"]);
    same(["ls-files","-s"]);
    same(["hash-object","a.txt"]);
    crossCheck();
  });

  it("add ., modified and untracked status, commit -a",()=>{
    same(["add","."]);
    same(["status"]);
    same(["status","--porcelain"]);
    same(["commit","-m","add the rest\n\nWith a body paragraph.\n"]);
    same(["log","--format=%H%n%P%n%T%n%an <%ae> %at%n%cn <%ce> %ct%n%s%n--%n%b--"]);
    write("a.txt","hello\nworld\n");
    write("dir/nested/b.txt","one\n");
    write("untracked/c.txt","c\n");
    same(["status"]);
    same(["status","--porcelain"]);
    same(["add","dir"]);
    write("dir/nested/b.txt","one\nthree\n");
    same(["status"]);
    same(["status","--porcelain"]);
    same(["commit","-am","edit both"]);
    same(["status","--porcelain"]);
    same(["log","--oneline"]);
    same(["log","-1","--format=%s"]);
    same(["log","-n","2","--format=%h %p"]);
    same(["log","--reverse","--format=%s"]);
    same(["log","--format=%s","--","a.txt"]);
    same(["cat-file","-p","HEAD:a.txt"].slice(0,2).concat([launch("sys",roots.sys,["rev-parse","HEAD:a.txt"],0).stdout.trim()]));
    crossCheck();
  });

  it("mv, rm, restore and reset",()=>{
    same(["mv","a.txt","renamed.txt"]);
    same(["status"]);
    same(["status","--porcelain"]);
    same(["commit","-m","rename a"]);
    same(["rm","renamed.txt"]);
    same(["status","--porcelain"]);
    same(["commit","-m","remove renamed"]);
    same(["rm","-r","--cached","dir"]);
    same(["status","--porcelain"]);
    same(["restore","--staged","dir"]);
    same(["status","--porcelain"]);
    write("dir/nested/b.txt","scribble\n");
    same(["restore","dir/nested/b.txt"]);
    same(["status","--porcelain"]);
    expect(read("dir/nested/b.txt").iso).toBe("one\nthree\n");
    same(["reset","--soft","HEAD~1"]);
    same(["status","--porcelain"]);
    same(["reset","HEAD~1"]);
    same(["status","--porcelain"]);
    same(["reset","--hard","HEAD"]);
    same(["status","--porcelain"]);
    same(["log","--oneline"]);
    remove("untracked");
    crossCheck();
  });

  it("branches, tags, fast-forward and true merges",()=>{
    same(["branch","dev"]);
    same(["branch"]);
    same(["checkout","dev"]);
    same(["branch","--show-current"]);
    write("dev.txt","dev\n");
    same(["add","dev.txt"]);
    same(["commit","-m","on dev"]);
    same(["checkout","main"]);
    same(["merge","dev"]);
    same(["log","--oneline"]);
    same(["rev-parse","--abbrev-ref","HEAD"]);
    write("main.txt","main\n");
    same(["add","main.txt"]);
    same(["commit","-m","on main"]);
    same(["switch","dev"]);
    write("dev.txt","dev\nmore\n");
    same(["commit","-am","more dev"]);
    same(["switch","main"]);
    same(["merge","--no-ff","-m","merge dev","dev"]);
    same(["log","--format=%H %P %s"]);
    same(["log","--oneline","-3"]);
    same(["rev-parse","HEAD^2"]);
    same(["rev-parse","--short","HEAD~2"]);
    same(["tag","v1"]);
    same(["tag","-a","v2","-m","annotated"]);
    same(["tag"]);
    same(["tag","-l","v*"]);
    same(["cat-file","-t","v2"]);
    same(["cat-file","-p","v2"]);
    same(["rev-parse","v2^{}"]);
    same(["show-ref"]);
    same(["show-ref","--tags"]);
    same(["branch","-d","dev"]);
    same(["branch"]);
    same(["tag","-d","v1"]);
    same(["tag"]);
    same(["checkout","-b","feature"]);
    same(["branch","-m","feature","renamed-feature"]);
    same(["branch"]);
    same(["switch","main"]);
    same(["branch","-D","renamed-feature"]);
    crossCheck();
  });

  it("a conflicting merge fails the same way and aborts cleanly",()=>{
    same(["checkout","-b","left"]);
    write("main.txt","left\n");
    same(["commit","-am","left side"]);
    same(["checkout","main"]);
    write("main.txt","right\n");
    same(["commit","-am","right side"]);
    const { sys,iso }=both(["merge","left"]);
    expect(iso.status).toBe(sys.status);
    expect(iso.stdout).toContain("CONFLICT (content): Merge conflict in main.txt");
    const merged=read("main.txt");
    expect(merged.iso).toContain("<<<<<<<");
    same(["merge","--abort"]);
    same(["status","--porcelain"]);
    expect(read("main.txt").iso).toBe("right\n");
    same(["branch","-D","left"]);
    crossCheck();
  });

  it("diff through bun pm diff, re-headed the way Git prints it",()=>{
    write("code.js","function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}\n\nfunction baz() {\n  return 3;\n}\n");
    write("numbers.txt",Array.from({ length:30 },(_,i)=>`line ${i+1}`).join("\n")+"\n");
    write("noeol.txt","no newline");
    write("blob.bin","\0\x01\x02\n");
    same(["add","."]);
    same(["commit","-m","diff fixtures"]);
    same(["diff"]);
    same(["diff","--exit-code"]);
    write("code.js","function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 22;\n}\n\nfunction baz() {\n  return 33;\n  // more\n}\n");
    write("numbers.txt",Array.from({ length:30 },(_,i)=>i===4?"changed 5":i===24?"changed 25":`line ${i+1}`).filter((l)=>l!=="line 15").join("\n")+"\nline 31\n");
    write("noeol.txt","still no newline");
    write("blob.bin","\0\x01\x03\n");
    write("untracked.txt","not shown\n");
    same(["diff"]);
    same(["diff","--stat"]);
    same(["diff","--name-only"]);
    same(["diff","--name-status"]);
    same(["diff","-U1","--","numbers.txt"]);
    same(["diff","--unified=0","numbers.txt"]);
    expect(both(["diff","--exit-code"]).iso.status).toBe(1);
    same(["diff","--quiet"]);
    same(["add","code.js","noeol.txt"]);
    same(["diff"]);
    same(["diff","--cached"]);
    same(["diff","--staged","--stat"]);
    same(["diff","HEAD"]);
    same(["diff","HEAD","--","code.js"]);
    remove("numbers.txt");
    same(["diff","--name-status"]);
    same(["diff"]);
    same(["commit","-am","diff changes"]);
    same(["diff","HEAD~1","HEAD"]);
    same(["diff","HEAD~1..HEAD","--stat"]);
    same(["diff","HEAD~1"]);
    same(["-c","color.ui=always","diff","HEAD~1","--","code.js"]);
    remove("untracked.txt");
    same(["status","--porcelain"]);
    crossCheck();
  });

  it("colours like Git, and by default even in a pipe",()=>{
    write("colour.txt","colour\n");
    write("dir/nested/b.txt","one\nthree\nfour\n");
    same(["add","colour.txt"]);
    same(["tag","v3"]);
    // Without the terminal-sensing defaults launch() adds, the pipe still gets colour.
    const raw=(...args)=>Bun.spawnSync({ cmd:[BUN,PROOT,"--git",...args], cwd:roots.iso, env:environment(0), stdout:"pipe", stderr:"pipe" }).stdout.toString();
    const bare=raw("status","-s");
    expect(bare).not.toBe(Bun.stripANSI(bare));
    expect(Bun.stripANSI(bare)).toBe(launch("sys",roots.sys,["status","-s"],0).stdout);
    expect(raw("status","-s","--no-color")).toBe(Bun.stripANSI(bare));
    expect(raw("-c","color.ui=never","status","-s")).toBe(Bun.stripANSI(bare));
    expect(Bun.stripANSI(raw("log","--oneline","-1"))).toContain("(HEAD -> main, tag: v3)");
    expect(raw("log","--oneline","-1","--no-decorate")).not.toContain("HEAD");
    for (const args of [["status"],["status","-s"],["status","-sb"],["branch","-a"],["log","--oneline","-3"],["log","--decorate","-1"],["log","--oneline","--decorate","-2"],["log","--format=%h%d %s","-2"]]) {
      // Without colour.ui the pipe gets plain text, so the plain runs above
      // and below already cover that; force it on and compare both the
      // sequences and what they wrap.
      const { sys,iso }=both(["-c","color.ui=always",...args]);
      const label=`git -c color.ui=always ${args.join(" ")}`;
      expect({ label, status:iso.status, plain:Bun.stripANSI(iso.stdout) }).toEqual({ label, status:sys.status, plain:Bun.stripANSI(sys.stdout) });
      expect({ label, stdout:iso.stdout }).toEqual({ label, stdout:sys.stdout });
      if (args[0]==="status" || args[0]==="branch") expect({ label, coloured:iso.stdout!==Bun.stripANSI(iso.stdout) }).toEqual({ label, coloured:true });
    }
    same(["-c","color.ui=never","status","-s"]);
    same(["-c","color.ui=always","status","--porcelain"]);
    same(["reset","-q","colour.txt"]);
    same(["tag","-d","v3"]);
    remove("colour.txt");
    same(["restore","dir"]);
    same(["status","--porcelain"]);
    crossCheck();
  });

  it("config in the repository and the home directory",()=>{
    same(["config","--local","test.value","one"]);
    same(["config","test.value"]);
    same(["config","--get","test.value"]);
    same(["config","--local","--list"]);
    same(["config","--unset","test.value"]);
    expect(both(["config","test.value"]).iso.status).toBe(1);
    same(["config","--global","alias.co","checkout"]);
    same(["config","--global","--list"]);
    same(["config","--global","--unset","alias.co"]);
    same(["config","--global","--list"]);
    same(["-c","user.name=Override","config","user.name"]);
  });

  it("push, ls-remote, clone, fetch and pull over smart HTTP",async ()=>{
    const remotes=join(scratch,"remotes");
    for (const side of ["sys","iso"]) {
      launch("sys",scratch,["init","-q","--bare",join(remotes,`${side}.git`)],0);
      launch("sys",scratch,["-C",join(remotes,`${side}.git`),"config","http.receivepack","true"],0);
    }
    const server=await serve(remotes);
    try {
      const url=(side)=>`http://127.0.0.1:${server.port}/${side}.git`;
      for (const side of ["sys","iso"]) launch(side,roots[side],["remote","add","origin",url(side)],0);
      same(["remote"]);
      ok(["push","-u","origin","main"]);
      same(["branch","-a"]);
      same(["branch","-r"]);
      ok(["push","--tags"]);
      same(["config","branch.main.remote"]);
      same(["config","branch.main.merge"]);
      const bare=(side)=>launch("sys",join(remotes,`${side}.git`),["show-ref"],0).stdout;
      expect(bare("iso")).toBe(bare("sys"));
      const listed=ok(["ls-remote","origin"]);
      expect(listed.iso.stdout).toContain("\tHEAD\n");
      expect(listed.iso.stdout).toContain("\trefs/tags/v2^{}\n");
      ok(["ls-remote","--heads",url("iso")]);
      ok(["ls-remote","--tags","--refs","origin"]);
      // Clone each bare repository with each implementation into a fresh pair.
      const clones={ sys:join(scratch,"clone-sys"), iso:join(scratch,"clone-iso") };
      for (const side of ["sys","iso"]) {
        const result=launch(side,scratch,["clone","-q",url("sys"),clones[side]],0);
        expect({ side, status:result.status, stderr:result.stderr }).toEqual({ side, status:0, stderr:result.stderr });
      }
      const describeClone=(dir)=>Object.fromEntries(["status --porcelain","log --all --format=%H %P %s","ls-files -s","branch -a","tag","rev-parse HEAD","config branch.main.merge"]
        .map((c)=>[c,launch("sys",dir,c.split(" "),0).stdout]));
      expect(describeClone(clones.iso)).toEqual(describeClone(clones.sys));
      // A commit lands in the shared bare repository from a third party.
      launch("sys",clones.sys,["commit","--allow-empty","-m","upstream change"],step+1);
      launch("sys",clones.sys,["push","-q","origin","main"],0);
      launch("sys",clones.sys,["push","-q",url("iso"),"main"],0);
      ok(["fetch","origin"]);
      same(["rev-parse","origin/main"]);
      same(["log","--oneline","origin/main","-1"]);
      ok(["pull","origin","main"]);
      same(["log","--oneline","-2"]);
      same(["status","-sb"]);
      same(["status"]);
      write("local.txt","local\n");
      same(["add","local.txt"]);
      same(["commit","-m","ahead by one"]);
      same(["status","-sb"]);
      same(["status"]);
      ok(["push"]);
      same(["status","-sb"]);
      launch("sys",clones.sys,["pull","-q","origin","main"],0);
      launch("sys",clones.sys,["commit","--allow-empty","-m","behind by one"],step+1);
      launch("sys",clones.sys,["push","-q","origin","main"],0);
      launch("sys",clones.sys,["push","-q",url("iso"),"main"],0);
      ok(["fetch"]);
      same(["status","-sb"]);
      same(["status"]);
      ok(["pull"]);
      same(["status","-sb"]);
      // Git 2.48 behaviour: the fetch above created origin/HEAD as a symref.
      expect(launch("sys",roots.iso,["symbolic-ref","refs/remotes/origin/HEAD"],0).stdout).toBe("refs/remotes/origin/main\n");
      expect(launch("iso",roots.iso,["branch","-a"],0).stdout).toContain("  remotes/origin/HEAD -> origin/main\n");
      expect(launch("iso",roots.iso,["-c","remote.origin.followRemoteHEAD=never","fetch","-q"],0).status).toBe(0);
      expect(launch("sys",roots.iso,["symbolic-ref","refs/remotes/origin/HEAD"],0).stdout).toBe("refs/remotes/origin/main\n");
      crossCheck();
    } finally { server.stop(); }
  },SLOW);

  it(`clones ${BUNMSH} the way the system git does`,async ()=>{
    try { await fetch(`${BUNMSH}/info/refs?service=git-upload-pack`,{ signal:AbortSignal.timeout(15000) }); }
    catch { console.warn("isogit: github.com unreachable; skipping the bunmsh clone"); return; }
    const clones={ sys:join(scratch,"bunmsh-sys"), iso:join(scratch,"bunmsh-iso") };
    for (const side of ["sys","iso"]) {
      const result=launch(side,scratch,["clone","-q",BUNMSH,clones[side]],0);
      expect({ side, status:result.status, stderr:result.stderr }).toEqual({ side, status:0, stderr:result.stderr });
    }
    for (const args of [["rev-parse","HEAD"],["branch","--show-current"],["log","--oneline"],["ls-files"],["status","--porcelain"],["tag"],["remote","-v"]]) {
      const label=`git ${args.join(" ")}`;
      const sys=launch("sys",clones.sys,args,0), iso=launch("iso",clones.iso,args,0);
      expect({ label, status:iso.status, stdout:iso.stdout.split(clones.iso).join("<clone>") })
        .toEqual({ label, status:sys.status, stdout:sys.stdout.split(clones.sys).join("<clone>") });
    }
    const describeClone=(dir)=>Object.fromEntries(["log --all --format=%H %P %T","show-ref","ls-files -s","status --porcelain"]
      .map((c)=>[c,launch("sys",dir,c.split(" "),0).stdout]));
    expect(describeClone(clones.iso)).toEqual(describeClone(clones.sys));
  },300000);
});
