import fs from 'fs';
import path from 'path';

const src = process.env.PATBATPP_SRC_FOLDER;
if (src && fs.existsSync(src)) {
  console.log(`Copying knowledge from: ${src}`);

  // Ensure GEMINI.md exists (check in src or src/.gemini)
  let geminiPath = path.join(src, 'GEMINI.md');
  if (!fs.existsSync(geminiPath)) {
    geminiPath = path.join(src, '.gemini', 'GEMINI.md');
  }

  if (!fs.existsSync(geminiPath)) {
    console.error(`ERROR: Critical asset missing! Could not find GEMINI.md in ${src} or ${path.join(src, '.gemini')}`);
    process.exit(1);
  }
  
  if (!fs.existsSync('the-brain')) {
    fs.mkdirSync('the-brain', { recursive: true });
  }

  // Copy GEMINI.md to the-brain root
  fs.copyFileSync(geminiPath, path.join('the-brain', 'GEMINI.md'));
  console.log(`  [COPY] GEMINI.md (System Instruction)`);

  const copyRecursive = (source, target) => {
    const files = fs.readdirSync(source);
    files.forEach(file => {
      // Skip .gemini folder and settings.json
      if (file === '.gemini' || file === 'settings.json') {
        console.log(`  [SKIP] ${file}`);
        return;
      }

      const curSource = path.join(source, file);
      const curTarget = path.join(target, file);
      if (fs.lstatSync(curSource).isDirectory()) {
        if (!fs.existsSync(curTarget)) {
          fs.mkdirSync(curTarget, { recursive: true });
        }
        copyRecursive(curSource, curTarget);
      } else {
        fs.copyFileSync(curSource, curTarget);
        console.log(`  [COPY] ${path.relative('the-brain', curTarget)}`);
      }
    });
  };

  copyRecursive(src, 'the-brain');
  console.log('Successfully prepared the-brain');
} else {
  console.error('Error: PATBATPP_SRC_FOLDER environment variable not set or path does not exist');
  process.exit(1);
}
