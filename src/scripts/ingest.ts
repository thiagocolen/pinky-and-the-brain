import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { S3Wrapper } from "../storage/s3.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { chunkId, type KnowledgeChunk } from "../utils/retrieval.js";
import {
  decodeStore,
  embed,
  encodeStore,
  normalise,
  quantise,
  type EmbeddingStore,
} from "../utils/embeddings.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root is 2 directories up from dist/scripts/ingest.js or src/scripts/ingest.ts
const rootDir = path.resolve(__dirname, "../../");

export const STORE_FILENAME = "knowledge-store.json";
export const EMBEDDINGS_FILENAME = "embeddings.bin";

/** How many texts go up per embedding request. */
const EMBED_BATCH = 100;

/** Gap between batches; see the pacing note in `buildEmbeddings`. */
const BATCH_PACING_MS = 2000;

/**
 * The nearest preceding markdown heading, tracked while walking a file.
 *
 * Recorded so a retrieved passage can say where it came from. Without it an
 * article can cite nothing, which sits awkwardly beside a writing standard that
 * demands claims be supported.
 */
function headingOf(paragraph: string): string | undefined {
  const match = paragraph.match(/^\s*#{1,6}\s+(.+?)\s*$/m);
  return match ? match[1].trim() : undefined;
}

function parseAndCollectFiles(
  dir: string,
  baseDirName: string,
  corpusRoot: string,
  db: KnowledgeChunk[],
) {
  if (!fs.existsSync(dir)) {
    return;
  }
  const list = fs.readdirSync(dir);
  for (const item of list) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      // Exclude raw roadmaps folder because they are too large and formatted ones are sufficient
      if (item === "raw") {
        continue;
      }
      parseAndCollectFiles(fullPath, baseDirName, corpusRoot, db);
    } else if (stat.isFile()) {
      // Forward slashes so the recorded source reads the same on every platform.
      const source = path.relative(corpusRoot, fullPath).split(path.sep).join("/");

      if (item.endsWith(".txt") || item.endsWith(".md")) {
        const content = fs.readFileSync(fullPath, "utf-8");
        // Split by paragraphs to keep semantic blocks together
        const paragraphs = content.split(/\n\s*\n/);
        let heading: string | undefined;
        for (const p of paragraphs) {
          const cleanP = p.trim();
          // A paragraph that opens with a heading both *is* a chunk and sets the
          // heading for the chunks after it.
          heading = headingOf(cleanP) ?? heading;
          if (cleanP.length > 20) {
            db.push({ id: chunkId(cleanP), content: cleanP, area: baseDirName, source, heading });
          }
        }
      } else if (item.endsWith(".json") && (fullPath.includes("roadmaps") || item.startsWith("formatted-"))) {
        try {
          const fileContent = fs.readFileSync(fullPath, "utf-8");
          const parsed = JSON.parse(fileContent);
          if (parsed.title && parsed.topics) {
            const role = parsed.title;
            const roleLine = `Role: ${role} - Description: ${parsed.description || ""}`;
            db.push({ id: chunkId(roleLine), content: roleLine, area: baseDirName, source, heading: role });
            for (const topic of parsed.topics) {
              if (topic.label && (topic.type === "topic" || topic.type === "subtopic" || topic.type === "title")) {
                const line = `Role: ${role} - Topic: ${topic.label}${topic.level ? ` (${topic.level})` : ""}`;
                db.push({ id: chunkId(line), content: line, area: baseDirName, source, heading: role });
              }
            }
          }
        } catch (e: any) {
          logger.error(`Error parsing JSON file ${fullPath}: ${e.message}`);
        }
      }
    }
  }
}

/**
 * Locates the curated corpus.
 *
 * `CURATED_CONTENT_PATH` wins; the rest are the historical locations, kept so
 * that an existing checkout still ingests without configuration. The last of
 * them used to be the *only* way this script found anything, which made
 * re-ingestion possible on exactly one machine.
 */
export function resolveCuratedContentPath(): string | undefined {
  const candidates = [
    config.curatedContentPath,
    path.join(rootDir, "..", "patb-rag-curated-content"),
    path.join(rootDir, "..", "agent-project", "patb-rag-curated-content"),
    "D:\\_code-projects\\langchainjs-project-01\\agent-project\\patb-rag-curated-content",
  ].filter(Boolean) as string[];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

/**
 * Embeds every chunk that does not already have a vector.
 *
 * Reuse is keyed on the content-addressed id, so a re-ingest after editing one
 * file pays to embed that file's paragraphs and nothing else. A run without a
 * key, or one whose requests fail, simply leaves the file as it was: the agent
 * falls back to BM25, which is a complete retriever on its own.
 */
async function buildEmbeddings(chunks: KnowledgeChunk[], existingPath: string): Promise<EmbeddingStore | null> {
  if (!config.geminiApiKey) {
    logger.warn("[Ingest] No GEMINI_API_KEY — skipping embeddings; retrieval will be lexical only.");
    return null;
  }

  let vectors = new Map<string, Int8Array>();
  if (fs.existsSync(existingPath)) {
    const previous = decodeStore(fs.readFileSync(existingPath));
    // A file built at a different dimension or by a different model cannot be
    // mixed with new vectors; comparing them would be meaningless.
    if (previous && previous.dim === config.geminiEmbeddingDim && previous.model === config.geminiEmbeddingModel) {
      vectors = previous.vectors;
      logger.info(`[Ingest] Reusing ${vectors.size} existing vectors.`);
    } else if (previous) {
      logger.warn("[Ingest] Existing embeddings were built with different settings; rebuilding all of them.");
    }
  }

  const pending = chunks.filter((chunk) => !vectors.has(chunk.id));
  logger.info(`[Ingest] Embedding ${pending.length} new chunks (${chunks.length - pending.length} reused).`);

  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    // Paced, because the quota counts each *text* rather than each request:
    // a batch of 100 spends 100 of the 3,000-per-minute allowance, so sending
    // them back to back burns the whole minute in twenty seconds and then
    // stalls. One batch every two seconds sits just inside the limit.
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, BATCH_PACING_MS));

    const batch = pending.slice(i, i + EMBED_BATCH);
    const values = await embed(batch.map((c) => c.content), "document");
    if (!values) {
      logger.warn(
        `[Ingest] Embedding gave up at batch ${i / EMBED_BATCH + 1}; keeping the ${vectors.size} vectors already built. ` +
          `Re-run 'npm run ingest' to resume — existing vectors are reused.`,
      );
      break;
    }
    batch.forEach((chunk, index) => vectors.set(chunk.id, quantise(normalise(values[index]))));
    logger.info(`[Ingest] Embedded ${Math.min(i + EMBED_BATCH, pending.length)}/${pending.length}`);
  }

  // Vectors for chunks that no longer exist are dropped, so deleting source
  // material shrinks the file instead of leaving orphans in it forever.
  const live = new Map<string, Int8Array>();
  for (const chunk of chunks) {
    const vector = vectors.get(chunk.id);
    if (vector) live.set(chunk.id, vector);
  }

  return live.size > 0
    ? { model: config.geminiEmbeddingModel, dim: config.geminiEmbeddingDim, vectors: live }
    : null;
}

async function main() {
  const curatedDir = resolveCuratedContentPath();
  if (!curatedDir) {
    logger.error(
      "Curated content directory not found. Set CURATED_CONTENT_PATH to the folder " +
        "holding the per-area source documents (aws-tutor, cellular-automata, …).",
    );
    process.exit(1);
  }
  logger.info(`Starting ingestion from ${curatedDir}`);

  const db: KnowledgeChunk[] = [];

  const items = fs.readdirSync(curatedDir);
  for (const item of items) {
    const itemPath = path.join(curatedDir, item);
    if (!fs.statSync(itemPath).isDirectory()) {
      continue;
    }

    // Curated content areas: aws-tutor, cellular-automata, english-certification-instructor, job-techinical-interview
    const area = item;
    logger.info(`Traversing content for specialist area: ${area}`);
    parseAndCollectFiles(itemPath, area, curatedDir, db);
  }

  // Identical paragraphs across files collapse to one chunk: they share an id,
  // and returning the same text twice only spends the model's attention twice.
  const unique = new Map<string, KnowledgeChunk>();
  for (const chunk of db) if (!unique.has(chunk.id)) unique.set(chunk.id, chunk);
  const chunks = [...unique.values()];
  logger.info(`Ingested ${chunks.length} chunks (${db.length - chunks.length} duplicates collapsed).`);

  const srcStorageDir = path.join(rootDir, "src", "storage");
  fs.mkdirSync(srcStorageDir, { recursive: true });
  const srcDest = path.join(srcStorageDir, STORE_FILENAME);
  fs.writeFileSync(srcDest, JSON.stringify(chunks, null, 2), "utf-8");
  logger.info(`Saved locally to ${srcDest}`);

  const embeddings = await buildEmbeddings(chunks, path.join(srcStorageDir, EMBEDDINGS_FILENAME));
  if (embeddings) {
    const encoded = encodeStore(embeddings);
    fs.writeFileSync(path.join(srcStorageDir, EMBEDDINGS_FILENAME), encoded);
    logger.info(
      `Saved ${embeddings.vectors.size} vectors (${embeddings.dim}d) — ${(encoded.length / 1048576).toFixed(2)} MB`,
    );
  }

  // Mirror into the compiled output so a running dist/ build sees the new store.
  const distStorageDir = path.join(rootDir, "dist", "storage");
  if (fs.existsSync(path.join(rootDir, "dist"))) {
    fs.mkdirSync(distStorageDir, { recursive: true });
    fs.writeFileSync(path.join(distStorageDir, STORE_FILENAME), JSON.stringify(chunks, null, 2), "utf-8");
    if (embeddings) {
      fs.writeFileSync(path.join(distStorageDir, EMBEDDINGS_FILENAME), encodeStore(embeddings));
    }
    logger.info(`Saved to compiled output: ${distStorageDir}`);
  }

  const s3 = new S3Wrapper();
  try {
    logger.info("Uploading knowledge store to S3...");
    await s3.uploadState(STORE_FILENAME, chunks);
    logger.info("Successfully uploaded database to S3!");
  } catch (error: any) {
    logger.warn(`Failed to upload to S3 (maybe offline/no credentials): ${error.message}`);
  }
}

// `import.meta.url` guard so the resolver above can be unit-tested without the
// module running an ingestion on import.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    logger.error("Ingestion failed: " + err.message);
    process.exit(1);
  });
}
