import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Mutable so each test can vary what the agent believes about the blog checkout
// and whether an image key is configured. `vi.hoisted` because vi.mock's factory
// is lifted above this file's own declarations.
const mockConfig = vi.hoisted(() => ({
  anthropicApiKey: "mock-key-for-testing",
  anthropicModel: "claude-sonnet-5",
  patbaApiKey: "mock-key-for-testing",
  blogRepoPath: "/nonexistent/blog-checkout",
  geminiApiKey: "",
  geminiImageModel: "gemini-3.1-flash-lite-image",
}));

vi.mock("../../config.js", () => ({
  config: mockConfig,
  projectRoot: process.cwd(),
}));

import {
  splitTitle,
  preparePost,
  escapeForMdx,
  publishToBlog,
  resolveExportPath,
} from "../../agents/tools.js";
import {
  BLOG_BRANCH,
  parseJsonResult,
  resolveBlogRepoPath,
  __setBlogSession,
  __resetBlogSession,
} from "../../utils/blog-mcp.js";
import {
  buildImagePrompt,
  extensionFor,
  generateCoverImage,
  __setImageGenerator,
  __resetImageGenerator,
} from "../../utils/image-gen.js";
import { BRAIN_SYSTEM_PROMPT, ARTICLE_CRAFT_PROMPT } from "../../agents/prompts.js";

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

describe("preparePost", () => {
  const article = "# Lenia\n\nA continuous cellular automaton.";

  it("sends the title and an MDX body, and nothing else", () => {
    // Frontmatter, status and the slug are the blog server's to write. A second
    // opinion about them here is exactly what this change removed.
    const post = preparePost(article);
    expect(post.title).toBe("Lenia");
    expect(post.body).toContain("continuous cellular automaton");
    expect(Object.keys(post).sort()).toEqual(["body", "title"]);
  });

  it("drops the H1 so the site does not render the title twice", () => {
    expect(preparePost(article).body).not.toContain("<h1>");
  });

  it("keeps the H1 when the caller supplies a different title", () => {
    const post = preparePost(article, { title: "Another Title" });
    expect(post.title).toBe("Another Title");
    expect(post.body).toContain("<h1>Lenia</h1>");
  });

  it("refuses an article with no derivable title", () => {
    expect(() => preparePost("No heading here.")).toThrow(/Cannot derive a post title/);
  });
});

describe("resolveBlogRepoPath", () => {
  afterEach(() => {
    mockConfig.blogRepoPath = "/nonexistent/blog-checkout";
  });

  it("explains how to fix a missing checkout rather than failing obscurely", () => {
    expect(() => resolveBlogRepoPath()).toThrow(/BLOG_REPO_PATH/);
    expect(() => resolveBlogRepoPath()).toThrow(/mcp-server/);
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
    __resetBlogSession();
    __resetImageGenerator();
    mockConfig.geminiApiKey = "";
  });

  /**
   * Stands in for the blog's `articles` MCP server.
   *
   * Answers each tool the way the real server does — JSON for the structured
   * ones, a sentence for `stage_changes` — so the assertions are about the
   * contract this agent depends on, not about our own wrapper.
   */
  const recordingSession = (overrides: Record<string, (args: any) => string> = {}) => {
    const calls: { tool: string; args: any }[] = [];

    __setBlogSession(async (tool, args) => {
      calls.push({ tool, args });
      if (overrides[tool]) return overrides[tool](args);
      switch (tool) {
        case "create_draft":
          return JSON.stringify({ slug: "lenia", path: "content/posts/lenia.mdx" });
        case "add_asset":
          return JSON.stringify({ url: `/images/${args.filename}` });
        case "update_post":
          return JSON.stringify({ slug: "lenia", updated: Object.keys(args) });
        case "stage_changes":
          return "Pushed to new-articles. Open a pull request: https://github.com/thiagocolen/thiagocolen.github.io/compare/new-articles";
        default:
          throw new Error(`unexpected tool ${tool}`);
      }
    });

    return {
      calls,
      names: () => calls.map((c) => c.tool),
      argsFor: (tool: string) => calls.find((c) => c.tool === tool)?.args,
    };
  };

  it("drafts, stages, and relays the blog's own review URL", async () => {
    const session = recordingSession();
    const result = await publishToBlog(article, { description: "About Lenia", tags: ["lenia"] });

    expect(session.names()).toEqual(["create_draft", "stage_changes"]);
    expect(result).toContain("compare/new-articles");
  });

  it("passes the headline and description through as distinct fields", async () => {
    // The blog renders them in different places; conflating them is the mistake
    // its MCP server explicitly warns authoring agents about.
    const session = recordingSession();
    await publishToBlog(article, {
      headline: "A continuous cellular automaton",
      description: "Shown on the article card",
      tags: ["lenia", "complexity"],
    });

    const args = session.argsFor("create_draft");
    expect(args.headline).toBe("A continuous cellular automaton");
    expect(args.description).toBe("Shown on the article card");
    expect(args.tags).toEqual(["lenia", "complexity"]);
  });

  it("never asks the blog to publish the post", async () => {
    // Two gates guard the live site: the post's own status flag and the pull
    // request. The agent is trusted with neither.
    const session = recordingSession();
    await publishToBlog(article);
    expect(session.names()).not.toContain("publish_post");
  });

  it("tells Pinky the article is neither live nor merged", async () => {
    recordingSession();
    const result = await publishToBlog(article);
    expect(result).toMatch(/not live/i);
    expect(result).toMatch(/until it is promoted there by hand/i);
  });

  it("attaches a generated cover using the slug the blog chose", async () => {
    mockConfig.geminiApiKey = "test-key";
    __setImageGenerator(async () => ({
      bytes: Buffer.from("fake-png-bytes"),
      mimeType: "image/png",
      extension: "png",
    }));
    const session = recordingSession();
    const result = await publishToBlog(article);

    // The image filename cannot be known before create_draft returns the slug,
    // which is why the asset is added after the draft rather than before it.
    expect(session.names()).toEqual([
      "create_draft",
      "add_asset",
      "update_post",
      "stage_changes",
    ]);
    expect(session.argsFor("add_asset").filename).toBe("lenia.png");
    expect(Buffer.from(session.argsFor("add_asset").content, "base64").toString()).toBe(
      "fake-png-bytes",
    );
    expect(session.argsFor("update_post").cover_image).toBe("/images/lenia.png");
    expect(result).toMatch(/cover image/i);
  });

  it("uses the format the model actually returned, not a hardcoded png", async () => {
    mockConfig.geminiApiKey = "test-key";
    __setImageGenerator(async () => ({
      bytes: Buffer.from("fake-jpeg-bytes"),
      mimeType: "image/jpeg",
      extension: "jpg",
    }));
    const session = recordingSession();
    await publishToBlog(article);

    expect(session.argsFor("add_asset").filename).toBe("lenia.jpg");
    expect(session.argsFor("update_post").cover_image).toBe("/images/lenia.jpg");
  });

  it("still publishes when image generation fails", async () => {
    mockConfig.geminiApiKey = "test-key";
    __setImageGenerator(async () => {
      throw new Error("model unavailable");
    });
    const session = recordingSession();
    const result = await publishToBlog(article);

    expect(session.names()).not.toContain("add_asset");
    expect(result).toMatch(/no cover image/i);
    expect(result).toContain("compare/new-articles");
  });

  it("reports what the blog refused, rather than claiming success", async () => {
    recordingSession({
      create_draft: () => {
        throw new Error("A post with slug 'lenia' already exists");
      },
    });

    const result = await publishToBlog(article);
    expect(result).toMatch(/failed to publish/i);
    expect(result).toMatch(/already exists/i);
  });

  it("does not invent a slug when the blog fails to report one", async () => {
    recordingSession({ create_draft: () => "created, probably" });

    const result = await publishToBlog(article);
    expect(result).toMatch(/did not report a slug/i);
  });
});

describe("parseJsonResult", () => {
  it("returns undefined for prose rather than throwing", () => {
    expect(parseJsonResult("Pushed to new-articles.")).toBeUndefined();
    expect(parseJsonResult<{ slug: string }>('{"slug":"lenia"}')?.slug).toBe("lenia");
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
    __resetBlogSession();
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
    __setBlogSession(async () => {
      throw new Error("must not reach the blog");
    });
    const publishArticle = await getTool("publish_article");
    const result: any = await publishArticle.invoke({ filename: "never-written.md" });
    expect(String(result)).toContain("No article exists");
  });

  it("offers the blog a short title and a separate headline", async () => {
    const publishArticle = await getTool("publish_article");
    const schema: any = (publishArticle as any).schema;
    expect(Object.keys(schema.shape)).toEqual(
      expect.arrayContaining(["title", "headline", "description", "tags"]),
    );
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

  it("makes The Brain relay every URL the publish tool returned", () => {
    // The bug this replaced: the delivery report was written, then dropped
    // before it ever reached the caller.
    expect(BRAIN_SYSTEM_PROMPT).toMatch(/relay the tool's entire result/i);
    expect(BRAIN_SYSTEM_PROMPT).toMatch(/including every URL/i);
    expect(BRAIN_SYSTEM_PROMPT).toMatch(/not merged/i);
  });
});

describe("The article writing guide in the system prompt", () => {
  it("is carried into the prompt the agent actually runs on", () => {
    expect(BRAIN_SYSTEM_PROMPT).toContain(ARTICLE_CRAFT_PROMPT);
  });

  it("fixes the topic, audience, purpose and stakes before drafting", () => {
    expect(ARTICLE_CRAFT_PROMPT).toMatch(/\*\*Topic\*\*/);
    expect(ARTICLE_CRAFT_PROMPT).toMatch(/\*\*Audience\*\*/);
    expect(ARTICLE_CRAFT_PROMPT).toMatch(/\*\*Purpose\*\*/);
    expect(ARTICLE_CRAFT_PROMPT).toMatch(/why the reader should care/i);
  });

  it("prescribes the three-part structure", () => {
    expect(ARTICLE_CRAFT_PROMPT).toMatch(/introduction/i);
    expect(ARTICLE_CRAFT_PROMPT).toMatch(/middle/i);
    expect(ARTICLE_CRAFT_PROMPT).toMatch(/\bend\b/i);
  });

  it("caps the title length, because the title becomes the URL", () => {
    expect(ARTICLE_CRAFT_PROMPT).toMatch(/six words/i);
    expect(ARTICLE_CRAFT_PROMPT).toMatch(/URL slug/i);
    expect(ARTICLE_CRAFT_PROMPT).toMatch(/headline/i);
  });

  it("tells the agent where the long title belongs instead", () => {
    expect(BRAIN_SYSTEM_PROMPT).toMatch(/at most about six words/i);
  });
});

describe("The blog branch the agent stages to", () => {
  it("is the branch no workflow builds", () => {
    // Pushing here cannot reach the public site; only a merged PR can.
    expect(BLOG_BRANCH).toBe("new-articles");
  });
});
