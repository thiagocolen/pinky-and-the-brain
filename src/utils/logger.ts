import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../../");

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m"
};

const LEVELS: Record<string, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const getLogLevel = (): number => {
  const envLevel = (process.env.LOG_LEVEL || "INFO").toUpperCase();
  return LEVELS[envLevel] !== undefined ? LEVELS[envLevel] : 1;
};

class Logger {
  private logFilePath: string;

  constructor() {
    // Write logs to a file named "agent.log" in the project root directory
    this.logFilePath = path.join(projectRoot, "agent.log");
    
    // Ensure parent directory exists
    const logDir = path.dirname(this.logFilePath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  private write(level: string, message: string, ...args: any[]) {
    const levelVal = LEVELS[level] !== undefined ? LEVELS[level] : 1;

    const date = new Date();
    const pad = (n: number, l = 2) => String(n).padStart(l, "0");
    const timestampStr = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;

    const formattedArgs = args.map(arg => {
      if (arg instanceof Error) {
        return arg.stack || arg.message;
      }
      return typeof arg === "object" ? JSON.stringify(arg, null, 2) : arg;
    }).join(" ");
    
    const fullMessage = formattedArgs ? `${message} ${formattedArgs}` : message;
    const fileLogLine = `[${timestampStr}] [${level.padEnd(5)}] ${fullMessage}\n`;

    // 1. Write to centralized log file (always logs all levels, down to DEBUG)
    const logToFile = process.env.LOG_TO_FILE !== "false";
    if (logToFile) {
      try {
        fs.appendFileSync(this.logFilePath, fileLogLine, "utf8");
      } catch (e) {
        // Fallback if writing to file fails
      }
    }

    // 2. Write to terminal (stderr - which doesn't corrupt stdout JSON-RPC channel)
    const logToTerminal = process.env.LOG_TO_TERMINAL !== "false";
    if (logToTerminal && levelVal >= getLogLevel()) {
      const useColor = process.env.LOG_COLOR !== "false" && (process.env.LOG_COLOR === "true" || process.stderr.isTTY);

      if (useColor) {
        let levelColor = ANSI.reset;
        if (level === "DEBUG") levelColor = ANSI.gray;
        else if (level === "INFO") levelColor = ANSI.green;
        else if (level === "WARN") levelColor = ANSI.yellow;
        else if (level === "ERROR") levelColor = ANSI.red;

        // Colorize leading square bracket tags (e.g. [REST], [The Brain], [Specialists])
        let coloredMessage = fullMessage;
        const tagRegex = /^(\[[^\]]+\])/;
        const match = tagRegex.exec(fullMessage);
        if (match) {
          const tag = match[1];
          const rest = fullMessage.slice(tag.length);
          coloredMessage = `${ANSI.cyan}${tag}${ANSI.reset}${rest}`;
        }

        const termLogLine = `${ANSI.gray}[${timestampStr}]${ANSI.reset} ${levelColor}[${level.padEnd(5)}]${ANSI.reset} ${coloredMessage}\n`;
        process.stderr.write(termLogLine);
      } else {
        process.stderr.write(fileLogLine);
      }
    }
  }

  public info(message: string, ...args: any[]) {
    this.write("INFO", message, ...args);
  }

  public warn(message: string, ...args: any[]) {
    this.write("WARN", message, ...args);
  }

  public error(message: string, ...args: any[]) {
    this.write("ERROR", message, ...args);
  }

  public debug(message: string, ...args: any[]) {
    this.write("DEBUG", message, ...args);
  }
}

export const logger = new Logger();

// Catch all unhandled application errors and log them to the centralized file
process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", error.message, error.stack);
});

process.on("unhandledRejection", (reason: any) => {
  logger.error("Unhandled Rejection:", reason?.message || reason, reason?.stack || "");
});
