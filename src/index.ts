import './polyfill.js'; // Ensure polyfill is first
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { App } from './components/App.js';
import { log, logError, enableDevMode } from './utils/logger.js';
import * as fs from 'fs';

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

program
  .name('pinky-and-the-brain')
  .description('A crazy little piece of software that works with your gemini-cli')
  .version('1.4.0')
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
