import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { logger } from "./utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../");

// 1. Load from the current working directory .env if present
dotenv.config({ override: true });

// 2. Load from the project root .env as a fallback
dotenv.config({ path: path.join(rootDir, ".env"), override: true });

// Disable LangSmith tracing by default
const defaultProject = "pinky-and-the-brain-agents";
const defaultEndpoint = "https://api.smith.langchain.com";

if (process.env.LANGCHAIN_TRACING_V2 === undefined) {
  process.env.LANGCHAIN_TRACING_V2 = "false";
}
if (process.env.LANGSMITH_TRACING === undefined) {
  process.env.LANGSMITH_TRACING = "false";
}

if (!process.env.LANGCHAIN_PROJECT) {
  process.env.LANGCHAIN_PROJECT = defaultProject;
}
if (!process.env.LANGSMITH_PROJECT) {
  process.env.LANGSMITH_PROJECT = defaultProject;
}

if (!process.env.LANGCHAIN_ENDPOINT) {
  process.env.LANGCHAIN_ENDPOINT = defaultEndpoint;
}
if (!process.env.LANGSMITH_ENDPOINT) {
  process.env.LANGSMITH_ENDPOINT = defaultEndpoint;
}

if (process.env.LANGCHAIN_CALLBACKS_BACKGROUND === undefined) {
  process.env.LANGCHAIN_CALLBACKS_BACKGROUND = "false";
}
if (process.env.LANGSMITH_TRACING_BACKGROUND === undefined) {
  process.env.LANGSMITH_TRACING_BACKGROUND = "false";
}

// Zod Schema definition
const ConfigSchema = z.object({
  nodeEnv: z.string().default("development"),
  bucketName: z.string().default("pinky-and-the-brain-agents-state-store-dev-094094788286"),
  anthropicApiKey: z.string().default(""),
  anthropicModel: z.string().default("claude-sonnet-5"),
  awsRegion: z.string().default("sa-east-1"),
  patbaApiKey: z.string().default(""),
  langchainTracingV2: z.boolean().default(false),
  langchainApiKey: z.string().default(""),
  langchainProject: z.string().default("pinky-and-the-brain-agents"),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

// Parse raw environment values
const rawConfig = {
  nodeEnv: process.env.NODE_ENV,
  bucketName: process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
  awsRegion: process.env.AWS_REGION,
  patbaApiKey: process.env.PATBA_API_KEY || process.env.API_KEY || process.env.AWS_APP_API_KEY,
  langchainTracingV2: process.env.LANGCHAIN_TRACING_V2 === "true" || process.env.LANGSMITH_TRACING === "true",
  langchainApiKey: process.env.LANGCHAIN_API_KEY || process.env.LANGSMITH_API_KEY,
  langchainProject: process.env.LANGCHAIN_PROJECT || process.env.LANGSMITH_PROJECT,
};

let validatedConfig: AppConfig;
try {
  validatedConfig = ConfigSchema.parse(rawConfig);
} catch (error: any) {
  logger.error("Configuration schema validation error:", error.errors || error.message);
  // Fail fast if not configured
  throw error;
}

export const config = validatedConfig;
export const projectRoot = rootDir;

export function validateApiKey(key: string): boolean {
  if (!config.patbaApiKey) return false;
  return key === config.patbaApiKey;
}

export function validateConfig() {
  if (!config.anthropicApiKey) {
    throw new Error("Missing critical environment variable: ANTHROPIC_API_KEY must be provided");
  }
  if (!config.patbaApiKey) {
    throw new Error("Missing critical environment variable: PATBA_API_KEY (or API_KEY / AWS_APP_API_KEY) must be provided");
  }


  if (!process.env.SLACK_BOT_TOKEN) {
    logger.info("SLACK_BOT_TOKEN is not set. Slack integration is disabled.");
  }

  if (config.langchainTracingV2) {
    if (!config.langchainApiKey) {
      logger.warn("⚠️ LANGCHAIN_TRACING_V2 is enabled, but LANGCHAIN_API_KEY is not defined. Traces will not be sent to LangSmith.");
    } else {
      logger.info(`🚀 LangSmith Tracing is enabled for project: "${config.langchainProject}"`);
    }
  }
}

