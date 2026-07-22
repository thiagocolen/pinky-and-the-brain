import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";
import { logger } from "./logger.js";

/**
 * Vector embeddings for the knowledge store.
 *
 * Scope note, same as `src/utils/image-gen.ts`: this agent is Anthropic-only
 * for *text generation*. Google appears here because Anthropic publishes no
 * embedding model, and nothing in the reasoning or writing path goes through
 * this module — it only decides which passages the model is shown.
 *
 * Every failure is soft, deliberately. Retrieval must keep working without a
 * `GEMINI_API_KEY`: a missing key, a refusal or a network error returns null,
 * and `retrieve_content` falls back to BM25 alone. Lexical retrieval is a
 * complete retriever in its own right, so the vectors are an improvement to
 * degrade from, never a dependency to fail on.
 */

/** Vectors are L2-normalised before quantising, so every component is in [-1, 1]. */
const QUANTISATION_SCALE = 127;

/** Identifies the file format, so a stale or foreign file is rejected rather than misread. */
const MAGIC = "PATBEMB1";

/** Fixed by `chunkId` in the ingest pipeline. */
const ID_BYTES = 12;

export interface EmbeddingStore {
  model: string;
  dim: number;
  /** Chunk id -> quantised unit vector. */
  vectors: Map<string, Int8Array>;
}

/**
 * L2-normalises a vector.
 *
 * Required rather than tidy: `gemini-embedding-001` is a Matryoshka model, so
 * asking for fewer dimensions than its native 3072 returns a *truncated*
 * vector, and truncation destroys the unit norm the full vector had. Skipping
 * this makes cosine similarity silently wrong — longer vectors simply win.
 */
export function normalise(values: number[]): number[] {
  let sum = 0;
  for (const v of values) sum += v * v;
  const magnitude = Math.sqrt(sum);
  if (magnitude === 0) return values.slice();
  return values.map((v) => v / magnitude);
}

/**
 * Packs a unit vector into one byte per dimension.
 *
 * At 256 dimensions this is 256 bytes per chunk rather than the 1024 that
 * float32 would cost: 1.8 MB across the corpus instead of 7.2 MB, in a file
 * that is baked into the container image and held in memory for the life of
 * the process. The precision lost is far below the noise floor of the
 * similarity itself — components are already confined to [-1, 1] by
 * normalisation, so the quantisation step is 1/127.
 */
export function quantise(values: number[]): Int8Array {
  const packed = new Int8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    // Clamped because a component of exactly 1 would round to 128 and overflow.
    packed[i] = Math.max(-127, Math.min(127, Math.round(values[i] * QUANTISATION_SCALE)));
  }
  return packed;
}

/**
 * Cosine similarity between two quantised vectors.
 *
 * Computed on the raw bytes rather than dequantising first: both vectors carry
 * the same scale factor, and dividing by the two magnitudes cancels it out
 * exactly. Dequantising would allocate two float arrays per comparison, and
 * there are 7,059 comparisons per query.
 */
export function cosine(a: Int8Array, b: Int8Array): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Serialises the store.
 *
 * A binary file rather than JSON because the alternative is a 1.8 MB base64
 * string on a single line — the same bytes, parsed more slowly at startup, and
 * no more readable to anyone.
 */
export function encodeStore(store: EmbeddingStore): Buffer {
  const ids = [...store.vectors.keys()];
  const model = Buffer.from(store.model, "utf-8");
  const header = Buffer.alloc(MAGIC.length + 2 + 4 + 2);
  let offset = header.write(MAGIC, "ascii");
  header.writeUInt16LE(store.dim, offset);
  header.writeUInt32LE(ids.length, offset + 2);
  header.writeUInt16LE(model.length, offset + 6);

  const idBlock = Buffer.alloc(ids.length * ID_BYTES);
  const vectorBlock = Buffer.alloc(ids.length * store.dim);
  ids.forEach((id, index) => {
    idBlock.write(id.padEnd(ID_BYTES, " ").slice(0, ID_BYTES), index * ID_BYTES, "ascii");
    Buffer.from(store.vectors.get(id)!.buffer).copy(vectorBlock, index * store.dim);
  });

  return Buffer.concat([header, model, idBlock, vectorBlock]);
}

/** Reads a store back, returning null for anything that is not one. */
export function decodeStore(buffer: Buffer): EmbeddingStore | null {
  if (buffer.length < MAGIC.length || buffer.toString("ascii", 0, MAGIC.length) !== MAGIC) {
    return null;
  }
  let offset = MAGIC.length;
  const dim = buffer.readUInt16LE(offset);
  const count = buffer.readUInt32LE(offset + 2);
  const modelLength = buffer.readUInt16LE(offset + 6);
  offset += 8;

  const model = buffer.toString("utf-8", offset, offset + modelLength);
  offset += modelLength;

  const vectors = new Map<string, Int8Array>();
  const vectorBase = offset + count * ID_BYTES;
  for (let i = 0; i < count; i++) {
    const id = buffer.toString("ascii", offset + i * ID_BYTES, offset + (i + 1) * ID_BYTES).trim();
    const start = vectorBase + i * dim;
    vectors.set(id, new Int8Array(buffer.subarray(start, start + dim)));
  }
  return { model, dim, vectors };
}

/** Test seam: lets the embedding call be replaced without a network or a key. */
export type Embedder = (texts: string[], kind: "document" | "query") => Promise<number[][] | null>;

let embedderOverride: Embedder | undefined;

export function __setEmbedder(embedder: Embedder): void {
  embedderOverride = embedder;
}

export function __resetEmbedder(): void {
  embedderOverride = undefined;
}

/**
 * Embeds texts through Gemini, or returns null.
 *
 * `taskType` is not decoration. Asymmetric models embed a question and a
 * passage into deliberately different regions of the space, and telling the
 * model which one it is looking at is most of the benefit of using a retrieval
 * model rather than a generic one.
 */
export async function embed(texts: string[], kind: "document" | "query"): Promise<number[][] | null> {
  if (embedderOverride) return embedderOverride(texts, kind);
  if (!config.geminiApiKey) return null;
  if (texts.length === 0) return [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
      const response = await ai.models.embedContent({
        model: config.geminiEmbeddingModel,
        contents: texts,
        config: {
          outputDimensionality: config.geminiEmbeddingDim,
          taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
        },
      });
      const values = (response.embeddings ?? []).map((e: any) => e.values as number[]);
      if (values.length !== texts.length || values.some((v) => !v?.length)) {
        logger.warn("[Embeddings] The model returned fewer vectors than texts; ignoring the batch.");
        return null;
      }
      return values;
    } catch (e: any) {
      const wait = transientRetryMs(e);
      if (wait === undefined || attempt === MAX_ATTEMPTS) {
        logger.warn(`[Embeddings] Embedding failed, continuing without vectors: ${e.message}`);
        return null;
      }
      logger.info(`[Embeddings] Rate limited; retrying in ${Math.round(wait / 1000)}s (attempt ${attempt}/${MAX_ATTEMPTS}).`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  return null;
}

const MAX_ATTEMPTS = 5;

/**
 * How long to wait before retrying, or undefined if the error is not transient.
 *
 * A 429 is not a failure, it is the quota asking to be paced — and treating it
 * as one is how a full ingestion silently stopped at 58% of the corpus, leaving
 * the semantic half of retrieval blind to two fifths of the material. The API
 * states how long to wait (`retryDelay: "21s"`), so that is preferred over a
 * guess; the exponential backoff is only the fallback.
 */
function transientRetryMs(error: any): number | undefined {
  const message = String(error?.message ?? "");
  const status = error?.status ?? error?.code;
  const isTransient =
    status === 429 ||
    status === 503 ||
    /RESOURCE_EXHAUSTED|UNAVAILABLE|\b429\b|\b503\b/.test(message);
  if (!isTransient) return undefined;

  const stated = message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  // A second of headroom: the stated delay is when the window reopens, not when
  // a request sent at that instant is guaranteed to be inside it.
  return stated ? Number(stated[1]) * 1000 + 1000 : 5000;
}

/**
 * Query vectors, memoised for the length of the process.
 *
 * The teaching loop retrieves the same subtopic repeatedly — decompose,
 * explain, test, re-explain all ground themselves against it — so without a
 * cache a single lesson pays for the same embedding a dozen times in both
 * latency and money.
 */
const queryCache = new Map<string, Int8Array | null>();
const QUERY_CACHE_LIMIT = 256;

export async function embedQuery(query: string): Promise<Int8Array | null> {
  const key = query.trim().toLowerCase();
  if (queryCache.has(key)) return queryCache.get(key)!;

  const vectors = await embed([query], "query");
  const packed = vectors ? quantise(normalise(vectors[0])) : null;

  // Crude eviction: this is a per-process cache of short strings, and the
  // access pattern is a handful of subtopics per conversation, not a working
  // set worth tracking recency for.
  if (queryCache.size >= QUERY_CACHE_LIMIT) queryCache.clear();
  queryCache.set(key, packed);
  return packed;
}

export function __clearQueryCache(): void {
  queryCache.clear();
}
