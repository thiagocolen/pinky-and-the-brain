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
  geminiImageSize: "1K",
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
  splitHeadline,
  extractFigures,
  renderBody,
  substituteFigures,
  escapeAttribute,
} from "../../agents/layout.js";
import {
  BLOG_BRANCH,
  parseJsonResult,
  resolveBlogRepoPath,
  __setBlogSession,
  __resetBlogSession,
} from "../../utils/blog-mcp.js";
import {
  buildImagePrompt,
  buildFigurePrompt,
  extensionFor,
  generateCoverImage,
  generateBodyImage,
  __setImageGenerator,
  __resetImageGenerator,
  type ImageGeometry,
} from "../../utils/image-gen.js";
import { ILLUSTRATION_STYLES, styleFor } from "../../utils/illustration-styles.js";
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

describe("splitHeadline", () => {
  it("lifts a deck sitting directly under the title", () => {
    const { headline, body } = splitHeadline("### Or: how I learned to love the blob\n\nProse.");
    expect(headline).toBe("Or: how I learned to love the blob");
    expect(body).toBe("Prose.");
  });

  it("leaves an ordinary subheading further down alone", () => {
    // Only the leading position means "deck". An H3 mid-article is navigation,
    // and lifting it would silently delete a section heading.
    const source = "Opening paragraph.\n\n### A real subheading\n\nMore prose.";
    const { headline, body } = splitHeadline(source);
    expect(headline).toBe("");
    expect(body).toBe(source);
  });

  it("copes with an article that has no deck", () => {
    expect(splitHeadline("Just prose.").headline).toBe("");
  });
});

describe("extractFigures", () => {
  it("collects the alt text and the generation prompt separately", () => {
    const { figures } = extractFigures("![A drifting glider](image: concentric rings)");
    expect(figures).toEqual([{ index: 0, alt: "A drifting glider", prompt: "concentric rings" }]);
  });

  it("leaves an inert marker rather than visible placeholder text", () => {
    // Figures are generated after the draft exists, so the marker may survive
    // to the page if anything fails. An HTML comment renders as nothing.
    const { markdown } = extractFigures("Before.\n\n![Alt](image: a prompt)\n\nAfter.");
    expect(markdown).toContain("<!--figure:0-->");
    expect(markdown).not.toContain("image:");
    expect(markdown).not.toContain("Alt");
  });

  it("numbers figures in the order they appear", () => {
    const { figures } = extractFigures("![One](image: first)\n\n![Two](image: second)");
    expect(figures.map((f) => f.index)).toEqual([0, 1]);
    expect(figures.map((f) => f.prompt)).toEqual(["first", "second"]);
  });

  it("ignores an ordinary image that already has a URL", () => {
    const source = "![A logo](https://example.com/logo.png)";
    const { markdown, figures } = extractFigures(source);
    expect(figures).toEqual([]);
    expect(markdown).toBe(source);
  });
});

describe("substituteFigures", () => {
  const figures = [
    { index: 0, alt: "A drifting glider", prompt: "rings" },
    { index: 1, alt: "A membrane", prompt: "blobs" },
  ];

  it("renders an uploaded figure with its caption", () => {
    const html = substituteFigures(
      "<p>a</p><!--figure:0-->",
      figures,
      new Map([[0, "/images/lenia-fig-1.png"]]),
    );
    expect(html).toContain('<img src="/images/lenia-fig-1.png" alt="A drifting glider" />');
    expect(html).toContain("<figcaption>A drifting glider</figcaption>");
  });

  it("removes the marker of a figure that could not be generated", () => {
    // The article is worth more than the picture.
    const html = substituteFigures(
      "<!--figure:0--><!--figure:1-->",
      figures,
      new Map([[1, "/images/lenia-fig-2.png"]]),
    );
    expect(html).not.toContain("<!--figure:0-->");
    expect(html).toContain("lenia-fig-2.png");
  });
});

describe("renderBody", () => {
  it("turns a fenced block into the blog's Callout component", () => {
    const html = renderBody(":::tip Why this matters\nEmergence is easier to watch.\n:::");
    expect(html).toContain('<Callout type="tip" title="Why this matters">');
    expect(html).toContain("</Callout>");
  });

  it("renders the markdown inside a callout, not just around it", () => {
    // `marked` does not descend into block HTML, so the callout body has to be
    // parsed on its own — otherwise its prose ships as unformatted text.
    const html = renderBody(":::note\nThis is **important**.\n:::");
    expect(html).toContain("<strong>important</strong>");
  });

  it("omits the title attribute when the author gave none", () => {
    const html = renderBody(":::warn\nCareful.\n:::");
    expect(html).toContain('<Callout type="warn">');
  });

  it("passes an unrecognised type through for the blog to degrade", () => {
    // The blog's component falls back to `note`. A second opinion about the
    // valid set here could only drift away from it.
    expect(renderBody(":::sidebar\nText.\n:::")).toContain('<Callout type="sidebar">');
  });

  it("closes a callout the author forgot to close", () => {
    const html = renderBody("Prose.\n\n:::tip\nUnterminated.");
    expect(html).toContain("</Callout>");
    expect(html).not.toContain(":::");
  });

  it("still escapes braces that would break the site build", () => {
    const html = renderBody(":::note\nUse `{ a: 1 }` here.\n:::");
    expect(html).not.toMatch(/[{}]/);
  });

  it("renders prose surrounding a callout as ordinary markdown", () => {
    const html = renderBody("Before.\n\n:::tip\nAside.\n:::\n\nAfter.");
    expect(html).toContain("<p>Before.</p>");
    expect(html).toContain("<p>After.</p>");
  });
});

describe("the article signature", () => {
  // The signature is authored by the model, not appended by code, so the only
  // thing holding it together is the literal text in ARTICLE_CRAFT_PROMPT.
  // These tests render *that* text rather than a copy of it, which is what
  // stops the instruction and the renderer from drifting apart.
  const SIGNATURE =
    "*Written by **The Brain**, of " +
    "[Pinky and the Brain Agents](https://github.com/thiagocolen/pinky-and-the-brain).*";

  it("is the wording the writing standard actually asks for", () => {
    expect(ARTICLE_CRAFT_PROMPT).toContain(SIGNATURE);
  });

  it("renders as a rule and a credit linking back to the repository", () => {
    const html = renderBody(`The closing paragraph.\n\n---\n\n${SIGNATURE}`);
    expect(html).toContain("<hr>");
    expect(html).toContain('href="https://github.com/thiagocolen/pinky-and-the-brain"');
    expect(html).toContain("<strong>The Brain</strong>");
  });

  it("survives publication as the last thing in the body", () => {
    const post = preparePost(`# Lenia\n\nA continuous automaton.\n\n---\n\n${SIGNATURE}`);
    expect(post.body.trimEnd()).toMatch(/Pinky and the Brain Agents<\/a>\.<\/em><\/p>$/);
  });

  it("swallows the closing paragraph when the blank line is missing", () => {
    // Why the standard is emphatic about that blank line: three hyphens pressed
    // against a paragraph are setext underlining, not a thematic break, and the
    // article's last sentence ships as an <h2>.
    const html = renderBody(`The closing paragraph.\n---\n\n${SIGNATURE}`);
    expect(html).toContain("<h2>The closing paragraph.</h2>");
  });
});

describe("escapeAttribute", () => {
  it("neutralises quotes and braces that would break the tag or the build", () => {
    expect(escapeAttribute('a "quoted" {brace}')).toBe("a &quot;quoted&quot; &#123;brace&#125;");
  });
});

describe("preparePost", () => {
  const article = "# Lenia\n\nA continuous cellular automaton.";

  it("sends the article's own content, and nothing else", () => {
    // Status, `published_at` and the slug are the blog server's to write. A
    // second opinion about them here is exactly what this change removed.
    const post = preparePost(article);
    expect(post.title).toBe("Lenia");
    expect(post.body).toContain("continuous cellular automaton");
    expect(Object.keys(post).sort()).toEqual(["body", "figures", "headline", "title"]);
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

  it("lifts the article's own deck into the headline field", () => {
    // The bug this fixes: the deck shipped as a stray <h3> at the top of the
    // body while the headline frontmatter stayed empty.
    const post = preparePost("# Lenia\n\n### Learning to love the blob\n\nProse.");
    expect(post.headline).toBe("Learning to love the blob");
    expect(post.body).not.toContain("<h3>");
  });

  it("lifts the deck even when the caller overrides the title", () => {
    const post = preparePost("# Lenia\n\n### A deck\n\nProse.", { title: "Another Title" });
    expect(post.headline).toBe("A deck");
    expect(post.body).toContain("<h1>Lenia</h1>");
    expect(post.body).not.toContain("<h3>");
  });

  it("lets an explicit headline win over the authored deck", () => {
    const post = preparePost("# Lenia\n\n### Authored deck\n\nProse.", {
      headline: "Supplied deck",
    });
    expect(post.headline).toBe("Supplied deck");
  });

  it("carries the article's layout into the body", () => {
    const post = preparePost(
      "# Lenia\n\nProse.\n\n:::tip Note this\nAn aside.\n:::\n\n![A glider](image: rings)",
    );
    expect(post.body).toContain('<Callout type="tip" title="Note this">');
    expect(post.body).toContain("<!--figure:0-->");
    expect(post.figures).toHaveLength(1);
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
    mockConfig.geminiImageSize = "1K";
  });

  it("forbids text in the generated image", () => {
    // Models render lettering eagerly and get it wrong; a misspelled cover is
    // worse than no cover.
    expect(buildImagePrompt("Lenia")).toMatch(/no text/i);
  });

  it("includes the article subject and the article's style", () => {
    const prompt = buildImagePrompt("Lenia", "Continuous cellular automata");
    expect(prompt).toContain("Lenia");
    expect(prompt).toContain("Continuous cellular automata");
    expect(prompt).toContain(styleFor("Lenia").prompt);
  });

  it("draws the cover and every figure of one article in the same style", () => {
    // The whole point of a per-article style: a figure must never derive its own
    // look from its own prompt text.
    const style = styleFor("Lenia");
    expect(buildImagePrompt("Lenia", undefined, style)).toContain(style.prompt);
    expect(buildFigurePrompt("concentric rings", style)).toContain(style.prompt);
  });

  it("asks for artwork that bleeds off every edge", () => {
    // Image models otherwise centre the subject and leave air around it, which
    // reads as clip-art dropped onto the page.
    for (const prompt of [buildImagePrompt("Lenia"), buildFigurePrompt("rings", styleFor("Lenia"))]) {
      expect(prompt).toMatch(/full-bleed/i);
      expect(prompt).toMatch(/past all four edges/i);
      expect(prompt).toMatch(/no border/i);
    }
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

  it("forbids text in figures too, not only on the cover", () => {
    expect(buildFigurePrompt("concentric rings", styleFor("Lenia"))).toMatch(/no text/i);
  });

  it("leads a figure prompt with what the author asked for", () => {
    // The author has already named the idea; a figure that does not match its
    // caption is worse than no figure.
    const prompt = buildFigurePrompt("concentric rings", styleFor("Lenia"), "A drifting glider");
    expect(prompt).toContain("concentric rings");
    expect(prompt).toContain("A drifting glider");
  });

  it("asks for a square cover and a wide figure at the configured size", () => {
    // A 1:1 frame holds more pixels than a 16:9 one at the same tier, which is
    // the only way a model that serves a single tier can give a cover more
    // material than a figure.
    const geometries: ImageGeometry[] = [];
    mockConfig.geminiApiKey = "test-key";
    __setImageGenerator(async (_prompt, geometry) => {
      geometries.push(geometry);
      return null;
    });

    // Sequentially, so the assertion reads the two requests rather than however
    // two concurrent ones happened to interleave.
    return generateCoverImage("Lenia")
      .then(() => generateBodyImage("rings", styleFor("Lenia")))
      .then(() => {
        expect(geometries).toEqual([
          { aspectRatio: "1:1", imageSize: "1K" },
          { aspectRatio: "16:9", imageSize: "1K" },
        ]);
      });
  });

  it("does not retry when the configured size is already the fallback", () => {
    // The common case: one request per image, not two.
    let calls = 0;
    mockConfig.geminiApiKey = "test-key";
    __setImageGenerator(async () => {
      calls += 1;
      return null;
    });

    return generateCoverImage("Lenia").then(() => expect(calls).toBe(1));
  });

  it("retries at a documented size when the configured one is refused", async () => {
    // Not hypothetical: the default image model answers 400 for both `512` and
    // `2K`. Without this retry an unserved size would silently cost every image
    // of every article, since failure here is soft by design.
    mockConfig.geminiApiKey = "test-key";
    mockConfig.geminiImageSize = "2K";
    __setImageGenerator(async (_prompt, { imageSize }) => {
      if (imageSize !== "1K") throw new Error("Image size 2K is not supported for this model");
      return { bytes: Buffer.from("png"), mimeType: "image/png", extension: "png" };
    });

    expect(await generateBodyImage("rings", styleFor("Lenia"))).not.toBeNull();
  });

  it("returns null from a failed figure, so the article still publishes", async () => {
    mockConfig.geminiApiKey = "test-key";
    __setImageGenerator(async () => {
      throw new Error("model unavailable");
    });
    expect(await generateBodyImage("rings", styleFor("Lenia"), "A glider")).toBeNull();
  });
});

describe("illustration styles", () => {
  it("gives the same article the same style every time it is published", () => {
    expect(styleFor("Lenia").id).toBe(styleFor("Lenia").id);
    expect(styleFor("Lenia").id).toBe(styleFor("  lenia  ").id);
  });

  it("spreads articles across the catalogue rather than clustering them", () => {
    const titles = [
      "Lenia",
      "Conway's Game of Life",
      "Particle Life",
      "AWS Shared Responsibility",
      "Elementary Automata",
      "IELTS Speaking",
      "Frontend Interview Roadmap",
      "S3 Storage Classes",
    ];
    const chosen = new Set(titles.map((t) => styleFor(t).id));
    expect(chosen.size).toBeGreaterThan(1);
  });

  it("carries no aspect-ratio flags, since the ratio is a request parameter", () => {
    for (const style of ILLUSTRATION_STYLES) {
      expect(style.prompt).not.toContain("--ar");
    }
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

  it("uploads one figure per marker and patches them into the body", async () => {
    mockConfig.geminiApiKey = "test-key";
    __setImageGenerator(async () => ({
      bytes: Buffer.from("fake-png-bytes"),
      mimeType: "image/png",
      extension: "png",
    }));
    const session = recordingSession();
    const illustrated =
      "# Lenia\n\nProse.\n\n![A drifting glider](image: rings)\n\nMore.\n\n![A membrane](image: blobs)";
    const result = await publishToBlog(illustrated);

    // Cover plus two figures, and a single patch carrying both the cover and
    // the finished body — not one round trip per image.
    expect(session.names().filter((n) => n === "add_asset")).toHaveLength(3);
    expect(session.names().filter((n) => n === "update_post")).toHaveLength(1);
    expect(session.calls.map((c) => c.args.filename).filter(Boolean)).toEqual([
      "lenia.png",
      "lenia-fig-1.png",
      "lenia-fig-2.png",
    ]);

    const body = session.argsFor("update_post").body;
    expect(body).toContain('<img src="/images/lenia-fig-1.png" alt="A drifting glider" />');
    expect(body).toContain('<img src="/images/lenia-fig-2.png" alt="A membrane" />');
    expect(body).not.toContain("<!--figure:");
    expect(result).toMatch(/2 of 2 generated figure/i);
  });

  it("drops only the figure that failed, keeping the rest", async () => {
    mockConfig.geminiApiKey = "test-key";
    __setImageGenerator(async (prompt) => {
      // The cover generates, the first figure fails, the second succeeds. Keyed
      // on the prompt rather than on a call count because a failed request is
      // retried at a smaller size, and this figure fails at every size.
      if (prompt.includes("depicting: one")) return null;
      return { bytes: Buffer.from("bytes"), mimeType: "image/png", extension: "png" };
    });
    const session = recordingSession();
    const result = await publishToBlog(
      "# Lenia\n\n![First](image: one)\n\n![Second](image: two)",
    );

    const body = session.argsFor("update_post").body;
    expect(body).not.toContain("<!--figure:");
    expect(body).not.toContain('alt="First"');
    expect(body).toContain('alt="Second"');
    expect(result).toMatch(/1 of 2 generated figure/i);
  });

  it("leaves the draft untouched when no image of any kind could be made", async () => {
    // With nothing to patch, the draft as created is already correct — its
    // markers are HTML comments, invisible on the page either way.
    mockConfig.geminiApiKey = "test-key";
    __setImageGenerator(async () => null);
    const session = recordingSession();
    const result = await publishToBlog("# Lenia\n\n![A glider](image: rings)");

    expect(session.names()).toEqual(["create_draft", "stage_changes"]);
    expect(session.argsFor("create_draft").body).toContain("<!--figure:0-->");
    expect(result).toContain("compare/new-articles");
  });

  it("sends the article's deck to the blog as the headline", async () => {
    const session = recordingSession();
    await publishToBlog("# Lenia\n\n### Learning to love the blob\n\nProse.");
    expect(session.argsFor("create_draft").headline).toBe("Learning to love the blob");
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

  it("treats choosing to publish as the confirmation, rather than asking again", () => {
    // Picking "publish" from the delivery menu is already a deliberate choice;
    // a second "shall I proceed?" only cost a round trip.
    expect(BRAIN_SYSTEM_PROMPT).toMatch(/choosing to publish \*\*is\*\* the confirmation/i);
    expect(BRAIN_SYSTEM_PROMPT).toMatch(/do not ask them to confirm the push/i);
  });

  it("has The Brain write the listing description and tags itself", () => {
    expect(BRAIN_SYSTEM_PROMPT).toMatch(/description and a few lowercase tags \*\*yourself\*\*/i);
    expect(BRAIN_SYSTEM_PROMPT).toMatch(/state the description and tags you chose/i);
  });

  it("goes from a saved article straight to the delivery menu", () => {
    // No "anything to change?" pause: the menu itself is the question, and a
    // change request arrives in place of a destination.
    expect(BRAIN_SYSTEM_PROMPT).toMatch(/Do not ask whether they want to change anything/i);
    expect(BRAIN_SYSTEM_PROMPT).toMatch(/go straight on to \*\*Step 4c\*\*/i);
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
    expect(ARTICLE_CRAFT_PROMPT).toMatch(/deck/i);
  });

  it("tells the agent where the long title belongs instead", () => {
    expect(BRAIN_SYSTEM_PROMPT).toMatch(/at most about six words/i);
  });

  it("teaches all three layout marks, so an article is not a wall of text", () => {
    expect(ARTICLE_CRAFT_PROMPT).toMatch(/## Layout/);
    expect(ARTICLE_CRAFT_PROMPT).toContain(":::tip");
    expect(ARTICLE_CRAFT_PROMPT).toContain("(image:");
    expect(ARTICLE_CRAFT_PROMPT).toMatch(/line immediately under the title/i);
  });

  it("requires the layout to live in the file Pinky reviews", () => {
    expect(ARTICLE_CRAFT_PROMPT).toMatch(/into the file itself/i);
    expect(BRAIN_SYSTEM_PROMPT).toMatch(/The layout goes \*\*in the file\*\*/);
  });

  it("keeps callouts and figures from being mere decoration", () => {
    expect(ARTICLE_CRAFT_PROMPT).toMatch(/restate what the prose already says/i);
    expect(ARTICLE_CRAFT_PROMPT).toMatch(/merely decorates should be cut/i);
  });

  it("warns that generated illustrations must not contain text", () => {
    expect(ARTICLE_CRAFT_PROMPT).toMatch(/never for anything containing text/i);
  });

  it("leaves the illustration style to the publisher, not to the author", () => {
    // A figure prompt naming a colour or a medium fights the style `styleFor`
    // fixes for the whole article.
    expect(ARTICLE_CRAFT_PROMPT).toMatch(/never how it should look/i);
    expect(ARTICLE_CRAFT_PROMPT).toMatch(/the style is fixed per article/i);
  });
});

describe("The blog branch the agent stages to", () => {
  it("is the branch no workflow builds", () => {
    // Pushing here cannot reach the public site; only a merged PR can.
    expect(BLOG_BRANCH).toBe("new-articles");
  });
});
