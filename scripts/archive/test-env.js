import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

console.log("=== Node Process Environment Diagnostic ===");
console.log("process.cwd():", process.cwd());
console.log("process.env.GOOGLE_API_KEY (from shell):", process.env.GOOGLE_API_KEY ? "DEFINED" : "UNDEFINED");
console.log("process.env.OPENAI_API_KEY (from shell):", process.env.OPENAI_API_KEY ? "DEFINED" : "UNDEFINED");

// Let's test loading dotenv relative to this script
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../");
const dotenvPath = path.join(rootDir, ".env");
console.log("Targeting .env at:", dotenvPath);

const result = dotenv.config({ path: dotenvPath });
if (result.error) {
  console.log("Dotenv load error:", result.error.message);
} else {
  console.log("Dotenv loaded successfully!");
}

console.log("process.env.GOOGLE_API_KEY (after dotenv):", process.env.GOOGLE_API_KEY ? "DEFINED" : "UNDEFINED");
console.log("process.env.OPENAI_API_KEY (after dotenv):", process.env.OPENAI_API_KEY ? "DEFINED" : "UNDEFINED");
