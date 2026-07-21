import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";
import { logger } from "./logger.js";

/**
 * Cover-image generation for published articles.
 *
 * Scope note: this agent is deliberately Anthropic-only for *text* (see
 * src/utils/model.ts). Google appears here for image generation alone, because
 * Anthropic models do not generate images. Nothing in the reasoning or writing
 * path goes through this module.
 *
 * Every failure is soft. A missing key, a refusal, a network error — all return
 * null, and the article publishes without a cover. An image is a nice-to-have;
 * losing the article because of it would not be.
 */

/** Style keywords for every cover: abstract artwork, never a photograph. */
const STYLE_KEYWORDS = "abstract geometric line drawing, flat vector art, bold shapes, limited palette";

/**
 * Aspect ratio matching where covers are actually displayed — a short banner on
 * the post page and a wide card thumbnail in the listing, both cropped via CSS
 * `background-size: cover`.
 */
const COVER_ASPECT_RATIO = "16:9";

/**
 * Body figures sit inline in a column of prose, uncropped, so they are shaped
 * to be looked at rather than to survive a crop. Squarer than a cover: a 16:9
 * figure mid-article reads as a divider more than as an illustration.
 */
const BODY_ASPECT_RATIO = "4:3";

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
  /** File extension without the dot, derived from the returned MIME type. */
  extension: string;
}

/**
 * Builds the prompt.
 *
 * The "no text" instruction is not decoration: image models render lettering
 * eagerly and get it subtly wrong, and a cover with a misspelled word on it
 * looks far worse than a cover with no word at all.
 */
export function buildImagePrompt(title: string, description?: string): string {
  const subject = [title, description].filter(Boolean).join(". ");
  return (
    `Cover illustration for a technical article about: ${subject}. ` +
    `Style: ${STYLE_KEYWORDS}. ` +
    `Absolutely no text, no words, no letters, no numbers, no captions, no watermarks. ` +
    `Composition should read clearly when cropped to a wide banner.`
  );
}

/**
 * Builds the prompt for a figure inside the article.
 *
 * Separate from `buildImagePrompt` because the job is different: a cover
 * illustrates the article, a figure illustrates one idea within it. The author
 * has already said what that idea is, so their words lead and the style
 * keywords follow — a figure that does not match its caption is worse than no
 * figure. The no-text clause is repeated verbatim; it is load-bearing for
 * exactly the same reason it is on the cover.
 */
export function buildFigurePrompt(prompt: string, alt?: string): string {
  const subject = [prompt, alt].filter(Boolean).join(". ");
  return (
    `Illustration accompanying a passage of a technical article, depicting: ${subject}. ` +
    `Style: ${STYLE_KEYWORDS}. ` +
    `Absolutely no text, no words, no letters, no numbers, no captions, no watermarks. ` +
    `Composition should read clearly at the width of a column of body text.`
  );
}

/** Maps a returned MIME type to a file extension. */
export function extensionFor(mimeType: string): string {
  if (/jpe?g/i.test(mimeType)) return "jpg";
  if (/webp/i.test(mimeType)) return "webp";
  return "png";
}

/** Test seam: the model call, so tests never reach the network. */
export type ImageGenerator = (prompt: string, aspectRatio: string) => Promise<GeneratedImage | null>;

const defaultGenerator: ImageGenerator = async (prompt, aspectRatio) => {
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

  const response = await ai.models.generateContent({
    model: config.geminiImageModel,
    contents: prompt,
    config: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio },
    },
  });

  const parts = response?.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const inline = part.inlineData;
    if (inline?.data) {
      const mimeType = inline.mimeType || "image/png";
      return {
        bytes: Buffer.from(inline.data, "base64"),
        mimeType,
        extension: extensionFor(mimeType),
      };
    }
  }
  return null;
};

let generate: ImageGenerator = defaultGenerator;

export function __setImageGenerator(generator: ImageGenerator): void {
  generate = generator;
}

export function __resetImageGenerator(): void {
  generate = defaultGenerator;
}

/**
 * Runs one generation, absorbing every way it can fail.
 *
 * Shared by covers and figures so the soft-failure contract is written once: a
 * missing key, a refusal, a network error and an empty response all return
 * null, and the caller — always mid-publish — carries on without the picture.
 * `label` names the image in the log, since a publish may produce several.
 */
async function generateImage(
  prompt: string,
  aspectRatio: string,
  label: string,
): Promise<GeneratedImage | null> {
  if (!config.geminiApiKey) {
    logger.info(`[ImageGen] No GEMINI_API_KEY set — publishing without ${label}.`);
    return null;
  }

  try {
    const image = await generate(prompt, aspectRatio);
    if (!image) {
      logger.warn(`[ImageGen] ${config.geminiImageModel} returned no image for ${label}.`);
      return null;
    }
    logger.info(
      `[ImageGen] Generated a ${image.mimeType} image for ${label} (${image.bytes.length} bytes)`,
    );
    return image;
  } catch (e: any) {
    logger.error(`[ImageGen] Generation failed for ${label}: ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Generates a cover image, or returns null if one cannot be had.
 *
 * Never throws: the caller is mid-publish and an article without a picture is a
 * far better outcome than a failed publish.
 */
export async function generateCoverImage(
  title: string,
  description?: string,
): Promise<GeneratedImage | null> {
  return generateImage(
    buildImagePrompt(title, description),
    COVER_ASPECT_RATIO,
    `the cover of "${title}"`,
  );
}

/**
 * Generates one in-article figure, or returns null if one cannot be had.
 *
 * Same contract as the cover: never throws. A figure that fails to generate
 * simply does not appear — see `substituteFigures` in `src/agents/layout.ts`,
 * which drops the marker rather than leaving a hole in the page.
 */
export async function generateBodyImage(
  prompt: string,
  alt?: string,
): Promise<GeneratedImage | null> {
  return generateImage(
    buildFigurePrompt(prompt, alt),
    BODY_ASPECT_RATIO,
    `the figure "${alt || prompt}"`,
  );
}
