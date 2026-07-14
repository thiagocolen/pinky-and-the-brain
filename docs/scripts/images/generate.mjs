#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { targets } from './manifest.mjs';
import { STATIC_IMG_DIR, CONFIG_PATH, ensureDir, resolveFromCwd } from './util.mjs';

const FAVICON_SIZES = [16, 32, 48];

const { values } = parseArgs({
  options: {
    source: { type: 'string', short: 's' },
    'skip-config': { type: 'boolean', default: false },
  },
});

if (!values.source) {
  console.error('Usage: node scripts/images/generate.mjs --source <path-to-image> [--skip-config]');
  process.exit(1);
}

const sourcePath = resolveFromCwd(values.source);

async function buildFavicon() {
  const buffers = await Promise.all(
    FAVICON_SIZES.map((size) =>
      sharp(sourcePath)
        .resize(size, size, { fit: 'cover', position: 'centre' })
        .png()
        .toBuffer()
    )
  );
  const icoBuffer = await pngToIco(buffers);
  const outPath = path.join(STATIC_IMG_DIR, 'favicon.ico');
  await ensureDir(outPath);
  await writeFile(outPath, icoBuffer);
  console.log(`  wrote ${path.relative(process.cwd(), outPath)}`);
}

async function buildTarget(target) {
  const outPath = path.join(STATIC_IMG_DIR, target.file);
  await ensureDir(outPath);

  let pipeline;
  if (target.op === 'contain') {
    pipeline = sharp(sourcePath).resize(target.width, target.height, {
      fit: 'contain',
      background: target.background ?? { r: 0, g: 0, b: 0, alpha: 0 },
    });
  } else if (target.op === 'cover') {
    pipeline = sharp(sourcePath).resize(target.width, target.height, {
      fit: 'cover',
      position: target.position ?? 'centre',
    });
  } else {
    throw new Error(`Unknown op "${target.op}" for target ${target.file}`);
  }

  if (target.format === 'jpg' || target.format === 'jpeg') {
    pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: target.quality ?? 85 });
  } else if (target.format === 'webp') {
    pipeline = pipeline.webp({ quality: target.quality ?? 85 });
  } else {
    pipeline = pipeline.png({ compressionLevel: 9 });
  }

  await pipeline.toFile(outPath);
  console.log(`  wrote ${path.relative(process.cwd(), outPath)}`);
}

// Repoints docusaurus.config.ts at the generated logo.png and wires up the
// social card as the default OG/Twitter image, since a raster source can't
// become the vector logo.svg the config previously pointed at.
async function patchDocusaurusConfig() {
  let content = await readFile(CONFIG_PATH, 'utf8');
  let changed = false;

  if (content.includes("src: 'img/logo.svg'")) {
    content = content.replace("src: 'img/logo.svg'", "src: 'img/logo.png'");
    changed = true;
  }

  if (!/\bimage:\s*'img\//.test(content)) {
    content = content.replace(
      /themeConfig:\s*\{\r?\n/,
      (match) => `${match}    image: 'img/docusaurus-social-card.jpg',\r\n`
    );
    changed = true;
  }

  if (changed) {
    await writeFile(CONFIG_PATH, content, 'utf8');
    console.log(`  patched ${path.relative(process.cwd(), CONFIG_PATH)}`);
  }
}

async function main() {
  console.log(`Generating image assets from ${sourcePath}`);
  await buildFavicon();
  for (const target of targets) {
    await buildTarget(target);
  }
  if (!values['skip-config']) {
    await patchDocusaurusConfig();
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
