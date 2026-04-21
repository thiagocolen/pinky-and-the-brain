import './polyfill.js'; // Ensure polyfill is first
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { App } from './components/App.js';
import { log, logError, enableDevMode } from './utils/logger.js';
import * as fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global error handlers
process.on('uncaughtException', (err) => {
  logError(err);
  fs.appendFileSync('FATAL_ERROR.log', (err instanceof Error ? err.stack : String(err)) + '\n');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logError(reason);
  fs.appendFileSync('FATAL_ERROR.log', 'Unhandled Rejection: ' + String(reason) + '\n');
  process.exit(1);
});

const program = new Command();

// Get version from package.json
let version = '0.0.0';
try {
  const pkgPath = (process as any).pkg 
    ? path.resolve(__dirname, '..', 'package.json')
    : path.resolve(process.cwd(), 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    version = pkg.version;
  }
} catch (e) {
  // silent fail
}

program
  .name('pinky-and-the-brain')
  .description('A crazy little piece of software that works with your gemini-cli')
  .version(version)
  .option('-c, --command <command>', 'Execute a command and exit')
  .option('-d, --development-mode', 'Enable development logging');

program.action(async (options) => {
  if (!(process as any).pkg && !process.env.PATBATPP_SRC_FOLDER) {
    console.error('Error: PATBATPP_SRC_FOLDER environment variable is not set.');
    process.exit(1);
  }

  if (options.developmentMode) {
    enableDevMode();
  }
  log('Starting pinky-and-the-brain...');

  try {
    const { waitUntilExit } = render(React.createElement(App, { 
      initialCommand: options.command 
    }));
    await waitUntilExit();
    log('Application exiting normally.');
  } catch (err) {
    logError(err);
    process.exit(1);
  }
});

program.parse(process.argv);
