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
  // Output tokens per reply. Bounded above by the Anthropic SDK, which refuses
  // a non-streaming request whose estimated duration exceeds ten minutes —
  // `max_tokens` over 128000/6 ≈ 21333 throws before it is ever sent, and every
  // entrypoint here goes through the non-streaming `invoke()`. Lifting the
  // ceiling further means streaming the run, not raising this number.
  anthropicMaxTokens: z.coerce.number().int().positive().default(16000),
  awsRegion: z.string().default("sa-east-1"),
  patbaApiKey: z.string().default(""),
  langchainTracingV2: z.boolean().default(false),
  langchainApiKey: z.string().default(""),
  langchainProject: z.string().default("pinky-and-the-brain-agents"),
  // The blog is a separate repository, and it owns its own publishing tools:
  // articles are written through the `articles` MCP server that ships inside it
  // (mcp-server/index.js). That server is stdio, so what we need is a path to a
  // checkout on this machine rather than a clone URL. Defaults to a sibling of
  // this project, which is the usual layout.
  blogRepoPath: z.string().default(path.resolve(rootDir, "../thiagocolen.github.io")),
  // Cover-image generation. Optional: without a key the article still publishes,
  // just without an image. The text model stays Anthropic; this is images only.
  geminiApiKey: z.string().default(""),
  geminiImageModel: z.string().default("gemini-3.1-flash-lite-image"),
  // Pixel size requested for every generated image; the cover/figure distinction
  // is carried by aspect ratio, not by this. Which values a model accepts is a
  // property of that model rather than of the API: the default image model
  // serves `1K` and answers 400 for both `512` and `2K`. It lives beside the
  // model name so that pointing at a model with a different ceiling is a
  // configuration change rather than a code change.
  geminiImageSize: z.string().default("1K"),
  // Where `npm run ingest` reads the curated source documents from. This used
  // to be three hard-coded paths inside the script, the last of them an
  // absolute Windows path, which meant ingest only ever worked on one machine.
  curatedContentPath: z.string().default(""),
  // Retrieval. `hybrid` fuses BM25 with vector similarity; `lexical` is BM25
  // alone. Hybrid degrades to lexical on its own when there is no Gemini key or
  // no embeddings file, so this exists to turn the vectors off deliberately —
  // to remove a per-turn API call, or to compare the two.
  retrievalMode: z.enum(["hybrid", "lexical"]).default("hybrid"),
  geminiEmbeddingModel: z.string().default("gemini-embedding-001"),
  // 256 of the model's native 3072 dimensions. It is a Matryoshka model, so a
  // truncated vector is still a usable one, and 256 keeps the whole file under
  // 2 MB — which matters because the store is not fetched at runtime, it is
  // baked into the container by `COPY src/` and then scanned in memory on every
  // query. Changing this invalidates every stored vector: the dimension is
  // recorded in the file, and a mismatch makes the agent ignore the vectors
  // rather than compare ones of different lengths.
  geminiEmbeddingDim: z.coerce.number().int().positive().default(256),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

// Parse raw environment values
const rawConfig = {
  nodeEnv: process.env.NODE_ENV,
  bucketName: process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
  // `|| undefined` so that an empty value falls back to the schema default
  // rather than coercing to 0 and failing validation at startup.
  anthropicMaxTokens: process.env.ANTHROPIC_MAX_TOKENS || undefined,
  awsRegion: process.env.AWS_REGION,
  patbaApiKey: process.env.PATBA_API_KEY || process.env.API_KEY || process.env.AWS_APP_API_KEY,
  langchainTracingV2: process.env.LANGCHAIN_TRACING_V2 === "true" || process.env.LANGSMITH_TRACING === "true",
  langchainApiKey: process.env.LANGCHAIN_API_KEY || process.env.LANGSMITH_API_KEY,
  langchainProject: process.env.LANGCHAIN_PROJECT || process.env.LANGSMITH_PROJECT,
  blogRepoPath: process.env.BLOG_REPO_PATH,
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  geminiImageModel: process.env.GEMINI_IMAGE_MODEL,
  geminiImageSize: process.env.GEMINI_IMAGE_SIZE,
  curatedContentPath: process.env.CURATED_CONTENT_PATH,
  retrievalMode: process.env.RETRIEVAL_MODE || undefined,
  geminiEmbeddingModel: process.env.GEMINI_EMBEDDING_MODEL,
  geminiEmbeddingDim: process.env.GEMINI_EMBEDDING_DIM || undefined,
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

export interface ValidateConfigOptions {
  /**
   * Whether PATBA_API_KEY is required. It authenticates callers of the REST API
   * (`validateApiKey`), so only the HTTP entrypoint genuinely needs it. Local
   * stdio entrypoints talk to a client that already has OS-level access to this
   * process, and demanding the key there turns an unused secret into a hard
   * startup dependency — which is exactly what MCP clients trip over, since
   * they spawn servers with a filtered environment rather than the full one.
   */
  requirePatbaApiKey?: boolean;
}

export function validateConfig({ requirePatbaApiKey = true }: ValidateConfigOptions = {}) {
  if (!config.anthropicApiKey) {
    throw new Error("Missing critical environment variable: ANTHROPIC_API_KEY must be provided");
  }
  if (requirePatbaApiKey && !config.patbaApiKey) {
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

