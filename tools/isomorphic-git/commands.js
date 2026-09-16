// The Git commands `bunproot --git` understands, each a thin wrapper around
// one or a few isomorphic-git calls, taking Git's own option names and
// printing what Git prints so that `alias git='bunx bunproot --git'` works
// for the everyday flow.  index.js finds the command in the table exported at
// the bottom and calls its `run(ctx,argv)`; nothing here parses global options.
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import fs from "node:fs";
import { chmod, copyFile, lstat, mkdtemp, mkdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { count, list, parse, parseClone, positiveDepth } from "./options.js";

const VERSION="1.41.9";
const HINT=`Run\n\n  git config --global user.email "you@example.com"\n  git config --global user.name "Your Name"`;

// ---------------------------------------------------------------- helpers

// isomorphic-git trusts an index entry whose recorded stat data still matches
// the file, so a file edited in the same second the index was written -- the
// "racy git" case -- keeps reading as unmodified.  Git guards against that
// when it writes the index by zeroing the recorded size of every entry at
// least as new as the index itself, which forces the next reader to hash the
// file.  Do the same to the index before and after each command.
export async function smudgeIndex(gitdir) {
  const file=join(gitdir,"index");
  let buffer, written;
  try { buffer=await readFile(file); written=Math.floor((await stat(file)).mtimeMs/1000); } catch { return; }
  if (buffer.length<32 || buffer.toString("latin1",0,4)!=="DIRC") return;
  const version=buffer.readUInt32BE(4);
  if (version!==2 && version!==3) return;
  const count=buffer.readUInt32BE(8);
  let offset=12, changed=false;
  for (let entry=0; entry<count && offset+62<=buffer.length; entry++) {
    const mtime=buffer.readUInt32BE(offset+8), size=buffer.readUInt32BE(offset+36);
    if (mtime>=written && size!==0) { buffer.writeUInt32BE(0,offset+36); changed=true; }
    const flags=buffer.readUInt16BE(offset+60);
    const nameStart=offset+62+(version===3 && (flags&0x4000)?2:0);
    let nameLength=flags&0xfff;
    if (nameLength===0xfff) nameLength=buffer.indexOf(0,nameStart)-nameStart;
    offset+=Math.ceil((nameStart-offset+nameLength+1)/8)*8;
  }
  if (!changed) return;
  const hasher=new Bun.CryptoHasher("sha1");
  hasher.update(buffer.subarray(0,buffer.length-20));
  buffer.set(hasher.digest(),buffer.length-20);
  await writeFile(file,buffer);
}

// Everything a command needs about where it is running.  `dir` is found on
// demand because clone, init and ls-remote work outside a repository.
// Git's own palette, as plain SGR codes.  Unlike Git's color.ui=auto this is
// on whether or not stdout is a terminal: turning it off takes an explicit
// --no-color, -c color.ui=never, or the NO_COLOR environment variable.  The
// same goes for log decorations, which Git shows only on a terminal.
const PALETTE={ red:"\x1b[31m", green:"\x1b[32m", yellow:"\x1b[33m", cyan:"\x1b[36m", bold:"\x1b[1m", boldRed:"\x1b[1;31m", boldGreen:"\x1b[1;32m", boldYellow:"\x1b[1;33m", boldCyan:"\x1b[1;36m" };
export function context({ overrides={}, cwd=process.cwd(), out, err, tty=process.stdout.isTTY }={}) {
  let root;
  const setting=overrides["color.ui"]??overrides["color.status"]??overrides["color.branch"]??overrides["color.diff"]??"always";
  let colour=["never","false","off"].includes(setting)?false:setting==="auto"?!!tty && !process.env.NO_COLOR:!process.env.NO_COLOR;
  const decorateSetting=overrides["log.decorate"]??"always";
  const ctx={
    fs, http, git, cwd, overrides,
    decorate:["no","false","off"].includes(decorateSetting)?false:decorateSetting==="auto"?!!tty:true,
    opened:()=>root,
    get colour() { return colour; },
    set colour(value) { colour=value; },
    paint:(name,text)=>colour&&text?`${PALETTE[name]}${text}\x1b[m`:text,
    out:out??((text)=>process.stdout.write(text)),
    err:err??((text)=>process.stderr.write(text)),
    async repo() {
      if (!root) {
        let dir;
        try { dir=await git.findRoot({ fs, filepath:cwd }); }
        catch { throw new Error("not a git repository (or any of the parent directories): .git"); }
        root={ dir, gitdir:join(dir,".git") };
        await smudgeIndex(root.gitdir);
      }
      return root;
    },
    // A command-line path, repository-relative and POSIX the way the index
    // stores it.  "" is the repository itself.
    async pathspec(argument) {
      const { dir }=await this.repo();
      const path=relative(dir,resolve(cwd,argument)).split("\\").join("/");
      if (path.startsWith("../") || path==="..") throw new Error(`'${argument}' is outside repository at '${dir}'`);
      return path==="."?"":path;
    },
  };
  return ctx;
}

const base=async (ctx)=>({ fs, ...await ctx.repo() });
// Git reports some failures as `error:` with status 1 rather than `fatal:` 128.
function failure(message,exitCode=1) {
  return Object.assign(new Error(message),{ prefix:"error", exitCode });
}
const short=(oid)=>oid.slice(0,7);
const isOid=(text)=>/^[0-9a-f]{4,40}$/i.test(text);

// -- configuration: -c overrides, then the repository, then the user's files.
// isomorphic-git reads only the repository's config, so the global file is
// consulted through a scratch copy that its own parser understands.
async function globalConfig(action) {
  const home=homedir();
  const xdg=join(process.env.XDG_CONFIG_HOME||join(home,".config"),"git","config");
  const files=[xdg,join(home,".gitconfig")].filter((file)=>fs.existsSync(file));
  const scratch=await mkdtemp(join(tmpdir(),"bunproot-git-"));
  try {
    const results=[];
    for (const file of files.length?files:[join(home,".gitconfig")]) {
      if (fs.existsSync(file)) await copyFile(file,join(scratch,"config"));
      else await writeFile(join(scratch,"config"),"");
      results.push(await action(scratch,file));
    }
    return results;
  } finally { await rm(scratch,{ recursive:true, force:true }); }
}
async function globalGet(path,all=false) {
  const values=(await globalConfig(async (gitdir)=>all
    ?git.getConfigAll({ fs, gitdir, path })
    :git.getConfig({ fs, gitdir, path }))).flat().filter((value)=>value!==undefined);
  return all?values:values.at(-1);
}
async function globalSet(path,value,append) {
  await globalConfig(async (gitdir,file)=>{
    await git.setConfig({ fs, gitdir, path, value, append });
    await copyFile(join(gitdir,"config"),file);
  });
}
async function config(ctx,path) {
  if (path in ctx.overrides) return ctx.overrides[path];
  try {
    const { gitdir }=await ctx.repo();
    const value=await git.getConfig({ fs, gitdir, path });
    if (value!==undefined) return value;
  } catch {}
  return globalGet(path);
}

// -- identity, honouring the same environment Git does
// isomorphic-git stores the zone JavaScript-style, minutes west of UTC, and
// tells +0000 from -0000 by the sign of zero.
function offsetMinutes(sign,hours,minutes) {
  const total=Number(hours)*60+Number(minutes);
  return total===0?(sign==="-"?-0:0):sign==="-"?total:-total;
}
function parseDate(text) {
  let match=/^@?(\d+)(?:\s+([+-])(\d\d):?(\d\d))?$/.exec(text.trim());
  if (match) {
    const timestamp=Number(match[1]);
    const minutes=match[2]?offsetMinutes(match[2],match[3],match[4]):new Date(timestamp*1000).getTimezoneOffset();
    return { timestamp, timezoneOffset:minutes };
  }
  const date=new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date format: ${text}`);
  match=/([+-])(\d\d):?(\d\d)\s*$/.exec(text.trim());
  const minutes=match?offsetMinutes(match[1],match[2],match[3]):date.getTimezoneOffset();
  return { timestamp:Math.floor(date.getTime()/1000), timezoneOffset:minutes };
}
async function identity(ctx,role,{ date,literal }={}) {
  const env=process.env, prefix=`GIT_${role.toUpperCase()}_`;
  let name=env[`${prefix}NAME`], email=env[`${prefix}EMAIL`];
  if (literal) {
    const match=/^(.*?)\s*<([^>]*)>\s*$/.exec(literal);
    if (!match) throw new Error(`--author '${literal}' is not 'Name <email>' and matches no existing author`);
    [,name,email]=match;
  }
  name??=await config(ctx,"user.name");
  email??=await config(ctx,"user.email");
  if (!name || !email) throw new Error(`${role[0].toUpperCase()+role.slice(1)} identity unknown\n\n*** Please tell me who you are.\n\n${HINT}`);
  const person={ name, email };
  const when=date??env[`${prefix}DATE`];
  if (when) Object.assign(person,parseDate(when));
  return person;
}

// -- revisions: HEAD, a ref, an abbreviated id, with ~N, ^N and ^{} suffixes
async function peel(ctx,oid,type="commit") {
  const repo=await base(ctx);
  for (;;) {
    const object=await git.readObject({ ...repo, oid, format:"parsed" });
    if (object.type===type) return oid;
    if (object.type==="tag") { oid=object.object.object; continue; }
    if (object.type==="commit" && type==="tree") return object.object.tree;
    throw new Error(`${oid} is a ${object.type}, not a ${type}`);
  }
}
export async function revision(ctx,spec,type) {
  const repo=await base(ctx);
  const ops=[];
  let rest=spec, match;
  for (;;) {
    if ((match=/\^\{(commit|tree|)\}$/.exec(rest))) ops.unshift(["peel",match[1]||"commit"]);
    else if ((match=/~(\d*)$/.exec(rest))) ops.unshift(["first",Number(match[1]===""?1:match[1])]);
    else if ((match=/\^(\d*)$/.exec(rest))) ops.unshift(["nth",Number(match[1]===""?1:match[1])]);
    else break;
    rest=rest.slice(0,match.index);
  }
  let oid;
  try { oid=await git.resolveRef({ ...repo, ref:rest==="@"?"HEAD":rest }); }
  catch (error) {
    if (!isOid(rest)) throw new Error(`bad revision '${spec}'`);
    try { oid=await git.expandOid({ ...repo, oid:rest.toLowerCase() }); }
    catch { throw new Error(`bad revision '${spec}'`); }
  }
  for (const [op,n] of ops) {
    if (op==="peel") { oid=await peel(ctx,oid,n); continue; }
    for (let step=0; step<(op==="first"?n:1); step++) {
      oid=await peel(ctx,oid);
      const { commit }=await git.readCommit({ ...repo, oid });
      const parent=commit.parent[op==="first"?0:n-1];
      if (n>0 && !parent) throw new Error(`bad revision '${spec}'`);
      if (n>0) oid=parent;
    }
  }
  return type?peel(ctx,oid,type):oid;
}
async function head(ctx) {
  try { return await git.resolveRef({ ...await base(ctx), ref:"HEAD" }); }
  catch { return undefined; }
}
async function branchName(ctx) {
  return git.currentBranch({ ...await base(ctx) });
}

// -- staging, driven by the status matrix so a vanished file is a removal
async function stageRows(ctx,rows,{ trackedOnly=false }={}) {
  const repo=await base(ctx);
  for (const [path,headState,workdir,stage] of rows) {
    if (trackedOnly && !headState && !stage) continue;
    if (workdir===0) { if (stage!==0) await git.remove({ ...repo, filepath:path }); }
    else if (workdir!==stage) await git.add({ ...repo, filepath:path });
  }
}
async function statusRows(ctx,filepaths) {
  const repo=await base(ctx);
  const rows=await git.statusMatrix({ ...repo, filepaths:filepaths?.length?filepaths:undefined });
  return rows.filter(([path,h,w,s])=>!(h===1&&w===1&&s===1));
}

// -- the summary `git commit` prints
function lines(buffer) {
  const text=Buffer.from(buffer).toString("latin1");
  if (text==="") return [];
  const parts=text.split("\n");
  if (parts.at(-1)==="") parts.pop(); else parts.push(parts.pop()+"\0<no-eol>");
  return parts;
}
function binary(buffer) {
  return Buffer.from(buffer.subarray(0,8000)).includes(0);
}
function lcs(a,b) {
  if (a.length*b.length>25e6) return 0;
  let previous=new Uint32Array(b.length+1), current=new Uint32Array(b.length+1);
  for (const line of a) {
    for (let j=0; j<b.length; j++)
      current[j+1]=line===b[j]?previous[j]+1:Math.max(previous[j+1],current[j]);
    [previous,current]=[current,previous];
  }
  return previous[b.length];
}
async function treeDiff(ctx,before,after) {
  const repo=await base(ctx);
  const trees=[before?git.TREE({ ref:before }):null, git.TREE({ ref:after })].filter(Boolean);
  const changes=await git.walk({ ...repo, trees, map:async (path,entries)=>{
    const [a,b]=before?entries:[null,entries[0]];
    if (path===".") return;
    const [typeA,typeB]=await Promise.all([a?.type(),b?.type()]);
    if (typeA==="tree" && typeB==="tree") return;
    const [oidA,oidB,modeA,modeB]=await Promise.all([
      typeA==="blob"?a.oid():undefined, typeB==="blob"?b.oid():undefined,
      typeA==="blob"?a.mode():undefined, typeB==="blob"?b.mode():undefined,
    ]);
    if (!oidA && !oidB) return;
    if (oidA===oidB && modeA===modeB) return;
    return { path, oidA, oidB, modeA:modeA?.toString(8), modeB:modeB?.toString(8) };
  } });
  // Exact renames, the way Git's summary reports a moved file.
  const deleted=changes.filter((c)=>!c.oidB), added=changes.filter((c)=>!c.oidA);
  for (const gone of deleted) {
    const twin=added.find((c)=>c.oidB===gone.oidA && !c.renamed);
    if (!twin) continue;
    twin.renamed=gone.path; gone.dropped=true;
  }
  return changes.filter((c)=>!c.dropped);
}
async function changeStats(ctx,changes) {
  const repo=await base(ctx);
  for (const change of changes) {
    change.insertions=0; change.deletions=0;
    if (change.renamed) continue;
    const [a,b]=await Promise.all([
      change.oidA?git.readBlob({ ...repo, oid:change.oidA }):{ blob:new Uint8Array() },
      change.oidB?git.readBlob({ ...repo, oid:change.oidB }):{ blob:new Uint8Array() },
    ]);
    if (binary(a.blob) || binary(b.blob)) { change.binary=true; change.bytesBefore=a.blob.length; change.bytesAfter=b.blob.length; continue; }
    const before=lines(a.blob), after=lines(b.blob), common=lcs(before,after);
    change.insertions=after.length-common; change.deletions=before.length-common;
  }
  return {
    files:changes.length,
    insertions:changes.reduce((n,c)=>n+c.insertions,0),
    deletions:changes.reduce((n,c)=>n+c.deletions,0),
  };
}
function statLine({ files,insertions,deletions }) {
  const parts=[` ${files} file${files===1?"":"s"} changed`];
  if (!insertions && !deletions) parts.push(" 0 insertions(+)"," 0 deletions(-)");
  else {
    if (insertions) parts.push(` ${insertions} insertion${insertions===1?"":"s"}(+)`);
    if (deletions) parts.push(` ${deletions} deletion${deletions===1?"":"s"}(-)`);
  }
  return parts.join(",")+"\n";
}
// Git's --stat table at its default 80 columns, scaled the way diff.c does.
function statTable(changes) {
  const name=(c)=>c.renamed?`${c.renamed} => ${c.path}`:c.path;
  const nameWidth=Math.max(...changes.map((c)=>name(c).length));
  const maxChange=Math.max(...changes.map((c)=>c.insertions+c.deletions));
  const numberWidth=Math.max(String(maxChange).length,changes.some((c)=>c.binary)?3:0);
  const graphWidth=Math.max(80-nameWidth-numberWidth-6,10);
  const scale=(n)=>maxChange>graphWidth?(n?1+Math.floor(n*(graphWidth-1)/maxChange):0):n;
  let text="";
  for (const c of changes) {
    if (c.binary) { text+=` ${name(c).padEnd(nameWidth)} | Bin ${c.bytesBefore} -> ${c.bytesAfter} bytes\n`; continue; }
    const total=c.insertions+c.deletions;
    text+=` ${name(c).padEnd(nameWidth)} | ${String(total).padStart(numberWidth)} ${"+".repeat(scale(c.insertions))}${"-".repeat(scale(c.deletions))}\n`;
  }
  return text;
}
async function commitSummary(ctx,oid,parentOid,{ table=false }={}) {
  const changes=(await treeDiff(ctx,parentOid,oid)).sort((x,y)=>x.path<y.path?-1:1);
  if (changes.length===0) return "";
  const totals=await changeStats(ctx,changes);
  let text=(table?statTable(changes):"")+statLine(totals);
  for (const change of changes) {
    if (change.renamed) text+=` rename ${change.renamed} => ${change.path} (100%)\n`;
    else if (!change.oidA) text+=` create mode ${change.modeB} ${change.path}\n`;
    else if (!change.oidB) text+=` delete mode ${change.modeA} ${change.path}\n`;
    else if (change.modeA!==change.modeB) text+=` mode change ${change.modeA} => ${change.modeB} ${change.path}\n`;
  }
  return text;
}

// -- commit rendering
const DAYS=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MONTHS=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function zone(offset) {
  const sign=offset<0||Object.is(offset,-0)?"-":"+", minutes=Math.abs(offset);
  return `${sign}${String(Math.floor(minutes/60)).padStart(2,"0")}${String(minutes%60).padStart(2,"0")}`;
}
function shifted(person) { return new Date((person.timestamp-person.timezoneOffset*60)*1000); }
function gitDate(person) {
  const d=shifted(person), pad=(n)=>String(n).padStart(2,"0");
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()} ${zone(person.timezoneOffset)}`;
}
function isoDate(person,strict) {
  const d=shifted(person), pad=(n)=>String(n).padStart(2,"0"), z=zone(person.timezoneOffset);
  const date=`${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
  const time=`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return strict?`${date}T${time}${z.slice(0,3)}:${z.slice(3)}`:`${date} ${time} ${z}`;
}
function subject(message) {
  const paragraph=message.split(/\n\s*\n/)[0];
  return paragraph.split("\n").map((l)=>l.trim()).filter(Boolean).join(" ");
}
function body(message) {
  const at=message.search(/\n\s*\n/);
  return at<0?"":message.slice(at).replace(/^\n\s*\n/,"");
}
// What `%d` shows: HEAD, branches, tags and remote branches at each commit.
async function decorations(ctx) {
  const repo=await base(ctx);
  const names=new Map();
  const add=(oid,name)=>{ if (!names.has(oid)) names.set(oid,[]); names.get(oid).push(name); };
  const current=await branchName(ctx), commitOid=await head(ctx);
  if (commitOid) add(commitOid,current?`HEAD -> ${current}`:"HEAD");
  for (const name of (await git.listBranches({ ...repo })).sort()) {
    if (name===current) continue;
    add(await git.resolveRef({ ...repo, ref:`refs/heads/${name}` }),name);
  }
  for (const name of (await git.listTags({ ...repo })).sort())
    add(await peel(ctx,await git.resolveRef({ ...repo, ref:`refs/tags/${name}` })),`tag: ${name}`);
  for (const { remote } of await git.listRemotes({ ...repo }))
    for (const name of (await git.listBranches({ ...repo, remote })).sort())
      add(await git.resolveRef({ ...repo, ref:`refs/remotes/${remote}/${name}` }),`${remote}/${name}`);
  return names;
}
// A decoration list the way Git colours it: HEAD cyan, branches green, tags
// yellow, remote branches red, the punctuation yellow.
// Git colours them in its built-in formats only; a %d placeholder is plain.
function decorate(ctx,names,oid,{ colour=true }={}) {
  const list=names?.get(oid);
  if (!list?.length) return "";
  const paint=colour?ctx.paint:(name,text)=>text;
  const painted=list.map((name)=>{
    if (name.startsWith("HEAD -> ")) return `${paint("boldCyan","HEAD")}${paint("yellow"," -> ")}${paint("boldGreen",name.slice(8))}`;
    if (name==="HEAD") return paint("boldCyan",name);
    if (name.startsWith("tag: ")) return paint("boldYellow","tag: ")+paint("boldYellow",name.slice(5));
    if (name.includes("/")) return paint("boldRed",name);
    return paint("boldGreen",name);
  });
  return `${paint("yellow"," (")}${painted.join(paint("yellow",", "))}${paint("yellow",")")}`;
}
function formatCommit(format,{ oid,commit },names,ctx) {
  const a=commit.author, c=commit.committer;
  const decorated=names?decorate(ctx,names,oid,{ colour:false }):"";
  const fields={
    H:oid, h:short(oid), T:commit.tree, t:short(commit.tree),
    P:commit.parent.join(" "), p:commit.parent.map(short).join(" "),
    an:a.name, ae:a.email, ad:gitDate(a), aD:gitDate(a), at:String(a.timestamp), ai:isoDate(a), aI:isoDate(a,true),
    cn:c.name, ce:c.email, cd:gitDate(c), cD:gitDate(c), ct:String(c.timestamp), ci:isoDate(c), cI:isoDate(c,true),
    s:subject(commit.message), b:body(commit.message), B:commit.message,
    d:decorated, D:decorated.slice(2,-1), n:"\n", "%":"%",
  };
  return format.replace(/%(aD|aI|ai|ad|ae|an|at|cD|cI|ci|cd|ce|cn|ct|[HhTtPpsbBdDn%])/g,(whole,key)=>fields[key]);
}
function mediumCommit(ctx,{ oid,commit },names) {
  const decorated=names?decorate(ctx,names,oid):"";
  let text=ctx.paint("yellow",`commit ${oid}`)+decorated+"\n";
  if (commit.parent.length>1) text+=`Merge: ${commit.parent.map(short).join(" ")}\n`;
  text+=`Author: ${commit.author.name} <${commit.author.email}>\nDate:   ${gitDate(commit.author)}\n\n`;
  return text+commit.message.replace(/\n$/,"").split("\n").map((line)=>`    ${line}`).join("\n")+"\n";
}

// Git's --cleanup=whitespace: trailing blanks off, blank runs collapsed.
function cleanMessage(text) {
  const out=[];
  for (const line of text.split("\n").map((l)=>l.replace(/\s+$/,""))) {
    if (line==="" && (out.length===0 || out.at(-1)==="")) continue;
    out.push(line);
  }
  while (out.at(-1)==="") out.pop();
  return out.join("\n")+"\n";
}

// -- remotes and authentication
async function remoteUrl(ctx,name) {
  const remotes=await git.listRemotes({ ...await base(ctx) });
  const remote=remotes.find((r)=>r.remote===name);
  if (!remote) throw new Error(`'${name}' does not appear to be a git repository`);
  return remote.url;
}
async function remoteOf(ctx,branch) {
  return (branch && await config(ctx,`branch.${branch}.remote`))||"origin";
}
// Tokens from the environment or Git's own credential store; interactive
// prompting is deliberately absent so a script never hangs.
function onAuth(url) {
  const env=process.env;
  if (env.GIT_USERNAME || env.GIT_PASSWORD) return { username:env.GIT_USERNAME, password:env.GIT_PASSWORD };
  const token=env.GIT_TOKEN||env.GITHUB_TOKEN;
  if (token) return { username:"x-access-token", password:token };
  try {
    const host=new URL(url).host;
    for (const line of fs.readFileSync(join(homedir(),".git-credentials"),"utf8").split("\n")) {
      try {
        const saved=new URL(line.trim());
        if (saved.host===host && saved.username)
          return { username:decodeURIComponent(saved.username), password:decodeURIComponent(saved.password) };
      } catch {}
    }
  } catch {}
  return undefined;
}
function network(ctx,options={}) {
  return {
    http, onAuth,
    onMessage:options.quiet?undefined:(message)=>ctx.err(`remote: ${message}`),
    headers:{ "User-Agent":`git/isogit-${VERSION}` },
  };
}

// ---------------------------------------------------------------- commands

// isomorphic-git writes the core settings a browser wants; on a Linux host
// the repository is shared with the system git, so use its defaults.
async function nativeConfig(gitdir) {
  await git.setConfig({ fs, gitdir, path:"core.filemode", value:"true" });
  for (const path of ["core.symlinks","core.ignorecase"]) await git.setConfig({ fs, gitdir, path, value:undefined });
}
async function init(ctx,argv) {
  const { options,positional }=parse(argv,{ q:"quiet", quiet:"quiet", bare:"bare", b:["branch"], "initial-branch":["branch"] });
  if (positional.length>1) throw new Error("too many arguments");
  const dir=resolve(ctx.cwd,positional[0]??".");
  const defaultBranch=options.branch??ctx.overrides["init.defaultBranch"]??await globalGet("init.defaultBranch")??"master";
  const gitdir=options.bare?dir:join(dir,".git");
  const existed=fs.existsSync(join(gitdir,"HEAD"));
  await mkdir(dir,{ recursive:true });
  await git.init({ fs, dir, gitdir, bare:!!options.bare, defaultBranch });
  if (!existed) await nativeConfig(gitdir);
  if (!options.quiet) ctx.out(`${existed?"Reinitialized existing":"Initialized empty"} Git repository in ${gitdir}/\n`);
}

async function clone(ctx,argv) {
  const options=parseClone(argv,ctx.cwd);
  if (!options.quiet) ctx.err(`Cloning into '${relative(ctx.cwd,options.dir)||"."}'...\n`);
  const { quiet,...cloneOptions }=options;
  await git.clone({ fs, ...network(ctx,options), ...cloneOptions });
  await nativeConfig(join(options.dir,".git"));
}

async function add(ctx,argv) {
  const { options,positional }=parse(argv,{ A:"all", all:"all", u:"update", update:"update", f:"force", force:"force", v:"verbose", verbose:"verbose", "dry-run":"dryRun", n:"dryRun" });
  const repo=await base(ctx);
  if (positional.length===0 && !options.all && !options.update) { ctx.err("Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?\n"); return; }
  const paths=await Promise.all(positional.map((p)=>ctx.pathspec(p)));
  const filepaths=paths.length&&!paths.includes("")?paths:undefined;
  for (const [index,path] of paths.entries()) {
    if (path==="" || fs.existsSync(join(repo.dir,path))) continue;
    const staged=await git.listFiles({ ...repo });
    if (!staged.some((f)=>f===path || f.startsWith(path+"/")))
      throw new Error(`pathspec '${positional[index]}' did not match any files`);
  }
  let rows=await statusRows(ctx,filepaths);
  if (paths.length && filepaths && rows.length===0)
    for (const [index,path] of paths.entries())
      if (await git.isIgnored({ ...repo, filepath:path }))
        throw new Error(`The following paths are ignored by one of your .gitignore files:\n${positional[index]}\nhint: Use -f if you really want to add them.`);
  if (options.dryRun) { for (const [path] of rows) ctx.out(`add '${path}'\n`); return; }
  await stageRows(ctx,rows,{ trackedOnly:!!options.update && !options.all });
  if (options.verbose) for (const [path] of rows) ctx.out(`add '${path}'\n`);
}

async function remove(ctx,argv) {
  const { options,positional }=parse(argv,{ cached:"cached", r:"recursive", q:"quiet", quiet:"quiet", f:"force", force:"force" });
  if (positional.length===0) throw new Error("No pathspec was given. Which files should I remove?");
  const repo=await base(ctx);
  const staged=await git.listFiles({ ...repo });
  for (const argument of positional) {
    const path=await ctx.pathspec(argument);
    const matches=staged.filter((f)=>path==="" || f===path || f.startsWith(path+"/"));
    if (matches.length===0) throw new Error(`pathspec '${argument}' did not match any files`);
    if (matches.length>1 && matches[0]!==path && !options.recursive && !options.cached)
      throw new Error(`not removing '${argument}' recursively without -r`);
    for (const file of matches) {
      await git.remove({ ...repo, filepath:file });
      if (!options.cached) await rm(join(repo.dir,file),{ force:true });
      if (!options.quiet) ctx.out(`rm '${file}'\n`);
    }
  }
}

async function move(ctx,argv) {
  const { options,positional }=parse(argv,{ f:"force", force:"force", k:"skip", v:"verbose" });
  if (positional.length<2) throw new Error("usage: git mv <source>... <destination>");
  const repo=await base(ctx);
  const staged=await git.listFiles({ ...repo });
  const target=positional.at(-1), sources=positional.slice(0,-1);
  const targetPath=await ctx.pathspec(target);
  const targetIsDir=fs.existsSync(join(repo.dir,targetPath)) && (await stat(join(repo.dir,targetPath))).isDirectory();
  if (sources.length>1 && !targetIsDir) throw new Error(`destination '${target}' is not a directory`);
  for (const source of sources) {
    const from=await ctx.pathspec(source);
    const to=targetIsDir?join(targetPath,basename(from)).split("\\").join("/"):targetPath;
    const files=staged.filter((f)=>f===from || f.startsWith(from+"/"));
    if (files.length===0) throw new Error(`source directory is empty or not under version control: ${source}`);
    if (fs.existsSync(join(repo.dir,to)) && !options.force && !targetIsDir) throw new Error(`destination exists, source=${from}, destination=${to}`);
    await mkdir(dirname(join(repo.dir,to)),{ recursive:true });
    await rename(join(repo.dir,from),join(repo.dir,to));
    for (const file of files) {
      const moved=file===from?to:to+file.slice(from.length);
      await git.remove({ ...repo, filepath:file });
      await git.add({ ...repo, filepath:moved, force:true });
    }
  }
}

async function commit(ctx,argv) {
  const { options,positional }=parse(argv,{
    m:["message",list], message:["message",list], F:["file"], file:["file"],
    a:"all", all:"all", q:"quiet", quiet:"quiet", "allow-empty":"allowEmpty", amend:"amend",
    author:["author"], date:["date"], "no-verify":"noVerify", n:"noVerify", "no-edit":"noEdit",
    "allow-empty-message":"allowEmptyMessage", v:"verbose", verbose:"verbose",
  });
  const repo=await base(ctx);
  // -a stages every tracked change; named paths stage those paths' changes.
  if (options.all || positional.length) {
    const filepaths=await Promise.all(positional.map((p)=>ctx.pathspec(p)));
    await stageRows(ctx,await statusRows(ctx,filepaths.filter(Boolean)),{ trackedOnly:true });
  }
  let message;
  if (options.message) message=cleanMessage(options.message.join("\n\n"));
  else if (options.file) message=cleanMessage(await readFile(options.file==="-"?"/dev/stdin":resolve(ctx.cwd,options.file),"utf8"));
  else if (!options.amend) throw new Error("no commit message given; this port has no editor, use -m <message>");
  if (message==="\n" && !options.allowEmptyMessage) throw new Error("Aborting commit due to empty commit message.");
  const before=await head(ctx);
  const branch=await branchName(ctx);
  const author=await identity(ctx,"author",{ date:options.date, literal:options.author });
  const committer=await identity(ctx,"committer");
  let oid;
  try {
    oid=await git.commit({ ...repo, message, author, committer, amend:!!options.amend, disallowEmpty:!options.allowEmpty && !options.amend });
  } catch (error) {
    if (error.code!=="EmptyCommitError") throw error;
    // Git shows the status and exits 1 when there is nothing to commit.
    ctx.out(await statusText(ctx,{}));
    return 1;
  }
  if (options.quiet) return;
  const parent=options.amend&&before?(await git.readCommit({ ...repo, oid:before })).commit.parent[0]:before;
  const label=branch?branch:"detached HEAD";
  const root=!before?" (root-commit)":"";
  const written=(await git.readCommit({ ...repo, oid })).commit;
  let text=`[${label}${root} ${short(oid)}] ${subject(written.message)}\n`;
  if (written.author.name!==written.committer.name || written.author.email!==written.committer.email)
    text+=` Author: ${written.author.name} <${written.author.email}>\n`;
  if (options.date || options.amend) text+=` Date: ${gitDate(written.author)}\n`;
  ctx.out(text+await commitSummary(ctx,oid,parent));
}

// -- status, in Git's long and short forms
function porcelainRows(rows) {
  const tracked=[], untracked=[];
  for (const [path,h,w,s] of rows) {
    if (h===0 && s===0) { if (w!==0) untracked.push(path); continue; }
    const x=h===0?"A":s===0?"D":s===1?" ":"M";
    let y;
    if (s===0) { y=" "; if (w!==0) untracked.push(path); }
    else if (w===0) y="D";
    else if (s===3 || (s===1 && w===2)) y="M";
    else y=" ";
    tracked.push({ path, x, y });
  }
  return { tracked, untracked };
}
// An untracked directory is one line, the way Git collapses it.
function collapse(untracked,trackedPaths) {
  const trackedDirs=new Set();
  for (const path of trackedPaths) for (let at=path.indexOf("/"); at>=0; at=path.indexOf("/",at+1)) trackedDirs.add(path.slice(0,at));
  const shown=new Set();
  for (const path of untracked) {
    let entry=path;
    for (let at=path.indexOf("/"); at>=0; at=path.indexOf("/",at+1)) {
      const dir=path.slice(0,at);
      if (!trackedDirs.has(dir)) { entry=dir+"/"; break; }
    }
    shown.add(entry);
  }
  return [...shown].sort();
}
// Pair a staged deletion with a staged addition of the same blob, which is
// what Git's default rename detection reports for a moved file.
async function pairRenames(ctx,staged) {
  const repo=await base(ctx);
  const commitOid=await head(ctx);
  const added=staged.filter((r)=>r.x==="A"), gone=staged.filter((r)=>r.x==="D");
  if (!commitOid || !added.length || !gone.length) return staged;
  const wanted=new Set(added.map((r)=>r.path));
  const stageOids=new Map(await git.walk({ ...repo, trees:[git.STAGE()], map:async (path,[entry])=>
    wanted.has(path)&&entry&&await entry.type()==="blob"?[path,await entry.oid()]:undefined }));
  for (const row of gone) {
    let oid;
    try { oid=(await git.readBlob({ ...repo, oid:commitOid, filepath:row.path })).oid; } catch { continue; }
    const twin=added.find((r)=>!r.renamedFrom && stageOids.get(r.path)===oid);
    if (twin) { twin.renamedFrom=row.path; row.dropped=true; }
  }
  return staged.filter((r)=>!r.dropped);
}
async function statusParts(ctx,filepaths) {
  const repo=await base(ctx);
  const rows=await statusRows(ctx,filepaths);
  const { tracked,untracked }=porcelainRows(rows);
  const all=(await git.listFiles({ ...repo }));
  const paired=await pairRenames(ctx,tracked.filter((r)=>r.x!==" "));
  const shown=tracked.filter((r)=>r.x===" " || paired.includes(r)).sort((a,b)=>a.path<b.path?-1:1);
  for (const row of shown) if (row.renamedFrom) row.x="R";
  return { tracked:shown, untracked:collapse(untracked,all), rows };
}
// Where the branch stands against its upstream, for the status header.
async function upstreamState(ctx,branch,commitOid) {
  if (!branch || !commitOid) return null;
  const remote=await config(ctx,`branch.${branch}.remote`), merge=await config(ctx,`branch.${branch}.merge`);
  if (!remote || !merge) return null;
  const repo=await base(ctx);
  const name=`${remote}/${merge.replace(/^refs\/heads\//,"")}`;
  let theirs;
  try { theirs=await git.resolveRef({ ...repo, ref:`refs/remotes/${name}` }); } catch { return { name, gone:true }; }
  const oids=async (ref)=>new Set((await git.log({ ...repo, ref })).map((c)=>c.oid));
  const [ours,upstream]=await Promise.all([oids(commitOid),oids(theirs)]);
  return { name, ahead:[...ours].filter((o)=>!upstream.has(o)).length, behind:[...upstream].filter((o)=>!ours.has(o)).length };
}
function upstreamHeader(state) {
  if (!state || state.gone) return "";
  const plural=(n)=>`${n} commit${n===1?"":"s"}`;
  if (!state.ahead && !state.behind) return `Your branch is up to date with '${state.name}'.\n\n`;
  if (!state.behind) return `Your branch is ahead of '${state.name}' by ${plural(state.ahead)}.\n  (use "git push" to publish your local commits)\n\n`;
  if (!state.ahead) return `Your branch is behind '${state.name}' by ${plural(state.behind)}, and can be fast-forwarded.\n  (use "git pull" to update your local branch)\n\n`;
  return `Your branch and '${state.name}' have diverged,\nand have ${state.ahead} and ${state.behind} different commits each, respectively.\n  (use "git pull" if you want to integrate the remote branch with yours)\n\n`;
}
async function statusText(ctx,options,filepaths) {
  const repo=await base(ctx);
  const branch=await branchName(ctx);
  const commitOid=await head(ctx);
  const { tracked,untracked }=await statusParts(ctx,filepaths);
  const state=await upstreamState(ctx,branch,commitOid);
  if (options.short || options.porcelain) {
    let text="";
    if (options.branch) {
      let line=commitOid?`## ${branch?ctx.paint("green",branch):ctx.paint("red","HEAD (no branch)")}`:`## No commits yet on ${ctx.paint("green",branch)}`;
      if (state && !state.gone) {
        const counts=[state.ahead&&`ahead ${ctx.paint("green",String(state.ahead))}`,state.behind&&`behind ${ctx.paint("red",String(state.behind))}`].filter(Boolean);
        line+=`...${ctx.paint("red",state.name)}${counts.length?` [${counts.join(", ")}]`:""}`;
      }
      text+=line+"\n";
    }
    for (const { path,x,y,renamedFrom } of tracked)
      text+=`${x===" "?x:ctx.paint("green",x)}${y===" "?y:ctx.paint("red",y)} ${renamedFrom?`${renamedFrom} -> `:""}${path}\n`;
    for (const path of untracked) text+=`${ctx.paint("red","??")} ${path}\n`;
    return text;
  }
  const staged=tracked.filter((r)=>r.x!==" "), unstaged=tracked.filter((r)=>r.y!==" ");
  let text=(branch?`On branch ${branch}\n`:`${ctx.paint("red","HEAD detached at ")}${short(commitOid)}\n`)+upstreamHeader(state);
  if (!commitOid) text+="\nNo commits yet\n\n";
  const label=(word)=>(word+":").padEnd(12);
  const shownStaged=staged;
  if (shownStaged.length) {
    text+=`Changes to be committed:\n  (use "git ${commitOid?"restore --staged":"rm --cached"} <file>..." to unstage)\n`;
    for (const r of shownStaged) {
      if (r.renamedFrom) text+=`\t${ctx.paint("green",`${label("renamed")}${r.renamedFrom} -> ${r.path}`)}\n`;
      else text+=`\t${ctx.paint("green",`${label(r.x==="A"?"new file":r.x==="D"?"deleted":"modified")}${r.path}`)}\n`;
    }
    text+="\n";
  }
  if (unstaged.length) {
    text+=`Changes not staged for commit:\n  (use "git add${unstaged.some((r)=>r.y==="D")?"/rm":""} <file>..." to update what will be committed)\n  (use "git restore <file>..." to discard changes in working directory)\n`;
    for (const r of unstaged) text+=`\t${ctx.paint("red",`${label(r.y==="D"?"deleted":"modified")}${r.path}`)}\n`;
    text+="\n";
  }
  if (untracked.length) {
    text+=`Untracked files:\n  (use "git add <file>..." to include in what will be committed)\n`;
    for (const path of untracked) text+=`\t${ctx.paint("red",path)}\n`;
    text+="\n";
  }
  if (shownStaged.length) return text;
  if (unstaged.length) return text+`no changes added to commit (use "git add" and/or "git commit -a")\n`;
  if (untracked.length) return text+`nothing added to commit but untracked files present (use "git add" to track)\n`;
  return text+(commitOid?"nothing to commit, working tree clean\n":`nothing to commit (create/copy files and use "git add" to track)\n`);
}
async function status(ctx,argv) {
  const { options,positional }=parse(argv,{ s:"short", short:"short", porcelain:"porcelain", b:"branch", branch:"branch", u:"untracked", "untracked-files":["untrackedFiles"], long:"long", color:"color", "no-color":"noColor" });
  if (options.color) ctx.colour=true;
  if (options.noColor || options.porcelain) ctx.colour=false;
  const filepaths=await Promise.all(positional.map((p)=>ctx.pathspec(p)));
  ctx.out(await statusText(ctx,options,filepaths.filter(Boolean)));
}

async function log(ctx,argv) {
  const parsed=parse(argv,{
    n:["maxCount",count], "max-count":["maxCount",count], "<n>":["maxCount",count],
    oneline:"oneline", format:["format"], pretty:["format"], reverse:"reverse",
    "no-decorate":"noDecorate", decorate:["decorate",null,true], "first-parent":"firstParent", color:"color", "no-color":"noColor", "no-pager":"noPager",
  });
  const { options,positional }=parsed;
  if (options.color) ctx.colour=true;
  if (options.noColor) ctx.colour=false;
  const repo=await base(ctx);
  const paths=parsed.paths??[];
  let refs=positional.slice(0,positional.length-paths.length);
  if (paths.length===0 && refs.length>1) throw new Error("this port takes one revision and optionally one path after --");
  if (paths.length>1) throw new Error("this port follows at most one path");
  const ref=refs[0]?await revision(ctx,refs[0]):await head(ctx);
  if (!ref) throw new Error(`your current branch '${await branchName(ctx)}' does not have any commits yet`);
  const filepath=paths[0]?await ctx.pathspec(paths[0]):undefined;
  let commits=await git.log({ ...repo, ref, depth:filepath?undefined:options.maxCount, filepath, force:true });
  if (options.maxCount!==undefined) commits=commits.slice(0,options.maxCount);
  if (options.reverse) commits.reverse();
  let format=options.format;
  if (format?.startsWith("format:") || format?.startsWith("tformat:")) format=format.slice(format.indexOf(":")+1);
  else if (format!==undefined && !format.includes("%") && ["medium","short","full","fuller","raw"].includes(format)) format=undefined;
  // log.decorate=auto: decorations appear on a terminal, or when asked for.
  const decorateWanted=options.decorate!==undefined?options.decorate!=="no":!options.noDecorate && ctx.decorate;
  const oneline=options.oneline || format==="oneline";
  if (format!==undefined && !oneline) {
    const names=/%[dD]/.test(format)?await decorations(ctx):undefined;
    for (const entry of commits) ctx.out(formatCommit(format,entry,names,ctx)+"\n");
    return;
  }
  const names=decorateWanted?await decorations(ctx):undefined;
  if (oneline) {
    for (const entry of commits)
      ctx.out(`${ctx.paint("yellow",options.oneline?short(entry.oid):entry.oid)}${decorate(ctx,names,entry.oid)} ${subject(entry.commit.message)}\n`);
    return;
  }
  ctx.out(commits.map((entry)=>mediumCommit(ctx,entry,names)).join("\n"));
}

async function branch(ctx,argv) {
  const { options,positional }=parse(argv,{
    a:"all", all:"all", r:"remotes", remotes:"remotes", l:"listOnly", list:"listOnly",
    d:"remove", delete:"remove", D:"forceRemove", m:"rename", move:"rename", M:"forceRename",
    f:"force", force:"force", "show-current":"showCurrent", q:"quiet", quiet:"quiet",
    u:["upstream"], "set-upstream-to":["upstream"], "unset-upstream":"unsetUpstream", "no-track":"noTrack", color:"color", "no-color":"noColor",
  });
  if (options.color) ctx.colour=true;
  if (options.noColor) ctx.colour=false;
  const repo=await base(ctx);
  const current=await branchName(ctx);
  if (options.showCurrent) { if (current) ctx.out(`${current}\n`); return; }
  if (options.remove || options.forceRemove) {
    if (positional.length===0) throw new Error("branch name required");
    for (const name of positional) {
      let oid;
      try { oid=await git.resolveRef({ ...repo, ref:`refs/heads/${name}` }); }
      catch { throw new Error(`branch '${name}' not found.`); }
      if (name===current) throw new Error(`cannot delete branch '${name}' used by worktree at '${repo.dir}'`);
      await git.deleteBranch({ ...repo, ref:name });
      ctx.out(`Deleted branch ${name} (was ${short(oid)}).\n`);
    }
    return;
  }
  if (options.rename || options.forceRename) {
    const [oldName,newName]=positional.length===1?[current,positional[0]]:positional;
    if (!newName) throw new Error("branch name required");
    await git.renameBranch({ ...repo, oldref:oldName, ref:newName, checkout:oldName===current, force:!!options.forceRename });
    return;
  }
  if (options.upstream!==undefined) {
    const name=positional[0]??current;
    const [remote,...rest]=options.upstream.split("/");
    await git.setConfig({ ...repo, path:`branch.${name}.remote`, value:remote });
    await git.setConfig({ ...repo, path:`branch.${name}.merge`, value:`refs/heads/${rest.join("/")}` });
    ctx.out(`branch '${name}' set up to track '${options.upstream}'.\n`);
    return;
  }
  if (positional.length>0 && !options.listOnly) {
    const [name,start]=positional;
    if (positional.length>2) throw new Error("too many arguments");
    const object=start?await revision(ctx,start,"commit"):undefined;
    if (!object && !await head(ctx)) throw new Error("not a valid object name: 'HEAD'");
    await git.branch({ ...repo, ref:name, object, force:!!options.force, checkout:false });
    return;
  }
  const local=options.remotes?[]:(await git.listBranches({ ...repo })).sort();
  const remotes=options.all||options.remotes?(await git.listRemotes({ ...repo })).map((r)=>r.remote):[];
  let text="";
  for (const name of local) text+=name===current?`* ${ctx.paint("green",name)}\n`:`  ${name}\n`;
  if (!current && await head(ctx)) text=`* ${ctx.paint("green",`(HEAD detached at ${short(await head(ctx))})`)}\n`+text;
  for (const remote of remotes.sort()) {
    const prefix=options.remotes?"":"remotes/";
    for (const name of (await git.listBranches({ ...repo, remote })).sort()) {
      if (name!=="HEAD") { text+=`  ${ctx.paint("red",`${prefix}${remote}/${name}`)}\n`; continue; }
      // The remote's HEAD, as `origin/HEAD -> origin/main` when it is a symref.
      const target=(await readFile(join(repo.gitdir,"refs","remotes",remote,"HEAD"),"utf8").catch(()=>"")).trim();
      const match=/^ref: refs\/remotes\/(.+)$/.exec(target);
      if (match) text+=`  ${ctx.paint("red",`${prefix}${remote}/HEAD`)} -> ${match[1]}\n`;
    }
  }
  ctx.out(text);
}

async function checkout(ctx,argv) {
  const parsed=parse(argv,{ b:["create"], B:["forceCreate"], f:"force", force:"force", q:"quiet", quiet:"quiet", "no-track":"noTrack", t:"track", track:"track", detach:"detach", "orphan":["orphan"] });
  const { options,positional }=parsed;
  const repo=await base(ctx);
  const separator=parsed.paths?positional.length-parsed.paths.length:-1;
  let paths=parsed.paths??[];
  let refs=positional.slice(0,separator<0?positional.length:separator);
  const create=options.create??options.forceCreate;
  if (create) {
    const start=refs[0]?await revision(ctx,refs[0],"commit"):await head(ctx);
    if (!start) throw new Error("not a valid object name: 'HEAD'");
    await git.branch({ ...repo, ref:create, object:start, force:!!options.forceCreate, checkout:false });
    await git.checkout({ ...repo, ref:create, force:!!options.force });
    if (!options.quiet) ctx.err(`Switched to a new branch '${create}'\n`);
    return;
  }
  // `checkout <ref> -- <paths>` and `checkout <paths>` restore files.
  if (separator<0 && refs.length) {
    const local=await git.listBranches({ ...repo });
    const remoteNames=(await git.listRemotes({ ...repo })).map((r)=>r.remote);
    const isRef=async (name)=>{
      if (local.includes(name) || name==="HEAD" || isOid(name)) return true;
      try { await revision(ctx,name); return true; } catch {}
      for (const remote of remoteNames) if ((await git.listBranches({ ...repo, remote })).includes(name)) return true;
      return false;
    };
    if (!await isRef(refs[0])) { paths=refs; refs=[]; }
    else if (refs.length>1) { paths=refs.slice(1); refs=refs.slice(0,1); }
  }
  if (paths.length) {
    const filepaths=await Promise.all(paths.map((p)=>ctx.pathspec(p)));
    if (!refs[0]) return restoreFromIndex(ctx,paths,filepaths);
    const ref=await revision(ctx,refs[0],"commit");
    await git.checkout({ ...repo, ref, filepaths:filepaths.map((p)=>p||"."), force:true, noUpdateHead:true });
    await stageRows(ctx,await statusRows(ctx,filepaths.filter(Boolean)),{});
    return;
  }
  if (refs.length!==1) throw new Error("usage: git checkout [<branch>] | -b <new-branch> [<start-point>] | [<tree-ish>] -- <pathspec>...");
  const target=refs[0];
  const local=await git.listBranches({ ...repo });
  const current=await branchName(ctx);
  if (local.includes(target)) {
    if (target===current) { if (!options.quiet) ctx.err(`Already on '${target}'\n`); return; }
    await git.checkout({ ...repo, ref:target, force:!!options.force });
    if (!options.quiet) ctx.err(`Switched to branch '${target}'\n`);
    return;
  }
  for (const { remote } of await git.listRemotes({ ...repo })) {
    if ((await git.listBranches({ ...repo, remote })).includes(target)) {
      await git.checkout({ ...repo, ref:target, remote, force:!!options.force });
      if (!options.quiet) ctx.err(`branch '${target}' set up to track '${remote}/${target}'.\nSwitched to a new branch '${target}'\n`);
      return;
    }
  }
  const oid=await revision(ctx,target,"commit");
  await git.checkout({ ...repo, ref:oid, force:!!options.force });
  if (!options.quiet) ctx.err(`Note: switching to '${target}'.\nHEAD is now at ${short(oid)} ${subject((await git.readCommit({ ...repo, oid })).commit.message)}\n`);
}

// `checkout -- <path>` and `restore <path>`: the worktree copy comes from
// the index, not HEAD.
async function restoreFromIndex(ctx,shown,filepaths) {
  const repo=await base(ctx);
  const entries=await git.walk({ ...repo, trees:[git.STAGE()], map:async (path,[entry])=>{
    if (path==="." || !entry || await entry.type()!=="blob") return;
    if (!filepaths.some((p)=>p==="" || path===p || path.startsWith(p+"/"))) return;
    return { path, oid:await entry.oid(), mode:await entry.mode() };
  } });
  for (const [index,path] of filepaths.entries())
    if (!entries.some((e)=>path==="" || e.path===path || e.path.startsWith(path+"/")))
      throw failure(`pathspec '${shown[index]}' did not match any file(s) known to git`);
  for (const { path,oid,mode } of entries) {
    const { blob }=await git.readBlob({ ...repo, oid });
    const target=join(repo.dir,path);
    await mkdir(dirname(target),{ recursive:true });
    if (mode===0o120000) { await rm(target,{ force:true }); await symlink(Buffer.from(blob).toString(),target); continue; }
    await writeFile(target,blob,{ mode:mode===0o100755?0o755:0o644 });
    await chmod(target,mode===0o100755?0o755:0o644);
  }
}

async function switchBranch(ctx,argv) {
  const { options,positional }=parse(argv,{ c:["create"], create:["create"], C:["forceCreate"], "force-create":["forceCreate"], f:"force", "discard-changes":"force", q:"quiet", quiet:"quiet", detach:"detach", "no-track":"noTrack", t:"track", track:"track" });
  const create=options.create??options.forceCreate;
  const rewritten=[];
  if (create) rewritten.push(options.forceCreate?"-B":"-b",create);
  if (options.force) rewritten.push("-f");
  if (options.quiet) rewritten.push("-q");
  if (positional.length>(create?1:1)) throw new Error("only one reference expected");
  return checkout(ctx,[...rewritten,...positional]);
}

async function restore(ctx,argv) {
  const { options,positional }=parse(argv,{ S:"staged", staged:"staged", W:"worktree", worktree:"worktree", s:["source"], source:["source"], q:"quiet", quiet:"quiet" });
  if (positional.length===0) throw new Error("you must specify path(s) to restore");
  const repo=await base(ctx);
  const filepaths=await Promise.all(positional.map((p)=>ctx.pathspec(p)));
  const source=options.source?await revision(ctx,options.source,"commit"):"HEAD";
  const worktree=options.worktree || !options.staged;
  if (options.staged) {
    const staged=await git.listFiles({ ...repo });
    const headFiles=await head(ctx)?await git.listFiles({ ...repo, ref:source }):[];
    for (const path of filepaths) {
      const matches=[...new Set([...staged,...headFiles])].filter((f)=>path==="" || f===path || f.startsWith(path+"/"));
      for (const file of matches) await git.resetIndex({ ...repo, filepath:file, ref:await head(ctx)?source:undefined });
    }
  }
  if (!worktree) return;
  if (!options.source && !options.staged) return restoreFromIndex(ctx,positional,filepaths);
  await git.checkout({ ...repo, ref:source, filepaths:filepaths.map((p)=>p||"."), force:true, noUpdateHead:true });
}

async function reset(ctx,argv) {
  const parsed=parse(argv,{ hard:"hard", soft:"soft", mixed:"mixed", q:"quiet", quiet:"quiet" });
  const { options,positional }=parsed;
  const repo=await base(ctx);
  const separator=parsed.paths?positional.length-parsed.paths.length:-1;
  const explicitPaths=parsed.paths??[];
  let refs=positional.slice(0,separator<0?positional.length:separator);
  const commitOid=await head(ctx);
  // `reset [<ref>] <paths>`: unstage.
  let paths=explicitPaths;
  if (separator<0 && refs.length && !options.hard && !options.soft && !options.mixed) {
    const looksLikeRef=async (name)=>{ try { await revision(ctx,name); return true; } catch { return false; } };
    if (!await looksLikeRef(refs[0])) { paths=refs; refs=[]; }
    else if (refs.length>1) { paths=refs.slice(1); refs=refs.slice(0,1); }
  }
  if (paths.length) {
    const ref=refs[0]?await revision(ctx,refs[0],"commit"):(commitOid?"HEAD":undefined);
    const staged=await git.listFiles({ ...repo });
    const treeFiles=ref?await git.listFiles({ ...repo, ref }):[];
    for (const argument of paths) {
      const path=await ctx.pathspec(argument);
      const matches=[...new Set([...staged,...treeFiles])].filter((f)=>path==="" || f===path || f.startsWith(path+"/"));
      for (const file of matches) await git.resetIndex({ ...repo, filepath:file, ref });
    }
    return;
  }
  const target=refs[0]?await revision(ctx,refs[0],"commit"):commitOid;
  if (!target) throw new Error("Failed to resolve 'HEAD' as a valid ref.");
  const current=await branchName(ctx);
  await git.writeRef({ ...repo, ref:current?`refs/heads/${current}`:"HEAD", value:target, force:true });
  if (options.soft) return;
  if (options.hard) {
    await git.checkout({ ...repo, ref:current??target, force:true });
    if (!options.quiet) ctx.out(`HEAD is now at ${short(target)} ${subject((await git.readCommit({ ...repo, oid:target })).commit.message)}\n`);
    return;
  }
  const staged=await git.listFiles({ ...repo });
  const treeFiles=await git.listFiles({ ...repo, ref:target });
  for (const file of new Set([...staged,...treeFiles])) await git.resetIndex({ ...repo, filepath:file, ref:target });
  if (!options.quiet) {
    const unstaged=(await statusRows(ctx)).filter(([,h,w,s])=>(h||s) && w!==1 && !(w===2 && s===2));
    if (unstaged.length) ctx.out("Unstaged changes after reset:\n"+unstaged.map(([p,h,w])=>`${w===0?"D":"M"}\t${p}\n`).join(""));
  }
}

async function tag(ctx,argv) {
  const { options,positional }=parse(argv,{ a:"annotate", annotate:"annotate", m:["message",list], message:["message",list], d:"remove", delete:"remove", l:"listOnly", list:"listOnly", f:"force", force:"force", F:["file"] });
  const repo=await base(ctx);
  if (options.remove) {
    for (const name of positional) {
      let oid;
      try { oid=await git.resolveRef({ ...repo, ref:`refs/tags/${name}` }); }
      catch { throw new Error(`tag '${name}' not found.`); }
      await git.deleteTag({ ...repo, ref:name });
      ctx.out(`Deleted tag '${name}' (was ${short(await peel(ctx,oid))})\n`);
    }
    return;
  }
  if (positional.length===0 || options.listOnly) {
    const pattern=options.listOnly?positional[0]:undefined;
    const matcher=pattern?new RegExp("^"+pattern.split("*").map((p)=>p.replace(/[.+?^${}()|[\]\\]/g,"\\$&")).join(".*")+"$"):null;
    for (const name of (await git.listTags({ ...repo })).sort()) if (!matcher || matcher.test(name)) ctx.out(`${name}\n`);
    return;
  }
  const [name,start]=positional;
  const object=start?await revision(ctx,start):await head(ctx);
  if (!object) throw new Error("Failed to resolve 'HEAD' as a valid ref.");
  if (options.message || options.annotate || options.file) {
    const text=options.file?await readFile(resolve(ctx.cwd,options.file),"utf8"):(options.message??[]).join("\n\n");
    if (!text.trim()) throw new Error("no tag message?");
    const tagger=await identity(ctx,"committer");
    // isomorphic-git's tag template supplies the final newline itself.
    await git.annotatedTag({ ...repo, ref:name, object, message:cleanMessage(text).replace(/\n$/,""), tagger, force:!!options.force });
    return;
  }
  await git.tag({ ...repo, ref:name, object, force:!!options.force });
}

async function remote(ctx,argv) {
  const { options,positional }=parse(argv,{ v:"verbose", verbose:"verbose" });
  const repo=await base(ctx);
  const [verb,...rest]=positional;
  if (!verb) {
    for (const { remote,url } of (await git.listRemotes({ ...repo })).sort((a,b)=>a.remote<b.remote?-1:1))
      ctx.out(options.verbose?`${remote}\t${url} (fetch)\n${remote}\t${url} (push)\n`:`${remote}\n`);
    return;
  }
  if (verb==="add") {
    const { positional:[name,url] }=parse(rest,{ f:"fetch", fetch:"fetch", tags:"tags", "no-tags":"noTags" });
    if (!name || !url) throw new Error("usage: git remote add <name> <url>");
    await git.addRemote({ ...repo, remote:name, url });
    return;
  }
  if (verb==="remove" || verb==="rm") {
    if (!rest[0]) throw new Error("usage: git remote remove <name>");
    await remoteUrl(ctx,rest[0]);
    await git.deleteRemote({ ...repo, remote:rest[0] });
    return;
  }
  if (verb==="get-url") { ctx.out(`${await remoteUrl(ctx,rest[0])}\n`); return; }
  if (verb==="set-url") {
    if (!rest[0] || !rest[1]) throw new Error("usage: git remote set-url <name> <newurl>");
    await remoteUrl(ctx,rest[0]);
    await git.setConfig({ ...repo, path:`remote.${rest[0]}.url`, value:rest[1] });
    return;
  }
  if (verb==="show") {
    const url=await remoteUrl(ctx,rest[0]);
    ctx.out(`* remote ${rest[0]}\n  Fetch URL: ${url}\n  Push  URL: ${url}\n`);
    return;
  }
  throw new Error(`unknown subcommand: '${verb}'`);
}

async function fetch(ctx,argv) {
  const { options,positional }=parse(argv,{ depth:["depth",positiveDepth], tags:"tags", "no-tags":"noTags", p:"prune", prune:"prune", q:"quiet", quiet:"quiet", all:"all", v:"verbose", "prune-tags":"pruneTags", f:"force", force:"force", u:"update" });
  const repo=await base(ctx);
  const current=await branchName(ctx);
  const remotes=options.all?(await git.listRemotes({ ...repo })).map((r)=>r.remote):[positional[0]??await remoteOf(ctx,current)];
  for (const remote of remotes) {
    const url=await remoteUrl(ctx,remote);
    // isomorphic-git rewrites refs/remotes/<remote>/HEAD on every full fetch.
    // Git 2.48 creates it when missing and otherwise leaves it alone, under
    // remote.<remote>.followRemoteHEAD: create (the default), warn, always
    // or never.
    const follow=(await config(ctx,`remote.${remote}.followRemoteHEAD`))??"create";
    const remoteHead=join(repo.gitdir,"refs","remotes",remote,"HEAD");
    const before=await readFile(remoteHead,"utf8").catch(()=>undefined);
    const result=await git.fetch({ ...repo, ...network(ctx,options), remote, ref:positional[1], singleBranch:!!positional[1], depth:options.depth, tags:!!options.tags, prune:!!options.prune, pruneTags:!!options.pruneTags });
    const after=await readFile(remoteHead,"utf8").catch(()=>undefined);
    if (follow==="never" || (follow!=="always" && before!==undefined)) {
      if (before===undefined) await rm(remoteHead,{ force:true }); else if (after!==before) await writeFile(remoteHead,before);
      if (follow.startsWith("warn") && before!==undefined && after!==undefined && after!==before) {
        const branch=(text)=>text.trim().replace(/^ref: refs\/remotes\/[^/]+\//,"");
        if (follow==="warn" || follow.slice(12)!==branch(after))
          ctx.err(`warning: '${remote}/HEAD' points to '${branch(after)}' on the remote, but is set to '${branch(before)}' locally\n`);
      }
    }
    if (!options.quiet) ctx.err(`From ${url}\n${result.fetchHead?` * branch            ${result.fetchHeadDescription??""}\n`:""}`);
  }
}

async function pull(ctx,argv) {
  const { options,positional }=parse(argv,{ "ff-only":"ffOnly", "no-ff":"noFf", ff:"ff", rebase:"rebase", "no-rebase":"noRebase", q:"quiet", quiet:"quiet", depth:["depth",positiveDepth], p:"prune", prune:"prune", tags:"tags", "no-tags":"noTags", "allow-unrelated-histories":"unrelated" });
  if (options.rebase) throw new Error("--rebase is not available in this port");
  const repo=await base(ctx);
  const current=await branchName(ctx);
  if (!current) throw new Error("You are not currently on a branch.");
  const remote=positional[0]??await remoteOf(ctx,current);
  const merge=await config(ctx,`branch.${current}.merge`);
  const remoteRef=positional[1]??merge?.replace(/^refs\/heads\//,"");
  if (!remoteRef) throw new Error(`There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.\n\n    git pull <remote> <branch>`);
  const url=await remoteUrl(ctx,remote);
  const fetched=await git.fetch({ ...repo, ...network(ctx,options), remote, ref:remoteRef, singleBranch:true, depth:options.depth, tags:!!options.tags, prune:!!options.prune });
  if (!options.quiet) ctx.err(`From ${url}\n * branch            ${remoteRef.padEnd(10)} -> FETCH_HEAD\n`);
  // The rest is `git merge FETCH_HEAD`, so it prints what a merge prints.
  return mergeInto(ctx,{ ...options, theirs:fetched.fetchHead, message:`Merge branch '${remoteRef}' of ${url}` });
}

async function push(ctx,argv) {
  const { options,positional }=parse(argv,{ u:"upstream", "set-upstream":"upstream", f:"force", force:"force", d:"remove", delete:"remove", tags:"tags", q:"quiet", quiet:"quiet", v:"verbose", "all":"all", "no-verify":"noVerify", "force-with-lease":"force", "dry-run":"dryRun" });
  const repo=await base(ctx);
  const current=await branchName(ctx);
  const remote=positional[0]??await remoteOf(ctx,current);
  const url=await remoteUrl(ctx,remote);
  let specs=positional.slice(1);
  if (options.all) specs=await git.listBranches({ ...repo });
  if (options.tags) specs.push(...(await git.listTags({ ...repo })).map((t)=>`refs/tags/${t}`));
  if (specs.length===0) {
    if (!current) throw new Error("You are not currently on a branch.");
    const merge=await config(ctx,`branch.${current}.merge`);
    if (!merge && !options.upstream) throw new Error(`The current branch ${current} has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream ${remote} ${current}`);
    specs=[merge?`${current}:${merge}`:current];
  }
  if (!options.quiet) ctx.err(`To ${url}\n`);
  for (const spec of specs) {
    let force=!!options.force, remove=!!options.remove;
    let source=spec, destination;
    if (source.startsWith("+")) { force=true; source=source.slice(1); }
    const colon=source.indexOf(":");
    if (colon>=0) { destination=source.slice(colon+1); source=source.slice(0,colon); }
    if (source==="") { remove=true; source=undefined; }
    destination??=source;
    const isTag=source&&source.startsWith("refs/tags/");
    await git.push({ ...repo, ...network(ctx,options), remote, ref:remove?undefined:source, remoteRef:destination, force, delete:remove });
    if (!options.quiet) {
      const label=remove?" - [deleted]":isTag?" * [new tag]":" * [new branch]";
      ctx.err(`${label}${" ".repeat(Math.max(1,20-label.length))}${(source??"").replace(/^refs\/(heads|tags)\//,"")} -> ${(destination??"").replace(/^refs\/(heads|tags)\//,"")}\n`);
    }
    if (options.upstream && source && !isTag) {
      const name=source.replace(/^refs\/heads\//,"");
      await git.setConfig({ ...repo, path:`branch.${name}.remote`, value:remote });
      await git.setConfig({ ...repo, path:`branch.${name}.merge`, value:`refs/heads/${destination.replace(/^refs\/heads\//,"")}` });
      if (!options.quiet) ctx.out(`branch '${name}' set up to track '${remote}/${destination.replace(/^refs\/heads\//,"")}'.\n`);
    }
  }
}

async function mergeInto(ctx,{ theirs,message,noFf,ffOnly,quiet,unrelated }) {
  const repo=await base(ctx);
  const current=await branchName(ctx);
  if (!current) throw new Error("You are not currently on a branch.");
  const before=await head(ctx);
  const author=await identity(ctx,"author"), committer=await identity(ctx,"committer");
  let result;
  try {
    result=await git.merge({ ...repo, ours:current, theirs, author, committer, message, fastForward:!noFf, fastForwardOnly:!!ffOnly, abortOnConflict:false, allowUnrelatedHistories:!!unrelated });
  } catch (error) {
    if (error.code!=="MergeConflictError") throw error;
    for (const path of error.data.filepaths) ctx.out(`CONFLICT (content): Merge conflict in ${path}\n`);
    ctx.out("Automatic merge failed; fix conflicts and then commit the result.\n");
    return 1;
  }
  // A fast-forward only moves the ref; bring the index and worktree along.
  if (result.fastForward && !result.alreadyMerged) await git.checkout({ ...repo, ref:current });
  if (quiet) return;
  if (result.alreadyMerged) ctx.out("Already up to date.\n");
  else if (result.fastForward) {
    ctx.out(`Updating ${short(before)}..${short(result.oid)}\nFast-forward\n`);
    ctx.out(await commitSummary(ctx,result.oid,before,{ table:true }));
  }
  else ctx.out("Merge made by the 'ort' strategy.\n"+await commitSummary(ctx,result.oid,before,{ table:true }));
}

async function merge(ctx,argv) {
  const { options,positional }=parse(argv,{ "no-ff":"noFf", "ff-only":"ffOnly", ff:"ff", m:["message",list], abort:"abort", q:"quiet", quiet:"quiet", "no-edit":"noEdit", "allow-unrelated-histories":"unrelated", "no-commit":"noCommit" });
  const repo=await base(ctx);
  if (options.abort) { await git.abortMerge({ ...repo }); return; }
  if (positional.length!==1) throw new Error("this port merges exactly one branch at a time");
  const theirs=await revision(ctx,positional[0],"commit");
  const message=options.message?cleanMessage(options.message.join("\n\n")):undefined;
  return mergeInto(ctx,{ ...options, theirs, message });
}

// -- diff, with the line diffing done by `bun pm diff` over two scratch trees.
// Each side is materialized only for the paths that can differ; the JSON
// output carries one unified patch per file, which is re-headed the way Git
// prints it (index line, modes, hunk ranges and function context).
const BUN=()=>Bun.which("bun")||process.argv0;
async function materialize(root,files) {
  for (const { path,content,mode } of files) {
    if (content===undefined) continue;
    const target=join(root,path);
    await mkdir(dirname(target),{ recursive:true });
    await writeFile(target,content,{ mode:mode==="100755"?0o755:0o644 });
    await chmod(target,mode==="100755"?0o755:0o644);
  }
}
function bunDiff(left,right,context) {
  const result=Bun.spawnSync({ cmd:[BUN(),"pm","diff","--raw","--json","-U",String(context),left,right], stdout:"pipe", stderr:"pipe" });
  const text=result.stdout.toString();
  if (result.exitCode!==0 || !text.startsWith("{"))
    throw new Error(`git diff needs a Bun with 'bun pm diff' (running ${Bun.version}): ${result.stderr.toString().trim().split("\n")[0]}`);
  return JSON.parse(text).files;
}
// Git's default hunk header context: the closest earlier line of the old
// side that starts with a letter, '_' or '$', cut at 80 bytes.
function funcName(oldLines,start,count) {
  for (let at=(count===0?start:start-1)-1; at>=0; at--) {
    const line=oldLines[at];
    if (/^[A-Za-z_$]/.test(line)) return " "+line.replace(/\s+$/,"").slice(0,80);
  }
  return "";
}
// Git's colouring quirks are kept: every line ends in a reset, the function
// context is painted "normal", and a '+' sign is painted apart from its text.
function gitHunks(patch,oldText,ctx) {
  const oldLines=oldText.split("\n");
  const reset=ctx.colour?"\x1b[m":"";
  const lines=patch.split("\n");
  if (lines.at(-1)==="") lines.pop();
  return lines.map((line)=>{
    const match=/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(line);
    if (match) {
      const [,oldStart,oldCount,newStart,newCount]=match.map(Number);
      const range=(start,count)=>count===1?`${start}`:`${start},${count}`;
      const context=funcName(oldLines,oldStart,oldCount);
      return ctx.paint("cyan",`@@ -${range(oldStart,oldCount)} +${range(newStart,newCount)} @@`)+(context?` ${reset}${context.slice(1)}${reset}`:"");
    }
    if (line.startsWith("-")) return ctx.paint("red",line);
    if (line.startsWith("+")) return ctx.paint("green","+")+ctx.paint("green",line.slice(1));
    return line+reset;
  }).join("\n")+"\n";
}
async function diff(ctx,argv) {
  const parsed=parse(argv,{
    cached:"cached", staged:"cached", stat:"stat", "name-only":"nameOnly", "name-status":"nameStatus",
    U:["context",count], unified:["context",count], color:"color", "no-color":"noColor", "exit-code":"exitCode", quiet:"quiet",
    "no-ext-diff":"noExt", "no-renames":"noRenames", "no-index":"noIndex", p:"patch", u:"patch", patch:"patch",
  });
  const { options }=parsed;
  if (options.noIndex) throw new Error("--no-index is not available in this port");
  if (options.quiet) { options.exitCode=true; ctx.out=()=>{}; }
  if (options.color) ctx.colour=true;
  if (options.noColor) ctx.colour=false;
  const repo=await base(ctx);
  const paths=parsed.paths??[];
  let revs=parsed.positional.slice(0,parsed.positional.length-paths.length);
  if (revs.length===1 && revs[0].includes("..")) revs=revs[0].split(/\.\.\.?/);
  // Without `--`, trailing arguments that are not revisions are paths.
  if (!parsed.paths) {
    while (revs.length) {
      const last=revs.at(-1);
      let isRev=false;
      try { await revision(ctx,last); isRev=true; } catch {}
      if (isRev) break;
      paths.unshift(revs.pop());
    }
  }
  const filepaths=await Promise.all(paths.map((p)=>ctx.pathspec(p)));
  const within=(path)=>filepaths.length===0 || filepaths.some((p)=>p==="" || path===p || path.startsWith(p+"/"));
  const context=options.context??3;
  const blob=async (oid)=>oid?(await git.readBlob({ ...repo, oid })).blob:undefined;
  const tree=async (ref)=>{
    const entries=await git.walk({ ...repo, trees:[git.TREE({ ref })], map:async (path,[entry])=>
      path!=="." && entry && await entry.type()==="blob" && within(path)?[path,{ oid:await entry.oid(), mode:(await entry.mode()).toString(8) }]:undefined });
    return new Map(entries);
  };
  const stage=async ()=>{
    const entries=await git.walk({ ...repo, trees:[git.STAGE()], map:async (path,[entry])=>
      path!=="." && entry && await entry.type()==="blob" && within(path)?[path,{ oid:await entry.oid(), mode:(await entry.mode()).toString(8) }]:undefined });
    return new Map(entries);
  };
  const worktree=async (path)=>{
    const target=join(repo.dir,path);
    let info;
    try { info=await lstat(target); } catch { return undefined; }
    if (info.isSymbolicLink()) return { content:Buffer.from(await readlink(target)), mode:"120000" };
    if (info.isDirectory()) return undefined;
    return { content:await readFile(target), mode:info.mode&0o111?"100755":"100644" };
  };
  // Pairs of { path, left:{oid,mode,content}, right:{...} } that may differ.
  const pairs=[];
  const record=async (path,left,right)=>{
    if (left && !left.content) left.content=await blob(left.oid);
    if (right && !right.content) right.content=await blob(right.oid);
    if (left?.oid===undefined && left?.content) left.oid=(await git.hashBlob({ object:new Uint8Array(left.content) })).oid;
    if (right?.oid===undefined && right?.content) right.oid=(await git.hashBlob({ object:new Uint8Array(right.content) })).oid;
    if (!left && !right) return;
    if (left && right && left.oid===right.oid && left.mode===right.mode) return;
    pairs.push({ path, left, right });
  };
  if (revs.length===2) {
    const [a,b]=await Promise.all([tree(await revision(ctx,revs[0],"commit")),tree(await revision(ctx,revs[1],"commit"))]);
    for (const path of new Set([...a.keys(),...b.keys()])) await record(path,a.get(path),b.get(path));
  } else if (options.cached) {
    const commitOid=revs[0]?await revision(ctx,revs[0],"commit"):await head(ctx);
    const [a,b]=await Promise.all([commitOid?tree(commitOid):new Map(),stage()]);
    for (const path of new Set([...a.keys(),...b.keys()])) await record(path,a.get(path),b.get(path));
  } else {
    // Worktree against the index, or against a commit; untracked files stay out.
    const commitOid=revs[0]?await revision(ctx,revs[0],"commit"):undefined;
    const left=commitOid?await tree(commitOid):await stage();
    const rows=await git.statusMatrix({ ...repo, ref:commitOid, filepaths:filepaths.length?filepaths.filter(Boolean):undefined });
    for (const [path,h,w,st] of rows) {
      if (!left.has(path) && !(commitOid?h:st)) continue;
      if (h===1 && w===1 && st===1) continue;
      await record(path,left.get(path),await worktree(path));
    }
  }
  pairs.sort((x,y)=>x.path<y.path?-1:1);
  if (pairs.length===0) return options.exitCode?0:undefined;
  const scratch=await mkdtemp(join(tmpdir(),"bunproot-git-diff-"));
  let files;
  try {
    await mkdir(join(scratch,"a")); await mkdir(join(scratch,"b"));
    await materialize(join(scratch,"a"),pairs.map((p)=>({ path:p.path, ...p.left })));
    await materialize(join(scratch,"b"),pairs.map((p)=>({ path:p.path, ...p.right })));
    files=bunDiff(join(scratch,"a"),join(scratch,"b"),context);
  } finally { await rm(scratch,{ recursive:true, force:true }); }
  const byPath=new Map(pairs.map((p)=>[p.path,p]));
  const changes=files.map((file)=>({ ...file, ...byPath.get(file.path) })).filter((c)=>c.left||c.right);
  // A mode-only change has no patch but is still a change.
  for (const pair of pairs) if (!changes.some((c)=>c.path===pair.path) && pair.left && pair.right && pair.left.mode!==pair.right.mode) changes.push({ ...pair, status:"modified", linesAdded:0, linesRemoved:0 });
  changes.sort((x,y)=>x.path<y.path?-1:1);
  if (changes.length===0) return options.exitCode?0:undefined;
  if (options.nameOnly) { ctx.out(changes.map((c)=>c.path+"\n").join("")); return options.exitCode?1:undefined; }
  if (options.nameStatus) { ctx.out(changes.map((c)=>`${c.status==="added"?"A":c.status==="deleted"?"D":"M"}\t${c.path}\n`).join("")); return options.exitCode?1:undefined; }
  if (options.stat) {
    const rows=changes.map((c)=>({ path:c.path, insertions:c.linesAdded, deletions:c.linesRemoved, binary:c.binary, bytesBefore:c.bytesBefore, bytesAfter:c.bytesAfter }));
    ctx.out(statTable(rows)+statLine({ files:rows.length, insertions:rows.reduce((n,r)=>n+r.insertions,0), deletions:rows.reduce((n,r)=>n+r.deletions,0) }));
    return options.exitCode?1:undefined;
  }
  let text="";
  for (const c of changes) {
    const { left,right }=c;
    let header=`diff --git a/${c.path} b/${c.path}\n`;
    if (!left) header+=`new file mode ${right.mode}\n`;
    else if (!right) header+=`deleted file mode ${left.mode}\n`;
    else if (left.mode!==right.mode) header+=`old mode ${left.mode}\nnew mode ${right.mode}\n`;
    const same=left && right && left.oid===right.oid;
    if (!same) header+=`index ${short(left?.oid??"0".repeat(40))}..${short(right?.oid??"0".repeat(40))}${left && right && left.mode===right.mode?` ${left.mode}`:""}\n`;
    if (same) { text+=ctx.paint("bold",header.trimEnd()).replace(/\n/g,"\n")+"\n"; continue; }
    if (c.binary) { text+=ctx.paint("bold",header.trimEnd())+"\n"+`Binary files ${left?`a/${c.path}`:"/dev/null"} and ${right?`b/${c.path}`:"/dev/null"} differ\n`; continue; }
    header+=`--- ${left?`a/${c.path}`:"/dev/null"}\n+++ ${right?`b/${c.path}`:"/dev/null"}`;
    text+=header.split("\n").map((line)=>ctx.paint("bold",line)).join("\n")+"\n";
    text+=gitHunks(c.patch??"",left?Buffer.from(left.content).toString("latin1"):"",ctx);
  }
  ctx.out(text);
  return options.exitCode?1:undefined;
}

async function cherryPick(ctx,argv) {
  const { options,positional }=parse(argv,{ "no-commit":"noCommit", n:"noCommit", x:"record", e:"edit", "allow-empty":"allowEmpty" });
  if (positional.length!==1) throw new Error("this port cherry-picks exactly one commit at a time");
  const repo=await base(ctx);
  const oid=await revision(ctx,positional[0],"commit");
  const current=await branchName(ctx);
  const before=await head(ctx);
  const committer=await identity(ctx,"committer");
  const result=await git.cherryPick({ ...repo, ours:current, theirs:oid, committer, noCommit:!!options.noCommit });
  if (result.conflicts?.length) { for (const path of result.conflicts) ctx.out(`CONFLICT (content): Merge conflict in ${path}\n`); return 1; }
  await git.checkout({ ...repo, ref:current });
  if (result.oid) ctx.out(`[${current} ${short(result.oid)}] ${subject((await git.readCommit({ ...repo, oid:result.oid })).commit.message)}\n`+await commitSummary(ctx,result.oid,before));
}

async function revParse(ctx,argv) {
  const { options,positional }=parse(argv,{ "show-toplevel":"toplevel", "git-dir":"gitdir", "abbrev-ref":"abbrev", short:"short", "is-inside-work-tree":"inside", verify:"verify", q:"quiet", quiet:"quiet", "show-prefix":"prefix", "show-cdup":"cdup", "absolute-git-dir":"absoluteGitdir", "is-bare-repository":"bare", "symbolic-full-name":"fullName" });
  const repo=await base(ctx);
  if (options.toplevel) { ctx.out(`${repo.dir}\n`); return; }
  if (options.gitdir || options.absoluteGitdir) { ctx.out(`${relative(ctx.cwd,repo.gitdir)===".git"&&!options.absoluteGitdir?".git":repo.gitdir}\n`); return; }
  if (options.inside) { ctx.out("true\n"); return; }
  if (options.bare) { ctx.out("false\n"); return; }
  if (options.prefix) { const p=relative(repo.dir,ctx.cwd); ctx.out(p?`${p}/\n`:"\n"); return; }
  if (options.cdup) { const p=relative(ctx.cwd,repo.dir); ctx.out(p?`${p}/\n`:"\n"); return; }
  for (const spec of positional) {
    if (options.abbrev || options.fullName) {
      if (spec==="HEAD") { const name=await branchName(ctx); ctx.out(`${options.fullName?`refs/heads/${name}`:name??"HEAD"}\n`); continue; }
      const full=await git.expandRef({ ...repo, ref:spec });
      ctx.out(`${options.fullName?full:full.replace(/^refs\/(heads|tags)\//,"").replace(/^refs\/remotes\//,"")}\n`);
      continue;
    }
    const oid=await revision(ctx,spec);
    ctx.out(`${options.short?short(oid):oid}\n`);
  }
}

async function lsFiles(ctx,argv) {
  const { options,positional }=parse(argv,{ s:"stage", stage:"stage", c:"cached", cached:"cached", z:"nul", o:"others", others:"others", "exclude-standard":"excludeStandard" });
  const repo=await base(ctx);
  const filter=positional.length?await Promise.all(positional.map((p)=>ctx.pathspec(p))):[""];
  const keep=(f)=>filter.some((p)=>p==="" || f===p || f.startsWith(p+"/"));
  if (options.others) {
    const { untracked }=porcelainRows(await statusRows(ctx));
    for (const path of untracked.filter(keep).sort()) ctx.out(`${path}\n`);
    return;
  }
  const files=(await git.listFiles({ ...repo })).filter(keep).sort();
  if (!options.stage) { ctx.out(files.map((f)=>f+(options.nul?"\0":"\n")).join("")); return; }
  const entries=await git.walk({ ...repo, trees:[git.STAGE()], map:async (path,[entry])=>{
    if (path==="." || !entry || !keep(path)) return;
    if (await entry.type()!=="blob") return;
    return `${(await entry.mode()).toString(8)} ${await entry.oid()} 0\t${path}\n`;
  } });
  ctx.out(entries.sort().join(""));
}

async function showRef(ctx,argv) {
  const { options,positional }=parse(argv,{ heads:"heads", tags:"tags", "hash":"hash", s:"hash", d:"deref", dereference:"deref", verify:"verify", q:"quiet", quiet:"quiet" });
  const repo=await base(ctx);
  const wanted=[];
  if (options.heads || !options.tags) wanted.push("refs/heads/");
  if (options.tags || !options.heads) wanted.push("refs/tags/");
  if (!options.heads && !options.tags) wanted.push("refs/remotes/");
  const lines=[];
  for (const prefix of wanted) {
    const names=await git.listRefs({ ...repo, filepath:prefix.slice(0,-1) });
    for (const name of names) {
      const full=prefix+name;
      if (positional.length && !positional.some((p)=>full===p || full.endsWith("/"+p))) continue;
      const oid=await git.resolveRef({ ...repo, ref:full });
      lines.push(options.hash?`${oid}\n`:`${oid} ${full}\n`);
      if (options.deref && await peel(ctx,oid)!==oid) lines.push(`${await peel(ctx,oid)} ${full}^{}\n`);
    }
  }
  lines.sort((a,b)=>a.slice(41)<b.slice(41)?-1:1);
  ctx.out(lines.join(""));
  if (positional.length && lines.length===0) return 1;
}

async function lsRemote(ctx,argv) {
  const { options,positional }=parse(argv,{ h:"heads", heads:"heads", t:"tags", tags:"tags", refs:"refs", q:"quiet", quiet:"quiet", "get-url":"getUrl" });
  let target=positional[0];
  if (!target || !/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    const current=await branchName(ctx).catch(()=>undefined);
    target=await remoteUrl(ctx,target??await remoteOf(ctx,current));
  }
  if (options.getUrl) { ctx.out(`${target}\n`); return; }
  const refs=await git.listServerRefs({ ...network(ctx,options), url:target, symrefs:true, peelTags:true, protocolVersion:1 });
  const pattern=positional.slice(1);
  const keep=(ref)=>{
    if (options.heads && !ref.startsWith("refs/heads/")) return false;
    if (options.tags && !ref.startsWith("refs/tags/")) return false;
    if ((options.heads||options.tags||options.refs) && ref==="HEAD") return false;
    if (pattern.length && !pattern.some((p)=>ref===p || ref.endsWith("/"+p))) return false;
    return true;
  };
  const sorted=refs.filter((r)=>keep(r.ref)).sort((a,b)=>a.ref==="HEAD"?-1:b.ref==="HEAD"?1:a.ref<b.ref?-1:1);
  for (const { ref,oid,peeled } of sorted) {
    ctx.out(`${oid}\t${ref}\n`);
    if (peeled && !options.refs) ctx.out(`${peeled}\t${ref}^{}\n`);
  }
}

async function configCommand(ctx,argv) {
  const { options,positional }=parse(argv,{ get:"get", "get-all":"getAll", unset:"unset", "unset-all":"unsetAll", l:"listAll", list:"listAll", add:"add", global:"global", local:"local", system:"system", worktree:"local", bool:"bool", int:"int", "default":["fallback"], e:"edit", edit:"edit", "show-origin":"origin" });
  if (options.edit) throw new Error("this port has no editor; set values on the command line");
  const scope=options.global?"global":"local";
  const local=async ()=>base(ctx);
  if (options.listAll) {
    const lines=[];
    const dump=async (gitdir)=>{
      const text=await readFile(join(gitdir,"config"),"utf8").catch(()=>"");
      let section="";
      for (const raw of text.split("\n")) {
        const line=raw.trim();
        if (!line || line.startsWith("#") || line.startsWith(";")) continue;
        const header=/^\[([^\s"\]]+)(?:\s+"([^"]*)")?\]$/.exec(line);
        if (header) { section=header[2]!==undefined?`${header[1]}.${header[2]}`:header[1]; continue; }
        const equals=line.indexOf("=");
        const key=(equals<0?line:line.slice(0,equals)).trim().toLowerCase();
        const value=equals<0?"true":line.slice(equals+1).trim().replace(/^"(.*)"$/,"$1");
        lines.push(`${section}.${key}=${value}\n`);
      }
    };
    if (!options.local) await globalConfig((gitdir)=>dump(gitdir));
    if (!options.global) { try { await dump((await local()).gitdir); } catch (error) { if (options.local) throw error; } }
    ctx.out(lines.join(""));
    return;
  }
  const [path,value]=positional;
  if (!path) throw new Error("usage: git config [--global|--local] <name> [<value>] | --get <name> | --unset <name> | --list");
  const key=path.replace(/^([^.]+)\.(.*)\.([^.]+)$/,(m,s,sub,k)=>`${s}.${sub}.${k.toLowerCase()}`);
  if (options.unset || options.unsetAll) {
    if (scope==="global") await globalSet(key,undefined); else await git.setConfig({ ...await local(), path:key, value:undefined });
    return;
  }
  if (value!==undefined && !options.get && !options.getAll) {
    if (scope==="global") await globalSet(key,value,!!options.add); else await git.setConfig({ ...await local(), path:key, value, append:!!options.add });
    return;
  }
  let values;
  if (key in ctx.overrides && !options.global && !options.local) values=[ctx.overrides[key]];
  else if (options.global) values=await globalGet(key,true);
  else if (options.local) values=await git.getConfigAll({ ...await local(), path:key });
  else {
    values=[...await globalGet(key,true)];
    try { values.push(...await git.getConfigAll({ ...await local(), path:key })); } catch {}
  }
  values=values.filter((v)=>v!==undefined);
  if (values.length===0) { if (options.fallback!==undefined) { ctx.out(`${options.fallback}\n`); return; } return 1; }
  for (const item of options.getAll?values:[values.at(-1)]) ctx.out(`${item}\n`);
}

async function catFile(ctx,argv) {
  const { options,positional }=parse(argv,{ p:"pretty", t:"type", s:"size", e:"exists" });
  const repo=await base(ctx);
  if (positional.length!==1) throw new Error("usage: git cat-file (-t | -s | -e | -p) <object>");
  const oid=await revision(ctx,positional[0]);
  const object=await git.readObject({ ...repo, oid, format:"content" });
  if (options.exists) return;
  if (options.type) { ctx.out(`${object.type}\n`); return; }
  if (options.size) { ctx.out(`${object.object.length}\n`); return; }
  if (!options.pretty) throw new Error("usage: git cat-file (-t | -s | -e | -p) <object>");
  if (object.type==="tree") {
    const { tree }=await git.readTree({ ...repo, oid });
    for (const entry of tree) ctx.out(`${entry.mode.padStart(6,"0")} ${entry.type} ${entry.oid}\t${entry.path}\n`);
    return;
  }
  ctx.out(Buffer.from(object.object).toString(object.type==="blob"?"latin1":"utf8"));
}

async function hashObject(ctx,argv) {
  const { options,positional }=parse(argv,{ w:"write", stdin:"stdin", t:["type"] });
  const inputs=options.stdin?[await readFile("/dev/stdin")]:await Promise.all(positional.map((p)=>readFile(resolve(ctx.cwd,p))));
  for (const object of inputs) {
    if (options.write) ctx.out(`${await git.writeBlob({ ...await base(ctx), blob:new Uint8Array(object) })}\n`);
    else ctx.out(`${(await git.hashBlob({ object:new Uint8Array(object) })).oid}\n`);
  }
}

async function stash(ctx,argv) {
  const { options,positional }=parse(argv,{ m:["message",list], message:["message",list], q:"quiet", quiet:"quiet", "include-untracked":"untracked", u:"untracked" });
  const repo=await base(ctx);
  let [op="push",...rest]=positional;
  if (op==="save") { op="push"; if (rest.length) options.message=[rest.join(" ")]; }
  const refIdx=rest[0]?Number(/\{(\d+)\}/.exec(rest[0])?.[1]??rest[0]):0;
  if (!["push","pop","apply","drop","list","clear"].includes(op)) throw new Error(`unknown subcommand: ${op}`);
  if (op==="push" && !await config(ctx,"user.name")) {
    // stash signs its commits from the repository config alone.
    const author=await identity(ctx,"committer");
    await git.setConfig({ ...repo, path:"user.name", value:author.name });
    await git.setConfig({ ...repo, path:"user.email", value:author.email });
  }
  const before=await head(ctx);
  let dropped;
  if (op==="pop" || op==="drop") {
    const reflog=(await readFile(join(repo.gitdir,"logs","refs","stash"),"utf8").catch(()=>"")).split("\n").filter(Boolean).reverse();
    dropped=reflog[refIdx]?.split(" ")[1];
  }
  const result=await git.stash({ ...repo, op, message:options.message?.join("\n\n"), refIdx });
  if (op==="list") { for (const [index,line] of (result??[]).entries()) ctx.out(`stash@{${index}}: ${line.replace(/^\S+\s+/,"")}\n`); return; }
  if (options.quiet) return;
  if (op==="push") {
    const current=await branchName(ctx);
    ctx.out(`Saved working directory and index state ${options.message?.[0]?`On ${current}: ${options.message[0]}`:`WIP on ${current}: ${short(before)} ${subject((await git.readCommit({ ...repo, oid:before })).commit.message)}`}\n`);
  }
  if (op==="pop" || op==="apply") ctx.out(await statusText(ctx,{}));
  if (op==="pop" || op==="drop") ctx.out(`Dropped refs/stash@{${refIdx}} (${dropped})\n`);
}

async function version(ctx) {
  ctx.out(`git version 2.47.0.isomorphic-git.${VERSION} (bunproot)\n`);
}

// ---------------------------------------------------------------- table

export const commands={
  init:        { usage:"init [-q] [--bare] [-b <branch>] [<directory>]", run:init },
  clone:       { usage:"clone [--depth <n>] [-b <branch>] [--single-branch] [--no-tags] [-n] [-q] <repository> [<directory>]", run:clone },
  add:         { usage:"add [-A | -u] [-n] [-v] [--] <pathspec>...", run:add },
  rm:          { usage:"rm [--cached] [-r] [-q] [--] <pathspec>...", run:remove },
  mv:          { usage:"mv [-f] <source>... <destination>", run:move },
  commit:      { usage:"commit [-a] [-q] [--amend] [--allow-empty] [--author=<author>] [--date=<date>] (-m <msg> | -F <file>) [--] [<pathspec>...]", run:commit },
  status:      { usage:"status [-s | --porcelain] [-b] [--] [<pathspec>...]", run:status },
  log:         { usage:"log [-n <count>] [--oneline] [--format=<format>] [--reverse] [<revision>] [-- <path>]", run:log },
  branch:      { usage:"branch [-a | -r] | branch <name> [<start-point>] | branch (-d | -D | -m | -M | -u <upstream>) ... | branch --show-current", run:branch },
  checkout:    { usage:"checkout [-f] [-q] <branch> | checkout -b <new-branch> [<start-point>] | checkout [<tree-ish>] -- <pathspec>...", run:checkout },
  switch:      { usage:"switch [-f] [-q] <branch> | switch -c <new-branch> [<start-point>]", run:switchBranch },
  restore:     { usage:"restore [--staged] [--worktree] [--source=<tree-ish>] [--] <pathspec>...", run:restore },
  reset:       { usage:"reset [--soft | --mixed | --hard] [-q] [<commit>] | reset [<tree-ish>] [--] <pathspec>...", run:reset },
  tag:         { usage:"tag [-l [<pattern>]] | tag [-a] [-m <msg>] [-f] <tagname> [<commit>] | tag -d <tagname>...", run:tag },
  remote:      { usage:"remote [-v] | remote add <name> <url> | remote remove <name> | remote get-url <name> | remote set-url <name> <url>", run:remote },
  fetch:       { usage:"fetch [--depth <n>] [--tags] [-p] [-q] [--all] [<remote> [<branch>]]", run:fetch },
  pull:        { usage:"pull [--ff-only | --no-ff] [-q] [<remote> [<branch>]]", run:pull },
  push:        { usage:"push [-u] [-f] [-d] [--tags] [--all] [-q] [<remote> [<refspec>...]]", run:push },
  merge:       { usage:"merge [--no-ff | --ff-only] [-m <msg>] [--allow-unrelated-histories] <branch> | merge --abort", run:merge },
  diff:        { usage:"diff [--cached] [--stat | --name-only | --name-status] [-U<n>] [--exit-code] [<commit> [<commit>]] [--] [<path>...]", run:diff },
  "cherry-pick":{ usage:"cherry-pick [-n] <commit>", run:cherryPick },
  "rev-parse": { usage:"rev-parse [--short] [--abbrev-ref] [--verify] <revision>... | rev-parse --show-toplevel | --git-dir | --is-inside-work-tree | --show-prefix", run:revParse },
  "ls-files":  { usage:"ls-files [-s] [-o] [-z] [--] [<path>...]", run:lsFiles },
  "show-ref":  { usage:"show-ref [--heads] [--tags] [-d] [-s] [<pattern>...]", run:showRef },
  "ls-remote": { usage:"ls-remote [--heads] [--tags] [--refs] [<remote or url> [<pattern>...]]", run:lsRemote },
  config:      { usage:"config [--global | --local] <name> [<value>] | config --get <name> | config --unset <name> | config --list | config --add <name> <value>", run:configCommand },
  "cat-file":  { usage:"cat-file (-t | -s | -e | -p) <object>", run:catFile },
  "hash-object":{ usage:"hash-object [-w] [--stdin | <file>...]", run:hashObject },
  stash:       { usage:"stash [push [-m <msg>] | pop [<n>] | apply [<n>] | drop [<n>] | list | clear]", run:stash },
  version:     { usage:"version", run:version },
};
