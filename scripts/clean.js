import fs from 'fs';

const dirs = ['dist', 'bin', 'the-brain'];

dirs.forEach(dir => {
  if (fs.existsSync(dir)) {
    console.log(`Cleaning ${dir}...`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log('Clean complete.');
