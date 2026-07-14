import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const STATIC_IMG_DIR = path.resolve(__dirname, '../../static/img');
export const CONFIG_PATH = path.resolve(__dirname, '../../docusaurus.config.ts');

export async function ensureDir(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

export function resolveFromCwd(p) {
  return path.resolve(process.cwd(), p);
}
