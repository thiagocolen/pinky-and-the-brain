/**
 * Declarative list of assets to derive from a single source image.
 *
 * op:
 *   'contain' - fit the whole image inside width x height, padding with `background`
 *   'cover'   - fill width x height exactly, cropping to `position` (default centre)
 *
 * favicon.ico is handled separately in generate.mjs (multi-resolution ICO packing).
 */
export const targets = [
  {
    file: 'logo.png',
    op: 'cover',
    width: 192,
    height: 192,
    format: 'png',
  },
  {
    file: 'logo@2x.png',
    op: 'cover',
    width: 384,
    height: 384,
    format: 'png',
  },
  {
    file: 'apple-touch-icon.png',
    op: 'cover',
    width: 180,
    height: 180,
    format: 'png',
  },
  {
    file: 'docusaurus-social-card.jpg',
    op: 'cover',
    width: 1200,
    height: 630,
    format: 'jpg',
    quality: 85,
  },
  {
    file: 'thumbnail.jpg',
    op: 'cover',
    width: 400,
    height: 225,
    format: 'jpg',
    quality: 80,
  },
  {
    file: 'doc-hero.jpg',
    op: 'cover',
    width: 1600,
    height: 900,
    format: 'jpg',
    quality: 80,
  },
];
