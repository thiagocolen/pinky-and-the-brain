import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { config } from "../config.js";
import { logger } from "./logger.js";

/**
 * Delivery of an article to the blog, which is a *separate repository*
 * (thiagocolen.github.io) rather than anything inside this project.
 *
 * The article is not written into a checkout on this machine. It is clone →
 * branch → commit → push → pull request, so the change is reviewable, the
 * audit trail is the PR, and nothing depends on the operator happening to have
 * the blog checked out. Approval becomes a real GitHub review rather than an
 * honour-system prompt.
 */

/** Where posts live in the blog repo. Filename minus extension is the slug. */
export const POSTS_DIR = path.join("content", "posts");

/**
 * Where cover images are committed.
 *
 * Gatsby copies a root `static/` directory into the build output verbatim, with
 * no plugin or config, so `static/images/posts/x.png` is served at
 * `/images/posts/x.png` — which is what the frontmatter references. The blog has
 * no image pipeline (`gatsby-plugin-image` and `sharp` are installed but never
 * registered), and it needs none: cover images are interpolated straight into a
 * CSS `url()`.
 */
export const IMAGES_DIR = path.join("static", "images", "posts");

/** Public path of a post's cover image, as written into the frontmatter. */
export function coverImagePath(slug: string, extension = "png"): string {
  return `/images/posts/${slug}.${extension}`;
}

/** Branch created for a new article. `articles/*` is unused by the blog repo. */
export function articleBranch(slug: string): string {
  return `articles/${slug}`;
}

/**
 * Git can block forever waiting on a credential prompt, and a hung child here
 * hangs the whole agent turn. Every invocation is bounded and non-interactive.
 */
const CHILD_TIMEOUT_MS = 120_000;
const CHILD_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Strips anything that looks like a credential out of child-process output.
 *
 * This matters more than it looks: child output is written to `agent.log` *and*
 * returned into the model's context. Git echoes remote URLs freely, so a single
 * `https://user:token@github.com/...` in an error message would leak a live
 * token to both. Credentials are never interpolated into a URL here, but
 * redaction is the backstop for anything the environment supplies.
 */
export function redactSecrets(text: unknown): string {
  return String(text ?? "")
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, "<redacted-token>")
    .replace(/github_pat_[A-Za-z0-9_]{16,}/g, "<redacted-token>");
}

/** Test seam: every external command, isolated so tests never touch the network. */
export type CommandRunner = (command: string, args: string[], cwd?: string) => string;

const defaultRunner: CommandRunner = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf-8",
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: CHILD_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
    // Never let git stop for an interactive prompt: fail fast instead.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

let runCommand: CommandRunner = defaultRunner;

export function __setCommandRunner(runner: CommandRunner): void {
  runCommand = runner;
}

export function __resetCommandRunner(): void {
  runCommand = defaultRunner;
}

/** Harvests everything a failed child process reported, with secrets removed. */
function describeFailure(e: any): string {
  const detail = [e?.stderr, e?.stdout, e?.message]
    .filter(Boolean)
    .map((part) => redactSecrets(part))
    .join("\n")
    .trim();
  return detail || "no output";
}

export interface CoverImage {
  bytes: Buffer;
  /** File extension without the dot, e.g. "png". */
  extension: string;
}

export interface PublishRequest {
  slug: string;
  title: string;
  /** Full MDX file contents: frontmatter plus body. */
  mdx: string;
  image?: CoverImage | null;
}

export interface PublishResult {
  prUrl: string;
  branch: string;
  imageIncluded: boolean;
}

/**
 * Clones the blog, commits the article on its own branch, and opens a PR.
 *
 * Throws on failure with a message safe to show — callers turn that into a
 * sentence for Pinky. The clone is always removed, including on failure.
 */
export function publishArticleAsPullRequest(request: PublishRequest): PublishResult {
  const { slug, title, mdx, image } = request;
  const branch = articleBranch(slug);
  const baseBranch = config.blogBaseBranch;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-blog-"));

  try {
    const repo = path.join(tmpDir, "site");
    try {
      runCommand("git", [
        "clone",
        "--depth",
        "1",
        "--branch",
        baseBranch,
        config.blogRepoUrl,
        repo,
      ]);
    } catch (e: any) {
      throw new Error(
        `Could not clone the blog (${config.blogRepoUrl}, branch ${baseBranch}): ${describeFailure(e)}`,
      );
    }

    // Mirror the blog's own new-post.js, which refuses to overwrite a post.
    const postPath = path.join(repo, POSTS_DIR, `${slug}.mdx`);
    if (fs.existsSync(postPath)) {
      throw new Error(
        `The blog already has a post at ${POSTS_DIR}/${slug}.mdx on ${baseBranch}. ` +
          `Rename the article or update the existing post by hand.`,
      );
    }

    runCommand("git", ["checkout", "-b", branch], repo);

    fs.mkdirSync(path.dirname(postPath), { recursive: true });
    fs.writeFileSync(postPath, mdx, "utf-8");

    let imageIncluded = false;
    if (image) {
      const imagePath = path.join(repo, IMAGES_DIR, `${slug}.${image.extension}`);
      fs.mkdirSync(path.dirname(imagePath), { recursive: true });
      fs.writeFileSync(imagePath, image.bytes);
      imageIncluded = true;
    }

    runCommand("git", ["add", "--all"], repo);
    runCommand(
      "git",
      [
        // Set identity per-invocation: the agent must not depend on, or alter,
        // whatever global git identity this machine happens to have.
        "-c",
        "user.name=The Brain",
        "-c",
        "user.email=the-brain@users.noreply.github.com",
        "commit",
        "-m",
        `content: add "${title}" as a draft${imageIncluded ? " with cover image" : ""}`,
      ],
      repo,
    );

    try {
      runCommand(
        "git",
        [
          // Borrow the gh CLI's credentials for this push only, rather than
          // relying on (or rewriting) the machine's global git credential setup.
          "-c",
          "credential.helper=",
          "-c",
          "credential.https://github.com.helper=!gh auth git-credential",
          "push",
          "-u",
          "origin",
          branch,
        ],
        repo,
      );
    } catch (e: any) {
      throw new Error(
        `Could not push branch ${branch} to the blog: ${describeFailure(e)}. ` +
          `Check that the gh CLI is signed in with write access.`,
      );
    }

    let prUrl: string;
    try {
      prUrl = runCommand(
        "gh",
        [
          "pr",
          "create",
          "--base",
          baseBranch,
          "--head",
          branch,
          "--title",
          `content: add "${title}"`,
          "--body",
          prBody(slug, title, image?.extension ?? null, baseBranch),
        ],
        repo,
      )
        .trim()
        .split(/\s+/)
        .filter((line) => line.startsWith("http"))
        .pop() as string;
    } catch (e: any) {
      throw new Error(
        `Pushed branch ${branch}, but opening the pull request failed: ${describeFailure(e)}. ` +
          `The branch is on GitHub — a PR can still be opened by hand.`,
      );
    }

    logger.info(`[BlogRepo] Opened ${prUrl} for "${title}"`);
    return { prUrl, branch, imageIncluded };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * PR description. States plainly that merging does not publish anything.
 *
 * `extension` rather than a boolean: the model picks the format, and it is not
 * always PNG — a hardcoded extension here would describe a file that does not
 * exist in the very PR it is describing.
 */
function prBody(slug: string, title: string, extension: string | null, baseBranch: string): string {
  return [
    `Draft article written by The Brain.`,
    ``,
    `- **Post:** \`${POSTS_DIR}/${slug}.mdx\``,
    extension
      ? `- **Cover image:** \`${IMAGES_DIR}/${slug}.${extension}\` → \`${coverImagePath(slug, extension)}\``
      : `- **Cover image:** none`,
    `- **Status:** \`unpublished\` — merging this PR does **not** put the article live.`,
    ``,
    `\`gatsby build\` only includes posts with \`status: published\`, so this stays`,
    `invisible on the site (and in this PR's preview deploy) until it is promoted with`,
    `\`npm run publish-post -- ${slug}\` on \`${baseBranch}\`.`,
    ``,
    `To read it before merging: check out this branch and run \`npm run develop\`,`,
    `which does include drafts.`,
  ].join("\n");
}
