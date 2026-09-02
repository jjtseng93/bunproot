#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const sourceRoot = join(import.meta.dir, "..", "src");
const outputRoot = import.meta.dir;

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

for (const source of walk(sourceRoot)) {
  if (!/[.]([ch])$/.test(source)) continue;
  const sourceName = relative(sourceRoot, source);
  const output = join(outputRoot, `${sourceName}.js`);
  if (existsSync(output)) continue;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output,
    `/** ESM port placeholder for src/${sourceName}. */\n` +
    `export const sourceModule = ${JSON.stringify(`src/${sourceName}`)};\n` +
    `export const portStatus = "pending";\n`);
}
