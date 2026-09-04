#!/usr/bin/env bun
import { run } from "./cli/proot.c.js";

try {
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  console.error(`bunproot: ${error.message}`);
  process.exitCode = 1;
}
