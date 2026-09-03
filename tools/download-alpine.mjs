#!/usr/bin/env bun

import { renameSync, unlinkSync } from 'node:fs';
import https from 'node:https';
import { createInterface } from 'node:readline/promises';

const ALPINE_VERSION = '3.24.1';
const ARCH = 'aarch64';
const MAIN_VERSION = ALPINE_VERSION.split('.').slice(0, 2).join('.');
const FILE = `alpine-minirootfs-${ALPINE_VERSION}-${ARCH}.tar.gz`;
const BASE_URL = 'https://dl-cdn.alpinelinux.org/alpine';
const URL = `${BASE_URL}/v${MAIN_VERSION}/releases/${ARCH}/${FILE}`;
const TEMP_FILE = `${FILE}.part`;

function fail(message) {
  console.error(`download_alpine: ${message}`);
  process.exit(1);
}

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      rejectUnauthorized: false,
      headers: { 'user-agent': 'buninu-download-alpine/1' },
    }, response => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 5) return reject(new Error(`too many redirects: ${url}`));
        return resolve(download(new URL(response.headers.location, url), redirects + 1));
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${status}: ${url}`));
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

function sha256(bytes) {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

let checksumText;
try {
  checksumText = (await download(`${URL}.sha256`)).toString('utf8');
} catch (error) {
  fail(error?.message || String(error));
}

const expected = checksumText.match(/\b[0-9a-fA-F]{64}\b/)?.[0]?.toLowerCase();
if (!expected) fail(`invalid SHA-256 response from ${URL}.sha256`);

console.log('This script downloads an unmodified Alpine Linux minimal root filesystem directly from the official Alpine Linux distribution servers.');
console.log(`\x1b[32m URL: ${URL}`);
console.log(` Hash: ${expected}  ${FILE}\x1b[0m`);

const prompt = createInterface({ input: process.stdin, output: process.stdout });
let answer;
try {
  answer = await prompt.question('Continue? 繼續嗎？(Y/n)');
} finally {
  prompt.close();
}
if (/^n/i.test(answer.trim())) fail('User cancelled download!');

let bytes;
if (await Bun.file(FILE).exists()) {
  console.log('File already exists; verifying it.');
  bytes = new Uint8Array(await Bun.file(FILE).arrayBuffer());
} else {
  try {
    bytes = await download(URL);
    await Bun.write(TEMP_FILE, bytes);
  } catch (error) {
    try { unlinkSync(TEMP_FILE); } catch {}
    fail(error?.message || String(error));
  }
}

console.log('Doing SHA-256 checksum for file integrity...');
const actual = sha256(bytes);
if (actual !== expected) {
  if (await Bun.file(TEMP_FILE).exists()) unlinkSync(TEMP_FILE);
  fail(`checksum mismatch\nexpected: ${expected}\nactual:   ${actual}`);
}

if (await Bun.file(TEMP_FILE).exists()) renameSync(TEMP_FILE, FILE);
console.log(`${FILE}: OK`);
