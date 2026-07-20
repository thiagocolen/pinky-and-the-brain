import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

vi.mock("../../config.js", () => ({
  config: {
    anthropicApiKey: "mock-key-for-testing",
    anthropicModel: "claude-sonnet-5",
    patbaApiKey: "mock-key-for-testing",
    blogRepoPath: "/nonexistent/blog-checkout",
    geminiApiKey: "",
    geminiImageModel: "gemini-3.1-flash-lite-image",
  },
  projectRoot: process.cwd(),
}));

import {
  TOPICS,
  resolveTopic,
  retrieveContext,
  extractSubtopics,
  resolveArticlePath,
  loadVectorStore,
  __setVectorStore,
  __resetVectorStore,
} from "../../agents/tools.js";
import { BRAIN_SYSTEM_PROMPT } from "../../agents/prompts.js";

describe("Topic registry", () => {
  it("exposes the four topics of expertise", () => {
    expect(TOPICS.map((t) => t.id).sort()).toEqual([
      "aws",
      "cellular-automata",
      "english",
      "interview",
    ]);
  });

  it("maps every topic to an area present in the real vector store", () => {
    const areas = new Set(loadVectorStore().map((c) => c.area));
    for (const topic of TOPICS) {
      expect(areas.has(topic.area), `missing area ${topic.area}`).toBe(true);
    }
  });

  it("resolves a topic by id, label, and partial name", () => {
    expect(resolveTopic("aws")?.area).toBe("aws-tutor");
    expect(resolveTopic("Cellular Automata")?.id).toBe("cellular-automata");
    expect(resolveTopic("english for certifications")?.id).toBe("english");
  });

  it("returns undefined for an unknown topic", () => {
    expect(resolveTopic("bread baking")).toBeUndefined();
  });
});

describe("retrieveContext", () => {
  afterEach(() => {
    __resetVectorStore();
  });

  it("retrieves material for aws-tutor", () => {
    const results = retrieveContext("DynamoDB and IAM policies", "aws-tutor");
    expect(results.length).toBeGreaterThan(0);
  });

  it("retrieves material for the interview area", () => {
    const results = retrieveContext("JavaScript closure and hooks", "job-techinical-interview");
    expect(results.length).toBeGreaterThan(0);
  });

  it("ranks chunks containing more query terms first", () => {
    __setVectorStore([
      { area: "test", content: "nothing relevant here" },
      { area: "test", content: "alpha only" },
      { area: "test", content: "alpha beta gamma together" },
    ]);
    const results = retrieveContext("alpha beta gamma", "test");
    expect(results[0]).toBe("alpha beta gamma together");
    expect(results).not.toContain("nothing relevant here");
  });

  it("returns nothing for an unknown area", () => {
    __setVectorStore([{ area: "test", content: "alpha" }]);
    expect(retrieveContext("alpha", "no-such-area")).toEqual([]);
  });
});

describe("extractSubtopics", () => {
  afterEach(() => {
    __resetVectorStore();
  });

  it("uses roles for the interview roadmaps", () => {
    __setVectorStore([
      { area: "job", content: "Role: React Developer - Topic: Hooks" },
      { area: "job", content: "Role: React Developer - Topic: State" },
      { area: "job", content: "Role: Node.js Developer - Topic: Streams" },
    ]);
    expect(extractSubtopics("job")).toEqual(["React Developer", "Node.js Developer"]);
  });

  it("uses top-level headings when an area has enough of them", () => {
    const chunks = Array.from({ length: 6 }, (_, i) => ({
      area: "md",
      content: `# Heading ${i}`,
    }));
    chunks.push({ area: "md", content: "## Nested heading" });
    __setVectorStore(chunks);
    const subtopics = extractSubtopics("md");
    expect(subtopics).toHaveLength(6);
    expect(subtopics).not.toContain("Nested heading");
  });

  it("falls back to including H2s for shallow areas", () => {
    __setVectorStore([
      { area: "md", content: "# Only Heading" },
      { area: "md", content: "## IELTS" },
      { area: "md", content: "## TOEFL" },
    ]);
    expect(extractSubtopics("md")).toEqual(["Only Heading", "IELTS", "TOEFL"]);
  });

  it("finds real subtopics for each configured topic", () => {
    loadVectorStore();
    for (const topic of TOPICS) {
      expect(extractSubtopics(topic.area).length, `no subtopics for ${topic.id}`).toBeGreaterThan(0);
    }
  });
});

describe("resolveArticlePath", () => {
  it("appends .md and slugifies", () => {
    expect(path.basename(resolveArticlePath("Game of Life"))).toBe("Game-of-Life.md");
  });

  it("keeps an existing .md extension", () => {
    expect(path.basename(resolveArticlePath("conway.md"))).toBe("conway.md");
  });

  it("confines path traversal to the articles directory", () => {
    const resolved = resolveArticlePath("../../etc/passwd");
    expect(path.dirname(resolved)).toBe(path.resolve(process.cwd(), "articles"));
    expect(path.basename(resolved)).toBe("passwd.md");
  });
});

describe("Article tools", () => {
  let tmpDir: string;
  let cwdSpy: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-articles-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves an article and reports its path", async () => {
    const { brainTools } = await import("../../agents/tools.js");
    const saveArticle = brainTools.find((t: any) => t.name === "save_article")!;

    const result: any = await saveArticle.invoke({
      filename: "test-article.md",
      content: "# Test\n\nBody.",
    });

    // ARTICLES_DIR is resolved at module load, so assert on the reported path.
    const reportedPath = String(result).replace("Article saved to ", "");
    expect(fs.existsSync(reportedPath)).toBe(true);
    expect(fs.readFileSync(reportedPath, "utf-8")).toContain("# Test");
    fs.rmSync(reportedPath, { force: true });
  });

  it("refuses to update an article that does not exist", async () => {
    const { brainTools } = await import("../../agents/tools.js");
    const updateArticle = brainTools.find((t: any) => t.name === "update_article")!;

    const result: any = await updateArticle.invoke({
      filename: "does-not-exist-at-all.md",
      content: "nope",
    });
    expect(String(result)).toContain("No article exists");
  });
});

describe("System prompt", () => {
  it("establishes the persona and the user as Pinky", () => {
    expect(BRAIN_SYSTEM_PROMPT).toContain("The Brain");
    expect(BRAIN_SYSTEM_PROMPT).toContain("The user IS Pinky");
  });

  it("encodes the journey steps and the teaching loop", () => {
    expect(BRAIN_SYSTEM_PROMPT).toContain("list_topics");
    expect(BRAIN_SYSTEM_PROMPT).toContain("list_subtopics");
    expect(BRAIN_SYSTEM_PROMPT).toContain("save_article");
    expect(BRAIN_SYSTEM_PROMPT).toContain("update_article");
    expect(BRAIN_SYSTEM_PROMPT).toMatch(/Decompose/i);
    expect(BRAIN_SYSTEM_PROMPT).toMatch(/Never fake progress/i);
  });
});
