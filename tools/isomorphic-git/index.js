#!/usr/bin/env bun
// The entry point behind `bunproot --git`: makes sure the locked isomorphic-git
// is installed, reads Git's global options, and hands the command line to the
// matching entry in commands.js.  Meant to sit behind
// `alias git='bunx bunproot --git'`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { destination, parseClone } from "./options.js";

export { destination, parseClone };

const directory=import.meta.dir;
const expected="1.41.9";

function installed() {
  try {
    const pkg=JSON.parse(readFileSync(join(directory,"node_modules/isomorphic-git/package.json"),"utf8"));
    return pkg.version===expected;
  } catch { return false; }
}

export function confirmInstall(yes, ask=prompt) {
  if (yes) return;
  // Bun can return null for an empty interactive line when no default is
  // supplied, making Enter indistinguishable from EOF. Give prompt an
  // explicit default so the conventional uppercase Y really means yes.
  const answer=ask("Install now? (Y/n)","y");
  if (answer===null || !["","y","yes"].includes(answer.trim().toLowerCase()))
    throw new Error("isomorphic-git installation cancelled");
}

function install(yes=false) {
  if (installed()) return;
  const bun=Bun.which("bun")||process.argv0;
  const command=[bun,"install","--frozen-lockfile","--ignore-scripts","--production"];
  console.error([
    "bunproot --git uses",
    `isomorphic-git ${expected}.`,
    "The lock fixes all 55 packages.",
    "They will be downloaded from npm.",
    "Lifecycle scripts are disabled.",
    "Bun.spawnSync will run:",
    "  cwd:",
    `    ${directory}`,
    "  cmd:",
  ].join("\n"));
  console.error(command);
  confirmInstall(yes);
  Bun.spawnSync({
    cmd:command,
    cwd:directory,
    stdin:"inherit", stdout:"inherit", stderr:"inherit",
  });
  // Do not trust Bun install's exit status here. Before oven-sh/bun#39060 was
  // fixed it could report failure after completing the installation. The
  // locked package on disk is the result this command actually needs.
  if (!installed())
    throw new Error(`could not install the locked isomorphic-git ${expected}`);
}

// Git's own global options: the ones that change where or how a command runs.
// Anything after the command name belongs to the command.
export function parseGlobal(argv) {
  const global={ overrides:{}, directories:[], yes:false };
  let index=0;
  for (; index<argv.length; index++) {
    const argument=argv[index];
    if (argument==="--version") return { ...global, command:"version", argv:[] };
    if (argument==="--help" || argument==="-h") return { ...global, command:"help", argv:argv.slice(index+1) };
    if (argument==="--readme") return { ...global, command:"readme", argv:[] };
    if (argument==="--yes") { global.yes=true; continue; }
    if (argument==="-C") { global.directories.push(argv[++index]??"."); continue; }
    if (argument.startsWith("-C") && argument.length>2) { global.directories.push(argument.slice(2)); continue; }
    if (argument==="-c") {
      const setting=argv[++index];
      if (setting===undefined) throw new Error("option '-c' requires a value");
      const equals=setting.indexOf("=");
      global.overrides[equals<0?setting:setting.slice(0,equals)]=equals<0?"true":setting.slice(equals+1);
      continue;
    }
    if (argument.startsWith("-c") && argument.length>2 && argument[2]!=="-") { argv.splice(index+1,0,argument.slice(2)); continue; }
    if (argument==="-P" || argument==="--no-pager" || argument==="--paginate" || argument==="-p" || argument==="--no-replace-objects" || argument==="--literal-pathspecs") continue;
    if (argument.startsWith("-")) throw new Error(`unknown option: ${argument}`);
    break;
  }
  return { ...global, command:argv[index], argv:argv.slice(index+1) };
}

// The everyday commands first, then the rest; both in alphabetical order,
// the way README.md lists them.
const EVERYDAY=["add","branch","checkout","clone","commit","config","diff","fetch","init","log","merge","mv","pull","push","remote","reset","restore","rm","show","stash","status","switch","tag"];
function help(commands,name) {
  if (name && commands[name]) return `usage: git ${commands[name].usage}\n`;
  const usage=(n)=>`   ${n.padEnd(13)}${commands[n].usage.replace(/^\S+\s*/,"")}`;
  const everyday=EVERYDAY.filter((n)=>commands[n]);
  const rest=Object.keys(commands).filter((n)=>!EVERYDAY.includes(n)).sort();
  return `usage: git [--yes] [-C <path>] [-c <name>=<value>] <command> [<args>]\n\n`+
    `These are the Git commands this port understands, backed by isomorphic-git ${expected}.\n\nThe everyday ones:\n\n`+
    everyday.map(usage).join("\n")+`\n\nLess often:\n\n`+rest.map(usage).join("\n")+
    `\n\nSee 'git <command> --help' for a command's options and 'git --readme' for the guide. alias git='bunx bunproot --git'\n`;
}

// The guide next to this file, for `git --readme`; it needs nothing
// installed.  Rendered the way `bunproot --readme` renders its own: Bun's
// ANSI markdown with clickable links, coloured whether or not it goes to a
// pipe, at the terminal's width when there is one.  `raw` returns the
// markdown itself.
export function readme({ raw=false, columns=process.stdout.columns }={}) {
  const markdown=readFileSync(join(directory,"README.md"),"utf8");
  if (raw) return markdown;
  return Bun.markdown.ansi(markdown,columns?{ hyperlinks:true, columns }:{ hyperlinks:true });
}

export async function run(argv) {
  const global=parseGlobal([...argv]);
  if (global.command===undefined) throw new Error(help({}).split("\n")[0].replace(/^usage: /,"usage: ")+"\n"+`use 'bunproot --git --help' for the command list`);
  if (global.command==="readme") { process.stdout.write(readme()); return 0; }
  install(global.yes);
  const { commands,context,smudgeIndex,httpFailure }=await import("./commands.js");
  if (global.command==="help") { process.stdout.write(help(commands,global.argv[0])); return 0; }
  const command=commands[global.command];
  if (!command) throw new Error(`'${global.command}' is not a git command this port supports. See 'git --help'.`);
  if (global.argv.includes("--help") || global.argv.includes("-h") && !["log","status","ls-remote"].includes(global.command)) {
    process.stdout.write(help(commands,global.command)); return 0;
  }
  for (const directory of global.directories) process.chdir(directory);
  const ctx=context({ overrides:global.overrides });
  try {
    return (await command.run(ctx,global.argv))??0;
  } catch (error) {
    // A Git-level failure is reported the way Git reports it, with Git's
    // exit status; only the wrapper's own problems propagate to the caller.
    process.stderr.write(`${error.prefix??"fatal"}: ${httpFailure(error)??error.message}\n${error.hint?`hint: ${error.hint}\n`:""}`);
    return error.exitCode??128;
  } finally {
    if (ctx.opened()) await smudgeIndex(ctx.opened().gitdir);
  }
}
