import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { logger } from "./logger.js";

/**
 * The blog's own publishing tools, reached over MCP.
 *
 * thiagocolen.github.io ships an `articles` MCP server (`mcp-server/index.js`)
 * that owns the whole article lifecycle: draft, revise, add assets, stage. This
 * agent drives that server rather than reimplementing any of it.
 *
 * That is the point of the change. The previous approach — clone the blog,
 * write an .mdx by hand, commit, push, open a PR — meant this repository held a
 * second, independent opinion about the blog's frontmatter shape, its slug
 * rules, where images live and which branch is safe to push. Every one of those
 * could drift from the real thing without anybody noticing until a post
 * rendered wrong. The MCP server delegates to `develop-tools/posts.js`, the
 * same module the blog's npm scripts use, so there is now exactly one
 * definition of what a post is and this agent is a client of it.
 *
 * The server is stdio and lives inside the blog checkout, so "connecting" means
 * spawning it there.
 */

/** Where the server writes: a worktree on this branch, never a working tree. */
export const BLOG_BRANCH = "new-articles";

/** The server's entrypoint, relative to the blog repo root. */
const SERVER_ENTRYPOINT = path.join("mcp-server", "index.js");

/**
 * A tool call that the server itself reported as failed.
 *
 * The MCP SDK resolves rather than rejects on `isError`, so without this the
 * failure text would be parsed as a successful result.
 */
export class BlogToolError extends Error {}

/** Test seam: the whole session, so tests never spawn a process. */
export type BlogSession = (tool: string, args: Record<string, unknown>) => Promise<string>;

/** Resolves the blog checkout, failing with something actionable when absent. */
export function resolveBlogRepoPath(): string {
  const repoPath = path.resolve(config.blogRepoPath);
  if (!fs.existsSync(path.join(repoPath, SERVER_ENTRYPOINT))) {
    throw new Error(
      `The blog's MCP server is not at ${path.join(repoPath, SERVER_ENTRYPOINT)}. ` +
        `Set BLOG_REPO_PATH to a checkout of thiagocolen.github.io that has mcp-server/ ` +
        `(it arrives with the 'feature/mcp-publisher-tool' branch), and run ` +
        `'npm install' inside that directory once.`,
    );
  }
  return repoPath;
}

/**
 * Reads the text out of a tool result, or throws what the server complained
 * about.
 *
 * Every handler in the blog's server returns a single text block — JSON for the
 * structured tools, a sentence for `stage_changes` — so the shape is uniform.
 */
function readResult(result: any, tool: string): string {
  const text = (result?.content ?? [])
    .filter((block: any) => block?.type === "text")
    .map((block: any) => block.text)
    .join("\n")
    .trim();

  if (result?.isError) {
    throw new BlogToolError(text || `The blog rejected ${tool} without saying why.`);
  }
  return text;
}

/**
 * Opens one session against the blog's server, runs `work`, and always closes.
 *
 * A session per publish rather than a long-lived connection: the server holds a
 * git worktree open, and a publish is a short burst of calls with long gaps
 * between them. Leaving a child process alive across an idle conversation buys
 * nothing and keeps a lock we do not need.
 */
export async function withBlogSession<T>(work: (call: BlogSession) => Promise<T>): Promise<T> {
  if (sessionOverride) return work(sessionOverride);

  const cwd = resolveBlogRepoPath();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRYPOINT],
    cwd,
    // The server infers the PR base branch from the current branch unless told;
    // inheriting a filtered env keeps that inference the blog's decision.
    env: { ...process.env } as Record<string, string>,
  });

  const client = new Client({ name: "the-brain", version: "1.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    logger.info(`[BlogMCP] Connected to the blog's articles server at ${cwd}`);

    const call: BlogSession = async (tool, args) => {
      logger.info(`[BlogMCP] → ${tool}`);
      const result = await client.callTool({ name: tool, arguments: args });
      return readResult(result, tool);
    };

    return await work(call);
  } finally {
    // close() tears the transport down with it; the child must not outlive the
    // publish even when the publish threw.
    await client.close().catch(() => undefined);
  }
}

let sessionOverride: BlogSession | undefined;

export function __setBlogSession(session: BlogSession): void {
  sessionOverride = session;
}

export function __resetBlogSession(): void {
  sessionOverride = undefined;
}

/** Parses a tool's JSON result, tolerating the servers that answer in prose. */
export function parseJsonResult<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
