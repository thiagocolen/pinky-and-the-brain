#!/usr/bin/env node
/**
 * Scores the retrievers against a hand-labelled query set.
 *
 * The reason this exists: "retrieval is better now" is otherwise an assertion.
 * Every claim made in the changelog about the move from substring counting to
 * BM25, and from BM25 to hybrid, is a number printed by this script.
 *
 * The legacy retriever is reproduced here rather than kept alive in `src/`.
 * A baseline has to stay runnable to remain a baseline, but it should not be
 * loadable by the agent — nothing should be able to select it by accident.
 *
 * Usage:  npm run eval:retrieval
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const { loadKnowledgeStore, retrieveContext } = await import("../dist/agents/tools.js");
const { buildIndex, search } = await import("../dist/utils/retrieval.js");

const LIMIT = 10;

/**
 * The retriever as it stood before this work: whitespace split, terms of three
 * characters or more, one point per term appearing anywhere in the chunk as a
 * substring, ties broken by position in the store.
 */
function legacyRetrieve(chunks, query) {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  return chunks
    .map((chunk) => {
      const content = chunk.content.toLowerCase();
      let score = 0;
      for (const term of terms) if (content.includes(term)) score++;
      return { chunk, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT)
    .map((item) => item.chunk.id);
}

/** Fraction of the labelled passages that made it into the top `LIMIT`. */
function recall(returned, relevant) {
  if (relevant.size === 0) return 0;
  const found = returned.filter((id) => relevant.has(id)).length;
  return found / relevant.size;
}

/** Reciprocal rank of the first labelled passage: how far a reader has to read. */
function reciprocalRank(returned, relevant) {
  const index = returned.findIndex((id) => relevant.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

/** Binary-gain nDCG: rewards putting the good passages near the top, not merely in the list. */
function ndcg(returned, relevant) {
  let dcg = 0;
  returned.forEach((id, i) => {
    if (relevant.has(id)) dcg += 1 / Math.log2(i + 2);
  });
  let ideal = 0;
  for (let i = 0; i < Math.min(LIMIT, relevant.size); i++) ideal += 1 / Math.log2(i + 2);
  return ideal === 0 ? 0 : dcg / ideal;
}

async function main() {
  const fixturePath = path.join(rootDir, "src", "tests", "fixtures", "retrieval-eval.json");
  const { queries } = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
  const store = loadKnowledgeStore();

  // Labels are only meaningful if the chunks they name still exist. A silent
  // zero here would look like a retrieval regression rather than a stale file.
  const ids = new Set(store.map((c) => c.id));
  const missing = queries.flatMap((q) => q.relevant.filter((id) => !ids.has(id)));
  if (missing.length > 0) {
    console.error(
      `\n${missing.length} labelled chunk(s) are not in the store: ${missing.slice(0, 5).join(", ")}` +
        `\nThe corpus changed under the fixture — re-label before trusting these numbers.\n`,
    );
  }

  const retrievers = {
    "legacy (substring)": async (query, area) => {
      const chunks = store.filter((c) => c.area === area);
      return legacyRetrieve(chunks, query);
    },
    "bm25 (lexical)": async (query, area) => {
      const chunks = store.filter((c) => c.area === area);
      return search(buildIndex(chunks), query, LIMIT).map((c) => c.id);
    },
    "hybrid (bm25 + vectors)": async (query, area) =>
      (await retrieveContext(query, area, LIMIT, { mode: "hybrid" })).map((c) => c.id),
  };

  const rows = [];
  for (const [name, retrieve] of Object.entries(retrievers)) {
    let r = 0;
    let mrr = 0;
    let nd = 0;
    let misses = 0;
    for (const q of queries) {
      const relevant = new Set(q.relevant);
      const returned = await retrieve(q.query, q.area);
      r += recall(returned, relevant);
      const rr = reciprocalRank(returned, relevant);
      mrr += rr;
      nd += ndcg(returned, relevant);
      if (rr === 0) misses++;
    }
    const n = queries.length;
    rows.push({
      retriever: name,
      [`recall@${LIMIT}`]: (r / n).toFixed(3),
      MRR: (mrr / n).toFixed(3),
      [`nDCG@${LIMIT}`]: (nd / n).toFixed(3),
      "queries with nothing relevant": misses,
    });
  }

  console.log(`\n${queries.length} queries · ${store.length} chunks · top ${LIMIT}\n`);
  console.table(rows);
  console.log(
    "\nrecall@10  — how much of the labelled material was found at all." +
      "\nMRR        — how far down the first useful passage sits." +
      "\nnDCG@10    — whether the useful passages are near the top rather than merely present.\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
