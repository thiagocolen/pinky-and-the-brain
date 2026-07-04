import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const logPath = path.resolve(projectRoot, 'agent.log');

const DEFAULT_TAIL_LINES = 50;

function startTailing(filePath, tailLinesCount) {
  console.log(`📋 Tailing logs from: ${path.relative(projectRoot, filePath)}`);
  console.log(`🔔 Watching for changes... Press Ctrl+C to stop.\n`);

  let currentSize = 0;
  let watcher = null;

  const checkAndRead = () => {
    try {
      if (!fs.existsSync(filePath)) {
        return;
      }

      const stats = fs.statSync(filePath);
      
      // If file was truncated/recreated
      if (stats.size < currentSize) {
        console.log('\n🔄 Log file was truncated or restarted.');
        currentSize = 0;
      }

      if (currentSize === 0) {
        // First run: tail the last N lines
        const fd = fs.openSync(filePath, 'r');
        const readLength = Math.min(stats.size, 65536); // read up to 64KB
        const buffer = Buffer.alloc(readLength);
        const position = stats.size - readLength;

        fs.readSync(fd, buffer, 0, readLength, position);
        fs.closeSync(fd);

        const content = buffer.toString('utf-8');
        const lines = content.split(/\r?\n/);
        
        // Trim trailing empty line if it exists
        if (lines.length > 0 && lines[lines.length - 1] === '') {
          lines.pop();
        }

        const tailLines = lines.slice(-tailLinesCount);
        if (tailLines.length > 0) {
          process.stdout.write(tailLines.join('\n') + '\n');
        }
        currentSize = stats.size;
      } else if (stats.size > currentSize) {
        // Read only the new content
        const fd = fs.openSync(filePath, 'r');
        const newBytes = stats.size - currentSize;
        const buffer = Buffer.alloc(newBytes);

        fs.readSync(fd, buffer, 0, newBytes, currentSize);
        fs.closeSync(fd);

        process.stdout.write(buffer.toString('utf-8'));
        currentSize = stats.size;
      }
    } catch (err) {
      console.error(`❌ Error reading log file: ${err.message}`);
    }
  };

  // Run immediately for the initial tail
  checkAndRead();

  // Setup watcher
  const setupWatcher = () => {
    if (watcher) {
      watcher.close();
    }
    
    // Watch parent directory if the file does not exist yet
    const targetToWatch = fs.existsSync(filePath) ? filePath : projectRoot;
    
    watcher = fs.watch(targetToWatch, (eventType, filename) => {
      // If we were watching the directory, check if the log file was created
      if (targetToWatch === projectRoot) {
        if (filename === path.basename(filePath) && fs.existsSync(filePath)) {
          console.log(`📝 Log file detected! Starting watch...`);
          setupWatcher();
          checkAndRead();
        }
      } else {
        checkAndRead();
      }
    });

    watcher.on('error', (err) => {
      // If file gets deleted/re-created, restart watcher
      setTimeout(setupWatcher, 1000);
    });
  };

  setupWatcher();
}

startTailing(logPath, DEFAULT_TAIL_LINES);
