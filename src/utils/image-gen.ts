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
const ASPECT_RATIO = "16:9";

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

/** Maps a returned MIME type to a file extension. */
export function extensionFor(mimeType: string): string {
  if (/jpe?g/i.test(mimeType)) return "jpg";
  if (/webp/i.test(mimeType)) return "webp";
  return "png";
}

/** Test seam: the model call, so tests never reach the network. */
export type ImageGenerator = (prompt: string) => Promise<GeneratedImage | null>;

const defaultGenerator: ImageGenerator = async (prompt) => {
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

  const response = await ai.models.generateContent({
    model: config.geminiImageModel,
    contents: prompt,
    config: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: ASPECT_RATIO },
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
 * Generates a cover image, or returns null if one cannot be had.
 *
 * Never throws: the caller is mid-publish and an article without a picture is a
 * far better outcome than a failed publish.
 */
export async function generateCoverImage(
  title: string,
  description?: string,
): Promise<GeneratedImage | null> {
  if (!config.geminiApiKey) {
    logger.info("[ImageGen] No GEMINI_API_KEY set — publishing without a cover image.");
    return null;
  }

  try {
    const image = await generate(buildImagePrompt(title, description));
    if (!image) {
      logger.warn(`[ImageGen] ${config.geminiImageModel} returned no image for "${title}".`);
      return null;
    }
    logger.info(
      `[ImageGen] Generated a ${image.mimeType} cover for "${title}" (${image.bytes.length} bytes)`,
    );
    return image;
  } catch (e: any) {
    logger.error(`[ImageGen] Cover generation failed for "${title}": ${e?.message ?? e}`);
    return null;
  }
}
