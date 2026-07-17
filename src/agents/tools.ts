import { tool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface DbChunk {
  content: string;
  area: string;
}

/**
 * A topic of expertise, mapped to the `area` key used inside the vector store.
 * `area` values must match the ingested data exactly — note the misspelling of
 * `job-techinical-interview`, which is what the ingest script writes.
 */
export interface Topic {
  id: string;
  label: string;
  area: string;
  blurb: string;
}

export const TOPICS: Topic[] = [
  {
    id: "aws",
    label: "AWS Cloud Practitioner Certification",
    area: "aws-tutor",
    blurb: "The CLF-C02 exam: core AWS services, global infrastructure, security, pricing and support.",
  },
  {
    id: "cellular-automata",
    label: "Cellular Automata",
    area: "cellular-automata",
    blurb: "Conway's Game of Life, Wolfram's elementary automata, Lenia and particle life — complexity from simple rules.",
  },
  {
    id: "english",
    label: "English for Certifications",
    area: "english-certification-instructor",
    blurb: "IELTS, TOEFL and Cambridge exam structures, strategies and practice.",
  },
  {
    id: "interview",
    label: "Technical Interview Preparation",
    area: "job-techinical-interview",
    blurb: "Role-based interview roadmaps: React, Angular, JavaScript, Node.js, System Design and more.",
  },
];

export function resolveTopic(nameOrId: string): Topic | undefined {
  const needle = nameOrId.trim().toLowerCase();
  return (
    TOPICS.find((t) => t.id === needle || t.area === needle) ??
    TOPICS.find((t) => t.label.toLowerCase() === needle) ??
    TOPICS.find((t) => t.label.toLowerCase().includes(needle) || needle.includes(t.id))
  );
}

let dbCache: DbChunk[] = [];
let isDbLoaded = false;

/** Loads and caches the pre-ingested store. Paths cover both src and dist layouts. */
export function loadVectorStore(): DbChunk[] {
  if (isDbLoaded) return dbCache;
  const possiblePaths = [
    path.resolve(__dirname, "../storage/vector-store.json"),
    path.resolve(__dirname, "../../src/storage/vector-store.json"),
    path.resolve(__dirname, "../../../src/storage/vector-store.json"),
  ];
  for (const storePath of possiblePaths) {
    if (fs.existsSync(storePath)) {
      try {
        dbCache = JSON.parse(fs.readFileSync(storePath, "utf-8"));
        isDbLoaded = true;
        logger.info(`[Tools] Loaded ${dbCache.length} chunks from ${storePath}`);
        break;
      } catch (e: any) {
        logger.error("Failed to parse vector store: " + e.message);
      }
    }
  }
  return dbCache;
}

/** Test seam: replaces the cached store. */
export function __setVectorStore(chunks: DbChunk[]): void {
  dbCache = chunks;
  isDbLoaded = true;
}

/** Test seam: drops the cache so the next read loads from disk again. */
export function __resetVectorStore(): void {
  dbCache = [];
  isDbLoaded = false;
}

/**
 * Scores chunks in an area by how many query terms they contain and returns the
 * best ones. Keyword overlap, not embeddings — the store holds no vectors.
 */
export function retrieveContext(query: string, area: string, limit = 10): string[] {
  const store = loadVectorStore();
  if (store.length === 0) return [];

  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const areaStore = store.filter((chunk) => chunk.area === area);
  if (areaStore.length === 0) return [];

  const scored = areaStore.map((chunk) => {
    const contentLower = chunk.content.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (contentLower.includes(term)) score++;
    }
    return { chunk, score };
  });

  return scored
    .filter((item) => item.score > 0 || queryTerms.length === 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.chunk.content);
}

/**
 * Derives subtopic labels for an area.
 *
 * The ingested areas are shaped differently: the interview roadmaps store
 * `Role: X - Topic: Y` lines (so the roles are the useful grouping), while the
 * other areas are markdown, where headings are the natural subtopics.
 */
export function extractSubtopics(area: string): string[] {
  const chunks = loadVectorStore().filter((c) => c.area === area);
  if (chunks.length === 0) return [];

  const roles = new Set<string>();
  for (const chunk of chunks) {
    const match = chunk.content.match(/^Role:\s*(.+?)\s*-\s*Topic:/);
    if (match) roles.add(match[1].trim());
  }
  if (roles.size > 0) return [...roles];

  const h1: string[] = [];
  const h2: string[] = [];
  for (const chunk of chunks) {
    if (!chunk.content.trimStart().startsWith("#")) continue;
    const match = chunk.content.match(/^(#{1,2})\s+(.+)$/m);
    if (!match) continue;
    const label = match[2].trim();
    if (label.length < 3 || label.length > 80) continue;
    (match[1] === "#" ? h1 : h2).push(label);
  }

  // Prefer top-level headings, but fall back to including H2s when an area is
  // shallow (e.g. the English material has only two H1s).
  const unique = (xs: string[]) => [...new Set(xs)];
  const primary = unique(h1);
  return primary.length >= 6 ? primary : unique([...h1, ...h2]);
}

export const ARTICLES_DIR = path.resolve(process.cwd(), "articles");

/** Constrains a model-chosen filename to a single .md file inside ARTICLES_DIR. */
export function resolveArticlePath(filename: string): string {
  const base = path
    .basename(filename.trim())
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safe = base.toLowerCase().endsWith(".md") ? base : `${base || "article"}.md`;
  return path.join(ARTICLES_DIR, safe);
}

const listTopics = tool(
  async () => {
    const store = loadVectorStore();
    const available = TOPICS.filter((t) => store.some((c) => c.area === t.area));
    const topics = available.length > 0 ? available : TOPICS;
    return JSON.stringify(
      topics.map((t) => ({ id: t.id, topic: t.label, about: t.blurb })),
      null,
      2,
    );
  },
  {
    name: "list_topics",
    description:
      "List The Brain's topics of expertise. Call this before presenting the topic menu to Pinky.",
    schema: z.object({}),
  },
);

const listSubtopics = tool(
  async ({ topic }: { topic: string }) => {
    const resolved = resolveTopic(topic);
    if (!resolved) {
      return `Unknown topic "${topic}". Valid topics: ${TOPICS.map((t) => t.label).join(", ")}.`;
    }
    const subtopics = extractSubtopics(resolved.area);
    if (subtopics.length === 0) {
      return `No subtopics found for "${resolved.label}".`;
    }
    return JSON.stringify({ topic: resolved.label, subtopics }, null, 2);
  },
  {
    name: "list_subtopics",
    description:
      "List the subtopics available for a topic, read from the knowledge store. Call this after Pinky picks a topic.",
    schema: z.object({
      topic: z.string().describe("Topic id or label, e.g. 'aws' or 'Cellular Automata'."),
    }),
  },
);

const retrieveContentTool = tool(
  async ({ topic, query }: { topic: string; query: string }) => {
    const resolved = resolveTopic(topic);
    if (!resolved) {
      return `Unknown topic "${topic}". Valid topics: ${TOPICS.map((t) => t.label).join(", ")}.`;
    }
    const passages = retrieveContext(query, resolved.area);
    if (passages.length === 0) {
      return `No stored material matched "${query}" within "${resolved.label}".`;
    }
    return passages.map((p, i) => `--- passage ${i + 1} ---\n${p}`).join("\n\n");
  },
  {
    name: "retrieve_content",
    description:
      "Retrieve source material about a subtopic from the knowledge store. Use this to ground every explanation and article in real content — never invent facts you could look up here.",
    schema: z.object({
      topic: z.string().describe("Topic id or label the subtopic belongs to."),
      query: z.string().describe("The subtopic or question to search for."),
    }),
  },
);

const saveArticle = tool(
  async ({ filename, content }: { filename: string; content: string }) => {
    const target = resolveArticlePath(filename);
    fs.mkdirSync(ARTICLES_DIR, { recursive: true });
    fs.writeFileSync(target, content, "utf-8");
    logger.info(`[Tools] Article saved to ${target}`);
    return `Article saved to ${target}`;
  },
  {
    name: "save_article",
    description:
      "Save an article as a markdown file in the local ./articles directory. Returns the absolute path — always report that exact path to Pinky.",
    schema: z.object({
      filename: z.string().describe("Filename, e.g. 'game-of-life.md'. Slugified if needed."),
      content: z.string().describe("The full markdown content of the article."),
    }),
  },
);

const updateArticle = tool(
  async ({ filename, content }: { filename: string; content: string }) => {
    const target = resolveArticlePath(filename);
    if (!fs.existsSync(target)) {
      return `No article exists at ${target}. Use save_article to create it first.`;
    }
    fs.writeFileSync(target, content, "utf-8");
    logger.info(`[Tools] Article updated at ${target}`);
    return `Article updated at ${target}`;
  },
  {
    name: "update_article",
    description:
      "Overwrite an existing article with revised content, after Pinky has confirmed the change. Provide the complete new markdown, not a fragment.",
    schema: z.object({
      filename: z.string().describe("Filename of the existing article, e.g. 'game-of-life.md'."),
      content: z.string().describe("The full revised markdown content."),
    }),
  },
);

const readArticle = tool(
  async ({ filename }: { filename: string }) => {
    const target = resolveArticlePath(filename);
    if (!fs.existsSync(target)) return `No article exists at ${target}.`;
    return fs.readFileSync(target, "utf-8");
  },
  {
    name: "read_article",
    description: "Read back a saved article before revising it.",
    schema: z.object({
      filename: z.string().describe("Filename of the article, e.g. 'game-of-life.md'."),
    }),
  },
);

export const brainTools = [
  listTopics,
  listSubtopics,
  retrieveContentTool,
  saveArticle,
  updateArticle,
  readArticle,
];
