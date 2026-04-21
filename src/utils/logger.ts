import * as fs from 'fs';
import * as path from 'path';

const LOG_FILE = path.join(process.cwd(), 'pinky-and-the-brain.log');
let devMode = false;

export const enableDevMode = () => {
    devMode = true;
};

export const log = (message: string, data?: any) => {
    if (!devMode) return;
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}${data ? ' ' + JSON.stringify(data) : ''}\n`;
    try {
        fs.appendFileSync(LOG_FILE, logMessage);
    } catch (e) {
        // Fallback to console if file logging fails, though in Ink this might be invisible
        console.error('Failed to write to log file:', e);
    }
};

export const logError = (error: any) => {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : '';
    log(`ERROR: ${message}\n${stack}`);
};
