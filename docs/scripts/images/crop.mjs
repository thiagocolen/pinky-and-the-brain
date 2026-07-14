#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import sharp from 'sharp';
import { ensureDir, resolveFromCwd } from './util.mjs';

const { values } = parseArgs({
  options: {
    source: { type: 'string', short: 's' },
    out: { type: 'string', short: 'o' },
    left: { type: 'string' },
    top: { type: 'string' },
    width: { type: 'string' },
    height: { type: 'string' },
    format: { type: 'string' },
  },
});

const required = ['source', 'out', 'left', 'top', 'width', 'height'];
const missing = required.filter((key) => values[key] === undefined);
if (missing.length) {
  console.error(
    'Usage: node scripts/images/crop.mjs --source <path> --out <path> --left <n> --top <n> --width <n> --height <n> [--format png|jpg|webp]'
  );
  console.error(`Missing: ${missing.join(', ')}`);
  process.exit(1);
}

const sourcePath = resolveFromCwd(values.source);
const outPath = resolveFromCwd(values.out);
const format = values.format ?? path.extname(outPath).slice(1) ?? 'png';

async function main() {
  await ensureDir(outPath);

  let pipeline = sharp(sourcePath).extract({
    left: Number(values.left),
    top: Number(values.top),
    width: Number(values.width),
    height: Number(values.height),
  });

  if (format === 'jpg' || format === 'jpeg') {
    pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 85 });
  } else if (format === 'webp') {
    pipeline = pipeline.webp({ quality: 85 });
  } else {
    pipeline = pipeline.png();
  }

  await pipeline.toFile(outPath);
  console.log(`wrote ${path.relative(process.cwd(), outPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
