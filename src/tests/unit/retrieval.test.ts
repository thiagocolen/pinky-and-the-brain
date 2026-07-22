import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("../../config.js", () => ({
  config: {
    anthropicApiKey: "mock-key-for-testing",
    geminiApiKey: "mock-key-for-testing",
    geminiEmbeddingModel: "gemini-embedding-001",
    geminiEmbeddingDim: 4,
    retrievalMode: "hybrid",
  },
  projectRoot: process.cwd(),
}));

import {
  buildIndex,
  chunkId,
  fuseRankings,
  search,
  stem,
  tokenize,
  STOPWORDS,
  type KnowledgeChunk,
} from "../../utils/retrieval.js";
import {
  cosine,
  decodeStore,
  encodeStore,
  embedQuery,
  normalise,
  quantise,
  __setEmbedder,
  __resetEmbedder,
  __clearQueryCache,
} from "../../utils/embeddings.js";

const chunk = (content: string, area = "test"): KnowledgeChunk => ({
  id: chunkId(content),
  content,
  area,
});

describe("tokenize", () => {
  // Each of these is a defect the previous substring-counting scorer had, and
  // each was measured against the real store before being fixed.
  it("strips punctuation so a trailing question mark does not kill the term", () => {
    // "work?" could never match "work" — the term was dead weight in every
    // question a user actually types.
    expect(tokenize("How does it work?")).toContain("work");
  });

  it("drops the function words that carried most of the old score", () => {
    // "How does the Game of Life work?" scored 6 terms, of which how/does/the
    // matched almost every paragraph in the corpus.
    expect(tokenize("How does the Game of Life work?")).toEqual(["game", "life", "work"]);
  });

  it("keeps two-character domain terms the old length filter discarded", () => {
    // The old cutoff dropped anything <= 2 chars, losing S3 and AI while
    // keeping "the".
    expect(tokenize("S3 and AI")).toEqual(["s3", "ai"]);
  });

  it("never matches inside a longer word", () => {
    // `String.includes` scored "cell" inside "excellent" and "ant" inside
    // "important".
    expect(tokenize("excellent important started")).not.toContain("cell");
    expect(tokenize("excellent important started")).not.toContain("ant");
  });

  it("leaves domain vocabulary out of the stopword list", () => {
    for (const term of ["state", "set", "type", "value", "cell"]) {
      expect(STOPWORDS.has(term), `${term} must stay searchable`).toBe(false);
    }
  });
});

describe("stem", () => {
  it("folds the irregular plural that names a whole topic area", () => {
    expect(stem("automata")).toBe(stem("automaton"));
  });

  it("folds ordinary plurals", () => {
    expect(stem("policies")).toBe(stem("policy"));
    expect(stem("buckets")).toBe(stem("bucket"));
    expect(stem("boxes")).toBe(stem("box"));
  });

  it("does not mistake a singular ending in s for a plural", () => {
    expect(stem("class")).toBe("class");
    expect(stem("status")).toBe("status");
    expect(stem("analysis")).toBe("analysis");
  });
});

describe("BM25 search", () => {
  it("ranks a chunk about the query above one that merely mentions it", () => {
    const index = buildIndex([
      chunk("Lenia is a continuous cellular automaton. Lenia generalises Lenia's neighbourhood."),
      chunk("This page mentions Lenia once, in passing, among many other unrelated topics."),
    ]);
    const [top] = search(index, "Lenia", 5);
    expect(top.content).toContain("continuous cellular automaton");
  });

  it("weights a rare term above a common one", () => {
    const common = Array.from({ length: 20 }, (_, i) => chunk(`common term appears here ${i}`));
    const index = buildIndex([...common, chunk("rare glider term appears")]);
    const [top] = search(index, "common glider", 5);
    expect(top.content).toContain("glider");
  });

  it("does not let a long chunk win on surface area alone", () => {
    const padding = "unrelated filler sentence about something else entirely. ".repeat(60);
    const index = buildIndex([
      chunk(`${padding} glider`),
      chunk("A glider moves across the grid."),
    ]);
    const [top] = search(index, "glider", 5);
    expect(top.content).toBe("A glider moves across the grid.");
  });

  it("breaks ties deterministically rather than by position in the store", () => {
    // The old cut-off fell inside a block of equally-scored chunks, so which
    // passages the model saw depended on the order they were written to disk.
    const chunks = [chunk("alpha one"), chunk("alpha two"), chunk("alpha three")];
    const forwards = search(buildIndex(chunks), "alpha", 2).map((c) => c.id);
    const backwards = search(buildIndex([...chunks].reverse()), "alpha", 2).map((c) => c.id);
    expect(forwards).toEqual(backwards);
  });

  it("finds a passage phrased in the singular from a plural query", () => {
    const index = buildIndex([chunk("The automaton evolves one generation at a time.")]);
    expect(search(index, "cellular automata", 5)).toHaveLength(1);
  });

  it("returns nothing when the query is all stopwords", () => {
    expect(search(buildIndex([chunk("alpha")]), "how does the", 5)).toEqual([]);
  });

  it("never scores a term negatively for being common", () => {
    // The textbook IDF goes negative past 50% document frequency, which lets a
    // common word push a relevant chunk below an irrelevant one.
    const chunks = Array.from({ length: 10 }, (_, i) => chunk(`glider ${i}`));
    for (const hit of search(buildIndex(chunks), "glider", 10)) {
      expect(hit.score).toBeGreaterThan(0);
    }
  });
});

describe("chunkId", () => {
  it("is derived from the content, so it survives re-ingestion", () => {
    expect(chunkId("same text")).toBe(chunkId("same text"));
    expect(chunkId("other text")).not.toBe(chunkId("same text"));
  });
});

describe("fuseRankings", () => {
  it("promotes what both retrievers found over either one's favourite", () => {
    // The point of fusing: "agreed on by both" outranks "top of one list and
    // absent from the other". `shared` is only second on each list and still
    // wins, which is what stops one confident retriever deciding the outcome.
    const fused = fuseRankings([
      ["lexical-only", "shared"],
      ["vector-only", "shared"],
    ]);
    const ordered = [...fused.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(ordered[0]).toBe("shared");
  });

  it("still surfaces a result only one retriever found", () => {
    const fused = fuseRankings([["a"], ["z"]]);
    expect(fused.has("z")).toBe(true);
  });
});

describe("embedding vectors", () => {
  afterEach(() => {
    __resetEmbedder();
    __clearQueryCache();
  });

  it("normalises before quantising, because a truncated vector is not a unit vector", () => {
    const unit = normalise([3, 4, 0, 0]);
    expect(Math.hypot(...unit)).toBeCloseTo(1, 10);
  });

  it("preserves similarity through quantisation", () => {
    const a = quantise(normalise([1, 0.5, 0.2, 0]));
    const b = quantise(normalise([1, 0.5, 0.2, 0]));
    const c = quantise(normalise([-1, -0.5, 0, 0.3]));
    expect(cosine(a, b)).toBeCloseTo(1, 2);
    expect(cosine(a, c)).toBeLessThan(0);
  });

  it("round-trips a store through its binary format", () => {
    const vectors = new Map([
      ["aaaaaaaaaaaa", quantise(normalise([1, 0, 0, 0]))],
      ["bbbbbbbbbbbb", quantise(normalise([0, 1, 0, 0]))],
    ]);
    const decoded = decodeStore(encodeStore({ model: "gemini-embedding-001", dim: 4, vectors }));
    expect(decoded?.dim).toBe(4);
    expect(decoded?.model).toBe("gemini-embedding-001");
    expect([...decoded!.vectors.keys()]).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    expect(cosine(decoded!.vectors.get("aaaaaaaaaaaa")!, vectors.get("aaaaaaaaaaaa")!)).toBeCloseTo(1, 5);
  });

  it("rejects a file that is not an embedding store rather than misreading it", () => {
    expect(decodeStore(Buffer.from("not an embedding store at all"))).toBeNull();
  });

  it("asks for query and document vectors differently", () => {
    const kinds: string[] = [];
    __setEmbedder(async (_texts, kind) => {
      kinds.push(kind);
      return [[1, 0, 0, 0]];
    });
    return embedQuery("anything").then(() => expect(kinds).toEqual(["query"]));
  });

  it("embeds a repeated query only once", async () => {
    let calls = 0;
    __setEmbedder(async () => {
      calls++;
      return [[1, 0, 0, 0]];
    });
    await embedQuery("the same subtopic");
    await embedQuery("The Same Subtopic");
    expect(calls).toBe(1);
  });

  it("returns null rather than throwing when embedding fails", async () => {
    __setEmbedder(async () => null);
    expect(await embedQuery("anything")).toBeNull();
  });
});
