import { validateConfig } from "./config.js";
import readline from "readline";
import { AcpServer } from "./protocol/acp-server.js";

try {
  validateConfig();
} catch (e: any) {
  console.error("Configuration validation failed:", e.message);
  process.exit(1);
}

const acpServer = new AcpServer();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", async (line) => {
  if (!line.trim()) return;
  const response = await acpServer.handleInput(line);
  console.log(response);
});
