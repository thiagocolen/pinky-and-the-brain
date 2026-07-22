import { marked } from "marked";

/**
 * Article layout — "diagramation" — for the blog.
 *
 * An article is written as one markdown file, and that file carries its own
 * layout: a deck under the title, callouts, and figures. Pinky reads and
 * revises the real shape of the post before it is ever published, rather than
 * approving a description of a shape.
 *
 * This module turns those authoring marks into what the blog's `create_draft`
 * wants — MDX. It deliberately does no I/O and knows nothing about MCP or image
 * generation: everything here is a pure string transform, so the interesting
 * cases are cheap to test.
 *
 * The two marks are stripped in a pre-pass, before `marked` ever sees them:
 *
 *   :::tip Optional title      →  <Callout type="tip" title="Optional title">
 *   ![alt](image: a prompt)    →  <!--figure:0-->, generated and swapped later
 *
 * Neither survives `marked` intact if left in place — `:::` renders as a
 * paragraph of literal colons, and a link destination containing spaces is not
 * a link at all.
 */

/** A body image to be generated, in the order it appears in the article. */
export interface Figure {
  index: number;
  /** Alt text, also used as the visible caption. */
  alt: string;
  /** What the image should depict; fed to the image model, never rendered. */
  prompt: string;
}

/**
 * Escapes the two characters MDX treats as syntax.
 *
 * Post bodies are HTML inside a `.mdx` file, and MDX reads a bare `{` as the
 * start of a JSX expression. A code sample containing `{ }` fails the Gatsby
 * build for the whole site, not just this post. HTML entities render
 * identically and are inert to the MDX parser.
 *
 * Only text *outside* tags is touched; the tags `marked` emitted must survive.
 * Attribute values therefore need `escapeAttribute` instead — they sit inside a
 * tag, where this function deliberately does not reach.
 */
export function escapeForMdx(html: string): string {
  return html
    .split(/(<[^>]*>)/)
    .map((chunk, index) => (index % 2 === 1 ? chunk : chunk.replace(/[{}]/g, (c) => (c === "{" ? "&#123;" : "&#125;"))))
    .join("");
}

/** Escapes a string for use inside a double-quoted MDX attribute. */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/{/g, "&#123;")
    .replace(/}/g, "&#125;");
}

/**
 * Lifts the deck — an `###` heading immediately after the title.
 *
 * The blog renders `headline` under the `<h1>` itself, so a deck left in the
 * body would appear twice over: once as frontmatter and once as a stray H3.
 * Only a heading in that leading position counts; an `###` further down is an
 * ordinary subheading and is left alone.
 */
export function splitHeadline(markdown: string): { headline: string; body: string } {
  const match = markdown.match(/^\s*#{3}\s+(.+?)\s*$/m);
  if (!match || markdown.slice(0, match.index).trim() !== "") {
    return { headline: "", body: markdown.trim() };
  }
  return {
    headline: match[1].trim(),
    body: markdown.slice(match.index! + match[0].length).trim(),
  };
}

const FIGURE = /!\[([^\]]*)\]\(\s*image:\s*([^)]+)\)/g;

/**
 * Pulls the figures out, leaving an inert marker behind.
 *
 * The marker is an HTML comment on purpose. Figures are generated *after* the
 * draft exists — the image URLs depend on the slug the blog chooses — so the
 * body is written once with markers and patched once the URLs are known. If
 * generation fails, or the patch never happens, an HTML comment renders as
 * nothing at all; a visible `[figure 1]` would be a defect on a live page.
 */
export function extractFigures(markdown: string): { markdown: string; figures: Figure[] } {
  const figures: Figure[] = [];
  const stripped = markdown.replace(FIGURE, (_match, alt: string, prompt: string) => {
    const index = figures.length;
    figures.push({ index, alt: alt.trim(), prompt: prompt.trim() });
    return `<!--figure:${index}-->`;
  });
  return { markdown: stripped, figures };
}

/**
 * Renders one figure once its image has been uploaded and has a URL.
 *
 * Newline-delimited because MDX reads an unbroken run of HTML as a single
 * block: a `<figure>` butted straight against the paragraph after it would
 * swallow that paragraph rather than sit above it.
 */
export function renderFigure(figure: Figure, url: string): string {
  const alt = escapeAttribute(figure.alt);
  const caption = escapeForMdx(figure.alt);
  return `\n<figure><img src="${escapeAttribute(url)}" alt="${alt}" />` +
    (figure.alt ? `<figcaption>${caption}</figcaption>` : "") +
    `</figure>\n`;
}

/**
 * Swaps figure markers for rendered figures.
 *
 * A figure absent from `urls` — generation failed, or the key was missing —
 * has its marker removed rather than left behind. The article is worth more
 * than the picture.
 */
export function substituteFigures(body: string, figures: Figure[], urls: Map<number, string>): string {
  return figures.reduce((html, figure) => {
    const url = urls.get(figure.index);
    return html.replace(`<!--figure:${figure.index}-->`, url ? renderFigure(figure, url) : "");
  }, body);
}

const CALLOUT_OPEN = /^:::([a-zA-Z][\w-]*)[ \t]*(.*)$/;
const CALLOUT_CLOSE = /^:::[ \t]*$/;

interface Segment {
  kind: "prose" | "callout";
  text: string;
  type?: string;
  title?: string;
}

/**
 * Splits an article into prose and callout segments.
 *
 * An unterminated callout is closed at the end of the file rather than
 * abandoned: the alternative is emitting the author's `:::tip` as literal text
 * on a public page, and a missing closing fence is an obvious slip whose intent
 * is never in doubt.
 */
export function parseSegments(markdown: string): Segment[] {
  const segments: Segment[] = [];
  let prose: string[] = [];
  let callout: Segment | null = null;
  let body: string[] = [];

  const flushProse = () => {
    if (prose.join("\n").trim()) segments.push({ kind: "prose", text: prose.join("\n") });
    prose = [];
  };

  for (const line of markdown.split("\n")) {
    if (callout) {
      if (CALLOUT_CLOSE.test(line)) {
        segments.push({ ...callout, text: body.join("\n") });
        callout = null;
        body = [];
      } else {
        body.push(line);
      }
      continue;
    }

    const open = line.match(CALLOUT_OPEN);
    if (open) {
      flushProse();
      callout = { kind: "callout", text: "", type: open[1], title: open[2].trim() };
      continue;
    }
    prose.push(line);
  }

  if (callout) segments.push({ ...callout, text: body.join("\n") });
  flushProse();
  return segments;
}

/**
 * Renders an article body to MDX-safe HTML.
 *
 * Callout contents are parsed separately rather than as part of the surrounding
 * document, because `marked` does not process markdown nested inside a block
 * HTML element — wrapping first and parsing once would leave the callout's own
 * prose as unformatted text.
 *
 * The callout `type` is passed through unvalidated: the blog's component
 * degrades an unknown type to `note` (see `src/components/callout.js` there),
 * and a second opinion about the valid set here could only drift from it.
 */
export function renderBody(markdown: string): string {
  const html = parseSegments(markdown)
    .map((segment) => {
      const inner = marked.parse(segment.text.trim(), { async: false }) as string;
      if (segment.kind === "prose") return inner;

      const title = segment.title ? ` title="${escapeAttribute(segment.title)}"` : "";
      return `<Callout type="${escapeAttribute(segment.type!)}"${title}>\n${inner}\n</Callout>`;
    })
    .join("\n");

  return escapeForMdx(html);
}
