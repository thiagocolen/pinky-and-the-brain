import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Mutable so each test can point the agent at a different (or missing) checkout
// of thiagocolen.github.io. `vi.hoisted` because vi.mock's factory is lifted
// above this file's own declarations.
const mockConfig = vi.hoisted(() => ({
  anthropicApiKey: "mock-key-for-testing",
  anthropicModel: "claude-sonnet-5",
  patbaApiKey: "mock-key-for-testing",
  blogSitePath: "/nonexistent-site-checkout-for-tests",
}));

vi.mock("../../config.js", () => ({
  config: mockConfig,
  projectRoot: process.cwd(),
}));

import {
  slugify,
  splitTitle,
  buildBlogPost,
  publishToBlog,
  resolveExportPath,
  BLOG_POST_SCRIPT,
  __setPostScriptRunner,
  __resetPostScriptRunner,
} from "../../agents/tools.js";
import { BRAIN_SYSTEM_PROMPT } from "../../agents/prompts.js";

/** The slug pattern add-posts-from-json.js validates against. */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("slugify", () => {
  it("produces slugs the site's importer accepts", () => {
    for (const title of [
      "Conway's Game of Life",
      "AWS  —  Cloud Practitioner (CLF-C02)!",
      "React 19: what's new?",
    ]) {
      expect(slugify(title)).toMatch(SLUG_PATTERN);
    }
  });

  it("folds accents rather than dropping the letters", () => {
    expect(slugify("Autômatos Celulares")).toBe("automatos-celulares");
  });

  it("collapses separators and trims the edges", () => {
    expect(slugify("  --Hello___World--  ")).toBe("hello-world");
  });

  it("returns an empty string when nothing sluggable remains", () => {
    expect(slugify("!!! ???")).toBe("");
  });
});

describe("splitTitle", () => {
  it("splits the leading H1 off the body", () => {
    const { title, body } = splitTitle("# Game of Life\n\nCells live and die.");
    expect(title).toBe("Game of Life");
    expect(body).toBe("Cells live and die.");
  });

  it("leaves the markdown intact when there is no H1", () => {
    const { title, body } = splitTitle("Just a paragraph.");
    expect(title).toBe("");
    expect(body).toBe("Just a paragraph.");
  });

  it("does not mistake an H2 for the title", () => {
    expect(splitTitle("## Subheading\n\nText.").title).toBe("");
  });
});

describe("buildBlogPost", () => {
  const article = "# Game of Life\n\nA **cellular automaton**.\n\nSecond paragraph.";

  it("derives the title and slug from the H1", () => {
    const post = buildBlogPost(article);
    expect(post.title).toBe("Game of Life");
    expect(post.slug).toBe("game-of-life");
  });

  it("renders the body as HTML without repeating the title", () => {
    const post = buildBlogPost(article);
    expect(post.body_html).toContain("<strong>cellular automaton</strong>");
    expect(post.body_html).toContain("Second paragraph.");
    expect(post.body_html).not.toContain("Game of Life");
  });

  it("always produces a draft with no publish date", () => {
    const post = buildBlogPost(article);
    expect(post.status).toBe("unpublished");
    expect(post.published_at).toBeNull();
  });

  it("defaults description and tags to the importer's empty values", () => {
    const post = buildBlogPost(article);
    expect(post.description).toBeNull();
    expect(post.tags).toEqual([]);
  });

  it("carries the description and tags through", () => {
    const post = buildBlogPost(article, {
      description: "  A short summary.  ",
      tags: ["cellular-automata"],
    });
    expect(post.description).toBe("A short summary.");
    expect(post.tags).toEqual(["cellular-automata"]);
  });

  it("keeps the H1 in the body when the title is overridden", () => {
    const post = buildBlogPost(article, { title: "Conway's Automaton" });
    expect(post.title).toBe("Conway's Automaton");
    expect(post.slug).toBe("conways-automaton");
    expect(post.body_html).toContain("Game of Life");
  });

  it("refuses an article with no derivable title", () => {
    expect(() => buildBlogPost("Just prose, no heading.")).toThrow(/title/i);
  });

  it("refuses a title that cannot produce a valid slug", () => {
    expect(() => buildBlogPost("# ???")).toThrow(/slug/i);
  });
});

describe("publishToBlog", () => {
  let siteDir: string;

  /** Stands up a fake thiagocolen.github.io checkout containing the importer. */
  const createSiteCheckout = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-site-"));
    const script = path.join(dir, BLOG_POST_SCRIPT);
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "// stand-in for the real importer\n");
    return dir;
  };

  beforeEach(() => {
    siteDir = createSiteCheckout();
    mockConfig.blogSitePath = siteDir;
  });

  afterEach(() => {
    __resetPostScriptRunner();
    fs.rmSync(siteDir, { recursive: true, force: true });
    mockConfig.blogSitePath = "/nonexistent-site-checkout-for-tests";
  });

  it("runs the site's importer against the post JSON it wrote", () => {
    let seen: { siteDir: string; payload: any } | undefined;
    __setPostScriptRunner((dir, jsonPath) => {
      seen = { siteDir: dir, payload: JSON.parse(fs.readFileSync(jsonPath, "utf-8")) };
      return "✓ Added";
    });

    const result = publishToBlog("# Game of Life\n\nCells.", {
      description: "About automata.",
      tags: ["complexity"],
    });

    expect(seen!.siteDir).toBe(siteDir);
    expect(seen!.payload).toMatchObject({
      title: "Game of Life",
      slug: "game-of-life",
      status: "unpublished",
      published_at: null,
      description: "About automata.",
      tags: ["complexity"],
    });
    expect(result).toContain("game-of-life");
  });

  it("tells Pinky the post is a draft, never that it is live", () => {
    __setPostScriptRunner(() => "✓ Added");
    const result = publishToBlog("# Game of Life\n\nCells.");
    expect(result).toMatch(/draft/i);
    expect(result).toContain("unpublished");
  });

  it("removes the temporary JSON once the importer has run", () => {
    let jsonPath = "";
    __setPostScriptRunner((_dir, file) => {
      jsonPath = file;
      return "✓ Added";
    });
    publishToBlog("# Game of Life\n\nCells.");
    expect(fs.existsSync(jsonPath)).toBe(false);
  });

  it("cleans up even when the importer fails", () => {
    let jsonPath = "";
    __setPostScriptRunner((_dir, file) => {
      jsonPath = file;
      throw Object.assign(new Error("Command failed"), { stderr: "slug already published" });
    });
    const result = publishToBlog("# Game of Life\n\nCells.");
    expect(result).toMatch(/^Failed to publish/);
    expect(result).toContain("slug already published");
    expect(fs.existsSync(jsonPath)).toBe(false);
  });

  it("explains how to fix a missing site checkout instead of throwing", () => {
    mockConfig.blogSitePath = path.join(os.tmpdir(), "definitely-not-a-checkout");
    __setPostScriptRunner(() => {
      throw new Error("the importer must not run without a checkout");
    });
    const result = publishToBlog("# Game of Life\n\nCells.");
    expect(result).toContain("BLOG_SITE_PATH");
  });
});

describe("resolveExportPath", () => {
  it("places the article inside the folder Pinky named", () => {
    const target = resolveExportPath(path.join(os.tmpdir(), "pinky-out"), "game-of-life.md");
    expect(path.dirname(target)).toBe(path.join(os.tmpdir(), "pinky-out"));
    expect(path.basename(target)).toBe("game-of-life.md");
  });

  it("resolves a relative folder against the working directory", () => {
    expect(resolveExportPath("out/articles", "a.md")).toBe(
      path.join(process.cwd(), "out", "articles", "a.md"),
    );
  });

  it("keeps a traversing filename inside the destination folder", () => {
    const dest = path.join(os.tmpdir(), "pinky-out");
    const target = resolveExportPath(dest, "../../etc/passwd");
    expect(path.dirname(target)).toBe(dest);
    expect(path.basename(target)).toBe("passwd.md");
  });

  it("appends .md to an extensionless name", () => {
    expect(path.basename(resolveExportPath("out", "Game of Life"))).toBe("Game-of-Life.md");
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
    __resetPostScriptRunner();
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
    __setPostScriptRunner(() => {
      throw new Error("must not reach the importer");
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
});
