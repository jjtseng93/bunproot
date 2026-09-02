#!/usr/bin/env bun
import { run } from "./cli/proot.c.js";

try {
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  console.error(`proot-bun: ${error.message}`);
  process.exitCode = 1;
}
