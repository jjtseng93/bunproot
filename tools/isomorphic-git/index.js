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

function install() {
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
  // Bun can return null for an empty interactive line when no default is
  // supplied, making Enter indistinguishable from EOF. Give prompt an
  // explicit default so the conventional uppercase Y really means yes.
  const answer=prompt("Install now? (Y/n)","y");
  if (answer===null || !["","y","yes"].includes(answer.trim().toLowerCase()))
    throw new Error("isomorphic-git installation cancelled");
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
  const global={ overrides:{}, directories:[] };
  let index=0;
  for (; index<argv.length; index++) {
    const argument=argv[index];
    if (argument==="--version") return { ...global, command:"version", argv:[] };
    if (argument==="--help" || argument==="-h") return { ...global, command:"help", argv:argv.slice(index+1) };
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

function help(commands,name) {
  if (name && commands[name]) return `usage: git ${commands[name].usage}\n`;
  const names=Object.keys(commands).sort();
  return `usage: git [-C <path>] [-c <name>=<value>] <command> [<args>]\n\n`+
    `These are the Git commands this port understands, backed by isomorphic-git ${expected}:\n\n`+
    names.map((n)=>`   ${n.padEnd(13)}${commands[n].usage.replace(/^\S+\s*/,"")}`).join("\n")+
    `\n\nSee 'git <command> --help' for a command's options. alias git='bunx bunproot --git'\n`;
}

export async function run(argv) {
  const global=parseGlobal([...argv]);
  if (global.command===undefined) throw new Error(help({}).split("\n")[0].replace(/^usage: /,"usage: ")+"\n"+`use 'bunproot --git --help' for the command list`);
  install();
  const { commands,context,smudgeIndex }=await import("./commands.js");
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
    process.stderr.write(`${error.prefix??"fatal"}: ${error.message}\n`);
    return error.exitCode??128;
  } finally {
    if (ctx.opened()) await smudgeIndex(ctx.opened().gitdir);
  }
}
