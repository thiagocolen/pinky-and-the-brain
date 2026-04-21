import fs from 'fs';
import path from 'path';

const targetDir = 'the-brain';

console.log('--- Packaging Assets for .exe ---');

const listFiles = (dir) => {
    if (!fs.existsSync(dir)) {
        console.log(`Directory ${dir} not found.`);
        return;
    }

    const files = fs.readdirSync(dir);
    files.forEach(file => {
        const fullPath = path.join(dir, file);
        if (fs.lstatSync(fullPath).isDirectory()) {
            listFiles(fullPath);
        } else {
            console.log(`  [ASSET] ${path.relative('.', fullPath)}`);
        }
    });
};

listFiles(targetDir);
console.log('---------------------------------');
