import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import matter from "gray-matter";

// Mutable so each test can vary what the agent believes about the blog repo and
// whether an image key is configured. `vi.hoisted` because vi.mock's factory is
// lifted above this file's own declarations.
const mockConfig = vi.hoisted(() => ({
  anthropicApiKey: "mock-key-for-testing",
  anthropicModel: "claude-sonnet-5",
  patbaApiKey: "mock-key-for-testing",
  blogRepoUrl: "https://github.com/thiagocolen/thiagocolen.github.io.git",
  blogBaseBranch: "release/v1.2.0",
  geminiApiKey: "",
  geminiImageModel: "gemini-3.1-flash-lite-image",
}));

vi.mock("../../config.js", () => ({
  config: mockConfig,
  projectRoot: process.cwd(),
}));

import {
  slugify,
  splitTitle,
  buildPost,
  escapeForMdx,
  publishToBlog,
  resolveExportPath,
} from "../../agents/tools.js";
import {
  articleBranch,
  coverImagePath,
  redactSecrets,
  POSTS_DIR,
  IMAGES_DIR,
  __setCommandRunner,
  __resetCommandRunner,
} from "../../utils/blog-repo.js";
import {
  buildImagePrompt,
  extensionFor,
  generateCoverImage,
  __setImageGenerator,
  __resetImageGenerator,
} from "../../utils/image-gen.js";
import { BRAIN_SYSTEM_PROMPT } from "../../agents/prompts.js";

/** Slug shape the blog's own tooling produces, and its URLs depend on. */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("slugify", () => {
  it("produces slugs matching the blog's URL shape", () => {
    for (const title of [
      "Conway's Game of Life",
      "AWS  —  Cloud Practitioner (CLF-C02)!",
      "React 19: what's new?",
    ]) {
      expect(slugify(title)).toMatch(SLUG_PATTERN);
    }
  });

  it("matches develop-tools/new-post.js exactly, apostrophes included", () => {
    // The blog's script does not strip apostrophes, so neither do we — a slug
    // that disagrees with the site's own tool would produce a different URL.
    expect(slugify("Conway's Game")).toBe("conway-s-game");
  });

  it("collapses separators and trims the edges", () => {
    expect(slugify("  --Hello___World--  ")).toBe("hello-world");
  });

  it("returns an empty string when nothing sluggable remains", () => {
    expect(slugify("!!! ???")).toBe("");
  });
});

describe("splitTitle", () => {
  it("lifts the H1 out of the body", () => {
    const { title, body } = splitTitle("# The Title\n\nFirst paragraph.");
    expect(title).toBe("The Title");
    expect(body).toBe("First paragraph.");
  });

  it("leaves the text alone when there is no H1", () => {
    const { title, body } = splitTitle("Just prose.");
    expect(title).toBe("");
    expect(body).toBe("Just prose.");
  });
});

describe("escapeForMdx", () => {
  it("neutralises braces that MDX would read as an expression", () => {
    // A single unescaped `{` fails the Gatsby build for the whole site.
    const escaped = escapeForMdx("<p>const x = { a: 1 };</p>");
    expect(escaped).not.toMatch(/[{}]/);
    expect(escaped).toContain("&#123;");
    expect(escaped).toContain("&#125;");
  });

  it("leaves real HTML tags intact", () => {
    const escaped = escapeForMdx('<a href="/x">link</a>');
    expect(escaped).toBe('<a href="/x">link</a>');
  });
});

describe("buildPost", () => {
  const article = "# Lenia\n\nA continuous cellular automaton.";

  it("writes frontmatter gray-matter can read back", () => {
    const post = buildPost(article, { description: "About Lenia", tags: ["lenia"] });
    const parsed = matter(post.mdx);
    expect(parsed.data.title).toBe("Lenia");
    expect(parsed.data.description).toBe("About Lenia");
    expect(parsed.data.tags).toEqual(["lenia"]);
  });

  it("always produces a draft, never a live post", () => {
    const post = buildPost(article);
    const parsed = matter(post.mdx);
    expect(parsed.data.status).toBe("unpublished");
    expect(parsed.data.published_at).toBeNull();
  });

  it("drops the H1 so the site does not render the title twice", () => {
    const post = buildPost(article);
    expect(post.mdx).not.toContain("<h1>");
    expect(matter(post.mdx).content).toContain("continuous cellular automaton");
  });

  it("keeps the H1 when the caller supplies a different title", () => {
    const post = buildPost(article, { title: "Another Title" });
    expect(post.title).toBe("Another Title");
    expect(post.mdx).toContain("<h1>Lenia</h1>");
  });

  it("carries the cover image path into the frontmatter", () => {
    const post = buildPost(article, { coverImage: "/images/posts/lenia.png" });
    expect(matter(post.mdx).data.cover_image).toBe("/images/posts/lenia.png");
  });

  it("leaves cover_image empty when there is no image", () => {
    expect(matter(buildPost(article).mdx).data.cover_image).toBe("");
  });

  it("refuses a title that cannot become a slug", () => {
    expect(() => buildPost("# !!!\n\nBody.")).toThrow(/empty slug/);
  });

  it("refuses an article with no derivable title", () => {
    expect(() => buildPost("No heading here.")).toThrow(/Cannot derive a post title/);
  });
});

describe("redactSecrets", () => {
  it("strips credentials embedded in a remote URL", () => {
    // Child-process output reaches both agent.log and the model's context, so a
    // token echoed by git must not survive either trip.
    const redacted = redactSecrets(
      "fatal: could not read from https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz123456@github.com/o/r.git",
    );
    expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted).not.toContain("x-access-token");
  });

  it("strips a bare token anywhere in the text", () => {
    expect(redactSecrets("token github_pat_11ABCDEFG0123456789abcdef here")).not.toContain(
      "github_pat_11ABCDEFG0123456789abcdef",
    );
  });

  it("leaves ordinary output untouched", () => {
    expect(redactSecrets("Everything up-to-date")).toBe("Everything up-to-date");
  });
});

describe("blog repo paths", () => {
  it("names the branch after the slug", () => {
    expect(articleBranch("lenia")).toBe("articles/lenia");
  });

  it("points the frontmatter at the served image path, not the repo path", () => {
    // static/images/posts/x.png is served from /images/posts/x.png.
    expect(coverImagePath("lenia")).toBe("/images/posts/lenia.png");
    expect(IMAGES_DIR).toBe(path.join("static", "images", "posts"));
    expect(POSTS_DIR).toBe(path.join("content", "posts"));
  });
});

describe("image generation", () => {
  afterEach(() => {
    __resetImageGenerator();
    mockConfig.geminiApiKey = "";
  });

  it("forbids text in the generated image", () => {
    // Models render lettering eagerly and get it wrong; a misspelled cover is
    // worse than no cover.
    expect(buildImagePrompt("Lenia")).toMatch(/no text/i);
  });

  it("includes the article subject and the requested style", () => {
    const prompt = buildImagePrompt("Lenia", "Continuous cellular automata");
    expect(prompt).toContain("Lenia");
    expect(prompt).toContain("Continuous cellular automata");
    expect(prompt).toMatch(/abstract/i);
    expect(prompt).toMatch(/geometric/i);
  });

  it("derives the file extension from the returned MIME type", () => {
    expect(extensionFor("image/png")).toBe("png");
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("image/webp")).toBe("webp");
  });

  it("returns null without an API key, rather than throwing", async () => {
    __setImageGenerator(async () => {
      throw new Error("must not call the model without a key");
    });
    expect(await generateCoverImage("Lenia")).toBeNull();
  });

  it("returns null when generation fails, so the article still publishes", async () => {
    mockConfig.geminiApiKey = "test-key";
    __setImageGenerator(async () => {
      throw new Error("model unavailable");
    });
    expect(await generateCoverImage("Lenia")).toBeNull();
  });
});

describe("publishToBlog", () => {
  const article = "# Lenia\n\nA continuous cellular automaton.";

  afterEach(() => {
    __resetCommandRunner();
    __resetImageGenerator();
    mockConfig.geminiApiKey = "";
  });

  /**
   * Stands in for git and gh.
   *
   * The clone is deleted before publishToBlog returns, so anything a test wants
   * to assert about the committed files has to be captured while it still
   * exists — `git add` is the moment everything is on disk.
   */
  const recordingRunner = () => {
    const calls: { command: string; args: string[]; cwd?: string }[] = [];
    const staged: Record<string, Buffer> = {};
    let repoDir: string | undefined;

    const snapshot = (dir: string, prefix = "") => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = prefix ? path.join(prefix, entry.name) : entry.name;
        if (entry.isDirectory()) snapshot(full, rel);
        else staged[rel] = fs.readFileSync(full);
      }
    };

    __setCommandRunner((command, args, cwd) => {
      calls.push({ command, args, cwd });
      if (command === "git" && args[0] === "clone") {
        // Create the directory the real clone would have produced.
        repoDir = args[args.length - 1];
        fs.mkdirSync(path.join(repoDir, POSTS_DIR), { recursive: true });
        return "";
      }
      if (command === "git" && args[0] === "add") snapshot(repoDir!);
      if (command === "gh") return "https://github.com/thiagocolen/thiagocolen.github.io/pull/99\n";
      return "";
    });

    return {
      calls,
      staged,
      stagedText: (rel: string) => staged[rel]?.toString("utf-8"),
      find: (command: string, sub?: string) =>
        calls.find((c) => c.command === command && (!sub || c.args.includes(sub))),
    };
  };

  it("opens a pull request and reports its URL", async () => {
    const runner = recordingRunner();
    const result = await publishToBlog(article, { description: "About Lenia", tags: ["lenia"] });

    expect(result).toContain("https://github.com/thiagocolen/thiagocolen.github.io/pull/99");
    expect(runner.find("gh", "pr")).toBeTruthy();
  });

  it("branches from the configured base, not the repo default", async () => {
    // master still carries the retired SQLite pipeline and has no content/posts.
    const runner = recordingRunner();
    await publishToBlog(article);

    expect(runner.find("git", "clone")!.args).toContain("release/v1.2.0");
    expect(runner.find("git", "checkout")!.args).toContain("articles/lenia");
    expect(runner.find("gh")!.args).toContain("release/v1.2.0");
  });

  it("commits the post as a draft at the path the site sources from", async () => {
    const runner = recordingRunner();
    await publishToBlog(article, { description: "About Lenia" });

    const written = runner.stagedText(path.join(POSTS_DIR, "lenia.mdx"))!;
    expect(matter(written).data.status).toBe("unpublished");
    expect(matter(written).data.title).toBe("Lenia");
  });

  it("tells Pinky the article is neither live nor merged", async () => {
    recordingRunner();
    const result = await publishToBlog(article);
    expect(result).toMatch(/not live/i);
    expect(result).toMatch(/not merged/i);
  });

  it("commits a generated cover image and references it in the frontmatter", async () => {
    mockConfig.geminiApiKey = "test-key";
    __setImageGenerator(async () => ({
      bytes: Buffer.from("fake-png-bytes"),
      mimeType: "image/png",
      extension: "png",
    }));
    const runner = recordingRunner();
    await publishToBlog(article);

    expect(runner.staged[path.join(IMAGES_DIR, "lenia.png")]?.toString()).toBe("fake-png-bytes");
    const written = runner.stagedText(path.join(POSTS_DIR, "lenia.mdx"))!;
    expect(matter(written).data.cover_image).toBe("/images/posts/lenia.png");
  });

  it("describes the cover image with the format the model actually returned", async () => {
    // The model picks the format and it is not always PNG. A hardcoded
    // extension in the PR body described a file that was not in the PR.
    mockConfig.geminiApiKey = "test-key";
    __setImageGenerator(async () => ({
      bytes: Buffer.from("fake-jpeg-bytes"),
      mimeType: "image/jpeg",
      extension: "jpg",
    }));
    const runner = recordingRunner();
    await publishToBlog(article);

    expect(runner.staged[path.join(IMAGES_DIR, "lenia.jpg")]).toBeTruthy();
    const body = runner.find("gh")!.args[runner.find("gh")!.args.indexOf("--body") + 1];
    expect(body).toContain("lenia.jpg");
    expect(body).not.toContain("lenia.png");
  });

  it("still publishes when image generation fails", async () => {
    mockConfig.geminiApiKey = "test-key";
    __setImageGenerator(async () => {
      throw new Error("model unavailable");
    });
    const runner = recordingRunner();
    const result = await publishToBlog(article);

    expect(result).toContain("/pull/99");
    expect(result).toMatch(/no cover image/i);
    expect(Object.keys(runner.staged).some((f) => f.includes("images"))).toBe(false);
  });

  it("refuses to overwrite a post the blog already has", async () => {
    __setCommandRunner((command, args) => {
      if (command === "git" && args[0] === "clone") {
        const repo = args[args.length - 1];
        fs.mkdirSync(path.join(repo, POSTS_DIR), { recursive: true });
        fs.writeFileSync(path.join(repo, POSTS_DIR, "lenia.mdx"), "existing post");
        return "";
      }
      if (command === "gh") throw new Error("must not open a PR for a duplicate slug");
      return "";
    });

    const result = await publishToBlog(article);
    expect(result).toMatch(/already has a post/i);
  });

  it("reports a push failure without leaking the token git echoed", async () => {
    __setCommandRunner((command, args) => {
      if (command === "git" && args[0] === "clone") {
        fs.mkdirSync(path.join(args[args.length - 1], POSTS_DIR), { recursive: true });
        return "";
      }
      if (command === "git" && args.includes("push")) {
        throw Object.assign(new Error("Command failed"), {
          stderr: "remote: denied https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz123456@github.com/o/r.git",
        });
      }
      return "";
    });

    const result = await publishToBlog(article);
    expect(result).toMatch(/could not push/i);
    expect(result).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
  });

  it("removes the clone even when publishing fails", async () => {
    let repoDir: string | undefined;
    __setCommandRunner((command, args) => {
      if (command === "git" && args[0] === "clone") {
        repoDir = args[args.length - 1];
        fs.mkdirSync(path.join(repoDir, POSTS_DIR), { recursive: true });
        return "";
      }
      throw Object.assign(new Error("Command failed"), { stderr: "boom" });
    });

    await publishToBlog(article);
    expect(fs.existsSync(path.dirname(repoDir!))).toBe(false);
  });
});

describe("resolveExportPath", () => {
  it("keeps the filename flat inside the folder Pinky named", () => {
    const resolved = resolveExportPath(path.join(os.tmpdir(), "out"), "my-article.md");
    expect(path.dirname(resolved)).toBe(path.join(os.tmpdir(), "out"));
    expect(path.basename(resolved)).toBe("my-article.md");
  });

  it("expands a leading ~ to the home directory", () => {
    expect(resolveExportPath("~/docs", "a.md")).toBe(path.join(os.homedir(), "docs", "a.md"));
  });
});

describe("Delivery tools", () => {
  let tmpDir: string;
  let cwdSpy: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-delivery-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    __resetCommandRunner();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const getTool = async (name: string) => {
    const { brainTools } = await import("../../agents/tools.js");
    return brainTools.find((t: any) => t.name === name)!;
  };

  it("exposes both delivery tools to the agent", async () => {
    const { brainTools } = await import("../../agents/tools.js");
    const names = brainTools.map((t: any) => t.name);
    expect(names).toContain("publish_article");
    expect(names).toContain("export_article");
  });

  it("copies an article into a folder and reports the path", async () => {
    const saveArticle = await getTool("save_article");
    const saved: any = await saveArticle.invoke({
      filename: "delivery-test.md",
      content: "# Delivery\n\nBody.",
    });
    const savedPath = String(saved).replace("Article saved to ", "");

    const destination = path.join(tmpDir, "nested", "exports");
    const exportArticle = await getTool("export_article");
    const result: any = await exportArticle.invoke({
      filename: "delivery-test.md",
      folder: destination,
    });

    const reportedPath = String(result).replace("Article saved to ", "");
    expect(path.dirname(reportedPath)).toBe(destination);
    expect(fs.readFileSync(reportedPath, "utf-8")).toContain("# Delivery");
    fs.rmSync(savedPath, { force: true });
  });

  it("refuses to export an article that was never saved", async () => {
    const exportArticle = await getTool("export_article");
    const result: any = await exportArticle.invoke({
      filename: "never-written.md",
      folder: tmpDir,
    });
    expect(String(result)).toContain("No article exists");
  });

  it("refuses to publish an article that was never saved", async () => {
    __setCommandRunner(() => {
      throw new Error("must not touch the blog repo");
    });
    const publishArticle = await getTool("publish_article");
    const result: any = await publishArticle.invoke({ filename: "never-written.md" });
    expect(String(result)).toContain("No article exists");
  });
});

describe("Delivery instructions in the system prompt", () => {
  it("offers both destinations once an article is finished", () => {
    expect(BRAIN_SYSTEM_PROMPT).toContain("publish_article");
    expect(BRAIN_SYSTEM_PROMPT).toContain("export_article");
    expect(BRAIN_SYSTEM_PROMPT).toContain("thiagocolen.github.io");
  });

  it("requires Pinky to choose before anything leaves the conversation", () => {
    expect(BRAIN_SYSTEM_PROMPT).toMatch(/never on your own initiative/i);
    expect(BRAIN_SYSTEM_PROMPT).toMatch(/Never claim an article is live/i);
  });

  it("requires confirmation before pushing to a public repository", () => {
    expect(BRAIN_SYSTEM_PROMPT).toMatch(/confirmation before you act/i);
  });

  it("makes The Brain report the pull request, not a publication", () => {
    expect(BRAIN_SYSTEM_PROMPT).toMatch(/pull request URL/i);
    expect(BRAIN_SYSTEM_PROMPT).toMatch(/not merged/i);
  });
});
