import { tool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { generateBodyImage, generateCoverImage, type GeneratedImage } from "../utils/image-gen.js";
import { styleFor } from "../utils/illustration-styles.js";
import { BLOG_BRANCH, parseJsonResult, withBlogSession } from "../utils/blog-mcp.js";
import { logger } from "../utils/logger.js";
import {
  extractFigures,
  renderBody,
  splitHeadline,
  substituteFigures,
  type Figure,
} from "./layout.js";

// Layout is `layout.ts`'s business, but `escapeForMdx` was part of this
// module's surface before that file existed; re-exported so callers and tests
// need not care which side of the split it landed on.
export { escapeForMdx, splitHeadline, extractFigures, renderBody, type Figure } from "./layout.js";

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

/**
 * Delivery of a finished article.
 *
 * Two destinations, chosen by Pinky once the article is done:
 *  - the blog at thiagocolen.github.io, through that site's own MCP server; or
 *  - any folder on this machine.
 *
 * Note what is deliberately absent here: there is no `slugify`. The slug is the
 * blog's business \u2014 `create_draft` derives it from the title using the same
 * module the site's own npm scripts use \u2014 and a copy of that rule living here
 * could only ever drift away from the real one.
 */

/**
 * Splits the leading `# Title` off an article.
 *
 * The site renders the title from frontmatter, so leaving the H1 in the body
 * would show it twice.
 */
export function splitTitle(markdown: string): { title: string; body: string } {
  const match = markdown.match(/^\s*#\s+(.+?)\s*$/m);
  if (!match) return { title: "", body: markdown.trim() };
  return {
    title: match[1].trim(),
    body: markdown.slice(match.index! + match[0].length).trim(),
  };
}

export interface PreparedPost {
  title: string;
  /** Deck lifted from the article's own `###` line, if it has one. */
  headline?: string;
  /** MDX body: the article minus its title and deck, as MDX-safe HTML. */
  body: string;
  /** Figures awaiting generation; their markers sit inside `body`. */
  figures: Figure[];
}

/**
 * Turns a finished article into what `create_draft` wants.
 *
 * The article carries its own layout, so this is where that layout is read out
 * of it: the H1 becomes the title, a leading `###` becomes the deck, `:::`
 * blocks become callouts and image marks become figure placeholders. Status,
 * `published_at`, the slug and the rest of the frontmatter remain the blog
 * server's to write.
 */
export function preparePost(
  markdown: string,
  options: { title?: string; headline?: string } = {},
): PreparedPost {
  const split = splitTitle(markdown);
  const title = (options.title ?? split.title).trim();
  if (!title) {
    throw new Error("Cannot derive a post title: pass one, or start the article with '# Title'.");
  }
  // The deck is read from below the H1 either way. Only then is the original
  // H1 put back, and only when the caller overrode the title, so that no
  // heading is lost — lifting the deck must not depend on that override.
  const deck = splitHeadline(split.body);
  const source =
    options.title && split.title ? `# ${split.title}\n\n${deck.body}` : deck.body;
  const extracted = extractFigures(source);

  return {
    title,
    // An explicit argument wins over the authored deck, as it does for the title.
    headline: options.headline?.trim() || deck.headline || undefined,
    body: renderBody(extracted.markdown),
    figures: extracted.figures,
  };
}

export interface PublishOptions {
  title?: string;
  /** Deck shown under the title on the post page. */
  headline?: string;
  /** Listing blurb. Shown on article cards, not on the post page. */
  description?: string;
  tags?: string[];
}

/**
 * Publishes a finished article through the blog's own MCP server.
 *
 * The sequence mirrors the flow that server documents: create the draft, learn
 * the slug it chose, attach the images, then stage everything for review. Image
 * failure is soft throughout — it costs a picture, never the article.
 *
 * Images are uploaded *after* the draft exists because their filenames, and so
 * their URLs, are derived from the slug the blog chose. The body therefore goes
 * up once with inert markers where its figures belong, and is patched once by
 * the same `update_post` call that sets the cover — one round trip, not one per
 * figure.
 *
 * The staging result is relayed **verbatim** rather than parsed and reworded.
 * That server owns what staging produces (today a compare URL, a pull request
 * once it opens one itself), and a sentence assembled here would go stale the
 * moment that changes. Returns what Pinky should be told; never throws.
 */
export async function publishToBlog(
  markdown: string,
  options: PublishOptions = {},
): Promise<string> {
  let post: PreparedPost;
  try {
    post = preparePost(markdown, options);
  } catch (e: any) {
    return `Could not prepare the post: ${e.message}`;
  }

  // One style for the whole article, chosen here and handed to every image, so
  // that a post's cover and figures read as one set. Derived from the title, so
  // republishing the same article redraws it in the same style rather than
  // quietly restyling a post that is already under review.
  const style = styleFor(post.title);
  logger.info(`[Tools] Illustrating "${post.title}" in the ${style.label} style (${style.id})`);

  // Every generation is independent and each absorbs its own failures, so they
  // run together rather than serially: a publish with four figures should not
  // cost four round trips of latency.
  const [cover, figureImages] = await Promise.all([
    generateCoverImage(post.title, options.description, style),
    Promise.all(post.figures.map((figure) => generateBodyImage(figure.prompt, style, figure.alt))),
  ]);

  try {
    return await withBlogSession(async (call) => {
      const created = await call("create_draft", {
        title: post.title,
        headline: post.headline,
        description: options.description,
        tags: options.tags,
        body: post.body,
      });

      const slug = parseJsonResult<{ slug: string }>(created)?.slug;
      if (!slug) {
        throw new Error(`The blog created the draft but did not report a slug: ${created}`);
      }

      /** Uploads one image and returns the URL the blog will serve it from. */
      const upload = async (image: GeneratedImage, filename: string): Promise<string | undefined> => {
        const asset = await call("add_asset", {
          filename: `${filename}.${image.extension}`,
          content: image.bytes.toString("base64"),
          overwrite: true,
        });
        return parseJsonResult<{ url: string }>(asset)?.url;
      };

      const coverUrl = cover ? await upload(cover, slug) : undefined;

      const figureUrls = new Map<number, string>();
      for (const figure of post.figures) {
        const image = figureImages[figure.index];
        if (!image) continue;
        const url = await upload(image, `${slug}-fig-${figure.index + 1}`);
        if (url) figureUrls.set(figure.index, url);
      }

      // One patch for both, and only when there is something to patch: with no
      // images at all the draft as created is already correct, markers and all
      // — they are HTML comments, invisible either way.
      if (coverUrl || figureUrls.size > 0) {
        await call("update_post", {
          slug,
          ...(coverUrl ? { cover_image: coverUrl } : {}),
          body: substituteFigures(post.body, post.figures, figureUrls),
        });
      }

      const coverNote = coverUrl
        ? ", plus a generated cover image"
        : " (no cover image — generation was unavailable)";
      const figureNote =
        post.figures.length === 0
          ? ""
          : ` It carries ${figureUrls.size} of ${post.figures.length} generated figure(s).`;

      const staged = await call("stage_changes", {
        message: `content: add "${post.title}" as a draft`,
      });

      logger.info(`[Tools] Staged "${post.title}" (${slug}) on ${BLOG_BRANCH}`);
      return (
        `Published "${post.title}" to thiagocolen.github.io as content/posts/${slug}.mdx ` +
        `with status "unpublished"${coverNote}.${figureNote}\n\n${staged}\n\n` +
        `The article is NOT live: it is a draft on the "${BLOG_BRANCH}" branch awaiting ` +
        `review, and even once its pull request merges it stays invisible on the site ` +
        `until it is promoted there by hand.`
      );
    });
  } catch (e: any) {
    logger.error(`[Tools] Blog publish failed: ${e.message}`);
    return `Failed to publish to the website: ${e.message}`;
  }
}

/** Resolves a destination inside a Pinky-supplied folder, keeping the filename flat. */
export function resolveExportPath(folder: string, filename: string): string {
  // Callback form: a home directory containing "$" must not be read as a
  // replacement pattern.
  const expanded = folder.trim().replace(/^~(?=[\\/]|$)/, () => os.homedir());
  const dir = path.resolve(process.cwd(), expanded);
  return path.join(dir, path.basename(resolveArticlePath(filename)));
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

const publishArticle = tool(
  async ({
    filename,
    title,
    headline,
    description,
    tags,
  }: {
    filename: string;
    title?: string;
    headline?: string;
    description?: string;
    tags?: string[];
  }) => {
    const source = resolveArticlePath(filename);
    if (!fs.existsSync(source)) {
      return `No article exists at ${source}. Save it first, then publish.`;
    }
    try {
      return await publishToBlog(fs.readFileSync(source, "utf-8"), {
        title,
        headline,
        description,
        tags,
      });
    } catch (e: any) {
      return `Could not publish: ${e.message}`;
    }
  },
  {
    name: "publish_article",
    description:
      "Publish a saved article to the thiagocolen.github.io blog, using the blog's own publishing tools: it renders the article's layout (its deck, its ':::' callouts and its figures), generates a cover image and one image per figure, creates the post as a DRAFT (status 'unpublished'), attaches the images, and stages everything on the 'new-articles' branch for review. Returns what the blog reported, including the review URL — always relay that back to Pinky in full. The post is not live, and merging its pull request still does not publish it. Only call this after Pinky explicitly asks to publish.",
    schema: z.object({
      filename: z.string().describe("Filename of the saved article, e.g. 'game-of-life.md'."),
      title: z
        .string()
        .optional()
        .describe(
          "Overrides the article's H1 as the post title. The blog derives the URL slug from this, so keep it SHORT — at most about six words. Put the longer, wittier phrasing in 'headline' instead.",
        ),
      headline: z
        .string()
        .optional()
        .describe(
          "Overrides the deck the article already carries as its '###' line. Normally omit this — the deck belongs in the article file, where Pinky can read it before publishing.",
        ),
      description: z
        .string()
        .optional()
        .describe(
          "One-sentence summary shown on article cards in the blog's listing — NOT on the post page itself. Different from 'headline'.",
        ),
      tags: z
        .array(z.string())
        .optional()
        .describe("Lowercase topic tags, e.g. ['cellular-automata', 'complexity']."),
    }),
  },
);

const exportArticle = tool(
  async ({ filename, folder }: { filename: string; folder: string }) => {
    const source = resolveArticlePath(filename);
    if (!fs.existsSync(source)) {
      return `No article exists at ${source}. Save it first, then copy it.`;
    }
    try {
      const target = resolveExportPath(folder, filename);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      logger.info(`[Tools] Article exported to ${target}`);
      return `Article saved to ${target}`;
    } catch (e: any) {
      return `Could not save the article to "${folder}": ${e.message}`;
    }
  },
  {
    name: "export_article",
    description:
      "Copy a saved article into a folder Pinky names. Returns the absolute path — always report that exact path to Pinky.",
    schema: z.object({
      filename: z.string().describe("Filename of the saved article, e.g. 'game-of-life.md'."),
      folder: z
        .string()
        .describe("Destination folder Pinky provided, absolute or relative. Created if missing."),
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
  publishArticle,
  exportArticle,
];
