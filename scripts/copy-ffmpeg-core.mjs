#!/usr/bin/env node
/**
 * Copy FFmpeg core-mt WASM files from node_modules to public/ffmpeg/
 * so they can be served from same origin (eliminating CDN download latency).
 *
 * Runs automatically after `npm install` via the "postinstall" script.
 */
import { cpSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const sourceDir = join(rootDir, 'node_modules', '@ffmpeg', 'core-mt', 'dist', 'esm');
const targetDir = join(rootDir, 'public', 'ffmpeg');

const files = [
  'ffmpeg-core.js',
  'ffmpeg-core.wasm',
  'ffmpeg-core.worker.js',
];

if (!existsSync(sourceDir)) {
  console.warn('[postinstall] @ffmpeg/core-mt not found — skipping FFmpeg core copy');
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });

for (const file of files) {
  const src = join(sourceDir, file);
  const dst = join(targetDir, file);
  if (existsSync(src)) {
    cpSync(src, dst);
  } else {
    console.warn(`[postinstall] Missing ${file} in @ffmpeg/core-mt`);
  }
}

console.log('[postinstall] FFmpeg core files copied to public/ffmpeg/');
