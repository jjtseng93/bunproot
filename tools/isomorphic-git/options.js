// Git-style argument parsing, shared by every command in commands.js and by
// the entry point.  Kept free of isomorphic-git so the unit tests can load it
// before the locked helper has been installed.
import { basename, resolve } from "node:path";

// A spec maps an option name, written without its dashes, to what it sets:
//
//   quiet:"quiet"                     boolean flag, options.quiet=true
//   depth:["depth"]                   takes a value, options.depth=value
//   m:["message",(value,prev)=>...]   takes a value, stored through a reducer
//   decorate:["decorate",null,true]   the value is optional: `--decorate` alone
//                                     stores true, `--decorate=short` the value
//   "<n>":["maxCount"]                the -<digits> shorthand, as in `log -5`
//
// Single-character names are short options and may be clustered (`-am msg`);
// the rest of a cluster after a value-taking option is that option's value
// (`-n5`).  Long options accept `--name=value` and `--name value`.  Options
// and positionals may be interleaved the way Git allows; `--` ends options,
// and what follows it is also returned separately as `paths`.
export function parse(argv,spec) {
  const options={}, positional=[];
  let paths=null;
  const apply=(name,inline,shown,index)=>{
    const definition=spec[name];
    if (definition===undefined) throw new Error(`unknown option '${shown}'`);
    if (typeof definition==="string") {
      if (inline!==undefined) throw new Error(`option '${shown}' takes no value`);
      options[definition]=true;
      return index;
    }
    const [key,reduce,optional]=definition;
    let value=inline;
    if (value===undefined && optional) { options[key]=true; return index; }
    if (value===undefined) {
      if (index+1>=argv.length) throw new Error(`option '${shown}' requires a value`);
      value=argv[++index];
    }
    options[key]=reduce?reduce(value,options[key]):value;
    return index;
  };
  for (let index=0; index<argv.length; index++) {
    const argument=argv[index];
    if (argument==="--") { paths=argv.slice(index+1); positional.push(...paths); break; }
    if (argument==="-" || !argument.startsWith("-")) { positional.push(argument); continue; }
    if (argument.startsWith("--")) {
      const equals=argument.indexOf("=");
      const name=equals<0?argument.slice(2):argument.slice(2,equals);
      index=apply(name,equals<0?undefined:argument.slice(equals+1),`--${name}`,index);
      continue;
    }
    for (let at=1; at<argument.length; at++) {
      const name=argument[at];
      if (/\d/.test(name) && spec["<n>"]) { index=apply("<n>",argument.slice(at),argument,index); break; }
      const definition=spec[name];
      if (Array.isArray(definition)) {
        index=apply(name,argument.slice(at+1)||undefined,`-${name}`,index);
        break;
      }
      index=apply(name,undefined,`-${name}`,index);
    }
  }
  return { options,positional,paths };
}

// Reducers for options that may be repeated.
export const list=(value,previous=[])=>[...previous,value];
export const count=(value)=>{
  const number=Number(value);
  if (!Number.isSafeInteger(number) || number<0) throw new Error(`'${value}' is not a number`);
  return number;
};
export const positiveDepth=(value)=>{
  const number=Number(value);
  if (!Number.isSafeInteger(number) || number<1) throw new Error("depth must be a positive integer");
  return number;
};

export function destination(url) {
  const clean=url.replace(/[?#].*$/,"/").replace(/\/+$/,""), tail=clean.slice(clean.lastIndexOf("/")+1);
  const scp=tail||clean.slice(clean.lastIndexOf(":")+1);
  return basename(scp).replace(/\.git$/i,"")||"repository";
}

const cloneSpec={
  q:"quiet", quiet:"quiet",
  n:"noCheckout", "no-checkout":"noCheckout",
  "single-branch":"singleBranch", "no-single-branch":"multiBranch",
  "no-tags":"noTags",
  b:["ref"], branch:["ref"],
  o:["remote"], origin:["remote"],
  depth:["depth",positiveDepth],
};

export function parseClone(argv,cwd=process.cwd()) {
  const { options,positional }=parse(argv,cloneSpec);
  const { multiBranch,...rest }=options;
  const settings={ singleBranch:false, noCheckout:false, noTags:false, quiet:false, remote:"origin", ...rest };
  if (multiBranch) settings.singleBranch=false;
  if (positional.length<1) throw new Error("you must specify a repository to clone");
  if (positional.length>2) throw new Error("too many arguments");
  return { ...settings, url:positional[0], dir:resolve(cwd,positional[1]??destination(positional[0])) };
}
