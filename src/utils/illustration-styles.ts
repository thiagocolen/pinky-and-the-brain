/**
 * The illustration styles an article can be drawn in.
 *
 * One style is fixed per article and shared by its cover and every one of its
 * figures, so a post looks like a single piece of work rather than a handful of
 * unrelated pictures. The choice is made by `styleFor`, not by the model: what
 * an illustration *depicts* is the author's to decide (the `image:` half of a
 * figure mark), but how the whole set *looks* is the publisher's.
 *
 * The prompts are transcribed from a set written for image models directly.
 * They are copied verbatim with one edit: the trailing `--ar` flag is dropped
 * from each. That flag is Midjourney syntax, and here the aspect ratio is a
 * parameter on the request (`imageConfig`), which the model honours far more
 * reliably than a sentence — leaving the flag in the text only invites the two
 * to disagree.
 */

export interface IllustrationStyle {
  /** Stable identifier, used in logs so a published article can be traced to its look. */
  id: string;
  /** Human-readable name, for reports and documentation. */
  label: string;
  /** The style half of an image prompt: how it should look, never what it shows. */
  prompt: string;
}

export const ILLUSTRATION_STYLES: IllustrationStyle[] = [
  {
    id: "bauhaus-grid",
    label: "Bauhaus Minimalist Grid",
    prompt:
      "Abstract geometric pattern inspired by Bauhaus design. A clean, structured composition of " +
      "intersecting bold black lines, primary colored circles (vibrant red, deep cobalt blue, canary " +
      "yellow), and soft beige background space. Crisp vector style, sharp edges, flat colors, subtle " +
      "paper grain texture, balanced asymmetrical layout, minimalist graphic design.",
  },
  {
    id: "neon-isometric",
    label: "Neon Cyber-Isometric Lattice",
    prompt:
      "Complex 3D isometric pattern of interconnected geometric cubes and glowing polyhedra. Dark moody " +
      "background in deep navy and black, illuminated by electric magenta, cyan, and laser lime neon edge " +
      "lighting. Futuristic tech aesthetic, metallic chrome surfaces, glass refraction effects, intricate " +
      "structural network, high contrast, ray-traced lighting.",
  },
  {
    id: "sacred-geometry",
    label: "Sacred Geometry Mandala Layering",
    prompt:
      "Intricate sacred geometry pattern featuring overlapping Metatron's Cube, Seed of Life, and Golden " +
      "Ratio spirals. Delicate, ultra-fine white and rose gold lines over a deep iridescent indigo " +
      "background. Sacred symmetry, kaleidoscopic depth, fine line art, subtle metallic sheen, ethereal " +
      "ambient glow, highly detailed vector illustration.",
  },
  {
    id: "memphis-retro",
    label: "Memphis Design Retro Wave",
    prompt:
      "Energetic 1980s Memphis group abstract pattern. Playful arrangement of squiggly lines, floating 3D " +
      "spheres, pastel pyramids, and terrazzo tile textures. Bright color palette of mint green, soft pink, " +
      "lilac, bright coral, and black accents. Flat graphic style, high energy, bold contrast, retro modern " +
      "aesthetic.",
  },
  {
    id: "parametric-glass",
    label: "Parametric Glass Wave Tessellation",
    prompt:
      "Fluid parametric geometric pattern made of thousands of interlocking frosted glass tiles. Flowing " +
      "wave-like surface contour with translucent refraction and dispersion of light. Soft gradient palette " +
      "shifting from emerald green to deep teal and gold. Volumetric studio lighting, realistic caustic " +
      "reflections, smooth curves, architectural generative art style.",
  },
  {
    id: "op-art-monochrome",
    label: "Monochromatic Op-Art Illusion",
    prompt:
      "High-contrast optical art pattern featuring warping geometric grids and alternating black and white " +
      "stripes. Creates a dynamic 3D visual illusion of depth, distortion, and movement across a flat plane. " +
      "Ultra-sharp vector lines, seamless tessellation, mathematically precise curves, striking hypnotic " +
      "aesthetic.",
  },
  {
    id: "mid-century-mosaic",
    label: "Mid-Century Modern Stained Wood Mosaic",
    prompt:
      "Mid-century modern abstract pattern composed of overlapping geometric polygons, rounded triangles, " +
      "and arches. Rich natural material textures including walnut wood grain, brushed brass metal, matte " +
      "terracotta clay, and olive green velvet. Warm ambient lighting, tactile surface depth, retro organic " +
      "architectural design.",
  },
  {
    id: "voronoi-network",
    label: "Generative Fractal Voronoi Network",
    prompt:
      "Abstract Voronoi diagram pattern with cellular geometric structures. Stained-glass effect with " +
      "semi-translucent faceted polygons in a rich jewel-tone palette (amethyst, sapphire, amber, and ruby). " +
      "Luminous backlighting through thin gold grout lines, organic mathematical pattern, rich depth, high " +
      "dynamic range.",
  },
  {
    id: "low-poly-origami",
    label: "Low-Poly Origami Prism Field",
    prompt:
      "Seamless abstract tessellation of low-poly geometric prisms, evoking folded paper origami. Soft " +
      "pastel gradient across the surface shifting from peach to periwinkle blue and lavender. Subtle drop " +
      "shadows between geometric facets creating a physical 3D relief effect, clean matte texture, minimal " +
      "elegant look.",
  },
  {
    id: "de-stijl-fragments",
    label: "De Stijl Fragmented Composition",
    prompt:
      "Fragmented geometric abstraction inspired by Constructivism and De Stijl. Floating sharp diagonal " +
      "planes, intersecting rectangles, and overlapping translucent color blocks. Color palette of rich " +
      "bronze, burnt orange, off-white, matte black, and warm cream. Dynamic spatial balance, architectural " +
      "draft precision, subtle canvas texture.",
  },
];

/**
 * Picks the style for an article, deterministically.
 *
 * Deterministic rather than random or model-chosen for one reason: republishing
 * an article must not silently redraw it in a different style. The same key
 * always yields the same style, and FNV-1a spreads near-identical titles across
 * the catalogue rather than clustering them.
 *
 * Key it on the article *title*. The slug would be the more natural identity,
 * but the blog derives the slug itself and does not report it until the draft
 * already exists — by which point the images have been generated.
 */
export function styleFor(key: string): IllustrationStyle {
  const normalized = key.trim().toLowerCase();

  // FNV-1a, 32-bit. `Math.imul` keeps the multiply inside 32 bits; `>>> 0`
  // returns it to unsigned after JavaScript's bitwise ops make it signed.
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return ILLUSTRATION_STYLES[hash % ILLUSTRATION_STYLES.length];
}
