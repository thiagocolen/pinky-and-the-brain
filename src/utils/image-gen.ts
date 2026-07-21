import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";
import { logger } from "./logger.js";
import { IllustrationStyle, styleFor } from "./illustration-styles.js";

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

/**
 * Told to every image, whatever it depicts.
 *
 * Image models default to composing *within* the frame — a centred subject with
 * air around it, often on an implied page. That reads as clip-art dropped into
 * a layout. Asking for the artwork to run past all four edges makes the frame a
 * crop of something larger, which is both what the blog does to these images and
 * what makes them look like they belong to the page rather than sitting on it.
 */
const COMPOSITION_KEYWORDS =
  "Full-bleed composition: the artwork fills the entire frame edge to edge and continues " +
  "past all four edges, cropped by the frame. No border, no margin, no framing, no empty " +
  "background around the artwork, nothing floating on a blank page.";

/**
 * Covers are square, figures are wide, and that is the whole of the size story.
 *
 * The blog crops the cover with CSS to whatever slot it lands in — a banner on
 * the post page, a card in the listing — so a square carries the most usable
 * material into every one of them, and the full-bleed instruction above is what
 * makes surviving that crop the normal case rather than a lucky one. A figure is
 * punctuation inside a column of prose, not a second cover: 16:9 makes it a band
 * a reader takes in without losing the paragraph.
 *
 * The ratio is also what makes a cover *bigger* than a figure. `imageSize` is a
 * single request-wide tier (`config.geminiImageSize`) rather than one value per
 * kind, because a model serves the tiers it serves: the default image model
 * answers 400 for both `512` and `2K`, so asking for a large cover and a small
 * figure buys two failed round trips and one identical pair of images. At one
 * tier a 1:1 frame simply holds more pixels than a 16:9 one.
 */
const COVER_ASPECT_RATIO = "1:1";
const BODY_ASPECT_RATIO = "16:9";

/**
 * The size to fall back on when the configured one is refused.
 *
 * `1K` is the tier every image model documents. Since every failure in this
 * module is soft, a size the model does not serve would not raise anything — it
 * would quietly cost every figure of every article — so a failed request is
 * retried once here before the picture is given up on. That is not hypothetical:
 * it is what kept articles illustrated while `GEMINI_IMAGE_SIZE` was wrong.
 */
const FALLBACK_IMAGE_SIZE = "1K";

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
  /** File extension without the dot, derived from the returned MIME type. */
  extension: string;
}

/**
 * Builds the cover prompt.
 *
 * The "no text" instruction is not decoration: image models render lettering
 * eagerly and get it subtly wrong, and a cover with a misspelled word on it
 * looks far worse than a cover with no word at all.
 *
 * `style` defaults to the article's own so that a caller with nothing but a
 * title still gets the right look; `publishToBlog` passes it explicitly,
 * because the cover and the figures must be handed the *same* style and only
 * the caller knows they belong to one article.
 */
export function buildImagePrompt(
  title: string,
  description?: string,
  style: IllustrationStyle = styleFor(title),
): string {
  const subject = [title, description].filter(Boolean).join(". ");
  return (
    `Cover illustration for a technical article about: ${subject}. ` +
    `Style: ${style.prompt} ` +
    `Absolutely no text, no words, no letters, no numbers, no captions, no watermarks. ` +
    `${COMPOSITION_KEYWORDS}`
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
 *
 * `style` has no default here, unlike on the cover. A figure has no identity of
 * its own to derive one from: it must be drawn in the style of the article it
 * sits in, and requiring the caller to supply it is what makes that impossible
 * to forget.
 */
export function buildFigurePrompt(prompt: string, style: IllustrationStyle, alt?: string): string {
  const subject = [prompt, alt].filter(Boolean).join(". ");
  return (
    `Illustration accompanying a passage of a technical article, depicting: ${subject}. ` +
    `Style: ${style.prompt} ` +
    `Absolutely no text, no words, no letters, no numbers, no captions, no watermarks. ` +
    `${COMPOSITION_KEYWORDS}`
  );
}

/** Maps a returned MIME type to a file extension. */
export function extensionFor(mimeType: string): string {
  if (/jpe?g/i.test(mimeType)) return "jpg";
  if (/webp/i.test(mimeType)) return "webp";
  return "png";
}

/** The geometry of one request: both are parameters, never prose in the prompt. */
export interface ImageGeometry {
  aspectRatio: string;
  imageSize: string;
}

/** Test seam: the model call, so tests never reach the network. */
export type ImageGenerator = (
  prompt: string,
  geometry: ImageGeometry,
) => Promise<GeneratedImage | null>;

const defaultGenerator: ImageGenerator = async (prompt, { aspectRatio, imageSize }) => {
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

  const response = await ai.models.generateContent({
    model: config.geminiImageModel,
    contents: prompt,
    config: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio, imageSize },
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
  geometry: ImageGeometry,
  label: string,
): Promise<GeneratedImage | null> {
  if (!config.geminiApiKey) {
    logger.info(`[ImageGen] No GEMINI_API_KEY set — publishing without ${label}.`);
    return null;
  }

  const attempt = async (size: string): Promise<GeneratedImage | null> => {
    try {
      const image = await generate(prompt, { ...geometry, imageSize: size });
      if (!image) {
        logger.warn(
          `[ImageGen] ${config.geminiImageModel} returned no image for ${label} at ${size}.`,
        );
        return null;
      }
      logger.info(
        `[ImageGen] Generated a ${image.mimeType} image for ${label} ` +
          `(${geometry.aspectRatio}, ${size}, ${image.bytes.length} bytes)`,
      );
      return image;
    } catch (e: any) {
      logger.error(`[ImageGen] Generation failed for ${label} at ${size}: ${e?.message ?? e}`);
      return null;
    }
  };

  const image = await attempt(geometry.imageSize);
  if (image || geometry.imageSize === FALLBACK_IMAGE_SIZE) return image;

  // The requested size may simply not be one this model serves, and every
  // failure here is soft — so rather than let an unsupported size cost the
  // picture silently, ask once more for the size the API always documents.
  logger.warn(
    `[ImageGen] Retrying ${label} at ${FALLBACK_IMAGE_SIZE} after ${geometry.imageSize} produced nothing.`,
  );
  return attempt(FALLBACK_IMAGE_SIZE);
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
  style: IllustrationStyle = styleFor(title),
): Promise<GeneratedImage | null> {
  return generateImage(
    buildImagePrompt(title, description, style),
    { aspectRatio: COVER_ASPECT_RATIO, imageSize: config.geminiImageSize },
    `the cover of "${title}" (${style.id})`,
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
  style: IllustrationStyle,
  alt?: string,
): Promise<GeneratedImage | null> {
  return generateImage(
    buildFigurePrompt(prompt, style, alt),
    { aspectRatio: BODY_ASPECT_RATIO, imageSize: config.geminiImageSize },
    `the figure "${alt || prompt}" (${style.id})`,
  );
}
