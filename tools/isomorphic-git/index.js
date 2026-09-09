#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

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
    `bunproot --git uses isomorphic-git ${expected}.`,
    "Its lockfile fixes all 55 packages in the reviewed production dependency tree.",
    "The first run will download them from the npm registry with lifecycle scripts disabled.",
    "Bun.spawnSync will run:",
    `  cwd: ${directory}`,
    `  ${command.map((part)=>JSON.stringify(part)).join(" ")}`,
  ].join("\n"));
  const answer=prompt("Install the locked isomorphic-git dependencies now? (Y/n)");
  if (answer===null || !["","y","yes"].includes(answer.trim().toLowerCase()))
    throw new Error("isomorphic-git installation cancelled");
  const result=Bun.spawnSync({
    cmd:command,
    cwd:directory,
    stdin:"inherit", stdout:"inherit", stderr:"inherit",
  });
  if (result.exitCode!==0 || !installed())
    throw new Error(`could not install the locked isomorphic-git ${expected}`);
}

function value(argv,index,flag) {
  if (index+1>=argv.length) throw new Error(`option '${flag}' requires a value`);
  return argv[index+1];
}

export function destination(url) {
  const clean=url.replace(/[?#].*$/,"/").replace(/\/+$/,""), tail=clean.slice(clean.lastIndexOf("/")+1);
  const scp=tail||clean.slice(clean.lastIndexOf(":")+1);
  return basename(scp).replace(/\.git$/i,"")||"repository";
}

export function parseClone(argv) {
  const options={ singleBranch:false, noCheckout:false, noTags:false, quiet:false, remote:"origin" };
  const positional=[];
  for (let index=0, parsing=true; index<argv.length; index++) {
    const argument=argv[index];
    if (parsing && argument==="--") { parsing=false; continue; }
    if (!parsing || argument==="-" || !argument.startsWith("-")) { positional.push(argument); continue; }
    if (argument==="-q" || argument==="--quiet") { options.quiet=true; continue; }
    if (argument==="-n" || argument==="--no-checkout") { options.noCheckout=true; continue; }
    if (argument==="--single-branch") { options.singleBranch=true; continue; }
    if (argument==="--no-single-branch") { options.singleBranch=false; continue; }
    if (argument==="--no-tags") { options.noTags=true; continue; }
    if (argument==="-b" || argument==="--branch") { options.ref=value(argv,index,argument); index++; continue; }
    if (argument.startsWith("--branch=")) { options.ref=argument.slice(9); continue; }
    if (argument==="-o" || argument==="--origin") { options.remote=value(argv,index,argument); index++; continue; }
    if (argument.startsWith("--origin=")) { options.remote=argument.slice(9); continue; }
    if (argument==="--depth") { options.depth=Number(value(argv,index,argument)); index++; }
    else if (argument.startsWith("--depth=")) options.depth=Number(argument.slice(8));
    else throw new Error(`unknown option '${argument}'`);
    if (!Number.isSafeInteger(options.depth) || options.depth<1)
      throw new Error("depth must be a positive integer");
  }
  if (positional.length<1) throw new Error("you must specify a repository to clone");
  if (positional.length>2) throw new Error("too many arguments");
  return { ...options, url:positional[0], dir:resolve(positional[1]??destination(positional[0])) };
}

export async function run(argv) {
  if (argv[0]!=="clone") throw new Error(argv.length===0
    ?"usage: bunproot --git clone [OPTION ...] REPOSITORY [DIRECTORY]"
    :`'${argv[0]}' is not a supported git command; this version supports only 'clone'`);
  const options=parseClone(argv.slice(1));
  install();
  const [{ clone },{ default:http },{ default:fs }]=await Promise.all([
    import("isomorphic-git"), import("isomorphic-git/http/web"), import("node:fs")
  ]);
  if (!options.quiet) console.error(`Cloning into '${options.dir}'...`);
  const { quiet,...cloneOptions }=options;
  await clone({ fs, http, ...cloneOptions,
    onMessage:quiet?undefined:(message)=>process.stderr.write(message),
  });
  return 0;
}
