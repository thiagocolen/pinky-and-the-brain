/**
 * Lexical retrieval: tokenisation, stemming and BM25.
 *
 * This is the retriever behind `retrieve_content`, and it is deliberately pure
 * — no I/O, no config, no knowledge of where chunks come from — for the same
 * reason `src/agents/layout.ts` is: the interesting cases are all edge cases,
 * and edge cases are cheap to test when nothing has to be mocked.
 *
 * What it replaced is worth recording, because every rule here exists to fix
 * something that was measurably wrong. The previous implementation scored a
 * chunk by counting how many whitespace-split query terms appeared in it as
 * substrings, which meant:
 *
 *   - `work?` could never match `work`; punctuation was never stripped.
 *   - `how`, `does` and `the` all scored, being longer than the two-character
 *     cutoff. For "How does the Game of Life work?" only two of six terms
 *     carried any signal.
 *   - `cell` scored inside `excellent` and `ant` inside `important`, because
 *     `String.includes` does not know about word boundaries.
 *   - `automaton` missed `automata`.
 *   - Every match counted once, so a chunk mentioning a rare term in passing
 *     ranked level with one about it, and a long chunk beat a short one purely
 *     by having more surface area to hit.
 *   - Ties were broken by position in the JSON file.
 *
 * BM25 addresses the last two directly: term frequency saturates, rare terms
 * outweigh common ones, and length is normalised.
 */

import { createHash } from "node:crypto";

/**
 * A chunk's identity, derived from its own text.
 *
 * Content-addressed rather than positional because the store is rebuilt from
 * source: an array index changes the moment a paragraph is added anywhere
 * earlier in the corpus, which would silently invalidate both the evaluation
 * fixture and every stored embedding. A hash of the content survives
 * re-ingestion, reordering and re-chunking of *other* material, so only text
 * that actually changed needs re-embedding.
 *
 * Twelve hex characters is 48 bits. Across 7,059 chunks the chance of any
 * collision is about one in ten million, and a collision would merely make two
 * identical-scoring passages share a vector.
 */
export function chunkId(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 12);
}

/** A chunk of curated source material, as stored in the knowledge store. */
export interface KnowledgeChunk {
  /** Content-addressed and stable across re-ingest. See `chunkId`. */
  id: string;
  content: string;
  area: string;
  /** Corpus-relative path of the file this came from, when known. */
  source?: string;
  /** Nearest preceding markdown heading, when known. */
  heading?: string;
}

/** A chunk together with the score that selected it. */
export interface RetrievedChunk extends KnowledgeChunk {
  score: number;
}

/**
 * Words that carry no topical signal.
 *
 * The point of the list is not elegance but the observation that a question is
 * mostly function words: "How does the Game of Life work?" is six tokens, four
 * of which appear in nearly every English paragraph ever written. Left in, they
 * dominate the score and rank chunks by how much prose they contain.
 *
 * Kept deliberately short. An aggressive list starts eating domain vocabulary —
 * "state", "set" and "type" are all stopwords in some standard lists and all
 * meaningful in this corpus.
 */
export const STOPWORDS = new Set([
  "a", "about", "after", "all", "also", "am", "an", "and", "any", "are", "as", "at",
  "be", "because", "been", "before", "being", "between", "both", "but", "by",
  "can", "could", "did", "do", "does", "doing", "done", "down", "during",
  "each", "few", "for", "from", "further", "had", "has", "have", "having", "he",
  "her", "here", "hers", "him", "his", "how", "however",
  "i", "if", "in", "into", "is", "it", "its", "itself",
  "just", "me", "more", "most", "my", "no", "nor", "not", "now",
  "of", "off", "on", "once", "only", "or", "other", "our", "out", "over", "own",
  "same", "she", "should", "so", "some", "such",
  "than", "that", "the", "their", "theirs", "them", "then", "there", "these",
  "they", "this", "those", "through", "to", "too",
  "under", "until", "up", "us", "very", "was", "we", "were", "what", "when",
  "where", "whether", "which", "while", "who", "whom", "why", "will", "with",
  "would", "you", "your", "yours",
]);

/**
 * Plurals this corpus actually contains that no suffix rule would catch.
 *
 * `automata`/`automaton` is the one that matters — it is in the name of an
 * entire topic area, and a reader asking about "cellular automata" while the
 * source text says "the automaton" got nothing for it.
 */
const IRREGULAR_PLURALS: Record<string, string> = {
  automata: "automaton",
  phenomena: "phenomenon",
  criteria: "criterion",
  indices: "index",
  matrices: "matrix",
  vertices: "vertex",
  analyses: "analysis",
  hypotheses: "hypothesis",
  data: "datum",
};

/**
 * Folds a token towards a common stem.
 *
 * Deliberately light — plurals and nothing else. A full Porter stemmer would
 * conflate more, but it also mangles the technical vocabulary this corpus is
 * made of (`policies` → `polici`, `caching` → `cach`), and the failure mode of
 * over-stemming is silent: it returns confident matches on words the reader
 * never asked about.
 */
export function stem(token: string): string {
  const irregular = IRREGULAR_PLURALS[token];
  if (irregular) return irregular;

  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && /(ch|sh|x|z|s)es$/.test(token)) return token.slice(0, -2);
  // `ss`, `us` and `is` endings are not plurals: class, status, analysis.
  if (token.length > 3 && token.endsWith("s") && !/(ss|us|is)$/.test(token)) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * Splits text into scoring terms.
 *
 * Splitting on non-alphanumerics rather than whitespace is what makes `work?`
 * match `work`, and what stops `cell` from matching inside `excellent`: tokens
 * are compared whole, never as substrings.
 *
 * Two-character tokens survive the length filter because this corpus is full of
 * them — `S3`, `AI`, `UI`, `OS`. The previous cutoff discarded those while
 * keeping `the`, which is precisely backwards.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token))
    .map(stem);
}

/** BM25 term-frequency saturation. Standard value; higher means less saturation. */
const K1 = 1.2;
/** BM25 length normalisation. 0 disables it, 1 applies it fully. */
const B = 0.75;

interface IndexedDoc {
  chunk: KnowledgeChunk;
  /** Term -> frequency within this document. */
  frequencies: Map<string, number>;
  length: number;
}

/** An inverted index over one area's chunks. Build once, query many times. */
export interface BM25Index {
  docs: IndexedDoc[];
  /** Term -> number of documents containing it. */
  documentFrequency: Map<string, number>;
  averageLength: number;
}

export function buildIndex(chunks: KnowledgeChunk[]): BM25Index {
  const docs: IndexedDoc[] = [];
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;

  for (const chunk of chunks) {
    const tokens = tokenize(chunk.content);
    const frequencies = new Map<string, number>();
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    for (const term of frequencies.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
    totalLength += tokens.length;
    docs.push({ chunk, frequencies, length: tokens.length });
  }

  return {
    docs,
    documentFrequency,
    averageLength: docs.length > 0 ? totalLength / docs.length : 0,
  };
}

/**
 * Inverse document frequency, in the form that cannot go negative.
 *
 * The textbook BM25 IDF turns negative for a term appearing in more than half
 * the documents, which would let a common word actively *subtract* from a
 * score and push a genuinely relevant chunk below an irrelevant one. The `1 +`
 * variant is the usual fix and is what Lucene ships.
 */
function idf(totalDocs: number, docsWithTerm: number): number {
  return Math.log(1 + (totalDocs - docsWithTerm + 0.5) / (docsWithTerm + 0.5));
}

/**
 * Scores every document against the query and returns the best `limit`.
 *
 * Query terms are de-duplicated: BM25 sums over the terms of the query, so
 * asking about "cells, cells and more cells" would otherwise weight `cell`
 * three times for no reason a reader intended.
 *
 * Ties break on `id`, never on position in the store. That is not fussiness:
 * the old implementation's cut-off routinely fell inside a block of
 * equally-scored chunks, so which passages the model saw was decided by the
 * order they happened to be written to disk.
 */
export function search(index: BM25Index, query: string, limit: number): RetrievedChunk[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || index.docs.length === 0) return [];

  const total = index.docs.length;
  const scored: RetrievedChunk[] = [];

  for (const doc of index.docs) {
    let score = 0;
    for (const term of terms) {
      const frequency = doc.frequencies.get(term);
      if (!frequency) continue;
      const weight = idf(total, index.documentFrequency.get(term) ?? 0);
      const normalised =
        index.averageLength > 0 ? doc.length / index.averageLength : 1;
      score += weight * ((frequency * (K1 + 1)) / (frequency + K1 * (1 - B + B * normalised)));
    }
    if (score > 0) scored.push({ ...doc.chunk, score });
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, limit);
}

/**
 * Fuses several ranked lists into one.
 *
 * Reciprocal rank fusion, used here to combine BM25 with vector similarity.
 * It deliberately reads only the *rank* of a result, never its score, which is
 * the property that matters: a BM25 score and a cosine similarity are not
 * measured in the same units and cannot be added, weighted or averaged without
 * inventing a conversion between them. Rank is the one thing they share.
 *
 * `k` damps the influence of the very top positions so that one retriever being
 * confident cannot single-handedly decide the outcome; 60 is the value from the
 * original paper and the usual default.
 */
export function fuseRankings(rankings: string[][], k = 60): Map<string, number> {
  const fused = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, position) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + position + 1));
    });
  }
  return fused;
}
