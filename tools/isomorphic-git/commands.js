// The Git commands `bunproot --git` understands, each a thin wrapper around
// one or a few isomorphic-git calls, taking Git's own option names and
// printing what Git prints so that `alias git='bunx bunproot --git'` works
// for the everyday flow.  index.js finds the command in the table exported at
// the bottom and calls its `run(ctx,argv)`; nothing here parses global options.
import * as git from "isomorphic-git";
// isomorphic-git's own three-way line merger, from the locked tree.
import diff3Merge from "diff3";
import http from "isomorphic-git/http/web";
import fs from "node:fs";
import { chmod, copyFile, cp, lstat, mkdtemp, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir as osHomedir, tmpdir } from "node:os";
// Git honours $HOME as set, which Bun's os.homedir() does not follow.
const homedir=()=>process.env.HOME||process.env.USERPROFILE||osHomedir();
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { count, list, parse, parseClone, positiveDepth } from "./options.js";

const VERSION="1.41.9";
const EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904";
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
      const native=relative(dir,resolve(cwd,argument));
      if (isAbsolute(native)) throw new Error(`'${argument}' is outside repository at '${dir}'`);
      const path=native.split("\\").join("/");
      if (path.startsWith("../") || path==="..") throw new Error(`'${argument}' is outside repository at '${dir}'`);
      return path==="."?"":path;
    },
    // The repository-relative path as Git shows it from the current
    // directory: relative to it, with a directory's trailing slash kept.
    async display(path) {
      const prefix=await this.pathspec(".");
      if (!prefix) return path;
      const slash=path.endsWith("/")?"/":"";
      return posix.relative(prefix,path.slice(0,path.length-slash.length))+slash;
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
const readStdin=async ()=>Buffer.from(await Bun.stdin.arrayBuffer());

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
async function configAll(ctx,path) {
  if (path in ctx.overrides) return [ctx.overrides[path]];
  const values=[];
  try {
    const { gitdir }=await ctx.repo();
    values.push(...await git.getConfigAll({ fs, gitdir, path }));
  } catch {}
  if (values.length) return values;
  return globalGet(path,true);
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
async function statusRows(ctx,filepaths,ignored=false) {
  const repo=await base(ctx);
  const rows=await git.statusMatrix({ ...repo, filepaths:filepaths?.length?filepaths:undefined, ignored });
  return rows.filter(([path,h,w,s])=>!(h===1&&w===1&&s===1));
}

// -- a merge in progress: conflict stages in the index, and MERGE_HEAD.
// isomorphic-git keeps the conflict stages but exposes no API for them, and
// has no notion of MERGE_HEAD at all, so the index file is read directly and
// the state files are the port's own, in Git's layout.
async function indexEntries(ctx) {
  const repo=await base(ctx);
  let data;
  try { data=await readFile(join(repo.gitdir,"index")); } catch { return []; }
  const entries=[];
  if (data.length<12 || data.toString("latin1",0,4)!=="DIRC") return entries;
  const version=data.readUInt32BE(4), count=data.readUInt32BE(8);
  if (version!==2 && version!==3) return entries;
  let offset=12;
  for (let i=0; i<count && offset+62<=data.length; i++) {
    const flags=data.readUInt16BE(offset+60);
    const nameStart=offset+62+(version===3 && flags&0x4000?2:0);
    let nameLength=flags&0xfff;
    if (nameLength===0xfff) nameLength=data.indexOf(0,nameStart)-nameStart;
    entries.push({ path:data.toString("utf8",nameStart,nameStart+nameLength), mode:data.readUInt32BE(offset+24).toString(8),
      oid:data.toString("hex",offset+40,offset+60), stage:(flags>>12)&3 });
    offset+=Math.ceil((nameStart+nameLength+1-offset)/8)*8;
  }
  return entries;
}
async function unmergedPaths(ctx) {
  const stages=new Map();
  for (const { path,stage } of await indexEntries(ctx)) if (stage) stages.set(path,(stages.get(path)??new Set()).add(stage));
  return new Map([...stages].sort(([a],[b])=>a<b?-1:1));
}
// Git's two-letter code and long description for a set of conflict stages.
function unmergedKind(stages) {
  const key=[...stages].sort().join("");
  return { "123":["UU","both modified"], "12":["UD","deleted by them"], "13":["DU","deleted by us"],
    "23":["AA","both added"], "2":["AU","added by us"], "3":["UA","added by them"] }[key]??["UU","both modified"];
}
async function mergeHeads(ctx) {
  try { return (await readFile(join((await base(ctx)).gitdir,"MERGE_HEAD"),"utf8")).split("\n").filter(Boolean); } catch { return []; }
}
async function writeMergeState(ctx,theirs,message,conflicts) {
  const { gitdir }=await base(ctx);
  await writeFile(join(gitdir,"MERGE_HEAD"),`${theirs}\n`);
  await writeFile(join(gitdir,"MERGE_MODE"),"");
  await writeFile(join(gitdir,"MERGE_MSG"),`${message}\n\n# Conflicts:\n${conflicts.map((p)=>`#\t${p}\n`).join("")}`);
}
async function clearMergeState(ctx) {
  const { gitdir }=await base(ctx);
  for (const name of ["MERGE_HEAD","MERGE_MODE","MERGE_MSG","CHERRY_PICK_HEAD"]) await rm(join(gitdir,name),{ force:true });
}
async function cherryPickHead(ctx) {
  try { return (await readFile(join((await base(ctx)).gitdir,"CHERRY_PICK_HEAD"),"utf8")).trim()||undefined; } catch { return undefined; }
}
// Git refuses to commit or merge over unresolved conflicts, listing them.
async function refuseUnmerged(ctx,verb) {
  const unmerged=await unmergedPaths(ctx);
  if (unmerged.size===0) return;
  ctx.err(`error: ${verb} is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\n`);
  if (verb==="Committing") for (const path of unmerged.keys()) ctx.out(`U\t${path}\n`);
  throw new Error("Exiting because of an unresolved conflict.");
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
// "old => new" with the shared directory prefix and suffix outside the
// braces, the way Git's diffstat abbreviates a rename.
function renameLabel(a,b) {
  let pfx=0, i=0;
  while (i<a.length && i<b.length && a[i]===b[i]) { if (a[i]==="/") pfx=i+1; i++; }
  const at=(text,k)=>k<text.length?text[k]:"\0";
  const adjust=pfx?1:0;
  let sfx=0, ia=a.length, ib=b.length;
  while (pfx-adjust<=ia && pfx-adjust<=ib && at(a,ia)===at(b,ib)) { if (at(a,ia)==="/") sfx=a.length-ia; ia--; ib--; }
  const aMid=Math.max(0,a.length-pfx-sfx), bMid=Math.max(0,b.length-pfx-sfx);
  if (!(pfx+sfx)) return `${a} => ${b}`;
  return `${a.slice(0,pfx)}{${a.slice(pfx,pfx+aMid)} => ${b.slice(pfx,pfx+bMid)}}${a.slice(a.length-sfx)}`;
}
function statTable(changes) {
  const name=(c)=>c.renamed?renameLabel(c.renamed,c.path):c.path;
  const nameWidth=Math.max(...changes.map((c)=>name(c).length));
  const maxChange=Math.max(...changes.map((c)=>c.insertions+c.deletions));
  const numberWidth=Math.max(String(maxChange).length,changes.some((c)=>c.binary)?3:0);
  const graphWidth=Math.max(80-nameWidth-numberWidth-6,10);
  const scale=(n)=>maxChange>graphWidth?(n?1+Math.floor(n*(graphWidth-1)/maxChange):0):n;
  let text="";
  for (const c of changes) {
    if (c.binary) { text+=` ${name(c).padEnd(nameWidth)} | Bin ${c.bytesBefore} -> ${c.bytesAfter} bytes\n`; continue; }
    const total=c.insertions+c.deletions;
    const graph="+".repeat(scale(c.insertions))+"-".repeat(scale(c.deletions));
    text+=` ${name(c).padEnd(nameWidth)} | ${String(total).padStart(numberWidth)}${graph?` ${graph}`:""}\n`;
  }
  return text;
}
async function commitSummary(ctx,oid,parentOid,{ table=false }={}) {
  const changes=(await treeDiff(ctx,parentOid,oid)).sort((x,y)=>x.path<y.path?-1:1);
  if (changes.length===0) return "";
  const totals=await changeStats(ctx,changes);
  let text=(table?statTable(changes):"")+statLine(totals);
  for (const change of changes) {
    if (change.renamed) text+=` rename ${renameLabel(change.renamed,change.path)} (100%)\n`;
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
  // isomorphic-git stores JavaScript's minutes west of UTC; Git prints the
  // opposite direction (`getTimezoneOffset() === -480` is `+0800`). Preserve
  // negative zero because parseDate uses it to distinguish an explicit -0000.
  const sign=offset>0||Object.is(offset,-0)?"-":"+", minutes=Math.abs(offset);
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
  return format.replace(/%x([0-9a-fA-F]{2})|%(aD|aI|ai|ad|ae|an|at|cD|cI|ci|cd|ce|cn|ct|[HhTtPpsbBdDn%])/g,(whole,hex,key)=>hex?String.fromCharCode(parseInt(hex,16)):fields[key]);
}
function mediumCommit(ctx,{ oid,commit },names) {
  const decorated=names?decorate(ctx,names,oid):"";
  let text=ctx.paint("yellow",`commit ${oid}`)+decorated+"\n";
  if (commit.parent.length>1) text+=`Merge: ${commit.parent.map(short).join(" ")}\n`;
  text+=`Author: ${commit.author.name} <${commit.author.email}>\nDate:   ${gitDate(commit.author)}\n\n`;
  // Git expands tabs to 8-column stops in the formats that indent the message.
  const expand=(line)=>{ let out=""; for (const ch of line) out+=ch==="\t"?" ".repeat(8-out.length%8):ch; return out; };
  return text+commit.message.replace(/\n$/,"").split("\n").map((line)=>`    ${expand(line)}`).join("\n")+"\n";
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
function cleanEditedMessage(text) {
  return cleanMessage(text.split("\n").filter((line)=>!line.startsWith("#")).join("\n"));
}
async function editMessage(repo,initial="") {
  const file=join(repo.gitdir,"COMMIT_EDITMSG");
  await writeFile(file,initial||"\n# Please enter the commit message for your changes.\n");
  const editor=process.env.GIT_EDITOR||process.env.VISUAL||process.env.EDITOR;
  if (!editor) throw new Error("Terminal is dumb, but EDITOR unset");
  let cmd;
  if (process.platform==="win32") {
    const shell=process.env.ComSpec||process.env.COMSPEC||"cmd.exe";
    const quoted=file.replace(/"/g,'""');
    cmd=[shell,"/d","/s","/c",`${editor} \"${quoted}\"`];
  } else {
    const shell=process.env.SHELL||"/bin/sh";
    cmd=[shell,"-c",`${editor} \"$@\"`,"git-editor",file];
  }
  const result=Bun.spawnSync({ cmd, cwd:repo.dir, stdin:"inherit", stdout:"inherit", stderr:"inherit" });
  if (result.exitCode!==0) throw new Error(`There was a problem with the editor '${editor}'.`);
  return cleanEditedMessage(await readFile(file,"utf8"));
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
// Credentials, in Git's order: the environment (GIT_USERNAME/GIT_PASSWORD,
// then a GIT_TOKEN/GITHUB_TOKEN), a username in the URL, the configured
// credential.helper entries, and finally the `store` helper's file, which
// is what Git falls back to as well.  Interactive prompting is deliberately
// absent so a script never hangs.
export async function credentials(ctx,url) {
  const env=process.env;
  if (env.GIT_USERNAME || env.GIT_PASSWORD) return { username:env.GIT_USERNAME, password:env.GIT_PASSWORD };
  const token=env.GIT_TOKEN||env.GITHUB_TOKEN;
  if (token) return { username:"x-access-token", password:token };
  let parsed;
  try { parsed=new URL(url); } catch { return undefined; }
  const helpers=[...await configAll(ctx,`credential.${parsed.protocol}//${parsed.host}.helper`),...await configAll(ctx,"credential.helper")];
  for (const helper of helpers) {
    const found=await runCredentialHelper(helper,parsed);
    if (found) return found;
  }
  return storedCredential(parsed);
}
// One credential.helper value, given the `get` operation the way Git gives
// it: a shell command after `!`, a path, `store [--file=<path>]`, or a
// git-credential-<name> program on PATH.  `cache` needs Git's own daemon.
async function runCredentialHelper(helper,parsed) {
  const [name,...args]=helper.trim().split(/\s+/);
  if (name==="" || name==="cache") return undefined;
  if (name==="store") {
    const file=args.find((a)=>a.startsWith("--file="))?.slice(7);
    return storedCredential(parsed,file&&resolve(file.replace(/^~(?=\/|$)/,homedir())));
  }
  let cmd;
  if (helper.trim().startsWith("!")) {
    const shell=helper.trim().slice(1);
    cmd=process.platform==="win32"?[process.env.ComSpec||"cmd.exe","/d","/s","/c",`${shell} get`]:[process.env.SHELL||"/bin/sh","-c",`${shell} "$@"`,"git-credential","get"];
  } else {
    const program=isAbsolute(name)?name:Bun.which(`git-credential-${name}`)||Bun.which(name.startsWith("git-credential-")?name:`git-credential-${name}`);
    if (!program) return undefined;
    cmd=[program,...args,"get"];
  }
  const input=`protocol=${parsed.protocol.replace(/:$/,"")}\nhost=${parsed.host}\n${parsed.pathname.length>1?`path=${parsed.pathname.slice(1)}\n`:""}${parsed.username?`username=${decodeURIComponent(parsed.username)}\n`:""}\n`;
  let result;
  try { result=Bun.spawnSync({ cmd, stdin:Buffer.from(input), stdout:"pipe", stderr:"pipe", env:{ ...process.env, GIT_TERMINAL_PROMPT:"0" }, timeout:30000 }); }
  catch { return undefined; }
  if (result.exitCode!==0) return undefined;
  const reply={};
  for (const line of result.stdout.toString().split("\n")) {
    const equals=line.indexOf("=");
    if (equals>0) reply[line.slice(0,equals)]=line.slice(equals+1);
  }
  return reply.password?{ username:reply.username??decodeURIComponent(parsed.username), password:reply.password }:undefined;
}
// The `store` helper's file: ~/.git-credentials, then the XDG one.
function storedCredential(parsed,file) {
  const files=file?[file]:[join(homedir(),".git-credentials"),join(process.env.XDG_CONFIG_HOME||join(homedir(),".config"),"git","credentials")];
  for (const candidate of files) {
    let text;
    try { text=fs.readFileSync(candidate,"utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      try {
        const saved=new URL(line.trim());
        if (saved.host===parsed.host && saved.protocol===parsed.protocol && saved.username && (!parsed.username || decodeURIComponent(saved.username)===decodeURIComponent(parsed.username)))
          return { username:decodeURIComponent(saved.username), password:decodeURIComponent(saved.password) };
      } catch {}
    }
  }
  return undefined;
}
// Git's report when a credential was rejected -- or, where Git would have
// prompted, when none was found, with where this port had looked.
function authenticationFailed(url,{ none=false }={}) {
  const shown=url.replace(/\/?$/,"/");
  const error=new Error(`Authentication failed for '${shown}'`);
  if (none) error.hint="no credential found and this port never prompts: set GIT_TOKEN/GITHUB_TOKEN or GIT_USERNAME/GIT_PASSWORD, configure credential.helper (store, or a program such as `!gh auth git-credential`), or add a line to ~/.git-credentials";
  return error;
}
// The repository URL of the last request, for Git's wording of a failure.
let lastUrl;
export function httpFailure(error) {
  if (error.code!=="HttpError" || !lastUrl) return undefined;
  const { statusCode }=error.data;
  const shown=lastUrl.replace(/\/(info\/refs.*|git-(upload|receive)-pack)$/,"").replace(/\/?$/,"/");
  if (statusCode===401) return authenticationFailed(shown).message;
  return `unable to access '${shown}': The requested URL returned error: ${statusCode}`;
}
function network(ctx,options={}) {
  return {
    http:{ request:(request)=>{ lastUrl=request.url; return http.request(request); } },
    // No credential at all is where Git would prompt; this port reports the
    // failure instead.  A rejected credential is reported the same way.
    onAuth:async (target)=>{ const found=await credentials(ctx,target); if (!found) throw authenticationFailed(target,{ none:true }); return found; },
    onAuthFailure:(target)=>{ throw authenticationFailed(target); },
    // The server's sideband chatter is progress: Git shows it only on a
    // terminal, or with --progress.
    onMessage:options.quiet || (!options.progress && !process.stderr.isTTY)?undefined:(message)=>ctx.err(`remote: ${message}`),
    headers:{ "User-Agent":`git/isogit-${VERSION}` },
  };
}

// The URL as Git's fetch and pull print it after "From": no trailing .git or /.
const shownUrl=(url)=>url.replace(/\/?(\.git)?\/?$/,"");

// ---------------------------------------------------------------- commands

// isomorphic-git writes the core settings a browser wants; on a Linux host
// the repository is shared with the system git, so use its defaults.
async function nativeConfig(gitdir) {
  if (process.platform==="win32") {
    await git.setConfig({ fs, gitdir, path:"core.filemode", value:"false" });
    await git.setConfig({ fs, gitdir, path:"core.symlinks", value:"false" });
    await git.setConfig({ fs, gitdir, path:"core.ignorecase", value:"true" });
  } else {
    await git.setConfig({ fs, gitdir, path:"core.filemode", value:"true" });
    for (const path of ["core.symlinks","core.ignorecase"]) await git.setConfig({ fs, gitdir, path, value:undefined });
  }
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
  if (options.since!==undefined) options.since=new Date(parseDate(options.since).timestamp*1000);
  if (!options.quiet) ctx.err(`Cloning into '${relative(ctx.cwd,options.dir)||"."}'...\n`);
  const { quiet,...cloneOptions }=options;
  const localUrl=options.url.startsWith("file://")?fileURLToPath(options.url):!/^\w+(?::\/\/|::)/.test(options.url)&&!/^\w+@[^:]+:/.test(options.url)?options.url:null;
  if (localUrl!==null) return cloneLocal(ctx,{ ...cloneOptions, url:options.url, source:resolve(ctx.cwd,localUrl) });
  await git.clone({ fs, ...network(ctx,options), ...cloneOptions });
  await nativeConfig(join(options.dir,".git"));
}

async function cloneLocal(ctx,{ source,dir,url,remote="origin",ref,singleBranch,noCheckout,noTags }) {
  const sourceGitdir=fs.existsSync(join(source,".git"))?join(source,".git"):source;
  if (!fs.existsSync(join(sourceGitdir,"HEAD"))) throw new Error(`repository '${url}' does not exist`);
  if (fs.existsSync(dir) && (await fs.promises.readdir(dir)).length) throw new Error(`destination path '${basename(dir)}' already exists and is not an empty directory.`);
  await mkdir(dir,{ recursive:true });
  const gitdir=join(dir,".git");
  await git.init({ fs, dir, gitdir, defaultBranch:"master" });
  await cp(join(sourceGitdir,"objects"),join(gitdir,"objects"),{ recursive:true, force:true });
  const sourceRepo={ fs, gitdir:sourceGitdir, dir:source };
  const sourceHead=(await readFile(join(sourceGitdir,"HEAD"),"utf8")).trim();
  const symbolic=/^ref: refs\/heads\/(.+)$/.exec(sourceHead);
  const branches=await git.listBranches(sourceRepo);
  const branch=ref??symbolic?.[1]??branches[0];
  if (!branch || !branches.includes(branch)) throw new Error(`Remote branch ${branch} not found in upstream ${remote}`);
  for (const name of singleBranch?[branch]:branches) {
    const oid=await git.resolveRef({ ...sourceRepo, ref:`refs/heads/${name}` });
    await git.writeRef({ fs, gitdir, ref:`refs/remotes/${remote}/${name}`, value:oid, force:true });
  }
  await mkdir(join(gitdir,"refs","remotes",remote),{ recursive:true });
  await writeFile(join(gitdir,"refs","remotes",remote,"HEAD"),`ref: refs/remotes/${remote}/${branch}\n`);
  if (!noTags) for (const name of await git.listTags(sourceRepo)) {
    const oid=await git.resolveRef({ ...sourceRepo, ref:`refs/tags/${name}` });
    await git.writeRef({ fs, gitdir, ref:`refs/tags/${name}`, value:oid, force:true });
  }
  const oid=await git.resolveRef({ ...sourceRepo, ref:`refs/heads/${branch}` });
  await git.writeRef({ fs, gitdir, ref:`refs/heads/${branch}`, value:oid, force:true });
  await git.setConfig({ fs, gitdir, path:`remote.${remote}.url`, value:url });
  await git.setConfig({ fs, gitdir, path:`remote.${remote}.fetch`, value:`+refs/heads/*:refs/remotes/${remote}/*` });
  await git.setConfig({ fs, gitdir, path:`branch.${branch}.remote`, value:remote });
  await git.setConfig({ fs, gitdir, path:`branch.${branch}.merge`, value:`refs/heads/${branch}` });
  await writeFile(join(gitdir,"HEAD"),`ref: refs/heads/${branch}\n`);
  if (!noCheckout) await git.checkout({ fs, dir, gitdir, ref:branch, force:true });
  await nativeConfig(gitdir);
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
    "allow-empty-message":"allowEmptyMessage", v:"verbose", verbose:"verbose", "reset-author":"resetAuthor",
  });
  const repo=await base(ctx);
  // -a stages every tracked change; named paths stage those paths' changes.
  if (options.all || positional.length) {
    const filepaths=await Promise.all(positional.map((p)=>ctx.pathspec(p)));
    await stageRows(ctx,await statusRows(ctx,filepaths.filter(Boolean)),{ trackedOnly:true });
  }
  await refuseUnmerged(ctx,"Committing");
  // Concluding a merge: MERGE_HEAD supplies the other parents and MERGE_MSG
  // the message, which --no-edit takes as it is, comments included.
  const mergeParents=options.amend?[]:await mergeHeads(ctx);
  const picking=options.amend?undefined:await cherryPickHead(ctx);
  const picked=picking?(await git.readCommit({ ...repo, oid:picking })).commit:undefined;
  let message;
  if (options.message) message=cleanMessage(options.message.join("\n\n"));
  else if (options.file) message=cleanMessage(options.file==="-"?(await readStdin()).toString("utf8"):await readFile(resolve(ctx.cwd,options.file),"utf8"));
  else if (picked) message=options.noEdit?picked.message:await editMessage(repo,picked.message);
  else if (mergeParents.length) {
    const initial=await readFile(join(repo.gitdir,"MERGE_MSG"),"utf8").catch(()=>"");
    message=options.noEdit?initial.replace(/\n*$/,"\n"):await editMessage(repo,initial);
  }
  else {
    let initial="";
    if (options.amend && await head(ctx)) initial=(await git.readCommit({ ...repo, oid:await head(ctx) })).commit.message;
    message=options.noEdit&&options.amend?cleanMessage(initial):await editMessage(repo,initial);
  }
  if (message==="\n" && !options.allowEmptyMessage) throw new Error("Aborting commit due to empty commit message.");
  const before=await head(ctx);
  const branch=await branchName(ctx);
  // --amend starts from the original author; --author and --date replace
  // only the name/email or the date, and --reset-author all of it.
  let author=await identity(ctx,"author",{ date:options.date, literal:options.author });
  if (picked && !options.resetAuthor && !options.author && !options.date) author=picked.author;
  if (options.amend && before && !options.resetAuthor) {
    const original=(await git.readCommit({ ...repo, oid:before })).commit.author;
    author={ ...original, ...(options.author?{ name:author.name, email:author.email }:{}),
      ...(options.date?{ timestamp:author.timestamp, timezoneOffset:author.timezoneOffset }:{}) };
  }
  const committer=await identity(ctx,"committer");
  let oid;
  try {
    oid=await git.commit({ ...repo, message, author, committer, amend:!!options.amend, disallowEmpty:!options.allowEmpty && !options.amend && !mergeParents.length,
      ...(mergeParents.length?{ parent:[before,...mergeParents] }:{}) });
  } catch (error) {
    if (error.code!=="EmptyCommitError") throw error;
    // Git shows the status and exits 1 when there is nothing to commit.
    ctx.out(await statusText(ctx,{}));
    return 1;
  }
  if (mergeParents.length || picked) await clearMergeState(ctx);
  if (options.quiet) return;
  const parent=options.amend&&before?(await git.readCommit({ ...repo, oid:before })).commit.parent[0]:before;
  const label=branch?branch:"detached HEAD";
  const root=!before?" (root-commit)":"";
  const written=(await git.readCommit({ ...repo, oid })).commit;
  let text=`[${label}${root} ${short(oid)}] ${subject(written.message)}\n`;
  if (written.author.name!==written.committer.name || written.author.email!==written.committer.email)
    text+=` Author: ${written.author.name} <${written.author.email}>\n`;
  if (options.date || picked || (options.amend && !options.resetAuthor)) text+=` Date: ${gitDate(written.author)}\n`;
  // A merge commit gets no diffstat.
  ctx.out(text+(mergeParents.length?"":await commitSummary(ctx,oid,parent)));
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
async function statusParts(ctx,filepaths,includeIgnored=false) {
  const repo=await base(ctx);
  const rows=await statusRows(ctx,filepaths);
  const unmerged=await unmergedPaths(ctx);
  const { tracked,untracked }=porcelainRows(rows.filter(([path])=>!unmerged.has(path)));
  const all=(await git.listFiles({ ...repo }));
  const paired=await pairRenames(ctx,tracked.filter((r)=>r.x!==" "));
  const shown=tracked.filter((r)=>r.x===" " || paired.includes(r)).sort((a,b)=>a.path<b.path?-1:1);
  for (const row of shown) if (row.renamedFrom) row.x="R";
  for (const [path,stages] of unmerged) {
    if (filepaths?.length && !filepaths.some((p)=>p==="" || path===p || path.startsWith(p+"/"))) continue;
    const [code,kind]=unmergedKind(stages);
    shown.push({ path, x:code[0], y:code[1], unmerged:kind });
  }
  shown.sort((a,b)=>a.path<b.path?-1:1);
  let ignored=[];
  if (includeIgnored) {
    const visible=new Set((await statusRows(ctx,filepaths,true)).map(([path])=>path));
    for (const [path] of rows) visible.delete(path);
    for (const path of visible) if (path===".git" || path.startsWith(".git/")) visible.delete(path);
    ignored=collapse([...visible],all);
  }
  return { tracked:shown, untracked:collapse(untracked,all), ignored, rows, merging:(await mergeHeads(ctx)).length>0 };
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
  let { tracked,untracked,ignored,merging }=await statusParts(ctx,filepaths,options.ignored);
  // Only --porcelain keeps repository-relative paths; the human forms show
  // them relative to the current directory.
  if (!options.porcelain) {
    for (const row of tracked) { row.path=await ctx.display(row.path); if (row.renamedFrom) row.renamedFrom=await ctx.display(row.renamedFrom); }
    untracked=await Promise.all(untracked.map((p)=>ctx.display(p)));
    ignored=await Promise.all(ignored.map((p)=>ctx.display(p)));
  }
  const state=await upstreamState(ctx,branch,commitOid);
  const conflicts=tracked.filter((r)=>r.unmerged);
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
    for (const { path,x,y,renamedFrom,unmerged } of tracked)
      text+=unmerged?`${ctx.paint("red",x+y)} ${path}\n`:`${x===" "?x:ctx.paint("green",x)}${y===" "?y:ctx.paint("red",y)} ${renamedFrom?`${renamedFrom} -> `:""}${path}\n`;
    for (const path of untracked) text+=`${ctx.paint("red","??")} ${path}\n`;
    for (const path of ignored) text+=`${ctx.paint("red","!!")} ${path}\n`;
    return text;
  }
  const staged=tracked.filter((r)=>r.x!==" " && !r.unmerged), unstaged=tracked.filter((r)=>r.y!==" " && !r.unmerged);
  let text=(branch?`On branch ${branch}\n`:`${ctx.paint("red","HEAD detached at ")}${short(commitOid)}\n`)+upstreamHeader(state);
  if (conflicts.length) text+=`You have unmerged paths.\n  (fix conflicts and run "git commit")\n  (use "git merge --abort" to abort the merge)\n\n`;
  else if (merging) text+=`All conflicts fixed but you are still merging.\n  (use "git commit" to conclude merge)\n\n`;
  if (!commitOid) text+="\nNo commits yet\n\n";
  const label=(word)=>(word+":").padEnd(12);
  const shownStaged=staged;
  if (shownStaged.length) {
    text+=`Changes to be committed:\n`+(merging?"":`  (use "git ${commitOid?"restore --staged":"rm --cached"} <file>..." to unstage)\n`);
    for (const r of shownStaged) {
      if (r.renamedFrom) text+=`\t${ctx.paint("green",`${label("renamed")}${r.renamedFrom} -> ${r.path}`)}\n`;
      else text+=`\t${ctx.paint("green",`${label(r.x==="A"?"new file":r.x==="D"?"deleted":"modified")}${r.path}`)}\n`;
    }
    text+="\n";
  }
  if (conflicts.length) {
    const deletions=conflicts.some((r)=>r.unmerged.startsWith("deleted"));
    text+=`Unmerged paths:\n  (use "git add${deletions?"/rm":""} <file>..."${deletions?" as appropriate":""} to mark resolution)\n`;
    for (const r of conflicts) text+=`\t${ctx.paint("red",`${(r.unmerged+":").padEnd(17)}${r.path}`)}\n`;
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
  if (ignored.length) {
    text+=`Ignored files:\n  (use "git add -f <file>..." to include in what will be committed)\n`;
    for (const path of ignored) text+=`\t${ctx.paint("red",path)}\n`;
    text+="\n";
  }
  if (shownStaged.length) return text;
  if (unstaged.length || conflicts.length) return text+`no changes added to commit (use "git add" and/or "git commit -a")\n`;
  if (untracked.length) return text+`nothing added to commit but untracked files present (use "git add" to track)\n`;
  return text+(commitOid?"nothing to commit, working tree clean\n":`nothing to commit (create/copy files and use "git add" to track)\n`);
}
async function status(ctx,argv) {
  const { options,positional }=parse(argv,{ s:"short", short:"short", porcelain:"porcelain", b:"branch", branch:"branch", u:"untracked", "untracked-files":["untrackedFiles"], ignored:"ignored", long:"long", color:"color", "no-color":"noColor" });
  if (options.color) ctx.colour=true;
  if (options.noColor || options.porcelain) ctx.colour=false;
  const filepaths=await Promise.all(positional.map((p)=>ctx.pathspec(p)));
  ctx.out(await statusText(ctx,options,filepaths.filter(Boolean)));
}

async function log(ctx,argv) {
  const parsed=parse(argv,{
    n:["maxCount",count], "max-count":["maxCount",count], "<n>":["maxCount",count],
    oneline:"oneline", format:["format"], pretty:["format"], reverse:"reverse",
    "no-decorate":"noDecorate", decorate:["decorate",null,true], "first-parent":"firstParent", all:"all", since:["since"], follow:"follow", color:"color", "no-color":"noColor", "no-pager":"noPager",
  });
  const { options,positional }=parsed;
  if (options.color) ctx.colour=true;
  if (options.noColor) ctx.colour=false;
  const repo=await base(ctx);
  const paths=parsed.paths??[];
  let refs=positional.slice(0,positional.length-paths.length);
  if (paths.length===0 && refs.length>1) throw new Error("this port takes one revision and optionally one path after --");
  if (paths.length>1) throw new Error("this port follows at most one path");
  // A..B is what B reaches and A does not; A...B what only one of them does.
  let exclude=[], symmetric;
  if (refs[0]?.includes("..")) {
    const [a,b]=refs[0].split(/\.\.\.?/).map((r)=>r||"HEAD");
    symmetric=refs[0].includes("...")?await revision(ctx,a,"commit"):undefined;
    exclude=[await revision(ctx,a,"commit")];
    refs=[b];
  }
  const ref=refs[0]?await revision(ctx,refs[0]):await head(ctx);
  if (!ref && !options.all) throw new Error(`your current branch '${await branchName(ctx)}' does not have any commits yet`);
  const filepath=paths[0]?await ctx.pathspec(paths[0]):undefined;
  if (options.follow && !filepath) throw new Error("--follow requires exactly one path after --");
  let since;
  if (options.since!==undefined) since=new Date(parseDate(options.since).timestamp*1000);
  let commits;
  if (options.all) {
    const tips=[];
    for (const name of await git.listRefs({ ...repo, filepath:"refs" })) {
      try { tips.push(await revision(ctx,`refs/${name}`,"commit")); } catch {}
    }
    const entries=(await Promise.all([...new Set(tips)].map((tip)=>git.log({ ...repo, ref:tip, filepath, since, follow:!!options.follow, force:true })))).flat();
    commits=[...new Map(entries.map((entry)=>[entry.oid,entry])).values()].sort((a,b)=>b.commit.committer.timestamp-a.commit.committer.timestamp||a.oid.localeCompare(b.oid));
  } else commits=await git.log({ ...repo, ref, depth:filepath||exclude.length?undefined:options.maxCount, filepath, since, follow:!!options.follow, force:true });
  if (exclude.length) {
    const reachable=async (tip)=>new Set((await git.log({ ...repo, ref:tip, force:true })).map((c)=>c.oid));
    const left=await reachable(exclude[0]);
    if (symmetric) {
      const right=await reachable(ref);
      const only=(await git.log({ ...repo, ref:symmetric, filepath, since, force:true })).filter((c)=>!right.has(c.oid));
      commits=[...commits.filter((c)=>!left.has(c.oid)),...only].sort((a,b)=>b.commit.committer.timestamp-a.commit.committer.timestamp||a.oid.localeCompare(b.oid));
    } else commits=commits.filter((c)=>!left.has(c.oid));
  }
  if (options.maxCount!==undefined) commits=commits.slice(0,options.maxCount);
  if (options.reverse) commits.reverse();
  let format=options.format;
  // `format:` separates commits with a newline where `tformat:` (and
  // --format) terminates each one with it.
  const separator=format?.startsWith("format:")?"\n":"";
  if (format?.startsWith("format:") || format?.startsWith("tformat:")) format=format.slice(format.indexOf(":")+1);
  else if (format!==undefined && !format.includes("%") && ["medium","short","full","fuller","raw"].includes(format)) format=undefined;
  // log.decorate=auto: decorations appear on a terminal, or when asked for.
  const decorateWanted=options.decorate!==undefined?options.decorate!=="no":!options.noDecorate && ctx.decorate;
  const oneline=options.oneline || format==="oneline";
  if (format!==undefined && !oneline) {
    const names=/%[dD]/.test(format)?await decorations(ctx):undefined;
    if (separator) ctx.out(commits.map((entry)=>formatCommit(format,entry,names,ctx)).join(separator));
    else for (const entry of commits) ctx.out(formatCommit(format,entry,names,ctx)+"\n");
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

async function checkIgnore(ctx,argv) {
  const { options,positional }=parse(argv,{ q:"quiet", quiet:"quiet", "no-index":"noIndex" });
  if (positional.length===0) throw new Error("no path specified");
  const repo=await base(ctx);
  const tracked=options.noIndex?new Set():new Set(await git.listFiles({ ...repo }));
  let matched=false;
  for (const argument of positional) {
    const filepath=await ctx.pathspec(argument);
    if (!filepath || tracked.has(filepath)) continue;
    if (await git.isIgnored({ ...repo, filepath })) {
      matched=true;
      if (!options.quiet) ctx.out(`${argument}\n`);
    }
  }
  return matched?0:1;
}

async function mergeBase(ctx,argv) {
  const { options,positional }=parse(argv,{ "is-ancestor":"isAncestor", a:"all", all:"all", "octopus":"octopus" });
  if (options.octopus) throw new Error("--octopus is not available in this port");
  if (options.isAncestor) {
    if (positional.length!==2) throw new Error("--is-ancestor takes exactly two commits");
    const [ancestor,oid]=await Promise.all(positional.map((ref)=>revision(ctx,ref,"commit")));
    return await git.isDescendent({ ...await base(ctx), oid, ancestor })?0:1;
  }
  if (positional.length<2) throw new Error("need two or more commits");
  const oids=await Promise.all(positional.map((ref)=>revision(ctx,ref,"commit")));
  const bases=await git.findMergeBase({ ...await base(ctx), oids });
  for (const oid of options.all?bases:bases.slice(0,1)) ctx.out(`${oid}\n`);
  return bases.length?0:1;
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

// After switching branches Git lists the local changes it carried across,
// as diff-index --name-status against the new HEAD would -- except for a
// new branch made at the same commit, where nothing had to move.
async function carriedChanges(ctx) {
  const { tracked }=porcelainRows(await statusRows(ctx));
  return tracked.sort((a,b)=>a.path<b.path?-1:1).map(({ path,x,y })=>`${x==="A"?"A":x==="D"||y==="D"?"D":"M"}\t${path}\n`).join("");
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
    const moved=await switchTo(ctx,{ branch:create, force:options.force });
    if (!options.quiet) { if (moved) ctx.out(await carriedChanges(ctx)); ctx.err(`Switched to a new branch '${create}'\n`); }
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
    await switchTo(ctx,{ branch:target, force:options.force });
    if (!options.quiet) { ctx.out(await carriedChanges(ctx)); ctx.err(`Switched to branch '${target}'\n`); }
    return;
  }
  for (const { remote } of await git.listRemotes({ ...repo })) {
    if ((await git.listBranches({ ...repo, remote })).includes(target)) {
      const oid=await git.resolveRef({ ...repo, ref:`refs/remotes/${remote}/${target}` });
      await git.branch({ ...repo, ref:target, object:oid, checkout:false });
      await git.setConfig({ ...repo, path:`branch.${target}.remote`, value:remote });
      await git.setConfig({ ...repo, path:`branch.${target}.merge`, value:`refs/heads/${target}` });
      await switchTo(ctx,{ branch:target, force:options.force });
      if (!options.quiet) { ctx.out(await carriedChanges(ctx)); ctx.err(`branch '${target}' set up to track '${remote}/${target}'.\nSwitched to a new branch '${target}'\n`); }
      return;
    }
  }
  const oid=await revision(ctx,target,"commit");
  await switchTo(ctx,{ oid, force:options.force });
  if (!options.quiet) { ctx.out(await carriedChanges(ctx)); ctx.err(`Note: switching to '${target}'.\nHEAD is now at ${short(oid)} ${subject((await git.readCommit({ ...repo, oid })).commit.message)}\n`); }
}

// Moving HEAD to a branch or a commit.  isomorphic-git's checkout rewrites
// the index and worktree from the target tree, which throws staged changes
// away; Git carries local changes across and only touches the paths the two
// commits differ in, refusing when one of those has local changes.  --force
// discards them the way Git does.
async function switchTo(ctx,{ branch,oid,force }) {
  const repo=await base(ctx);
  const before=await head(ctx);
  const after=oid??await git.resolveRef({ ...repo, ref:`refs/heads/${branch}` });
  if (force) { await git.checkout({ ...repo, ref:branch??after, force:true }); return before!==after; }
  if (before!==after) {
    const changes=await treeDiff(ctx,before,after);
    const touched=new Set(changes.flatMap((c)=>c.renamed?[c.renamed,c.path]:[c.path]));
    const { tracked,untracked }=porcelainRows(await statusRows(ctx));
    const overwritten=tracked.filter((r)=>touched.has(r.path)).map((r)=>r.path);
    if (overwritten.length) throw failure(`Your local changes to the following files would be overwritten by checkout:\n${overwritten.map((p)=>`\t${p}\n`).join("")}Please commit your changes or stash them before you switch branches.\nAborting`);
    const clobbered=untracked.filter((p)=>changes.some((c)=>c.oidB && !c.oidA && c.path===p));
    if (clobbered.length) throw failure(`The following untracked working tree files would be overwritten by checkout:\n${clobbered.map((p)=>`\t${p}\n`).join("")}Please move or remove them before you switch branches.\nAborting`);
    await applyTree(ctx,before,after);
  }
  if (branch) await git.writeRef({ ...repo, ref:"HEAD", value:`refs/heads/${branch}`, symbolic:true, force:true });
  else await git.writeRef({ ...repo, ref:"HEAD", value:after, force:true });
  return before!==after;
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
    if (mode===0o120000 && process.platform!=="win32") { await rm(target,{ force:true }); await symlink(Buffer.from(blob).toString(),target); continue; }
    await writeFile(target,blob,{ mode:mode===0o100755?0o755:0o644 });
    if (process.platform!=="win32") await chmod(target,mode===0o100755?0o755:0o644);
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
      ctx.out(`Deleted tag '${name}' (was ${short(oid)})\n`);
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
  const { options,positional }=parse(argv,{ depth:["depth",positiveDepth], deepen:["deepen",positiveDepth], "shallow-since":["since"], "shallow-exclude":["exclude",list], tags:"tags", "no-tags":"noTags", p:"prune", prune:"prune", q:"quiet", quiet:"quiet", all:"all", v:"verbose", "prune-tags":"pruneTags", f:"force", force:"force", u:"update", progress:"progress" });
  if (options.deepen!==undefined) { options.depth=options.deepen; options.relative=true; }
  if (options.since!==undefined) options.since=new Date(parseDate(options.since).timestamp*1000);
  const repo=await base(ctx);
  const current=await branchName(ctx);
  const remotes=options.all?(await git.listRemotes({ ...repo })).map((r)=>r.remote):[positional[0]??await remoteOf(ctx,current)];
  // What Git reports: each remote-tracking ref and tag the fetch changed.
  const snapshot=async (remote)=>{
    const refs=new Map();
    for (const prefix of [`refs/remotes/${remote}`,"refs/tags"]) {
      for (const name of await git.listRefs({ ...repo, filepath:prefix }).catch(()=>[]))
        if (name!=="HEAD") refs.set(`${prefix}/${name}`,await git.resolveRef({ ...repo, ref:`${prefix}/${name}` }).catch(()=>undefined));
    }
    return refs;
  };
  for (const remote of remotes) {
    const url=await remoteUrl(ctx,remote);
    if (options.all && !options.quiet) ctx.err(`Fetching ${remote}\n`);
    const was=await snapshot(remote);
    // isomorphic-git rewrites refs/remotes/<remote>/HEAD on every full fetch.
    // Git 2.48 creates it when missing and otherwise leaves it alone, under
    // remote.<remote>.followRemoteHEAD: create (the default), warn, always
    // or never.
    const follow=(await config(ctx,`remote.${remote}.followRemoteHEAD`))??"create";
    const remoteHead=join(repo.gitdir,"refs","remotes",remote,"HEAD");
    const before=await readFile(remoteHead,"utf8").catch(()=>undefined);
    const result=await git.fetch({ ...repo, ...network(ctx,options), remote, ref:positional[1], singleBranch:!!positional[1], depth:options.depth, since:options.since, exclude:options.exclude, relative:!!options.relative, tags:!!options.tags, prune:!!options.prune, pruneTags:!!options.pruneTags });
    const after=await readFile(remoteHead,"utf8").catch(()=>undefined);
    if (follow==="never" || (follow!=="always" && before!==undefined)) {
      if (before===undefined) await rm(remoteHead,{ force:true }); else if (after!==before) await writeFile(remoteHead,before);
      if (follow.startsWith("warn") && before!==undefined && after!==undefined && after!==before) {
        const branch=(text)=>text.trim().replace(/^ref: refs\/remotes\/[^/]+\//,"");
        if (follow==="warn" || follow.slice(12)!==branch(after))
          ctx.err(`warning: '${remote}/HEAD' points to '${branch(after)}' on the remote, but is set to '${branch(before)}' locally\n`);
      }
    }
    if (options.quiet) continue;
    const lines=[];
    if (positional[1]) lines.push(` * branch            ${positional[1].padEnd(10)} -> FETCH_HEAD`);
    for (const [ref,oid] of await snapshot(remote)) {
      const old=was.get(ref), name=ref.replace(/^refs\/(remotes\/[^/]+|tags)\//,"");
      const to=ref.startsWith("refs/tags/")?name:`${remote}/${name}`;
      if (old===oid) continue;
      if (old===undefined) lines.push(` * [new ${ref.startsWith("refs/tags/")?"tag]   ":"branch]"}      ${name.padEnd(10)} -> ${to}`);
      else lines.push(`   ${short(old)}..${short(oid)}  ${name.padEnd(10)} -> ${to}`);
    }
    for (const [ref,oid] of was) if (oid!==undefined && !(await snapshot(remote)).has(ref)) lines.push(` - [deleted]         (none)     -> ${ref.replace(/^refs\/(remotes\/|tags\/)/,"")}`);
    if (lines.length) ctx.err(`From ${shownUrl(url)}\n${lines.join("\n")}\n`);
  }
}

async function pull(ctx,argv) {
  const { options,positional }=parse(argv,{ "ff-only":"ffOnly", "no-ff":"noFf", ff:"ff", rebase:"rebase", "no-rebase":"noRebase", q:"quiet", quiet:"quiet", depth:["depth",positiveDepth], p:"prune", prune:"prune", tags:"tags", "no-tags":"noTags", "allow-unrelated-histories":"unrelated", progress:"progress" });
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
  if (!options.quiet) ctx.err(`From ${shownUrl(url)}\n * branch            ${remoteRef.padEnd(10)} -> FETCH_HEAD\n`);
  // The rest is `git merge FETCH_HEAD`, so it prints what a merge prints.
  return mergeInto(ctx,{ ...options, theirs:fetched.fetchHead, message:`Merge branch '${remoteRef}' of ${url}` });
}

async function push(ctx,argv) {
  const { options,positional }=parse(argv,{ u:"upstream", "set-upstream":"upstream", f:"force", force:"force", d:"remove", delete:"remove", tags:"tags", q:"quiet", quiet:"quiet", v:"verbose", "all":"all", "no-verify":"noVerify", "force-with-lease":"force", "dry-run":"dryRun", progress:"progress" });
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

// Git labels conflict hunks HEAD and the other side as it was named on the
// command line (pull: the fetched id); isomorphic-git labels them with the
// branch names it resolved, which for the id this port passes is the id.
// Same line merge, Git's labels.
function gitMergeDriver(label) {
  return ({ contents:[base,ours,theirs] })=>{
    const split=(text)=>text.match(/^.*(\r?\n|$)/gm)??[];
    let mergedText="", cleanMerge=true;
    for (const item of diff3Merge(split(ours),split(base),split(theirs))) {
      if (item.ok) mergedText+=item.ok.join("");
      if (item.conflict) {
        cleanMerge=false;
        mergedText+=`<<<<<<< HEAD\n${item.conflict.a.join("")}=======\n${item.conflict.b.join("")}>>>>>>> ${label}\n`;
      }
    }
    return { cleanMerge, mergedText };
  };
}
// The files both sides changed since the merge base, which Git announces
// with "Auto-merging" whether or not the merge of their lines is clean.
async function autoMerged(ctx,ours,theirs,mergeBase) {
  const repo=await base(ctx);
  if (!mergeBase) {
    const bases=await git.findMergeBase({ ...repo, oids:[ours,theirs] });
    if (bases.length!==1) return [];
    mergeBase=bases[0];
  }
  const paths=await git.walk({ ...repo, trees:[git.TREE({ ref:mergeBase }),git.TREE({ ref:ours }),git.TREE({ ref:theirs })], map:async (path,[b,o,t])=>{
    if (path==="." || !b || !o || !t) return;
    if (await b.type()!=="blob" || await o.type()!=="blob" || await t.type()!=="blob") return;
    const [bo,oo,to]=await Promise.all([b.oid(),o.oid(),t.oid()]);
    return bo!==oo && bo!==to && oo!==to?path:undefined;
  } });
  return paths.filter(Boolean).sort();
}

// Write the paths that differ between two commits into the worktree and the
// index, the way a merge lands them, leaving every other path -- and any
// unrelated local change -- alone.
async function applyTree(ctx,before,after) {
  const repo=await base(ctx);
  for (const change of await treeDiff(ctx,before,after)) {
    if (change.renamed) { await rm(join(repo.dir,change.renamed),{ force:true }); await git.remove({ ...repo, filepath:change.renamed }); }
    if (!change.oidB) { await rm(join(repo.dir,change.path),{ force:true }); await git.remove({ ...repo, filepath:change.path }); continue; }
    const target=join(repo.dir,change.path);
    const { blob }=await git.readBlob({ ...repo, oid:change.oidB });
    await rm(target,{ force:true, recursive:true });
    await mkdir(dirname(target),{ recursive:true });
    if (change.modeB==="120000") await symlink(Buffer.from(blob).toString(),target);
    else await materialize(repo.dir,[{ path:change.path, content:blob, mode:change.modeB }]);
    await git.add({ ...repo, filepath:change.path, force:true });
  }
}

// On a conflicted merge isomorphic-git records the conflicts and the clean
// content merges, but leaves the other side's own additions, deletions and
// changes to untouched files out of the index and, for deletions, the
// worktree.  Git stages all of those; only the conflicts stay unmerged.
async function applyTheirs(ctx,ours,theirs,conflicts,mergeBase) {
  const repo=await base(ctx);
  if (!mergeBase) {
    const bases=await git.findMergeBase({ ...repo, oids:[ours,theirs] });
    if (bases.length!==1) return;
    mergeBase=bases[0];
  }
  const changes=await git.walk({ ...repo, trees:[git.TREE({ ref:mergeBase }),git.TREE({ ref:ours }),git.TREE({ ref:theirs })], map:async (path,[b,o,t])=>{
    if (path==="." || conflicts.has(path)) return;
    const blob=async (entry)=>entry && await entry.type()==="blob"?{ oid:await entry.oid(), mode:(await entry.mode()).toString(8) }:undefined;
    const [inBase,inOurs,inTheirs]=await Promise.all([blob(b),blob(o),blob(t)]);
    if (inBase?.oid!==inOurs?.oid || inBase?.mode!==inOurs?.mode) return;
    if (inBase?.oid===inTheirs?.oid && inBase?.mode===inTheirs?.mode) return;
    return { path, oidB:inTheirs?.oid, modeB:inTheirs?.mode };
  } });
  for (const change of changes.filter(Boolean)) {
    const target=join(repo.dir,change.path);
    if (!change.oidB) { await rm(target,{ force:true }); await git.remove({ ...repo, filepath:change.path }); continue; }
    const { blob }=await git.readBlob({ ...repo, oid:change.oidB });
    await rm(target,{ force:true, recursive:true });
    await mkdir(dirname(target),{ recursive:true });
    if (change.modeB==="120000") await symlink(Buffer.from(blob).toString(),target);
    else await materialize(repo.dir,[{ path:change.path, content:blob, mode:change.modeB }]);
    await git.add({ ...repo, filepath:change.path, force:true });
  }
}

// `merge --abort` is `reset --merge`: every path the merge staged or left
// unmerged goes back to HEAD in the index and worktree, and paths that only
// differ in the worktree keep their local changes.  isomorphic-git's
// abortMerge rewrites every clean path too, without its mode or stats, and
// decodes it as text on the way.
async function resetMerge(ctx) {
  const repo=await base(ctx);
  const commitOid=await head(ctx);
  const touched=new Set([...await unmergedPaths(ctx)].map(([path])=>path));
  for (const [path,h,,st] of await git.statusMatrix({ ...repo })) if (st!==1 && (h||st)) touched.add(path);
  const inHead=new Map(commitOid?await git.walk({ ...repo, trees:[git.TREE({ ref:commitOid })], map:async (path,[entry])=>
    touched.has(path) && entry && await entry.type()==="blob"?[path,{ oid:await entry.oid(), mode:(await entry.mode()).toString(8) }]:undefined }):[]);
  for (const path of [...touched].sort()) {
    const target=join(repo.dir,path), was=inHead.get(path);
    await rm(target,{ force:true, recursive:true });
    if (!was) { await git.remove({ ...repo, filepath:path }); continue; }
    const { blob }=await git.readBlob({ ...repo, oid:was.oid });
    await mkdir(dirname(target),{ recursive:true });
    if (was.mode==="120000") await symlink(Buffer.from(blob).toString(),target);
    else await materialize(repo.dir,[{ path, content:blob, mode:was.mode }]);
    await git.add({ ...repo, filepath:path, force:true });
  }
}

// The local changes a merge must not lose.  Git's checks, in its order: a
// true merge needs the index to match HEAD; the other side's changes since
// the merge base must not land on locally changed paths; a file it adds
// must not land on an untracked one.  A fast-forward reports the last two
// with status 1 after its "Updating" line, a true merge with status 2.
// isomorphic-git's conflict path then rewrites the whole result tree into
// the worktree, so the worktree copies of every other locally changed path
// are snapshotted, with a restore() to put them back.
async function guardLocalChanges(ctx,ours,theirs,{ fastForward }) {
  const repo=await base(ctx);
  const { tracked,untracked }=porcelainRows(await statusRows(ctx));
  if (!ours || (tracked.length===0 && untracked.length===0)) return { restore:async ()=>{} };
  const bases=await git.findMergeBase({ ...repo, oids:[ours,theirs] });
  const ff=fastForward && bases.length===1 && bases[0]===ours;
  const refuse=(message)=>{
    if (ff) { ctx.out(`Updating ${short(ours)}..${short(theirs)}\n`); throw failure(message); }
    throw failure(`${message}\nMerge with strategy ort failed.`,2);
  };
  const staged=tracked.filter((r)=>r.x!==" ").map((r)=>r.path);
  if (!ff && staged.length) throw failure(`Your local changes to the following files would be overwritten by merge:\n${staged.map((p)=>`  ${p}\n`).join("")}Merge with strategy ort failed.`,2);
  const changes=await treeDiff(ctx,bases.length===1?bases[0]:ours,theirs);
  const touched=new Set(changes.flatMap((c)=>c.renamed?[c.renamed,c.path]:[c.path]));
  const overwritten=tracked.filter((r)=>touched.has(r.path)).map((r)=>r.path);
  if (overwritten.length) refuse(`Your local changes to the following files would be overwritten by merge:\n${overwritten.map((p)=>`\t${p}\n`).join("")}Please commit your changes or stash them before you merge.\nAborting`);
  const created=new Set(changes.filter((c)=>!c.oidA).map((c)=>c.path));
  const clobbered=untracked.filter((p)=>created.has(p));
  if (clobbered.length) refuse(`The following untracked working tree files would be overwritten by merge:\n${clobbered.map((p)=>`\t${p}\n`).join("")}Please move or remove them before you merge.\nAborting`);
  return snapshotWorktree(ctx,tracked.map((r)=>r.path));
}
// The worktree copies of some paths, with a restore() to put them back.
async function snapshotWorktree(ctx,paths) {
  const repo=await base(ctx);
  const kept=[];
  for (const path of paths) {
    const target=join(repo.dir,path);
    let info;
    try { info=await lstat(target); } catch { kept.push({ path }); continue; }
    if (info.isSymbolicLink()) kept.push({ path, link:await readlink(target) });
    else if (!info.isDirectory()) kept.push({ path, content:await readFile(target), mode:info.mode&0o111?"100755":"100644" });
  }
  return { restore:async ()=>{
    for (const { path,link,content,mode } of kept) {
      const target=join(repo.dir,path);
      await rm(target,{ force:true, recursive:true });
      if (link!==undefined) { await mkdir(dirname(target),{ recursive:true }); await symlink(link,target); }
      else if (content!==undefined) await materialize(repo.dir,[{ path, content, mode }]);
    }
  } };
}

async function mergeInto(ctx,{ theirs,label,message,noFf,ffOnly,quiet,unrelated }) {
  const repo=await base(ctx);
  const current=await branchName(ctx);
  if (!current) throw new Error("You are not currently on a branch.");
  const before=await head(ctx);
  const author=await identity(ctx,"author"), committer=await identity(ctx,"committer");
  const merged=before?await autoMerged(ctx,before,theirs):[];
  // Git refuses to merge over local changes to the paths the other side
  // changed, and leaves other local changes alone.  isomorphic-git's
  // conflict path rewrites the whole result tree into the worktree, so
  // those other changes are snapshotted here and put back afterwards.
  const local=await guardLocalChanges(ctx,before,theirs,{ fastForward:!noFf });
  let result;
  try {
    result=await git.merge({ ...repo, ours:current, theirs, author, committer, message, fastForward:!noFf, fastForwardOnly:!!ffOnly, abortOnConflict:false, allowUnrelatedHistories:!!unrelated, mergeDriver:gitMergeDriver(label??theirs) });
  } catch (error) {
    if (error.code!=="MergeConflictError") throw error;
    await local.restore();
    const { filepaths,deleteByUs=[],deleteByTheirs=[] }=error.data;
    const name=label??theirs;
    for (const path of [...new Set([...merged,...filepaths])].sort()) {
      if (merged.includes(path)) ctx.out(`Auto-merging ${path}\n`);
      if (deleteByTheirs.includes(path)) ctx.out(`CONFLICT (modify/delete): ${path} deleted in ${name} and modified in HEAD.  Version HEAD of ${path} left in tree.\n`);
      else if (deleteByUs.includes(path)) ctx.out(`CONFLICT (modify/delete): ${path} deleted in HEAD and modified in ${name}.  Version ${name} of ${path} left in tree.\n`);
      else if (filepaths.includes(path)) ctx.out(`CONFLICT (content): Merge conflict in ${path}\n`);
    }
    ctx.out("Automatic merge failed; fix conflicts and then commit the result.\n");
    await applyTheirs(ctx,before,theirs,new Set(filepaths));
    await writeMergeState(ctx,theirs,message,[...filepaths].sort());
    return 1;
  }
  // isomorphic-git only moves the ref (a fast-forward) or writes the merged
  // tree and commit (a true merge); bring the index and worktree along.
  if (!result.alreadyMerged) await applyTree(ctx,before,result.oid);
  if (quiet) return;
  if (result.alreadyMerged) ctx.out("Already up to date.\n");
  else if (result.fastForward) {
    ctx.out(`Updating ${short(before)}..${short(result.oid)}\nFast-forward\n`);
    ctx.out(await commitSummary(ctx,result.oid,before,{ table:true }));
  }
  else ctx.out(merged.map((path)=>`Auto-merging ${path}\n`).join("")+"Merge made by the 'ort' strategy.\n"+await commitSummary(ctx,result.oid,before,{ table:true }));
}

async function merge(ctx,argv) {
  const { options,positional }=parse(argv,{ "no-ff":"noFf", "ff-only":"ffOnly", ff:"ff", m:["message",list], abort:"abort", q:"quiet", quiet:"quiet", "no-edit":"noEdit", "allow-unrelated-histories":"unrelated", "no-commit":"noCommit" });
  const repo=await base(ctx);
  if (options.abort) {
    if ((await mergeHeads(ctx)).length===0) throw new Error("There is no merge to abort (MERGE_HEAD missing).");
    await resetMerge(ctx);
    await clearMergeState(ctx);
    return;
  }
  if (positional.length!==1) throw new Error("this port merges exactly one branch at a time");
  await refuseUnmerged(ctx,"Merging");
  if ((await mergeHeads(ctx)).length) throw new Error("You have not concluded your merge (MERGE_HEAD exists).\nPlease, commit your changes before you merge.");
  const theirs=await revision(ctx,positional[0],"commit");
  const message=options.message?cleanMessage(options.message.join("\n\n")):await mergeMessage(ctx,positional[0]);
  return mergeInto(ctx,{ ...options, theirs, label:positional[0], message });
}

// Git's default merge message names what was merged -- a branch, a
// remote-tracking branch, a tag or a commit -- and says which branch it went
// into unless that is main or master.
async function mergeMessage(ctx,name) {
  const repo=await base(ctx);
  const exists=async (ref)=>{ try { await git.resolveRef({ ...repo, ref }); return true; } catch { return false; } };
  const what=await exists(`refs/heads/${name}`)?`branch '${name}'`
    :await exists(`refs/remotes/${name}`)?`remote-tracking branch '${name}'`
    :await exists(`refs/tags/${name}`)?`tag '${name}'`
    :`commit '${name}'`;
  const current=await branchName(ctx);
  return `Merge ${what}`+(current==="main"||current==="master"?"":` into ${current}`);
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
    if (process.platform!=="win32") await chmod(target,mode==="100755"?0o755:0o644);
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
function noIndexName(path) { return path.split("\\").join("/").replace(/^\/+/,""); }
function renamedPath(left,right) {
  if (left===right) return right;
  let start=0, end=0;
  while (start<left.length && left[start]===right[start]) start++;
  start=start===0?0:left.lastIndexOf("/",start-1)+1;
  while (end<left.length-start && end<right.length-start && left[left.length-1-end]===right[right.length-1-end]) end++;
  const suffixAt=left.indexOf("/",left.length-end);
  const suffix=suffixAt<0?"":left.slice(suffixAt);
  const a=left.slice(start,suffixAt<0?left.length:suffixAt), b=right.slice(start,suffixAt<0?right.length:right.length-suffix.length);
  if (start===0 && !suffix) return `${left} => ${right}`;
  return `${left.slice(0,start)}{${a} => ${b}}${suffix}`;
}
async function noIndexEntries(path) {
  const root=resolve(path), info=await lstat(root), entries=new Map();
  const visit=async (target,key)=>{
    const value=await lstat(target);
    if (value.isDirectory()) {
      for (const name of await readdir(target)) await visit(join(target,name),key?`${key}/${name}`:name);
    } else if (value.isSymbolicLink()) entries.set(key,{ content:Buffer.from(await readlink(target)), mode:"120000" });
    else entries.set(key,{ content:await readFile(target), mode:value.mode&0o111?"100755":"100644" });
  };
  if (info.isDirectory()) await visit(root,""); else await visit(root,".");
  return { root, directory:info.isDirectory(), entries };
}
async function diffNoIndex(ctx,options,positional) {
  if (positional.length!==2) throw new Error("usage: git diff --no-index [<options>] <path> <path>");
  const [leftArg,rightArg]=positional;
  const [left,right]=await Promise.all([noIndexEntries(resolve(ctx.cwd,leftArg)),noIndexEntries(resolve(ctx.cwd,rightArg))]);
  if (left.directory!==right.directory) throw new Error("this port cannot compare a file with a directory");
  const scratch=await mkdtemp(join(tmpdir(),"bunproot-git-no-index-"));
  const pairs=[];
  try {
    await mkdir(join(scratch,"a")); await mkdir(join(scratch,"b"));
    const keys=new Set([...left.entries.keys(),...right.entries.keys()]);
    for (const key of keys) {
      const a=left.entries.get(key), b=right.entries.get(key), virtual=key==="."?basename(right.root):key;
      if (a) { a.oid=(await git.hashBlob({ object:new Uint8Array(a.content) })).oid; await materialize(join(scratch,"a"),[{ path:virtual,...a }]); }
      if (b) { b.oid=(await git.hashBlob({ object:new Uint8Array(b.content) })).oid; await materialize(join(scratch,"b"),[{ path:virtual,...b }]); }
      if (!a || !b || a.oid!==b.oid || a.mode!==b.mode) pairs.push({ key,virtual,left:a,right:b });
    }
    if (!pairs.length) return 0;
    const files=bunDiff(join(scratch,"a"),join(scratch,"b"),options.context??3);
    const byPath=new Map(pairs.map((p)=>[p.virtual,p]));
    const changes=files.map((f)=>({ ...f,...byPath.get(f.path) })).filter((c)=>c.left||c.right);
    for (const pair of pairs) if (!changes.some((c)=>c.virtual===pair.virtual) && pair.left && pair.right && pair.left.mode!==pair.right.mode)
      changes.push({ ...pair,path:pair.virtual,status:"modified",linesAdded:0,linesRemoved:0 });
    const rootName=(arg,absolute)=>absolute?resolve(ctx.cwd,arg).split("\\").join("/"):arg.split("\\").join("/");
    for (const c of changes) {
      const suffix=c.key==="."?"":`/${c.key}`;
      c.labelA=left.directory?rootName(leftArg,false)+suffix:rootName(leftArg,false);
      c.labelB=right.directory?rootName(rightArg,false)+suffix:rootName(rightArg,false);
      c.fullA=left.directory?rootName(leftArg,false)+suffix:rootName(leftArg,false);
      c.fullB=right.directory?rootName(rightArg,false)+suffix:rootName(rightArg,false);
      if (!c.left) { c.labelA=c.labelB; c.fullA=c.fullB; }
      if (!c.right) { c.labelB=c.labelA; c.fullB=c.fullA; }
    }
    if (options.check) {
      let text="", bad=false;
      for (const c of changes) { let lineNo=0; for (const line of (c.patch??"").split("\n")) {
        const h=/^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line); if (h) { lineNo=Number(h[1]); continue; }
        if (line.startsWith("+")) { if (/[ \t]+$/.test(line.slice(1))) { text+=`${c.fullB}:${lineNo}: trailing whitespace.\n${line}\n`; bad=true; } lineNo++; }
        else if (!line.startsWith("-")) lineNo++;
      }}
      if (text) ctx.out(text); return bad?3:1;
    }
    if (options.nameOnly) { ctx.out(changes.map((c)=>(c.right?c.fullB:"/dev/null")+"\n").join("")); return 1; }
    if (options.nameStatus) { ctx.out(changes.map((c)=>`${c.status==="added"?"A":c.status==="deleted"?"D":"M"}\t${c.status==="added"?c.fullB:c.fullA}\n`).join("")); return 1; }
    if (options.stat) {
      const rows=changes.map((c)=>({ path:renamedPath(c.left?c.fullA:"/dev/null",c.right?c.fullB:"/dev/null"),insertions:c.linesAdded,deletions:c.linesRemoved,binary:c.binary,bytesBefore:c.bytesBefore,bytesAfter:c.bytesAfter }));
      ctx.out(statTable(rows)+statLine({ files:rows.length,insertions:rows.reduce((n,r)=>n+r.insertions,0),deletions:rows.reduce((n,r)=>n+r.deletions,0) })); return 1;
    }
    let text="";
    for (const c of changes) {
      const { left:a,right:b }=c;
      let header=`diff --git a/${noIndexName(c.labelA)} b/${noIndexName(c.labelB)}\n`;
      if (!a) header+=`new file mode ${b.mode}\n`; else if (!b) header+=`deleted file mode ${a.mode}\n`; else if (a.mode!==b.mode) header+=`old mode ${a.mode}\nnew mode ${b.mode}\n`;
      if (!a || !b || a.oid!==b.oid) header+=`index ${short(a?.oid??"0".repeat(40))}..${short(b?.oid??"0".repeat(40))}${a&&b&&a.mode===b.mode?` ${a.mode}`:""}\n`;
      if (a?.oid===b?.oid) { text+=ctx.paint("bold",header.trimEnd())+"\n"; continue; }
      if (c.binary) { text+=ctx.paint("bold",header.trimEnd())+`\nBinary files ${a?`a/${noIndexName(c.labelA)}`:"/dev/null"} and ${b?`b/${noIndexName(c.labelB)}`:"/dev/null"} differ\n`; continue; }
      header+=`--- ${a?`a/${noIndexName(c.labelA)}`:"/dev/null"}\n+++ ${b?`b/${noIndexName(c.labelB)}`:"/dev/null"}`;
      text+=header.split("\n").map((line)=>ctx.paint("bold",line)).join("\n")+"\n"+gitHunks(c.patch??"",a?Buffer.from(a.content).toString("latin1"):"",ctx);
    }
    ctx.out(text); return 1;
  } finally { await rm(scratch,{ recursive:true,force:true }); }
}
async function diff(ctx,argv) {
  const parsed=parse(argv,{
    cached:"cached", staged:"cached", stat:"stat", check:"check", "name-only":"nameOnly", "name-status":"nameStatus",
    U:["context",count], unified:["context",count], color:"color", "no-color":"noColor", "exit-code":"exitCode", quiet:"quiet",
    "no-ext-diff":"noExt", "no-renames":"noRenames", "no-index":"noIndex", p:"patch", u:"patch", patch:"patch",
  });
  const { options }=parsed;
  if (options.quiet) { options.exitCode=true; ctx.out=()=>{}; }
  if (options.color) ctx.colour=true;
  if (options.noColor) ctx.colour=false;
  if (options.noIndex) return diffNoIndex(ctx,options,parsed.positional);
  const repo=await base(ctx);
  const paths=parsed.paths??[];
  let revs=parsed.positional.slice(0,parsed.positional.length-paths.length);
  if (revs.length===1 && revs[0].includes("...")) {
    // A...B compares B with the merge base of the two.
    const [a,b]=await Promise.all(revs[0].split("...").map((r)=>revision(ctx,r||"HEAD","commit")));
    const bases=await git.findMergeBase({ ...repo, oids:[a,b] });
    if (bases.length===0) throw new Error(`no merge base found for ${revs[0]}`);
    revs=[bases[0],b];
  }
  else if (revs.length===1 && revs[0].includes("..")) revs=revs[0].split("..").map((r)=>r||"HEAD");
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
    if (ref===EMPTY_TREE) return new Map();
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
    const resolveTree=async (ref)=>ref===EMPTY_TREE?ref:revision(ctx,ref,"commit");
    const [a,b]=await Promise.all([tree(await resolveTree(revs[0])),tree(await resolveTree(revs[1]))]);
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
    // A path outside the index is untracked on the worktree side whichever
    // tree is on the left: a file added since the commit is new, and a file
    // the commit has but the index no longer does is deleted.
    for (const [path,h,w,st] of rows) {
      if (!left.has(path) && !st) continue;
      if (h===1 && w===1 && st===1) continue;
      await record(path,left.get(path),st?await worktree(path):undefined);
    }
  }
  // Exact renames, the way Git pairs a deleted file with an added one of
  // the same content; --no-renames keeps them apart.  Similar-content
  // renames are not detected.
  if (!options.noRenames) {
    const added=pairs.filter((p)=>!p.left);
    for (const gone of pairs.filter((p)=>!p.right)) {
      const twin=added.find((p)=>p.right.oid===gone.left.oid && !p.renamed);
      if (!twin) continue;
      twin.renamed=gone.path; twin.left=gone.left; gone.dropped=true;
    }
    for (let i=pairs.length; i-->0;) if (pairs[i].dropped) pairs.splice(i,1);
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
  for (const pair of pairs) if (!changes.some((c)=>c.path===pair.path) && pair.left && pair.right && (pair.renamed || pair.left.mode!==pair.right.mode)) changes.push({ ...pair, status:"modified", linesAdded:0, linesRemoved:0 });
  changes.sort((x,y)=>x.path<y.path?-1:1);
  if (changes.length===0) return options.exitCode?0:undefined;
  if (options.check) {
    let text="", bad=false;
    for (const change of changes) {
      if (change.binary || !change.patch) continue;
      let newLine=0;
      for (const line of change.patch.split("\n")) {
        const hunk=/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) { newLine=Number(hunk[1]); continue; }
        if (line.startsWith("+")) {
          if (/[ \t]+$/.test(line.slice(1))) {
            text+=`${change.path}:${newLine}: trailing whitespace.\n${line}\n`;
            bad=true;
          }
          newLine++;
        } else if (!line.startsWith("-")) newLine++;
      }
    }
    if (text) ctx.out(text);
    return bad?2:0;
  }
  if (options.nameOnly) { ctx.out(changes.map((c)=>c.path+"\n").join("")); return options.exitCode?1:undefined; }
  if (options.nameStatus) { ctx.out(changes.map((c)=>c.renamed?`R100\t${c.renamed}\t${c.path}\n`:`${c.status==="added"?"A":c.status==="deleted"?"D":"M"}\t${c.path}\n`).join("")); return options.exitCode?1:undefined; }
  if (options.stat) {
    const rows=changes.map((c)=>({ path:c.path, renamed:c.renamed, insertions:c.linesAdded, deletions:c.linesRemoved, binary:c.binary, bytesBefore:c.bytesBefore, bytesAfter:c.bytesAfter }));
    ctx.out(statTable(rows)+statLine({ files:rows.length, insertions:rows.reduce((n,r)=>n+r.insertions,0), deletions:rows.reduce((n,r)=>n+r.deletions,0) }));
    return options.exitCode?1:undefined;
  }
  let text="";
  for (const c of changes) {
    const { left,right }=c;
    let header=`diff --git a/${c.renamed??c.path} b/${c.path}\n`;
    if (!left) header+=`new file mode ${right.mode}\n`;
    else if (!right) header+=`deleted file mode ${left.mode}\n`;
    else if (left.mode!==right.mode) header+=`old mode ${left.mode}\nnew mode ${right.mode}\n`;
    if (c.renamed) header+=`similarity index 100%\nrename from ${c.renamed}\nrename to ${c.path}\n`;
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
  const { options,positional }=parse(argv,{ "no-commit":"noCommit", n:"noCommit", x:"record", e:"edit", "allow-empty":"allowEmpty", abort:"abort", continue:"continue", skip:"skip" });
  const repo=await base(ctx);
  if (options.abort || options.continue || options.skip) {
    const picking=await cherryPickHead(ctx);
    if (!picking) throw new Error("no cherry-pick or revert in progress");
    if (options.abort || options.skip) { await resetMerge(ctx); await clearMergeState(ctx); return; }
    await refuseUnmerged(ctx,"Committing");
    return commit(ctx,["--no-edit"]);
  }
  if (positional.length!==1) throw new Error("this port cherry-picks exactly one commit at a time");
  const oid=await revision(ctx,positional[0],"commit");
  const current=await branchName(ctx);
  const before=await head(ctx);
  const { commit:picked }=await git.readCommit({ ...repo, oid });
  if (picked.parent.length!==1) throw new Error(`commit ${oid} is a ${picked.parent.length?"merge":"root"} commit; this port cherry-picks single-parent commits only`);
  const committer=await identity(ctx,"committer");
  // Git's refusals: any staged change, or a local change to a path the
  // commit touches; unrelated worktree changes survive.
  const { tracked }=porcelainRows(await statusRows(ctx));
  if (tracked.some((r)=>r.x!==" ")) { ctx.err("error: your local changes would be overwritten by cherry-pick.\nhint: commit your changes or stash them to proceed.\n"); throw new Error("cherry-pick failed"); }
  const touched=new Set((await treeDiff(ctx,picked.parent[0],oid)).flatMap((c)=>c.renamed?[c.renamed,c.path]:[c.path]));
  const overwritten=tracked.filter((r)=>touched.has(r.path)).map((r)=>r.path);
  if (overwritten.length) { ctx.err(`error: Your local changes to the following files would be overwritten by merge:\n${overwritten.map((p)=>`\t${p}\n`).join("")}Please commit your changes or stash them before you merge.\nAborting\n`); throw new Error("cherry-pick failed"); }
  const local=await snapshotWorktree(ctx,tracked.map((r)=>r.path));
  const label=`${short(oid)} (${subject(picked.message)})`;
  const merged=await autoMerged(ctx,before,oid,picked.parent[0]);
  let result;
  try {
    result=await git.cherryPick({ ...repo, oid, committer, noUpdateBranch:true, abortOnConflict:false, mergeDriver:gitMergeDriver(label) });
  } catch (error) {
    if (error.code!=="MergeConflictError") throw error;
    await local.restore();
    const { filepaths,deleteByUs=[],deleteByTheirs=[] }=error.data;
    for (const path of [...new Set([...merged,...filepaths])].sort()) {
      if (merged.includes(path)) ctx.out(`Auto-merging ${path}\n`);
      if (deleteByTheirs.includes(path)) ctx.out(`CONFLICT (modify/delete): ${path} deleted in ${label} and modified in HEAD.  Version HEAD of ${path} left in tree.\n`);
      else if (deleteByUs.includes(path)) ctx.out(`CONFLICT (modify/delete): ${path} deleted in HEAD and modified in ${label}.  Version ${label} of ${path} left in tree.\n`);
      else if (filepaths.includes(path)) ctx.out(`CONFLICT (content): Merge conflict in ${path}\n`);
    }
    await applyTheirs(ctx,before,oid,new Set(filepaths),picked.parent[0]);
    await writeFile(join(repo.gitdir,"CHERRY_PICK_HEAD"),`${oid}\n`);
    ctx.err(`error: could not apply ${short(oid)}... ${subject(picked.message)}\nhint: After resolving the conflicts, mark them with\nhint: "git add/rm <pathspec>", then run\nhint: "git cherry-pick --continue".\nhint: You can instead skip this commit with "git cherry-pick --skip".\nhint: To abort and get back to the state before "git cherry-pick",\nhint: run "git cherry-pick --abort".\nhint: Disable this message with "git config advice.mergeConflict false"\n`);
    return 1;
  }
  // The commit object exists; land its tree, and move the branch unless -n.
  await applyTree(ctx,before,result);
  if (options.noCommit) return;
  await git.writeRef({ ...repo, ref:`refs/heads/${current}`, value:result, force:true });
  const written=(await git.readCommit({ ...repo, oid:result })).commit;
  let text=`[${current} ${short(result)}] ${subject(written.message)}\n`;
  if (written.author.name!==written.committer.name || written.author.email!==written.committer.email)
    text+=` Author: ${written.author.name} <${written.author.email}>\n`;
  text+=` Date: ${gitDate(written.author)}\n`;
  ctx.out(text+await commitSummary(ctx,result,before));
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
  const { options,positional }=parse(argv,{ s:"stage", stage:"stage", c:"cached", cached:"cached", z:"nul", o:"others", others:"others", "exclude-standard":"excludeStandard", "full-name":"fullName" });
  const repo=await base(ctx);
  // Without a pathspec Git lists the current directory's subtree, and shows
  // every path relative to that directory unless --full-name.
  const filter=positional.length?await Promise.all(positional.map((p)=>ctx.pathspec(p))):[await ctx.pathspec(".")];
  const keep=(f)=>filter.some((p)=>p==="" || f===p || f.startsWith(p+"/"));
  const name=async (f)=>options.fullName?f:ctx.display(f);
  if (options.others) {
    const { untracked }=porcelainRows(await statusRows(ctx));
    for (const path of untracked.filter(keep).sort()) ctx.out(`${await name(path)}\n`);
    return;
  }
  const files=(await git.listFiles({ ...repo })).filter(keep).sort();
  if (!options.stage) { for (const f of files) ctx.out(await name(f)+(options.nul?"\0":"\n")); return; }
  // Straight from the index, so conflict stages come out as Git lists them.
  const entries=(await indexEntries(ctx)).filter((e)=>keep(e.path)).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:a.stage-b.stage);
  for (const { path,mode,oid,stage } of entries) ctx.out(`${mode} ${oid} ${stage}\t${await name(path)}\n`);
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
  const { options,positional }=parse(argv,{ h:"heads", heads:"heads", t:"tags", tags:"tags", refs:"refs", q:"quiet", quiet:"quiet", "get-url":"getUrl", symref:"symref", "exit-code":"exitCode" });
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
  for (const { ref,oid,peeled,target } of sorted) {
    if (options.symref && target) ctx.out(`ref: ${target}\t${ref}\n`);
    ctx.out(`${oid}\t${ref}\n`);
    if (peeled && !options.refs) ctx.out(`${peeled}\t${ref}^{}\n`);
  }
  if (options.exitCode && sorted.length===0) return 2;
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
  const { options,positional }=parse(argv,{ w:"write", stdin:"stdin", "stdin-paths":"stdinPaths", t:["type"], "no-filters":"noFilters", literally:"literally" });
  const type=options.type??"blob";
  if (!["blob","tree","commit","tag"].includes(type)) throw new Error(`invalid object type \"${type}\"`);
  if (options.stdin && options.stdinPaths) throw new Error("cannot use --stdin with --stdin-paths");
  const paths=options.stdinPaths?(await readStdin()).toString("utf8").split("\n").filter(Boolean):positional;
  const inputs=options.stdin?[await readStdin()]:await Promise.all(paths.map((p)=>readFile(resolve(ctx.cwd,p))));
  for (const object of inputs) {
    if (options.write) ctx.out(`${await git.writeObject({ ...await base(ctx), type, object:new Uint8Array(object), format:"content" })}\n`);
    else {
      const hasher=new Bun.CryptoHasher("sha1");
      hasher.update(`${type} ${object.length}\0`); hasher.update(object);
      ctx.out(`${hasher.digest("hex")}\n`);
    }
  }
}

async function writeTreeFromIndex(ctx) {
  const repo=await base(ctx), root={ dirs:new Map(), files:[] };
  const entries=await git.walk({ ...repo, trees:[git.STAGE()], map:async (path,[entry])=>{
    if (path==="." || !entry || await entry.type()!=="blob") return;
    return { path,mode:(await entry.mode()).toString(8),oid:await entry.oid() };
  } });
  for (const entry of entries.filter(Boolean)) {
    const parts=entry.path.split("/"), name=parts.pop(); let node=root;
    for (const part of parts) { if (!node.dirs.has(part)) node.dirs.set(part,{ dirs:new Map(),files:[] }); node=node.dirs.get(part); }
    node.files.push({ mode:entry.mode,path:name,oid:entry.oid,type:"blob" });
  }
  const write=async (node)=>{
    const tree=[...node.files];
    for (const [path,child] of node.dirs) tree.push({ mode:"040000",path,oid:await write(child),type:"tree" });
    tree.sort((a,b)=>a.path.localeCompare(b.path));
    return git.writeTree({ ...repo,tree });
  };
  return write(root);
}
async function writeTreeCommand(ctx,argv) {
  if (argv.length) throw new Error("usage: git write-tree");
  ctx.out(`${await writeTreeFromIndex(ctx)}\n`);
}
async function mkTree(ctx,argv) {
  const { options,positional }=parse(argv,{ z:"nul", missing:"missing", batch:"batch" });
  if (positional.length) throw new Error("usage: git mktree [-z] [--missing]");
  const input=(await readStdin()).toString("latin1");
  const groups=options.batch?input.split(options.nul?"\0\0":"\n\n"):[input];
  for (const group of groups) {
    const records=group.split(options.nul?"\0":"\n").filter(Boolean);
    if (!records.length && options.batch) continue;
    const tree=[];
    for (const row of records) {
      const match=/^(\d+)\s+(blob|tree|commit)\s+([0-9a-f]{40})\t([\s\S]+)$/.exec(row);
      if (!match) throw new Error(`input format error: ${row}`);
      const [,mode,type,oid,path]=match;
      if (!options.missing) await git.readObject({ ...await base(ctx),oid });
      tree.push({ mode,path,oid,type });
    }
    ctx.out(`${await git.writeTree({ ...await base(ctx),tree })}\n`);
  }
}
async function commitTree(ctx,argv) {
  const { options,positional }=parse(argv,{ p:["parents",list], m:["messages",list], F:["files",list] });
  if (positional.length!==1) throw new Error("usage: git commit-tree <tree> [-p <parent>]... [-m <message> | -F <file>]...");
  const tree=await revision(ctx,positional[0],"tree"), parent=await Promise.all((options.parents??[]).map((p)=>revision(ctx,p,"commit")));
  const pieces=[...(options.messages??[])];
  for (const file of options.files??[]) pieces.push(file==="-"?(await readStdin()).toString("utf8"):await readFile(resolve(ctx.cwd,file),"utf8"));
  if (!pieces.length) pieces.push((await readStdin()).toString("utf8"));
  const author=await identity(ctx,"author"), committer=await identity(ctx,"committer");
  const oid=await git.writeCommit({ ...await base(ctx),commit:{ tree,parent,author,committer,message:cleanMessage(pieces.join("\n\n")) } });
  ctx.out(`${oid}\n`);
}
async function mkTag(ctx,argv) {
  const { positional }=parse(argv,{ strict:"strict", "no-strict":"noStrict" });
  if (positional.length) throw new Error("usage: git mktag");
  const object=new Uint8Array(await readStdin());
  ctx.out(`${await git.writeObject({ ...await base(ctx),type:"tag",object,format:"content" })}\n`);
}

function notesRef(value) {
  if (!value) return "refs/notes/commits";
  return value.startsWith("refs/")?value:`refs/notes/${value}`;
}
// isomorphic-git writes every notes commit with its own fixed message;
// Git's names the notes command.  The tip commit is rewritten with Git's.
async function renameNotesCommit(ctx,ref,verb) {
  const repo=await base(ctx);
  let oid;
  try { oid=await git.resolveRef({ ...repo, ref }); } catch { return; }
  const { commit }=await git.readCommit({ ...repo, oid });
  const message=`Notes ${verb.startsWith("remove")||verb==="prune"?"removed":"added"} by 'git notes ${verb}'\n`;
  if (commit.message===message) return;
  const rewritten=await git.writeCommit({ ...repo, commit:{ ...commit, message } });
  await git.writeRef({ ...repo, ref, value:rewritten, force:true });
}
async function notes(ctx,argv) {
  const parsed=parse(argv,{ ref:["ref"], f:"force", force:"force", m:["message",list], message:["message",list], F:["files",list], file:["files",list], "allow-empty":"allowEmpty" });
  const { options,positional }=parsed;
  const verbs=new Set(["add","append","copy","show","remove","list","get-ref","prune"]);
  const verb=verbs.has(positional[0])?positional.shift():"list";
  const repo=await base(ctx), ref=notesRef(options.ref);
  if (verb==="get-ref") { ctx.out(`${ref}\n`); return; }
  if (verb==="copy") {
    if (positional.length!==2) throw new Error("notes copy requires two objects");
    const [from,to]=await Promise.all(positional.map((p)=>revision(ctx,p)));
    const note=await git.readNote({ ...repo,ref,oid:from });
    const author=await identity(ctx,"author"), committer=await identity(ctx,"committer");
    await git.addNote({ ...repo,ref,oid:to,note,force:!!options.force,author,committer });
    await renameNotesCommit(ctx,ref,"copy"); return;
  }
  if (verb==="prune") {
    const author=await identity(ctx,"author"), committer=await identity(ctx,"committer");
    for (const entry of await git.listNotes({ ...repo,ref })) {
      try { await git.readObject({ ...repo,oid:entry.target }); }
      catch { await git.removeNote({ ...repo,ref,oid:entry.target,author,committer }); await renameNotesCommit(ctx,ref,"prune"); }
    }
    return;
  }
  if (verb==="list") {
    if (positional.length>1) throw new Error("notes list takes at most one object");
    const entries=await git.listNotes({ ...repo, ref });
    if (positional[0]) {
      const target=await revision(ctx,positional[0]);
      const found=entries.find((entry)=>entry.target===target);
      if (!found) return 1;
      ctx.out(`${found.note}\n`);
    } else for (const entry of entries.sort((a,b)=>a.target.localeCompare(b.target))) ctx.out(`${entry.note} ${entry.target}\n`);
    return;
  }
  const shown=positional[0]??"HEAD", oid=await revision(ctx,shown);
  if (verb==="show") {
    try { ctx.out(Buffer.from(await git.readNote({ ...repo, ref, oid })).toString()); }
    catch (error) { throw failure(`no note found for object ${oid}.`); }
    return;
  }
  const author=await identity(ctx,"author"), committer=await identity(ctx,"committer");
  if (verb==="remove") {
    for (const name of positional.length?positional:["HEAD"]) {
      await git.removeNote({ ...repo, ref, oid:await revision(ctx,name), author, committer });
      await renameNotesCommit(ctx,ref,"remove");
      ctx.err(`Removing note for object ${name}\n`);
    }
    return;
  }
  const pieces=[...(options.message??[])];
  for (const file of options.files??[]) pieces.push(file==="-"?(await readStdin()).toString("utf8"):await readFile(resolve(ctx.cwd,file),"utf8"));
  if (!pieces.length) throw new Error(`notes ${verb} requires -m <message> or -F <file> in this port`);
  let note=pieces.length?cleanMessage(pieces.join("\n\n")):"";
  if (verb==="append") {
    try { note=cleanMessage(Buffer.from(await git.readNote({ ...repo,ref,oid })).toString()+"\n"+note); } catch {}
  }
  await git.addNote({ ...repo, ref, oid, note, force:verb==="append"||!!options.force, author, committer });
  await renameNotesCommit(ctx,ref,verb);
}

async function applyRefUpdate(ctx,{ verb="update",ref,value,old }) {
  const repo=await base(ctx);
  let current;
  try { current=await git.resolveRef({ ...repo, ref }); } catch {}
  const expected=old && old!=="0".repeat(40)?await revision(ctx,old):old;
  if (expected && expected!=="0".repeat(40) && current!==expected)
    throw failure(`cannot lock ref '${ref}': is at ${current??"0".repeat(40)} but expected ${old}`);
  if (old==="0".repeat(40) && current) throw failure(`cannot lock ref '${ref}': reference already exists`);
  if (verb==="verify") {
    if (!old && current) throw failure(`cannot lock ref '${ref}': reference already exists`);
    return;
  }
  if (verb==="create" && current) throw failure(`cannot lock ref '${ref}': reference already exists`);
  if (verb==="delete" || value==="0".repeat(40)) {
    if (current) await git.deleteRef({ ...repo, ref });
    return;
  }
  const oid=await revision(ctx,value);
  await git.writeRef({ ...repo, ref, value:oid, force:true });
}
async function updateRef(ctx,argv) {
  const { options,positional }=parse(argv,{ d:"remove", m:["reason"], stdin:"stdin", "no-deref":"noDeref", "create-reflog":"createReflog" });
  if (options.stdin) {
    if (positional.length) throw new Error("--stdin does not take command-line ref arguments");
    const lines=(await readStdin()).toString("utf8").split("\n").map((line)=>line.trim()).filter(Boolean);
    for (const line of lines) {
      const [verb,ref,value,old,...extra]=line.split(/\s+/);
      if (!['update','create','delete','verify'].includes(verb) || !ref || extra.length) throw new Error(`unknown command: ${line}`);
      if ((verb==="update"||verb==="create")&&!value) throw new Error(`${verb}: missing <new-oid>`);
      await applyRefUpdate(ctx,{ verb,ref,value,old:verb==="delete"||verb==="verify"?value:old });
    }
    return;
  }
  const [ref,value,old]=positional;
  if (!ref || (!options.remove && !value) || positional.length>(options.remove?2:3)) throw new Error("usage: git update-ref [-d] <refname> [<new-oid> [<old-oid>]]");
  return applyRefUpdate(ctx,{ verb:options.remove?"delete":"update",ref,value,old:options.remove?value:old });
}

async function stash(ctx,argv) {
  const { options,positional }=parse(argv,{ m:["message",list], message:["message",list], q:"quiet", quiet:"quiet", "include-untracked":"untracked", u:"untracked" });
  const repo=await base(ctx);
  let [op="push",...rest]=positional;
  if (op==="save") { op="push"; if (rest.length) options.message=[rest.join(" ")]; }
  const refIdx=rest[0]?Number(/\{(\d+)\}/.exec(rest[0])?.[1]??rest[0]):0;
  if (!["push","pop","apply","drop","list","clear"].includes(op)) throw new Error(`unknown subcommand: ${op}`);
  const localName=op==="push"?await git.getConfig({ ...repo, path:"user.name" }):undefined;
  const localEmail=op==="push"?await git.getConfig({ ...repo, path:"user.email" }):undefined;
  let borrowedIdentity=false;
  if (op==="push" && !localName) {
    // stash signs its commits from the repository config alone.
    const author=await identity(ctx,"committer");
    await git.setConfig({ ...repo, path:"user.name", value:author.name });
    await git.setConfig({ ...repo, path:"user.email", value:author.email });
    borrowedIdentity=true;
  }
  const before=await head(ctx);
  let dropped;
  if (op==="pop" || op==="drop") {
    const reflog=(await readFile(join(repo.gitdir,"logs","refs","stash"),"utf8").catch(()=>"")).split("\n").filter(Boolean).reverse();
    dropped=reflog[refIdx]?.split(" ")[1];
  }
  let result;
  try { result=await git.stash({ ...repo, op, message:options.message?.join("\n\n"), refIdx }); }
  finally {
    if (borrowedIdentity) {
      await git.setConfig({ ...repo, path:"user.name", value:localName });
      await git.setConfig({ ...repo, path:"user.email", value:localEmail });
    }
  }
  if (op==="push") {
    // isomorphic-git stores `<message>: <head> <subject>` in the reflog. Git's
    // public stash name is `On <branch>: <message>` for an explicit message.
    const file=join(repo.gitdir,"logs","refs","stash");
    const reflog=await readFile(file,"utf8");
    const rows=reflog.trimEnd().split("\n");
    const current=await branchName(ctx);
    const message=options.message?.join("\n\n");
    const label=message?`On ${current}: ${message}`:`WIP on ${current}: ${short(before)} ${subject((await git.readCommit({ ...repo, oid:before })).commit.message)}`;
    rows[rows.length-1]=rows.at(-1).replace(/\t.*$/,`\t${label}`);
    await writeFile(file,rows.join("\n")+"\n");
  }
  if (op==="list") { for (const [index,line] of (result??[]).entries()) ctx.out(`stash@{${index}}: ${line.replace(/^\S+\s+/,"")}\n`); return; }
  if (options.quiet) return;
  if (op==="push") {
    const current=await branchName(ctx);
    ctx.out(`Saved working directory and index state ${options.message?.[0]?`On ${current}: ${options.message[0]}`:`WIP on ${current}: ${short(before)} ${subject((await git.readCommit({ ...repo, oid:before })).commit.message)}`}\n`);
  }
  if (op==="pop" || op==="apply") ctx.out(await statusText(ctx,{}));
  if (op==="pop" || op==="drop") ctx.out(`Dropped refs/stash@{${refIdx}} (${dropped})\n`);
}

async function show(ctx,argv) {
  const { options,positional }=parse(argv,{ stat:"stat", oneline:"oneline", "no-patch":"noPatch", s:"noPatch", color:"color", "no-color":"noColor" });
  if (positional.length>1) throw new Error("this port shows one object at a time");
  if (options.color) ctx.colour=true;
  if (options.noColor) ctx.colour=false;
  const oid=await revision(ctx,positional[0]??"HEAD");
  const repo=await base(ctx);
  const object=await git.readObject({ ...repo, oid, format:"parsed" });
  // An annotated tag: its header and message, then what it points to.
  if (object.type==="tag") {
    const { tag }=object.object, { tagger,message }=object.object;
    const body=message.replace(/\n*$/,"\n");
    ctx.out(options.oneline?`${ctx.paint("yellow",`tag ${tag}`)}\n\n${body}`:`${ctx.paint("yellow",`tag ${tag}`)}\nTagger: ${tagger.name} <${tagger.email}>\nDate:   ${gitDate(tagger)}\n\n${body}\n`);
    return show(ctx,[...argv.filter((a)=>a!==positional[0]),object.object.object]);
  }
  if (object.type!=="commit") return catFile(ctx,["-p",oid]);
  const entry={ oid,commit:object.object };
  const names=ctx.decorate?await decorations(ctx):undefined;
  if (options.oneline) ctx.out(`${ctx.paint("yellow",short(oid))}${decorate(ctx,names,oid)} ${subject(entry.commit.message)}\n`);
  else ctx.out(mediumCommit(ctx,entry,names));
  if (options.noPatch) return;
  if (!options.oneline) ctx.out("\n");
  let parent=object.object.parent[0];
  // At a shallow clone's boundary the parent is not there: a root commit.
  if (parent) { try { await git.readObject({ ...repo, oid:parent, format:"deflated" }); } catch { parent=undefined; } }
  return diff(ctx,[...(options.stat?["--stat"]:[]),parent??EMPTY_TREE,oid]);
}

async function version(ctx) {
  ctx.out(`git version 2.47.0.isomorphic-git.${VERSION} (bunproot)\n`);
}

// ---------------------------------------------------------------- table

export const commands={
  init:        { usage:"init [-q] [--bare] [-b <branch>] [<directory>]", run:init },
  clone:       { usage:"clone [--depth <n> | --shallow-since <date>] [--shallow-exclude <ref>] [-b <branch>] [--single-branch] [--no-tags] [-n] [-q] [--progress] <repository> [<directory>]", run:clone },
  add:         { usage:"add [-A | -u] [-n] [-v] [--] <pathspec>...", run:add },
  rm:          { usage:"rm [--cached] [-r] [-q] [--] <pathspec>...", run:remove },
  mv:          { usage:"mv [-f] <source>... <destination>", run:move },
  commit:      { usage:"commit [-a] [-q] [--amend] [--reset-author] [--allow-empty] [--author=<author>] [--date=<date>] [-m <msg> | -F <file>] [--] [<pathspec>...]", run:commit },
  status:      { usage:"status [-s | --porcelain] [-b] [--ignored] [--] [<pathspec>...]", run:status },
  log:         { usage:"log [--all] [-n <count>] [--oneline] [--format=<format>] [--since=<date>] [--follow] [--reverse] [<revision> | <rev>..<rev> | <rev>...<rev>] [-- <path>]", run:log },
  show:        { usage:"show [--stat | --no-patch] [--oneline] [<object>]", run:show },
  branch:      { usage:"branch [-a | -r] | branch <name> [<start-point>] | branch (-d | -D | -m | -M | -u <upstream>) ... | branch --show-current", run:branch },
  checkout:    { usage:"checkout [-f] [-q] <branch> | checkout -b <new-branch> [<start-point>] | checkout [<tree-ish>] -- <pathspec>...", run:checkout },
  switch:      { usage:"switch [-f] [-q] <branch> | switch -c <new-branch> [<start-point>]", run:switchBranch },
  restore:     { usage:"restore [--staged] [--worktree] [--source=<tree-ish>] [--] <pathspec>...", run:restore },
  reset:       { usage:"reset [--soft | --mixed | --hard] [-q] [<commit>] | reset [<tree-ish>] [--] <pathspec>...", run:reset },
  tag:         { usage:"tag [-l [<pattern>]] | tag [-a] [-m <msg>] [-f] <tagname> [<commit>] | tag -d <tagname>...", run:tag },
  remote:      { usage:"remote [-v] | remote add <name> <url> | remote remove <name> | remote get-url <name> | remote set-url <name> <url>", run:remote },
  fetch:       { usage:"fetch [--depth <n> | --deepen <n> | --shallow-since <date>] [--shallow-exclude <ref>] [--tags] [-p] [-q] [--all] [--progress] [<remote> [<branch>]]", run:fetch },
  pull:        { usage:"pull [--ff-only | --no-ff] [-q] [--progress] [<remote> [<branch>]]", run:pull },
  push:        { usage:"push [-u] [-f] [-d] [--tags] [--all] [-q] [--progress] [<remote> [<refspec>...]]", run:push },
  merge:       { usage:"merge [--no-ff | --ff-only] [-m <msg>] [--allow-unrelated-histories] <branch> | merge --abort", run:merge },
  diff:        { usage:"diff [--cached] [--check | --stat | --name-only | --name-status] [-U<n>] [--exit-code] [--no-renames] [<commit> [<commit>] | <commit>..<commit> | <commit>...<commit>] [--] [<path>...] | diff --no-index [<options>] <path> <path>", run:diff },
  "check-ignore":{ usage:"check-ignore [-q] [--no-index] <pathname>...", run:checkIgnore },
  "merge-base": { usage:"merge-base [-a] <commit> <commit>... | merge-base --is-ancestor <commit> <commit>", run:mergeBase },
  "cherry-pick":{ usage:"cherry-pick [-n] <commit> | cherry-pick (--continue | --skip | --abort)", run:cherryPick },
  "rev-parse": { usage:"rev-parse [--short] [--abbrev-ref] [--verify] <revision>... | rev-parse --show-toplevel | --git-dir | --is-inside-work-tree | --show-prefix", run:revParse },
  "ls-files":  { usage:"ls-files [-s] [-o] [-z] [--full-name] [--] [<path>...]", run:lsFiles },
  "show-ref":  { usage:"show-ref [--heads] [--tags] [-d] [-s] [<pattern>...]", run:showRef },
  "ls-remote": { usage:"ls-remote [--heads] [--tags] [--refs] [--symref] [--exit-code] [<remote or url> [<pattern>...]]", run:lsRemote },
  config:      { usage:"config [--global | --local] <name> [<value>] | config --get <name> | config --unset <name> | config --list | config --add <name> <value>", run:configCommand },
  "cat-file":  { usage:"cat-file (-t | -s | -e | -p) <object>", run:catFile },
  "hash-object":{ usage:"hash-object [-t <type>] [-w] [--stdin | --stdin-paths | <file>...]", run:hashObject },
  "write-tree":{ usage:"write-tree", run:writeTreeCommand },
  mktree:      { usage:"mktree [-z] [--missing] [--batch]", run:mkTree },
  "commit-tree":{ usage:"commit-tree <tree> [-p <parent>]... [-m <message> | -F <file>]...", run:commitTree },
  mktag:       { usage:"mktag", run:mkTag },
  notes:       { usage:"notes [--ref <notes-ref>] [list | show | add | append | copy | remove | prune | get-ref] [-m <msg> | -F <file>] [--allow-empty] ...", run:notes },
  "update-ref":{ usage:"update-ref [-m <reason>] <refname> <new-oid> [<old-oid>] | update-ref -d <refname> [<old-oid>] | update-ref --stdin", run:updateRef },
  stash:       { usage:"stash [push [-m <msg>] | pop [<n>] | apply [<n>] | drop [<n>] | list | clear]", run:stash },
  version:     { usage:"version", run:version },
};
