// Brand colour safety.
//
// A restaurant may pick any brand colour. RMS never paints that colour straight onto a button:
// it derives steps from it that are proven readable, then hands them to the stylesheet as
// CSS custom properties. The rule in the product is "colour means press", so every step here
// is a colour for something pressable.
//
//   action         filled buttons, and coloured text or icons on a white card
//   actionInk      coloured text or icons on the slate ground or on the hover wash
//   actionPressed  a filled button while hovered or held
//   actionWash     the faint tint behind an outlined or quiet button while hovered
//   onAction       text on a filled button (always white)
//
// Every step keeps the hue of the brand colour and only goes darker (and, where a screen
// cannot show it, a little less saturated). The maths is WCAG 2.x relative luminance.
//
// One more guard: black, white and greys have no colour to keep. A black button would look
// like ink and a grey one like secondary text, and "colour means press" would stop being
// true. Those brands get the default basil instead, and `adjustment` says so.

export const DEFAULT_BRAND = "#12804A"; // basil

/** Fixed surface colours the action steps are checked against. Must match tokens.css. */
export const SURFACES = {
  ground: "#DEE7F2",
  card: "#FFFFFF",
  ink: "#1E2420",
  line: "#CAD6E2",
} as const;

/** WCAG AA for normal-size text. */
export const AA_TEXT = 4.5;

/** OKLCH chroma below this reads as grey, black or white rather than as a colour. */
export const MIN_CHROMA = 0.04;

type Rgb = readonly [number, number, number]; // 0..1, gamma-encoded sRGB
type Oklch = readonly [number, number, number]; // lightness 0..1, chroma, hue in degrees

export type BrandTheme = {
  /** The colour the restaurant chose, normalised to #RRGGBB. Not used for text or fills. */
  brand: string;
  /**
   * What RMS did with it. none: used as chosen. darkened: same hue, darker, so words stay
   * readable. lightened: same hue, lighter, because it was too close to ink to read as
   * something to press. replaced: it was not a usable colour (not a hex colour, or a grey,
   * black or white), so the default basil is used. Settings should tell the owner in plain
   * words when it is not none.
   */
  adjustment: "none" | "darkened" | "lightened" | "replaced";
  action: string;
  actionInk: string;
  actionPressed: string;
  actionWash: string;
  onAction: string;
  /** Ready to spread onto a `style` prop or a `Theme` wrapper. */
  cssVars: Record<`--rms-${string}`, string>;
};

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * The only shape of brand colour RMS accepts: a string of exactly `#` and six hex digits.
 * Anything else (another type, `#RGB`, no hash, spaces, eight digits, CSS of any kind) is
 * null. The value ends up in a style attribute, so nothing but a checked hex may pass.
 */
export function normaliseHex(input: unknown): string | null {
  return typeof input === "string" && HEX.test(input) ? input.toUpperCase() : null;
}

function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function rgbToHex([r, g, b]: Rgb): string {
  const to = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase();
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/** WCAG 2.x relative luminance of a #RRGGBB colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.x contrast ratio between two #RRGGBB colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// OKLCH, so darkening keeps the hue the owner picked (Björn Ottosson's OKLab matrices).
function rgbToOklch([r, g, b]: Rgb): Oklch {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const hue = (Math.atan2(B, A) * 180) / Math.PI;
  return [L, Math.hypot(A, B), hue < 0 ? hue + 360 : hue];
}

function oklchToLinear([L, C, h]: Oklch): Rgb {
  const A = C * Math.cos((h * Math.PI) / 180);
  const B = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** How much colour a hex has, as OKLCH chroma. Greys are near 0, vivid colours 0.1 to 0.3. */
export function chromaOf(hex: string): number {
  return rgbToOklch(hexToRgb(hex))[1];
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

/** OKLCH to a hex a screen can show: chroma is eased down until the colour fits sRGB. */
function oklchToHex([L, C, h]: Oklch): string {
  let chroma = C;
  let linear = oklchToLinear([L, chroma, h]);
  if (!inGamut(linear)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear([L, mid, h]))) lo = mid;
      else hi = mid;
    }
    chroma = lo;
    linear = oklchToLinear([L, chroma, h]);
  }
  return rgbToHex([toGamma(linear[0]), toGamma(linear[1]), toGamma(linear[2])]);
}

const passes = (hex: string, against: readonly string[], min: number) =>
  against.every((surface) => contrastRatio(hex, surface) >= min);

/**
 * The lightest version of `hex`, same hue, that reaches `min` contrast against every surface.
 * Returns `hex` unchanged when it already passes.
 */
export function darkenToContrast(hex: string, against: readonly string[], min: number = AA_TEXT): string {
  if (passes(hex, against, min)) return hex;
  const [L, C, h] = rgbToOklch(hexToRgb(hex));
  let lo = 0; // black always passes against these light surfaces
  let hi = L;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (passes(oklchToHex([mid, C, h]), against, min)) lo = mid;
    else hi = mid;
  }
  // Rounding to 8 bits per channel can land a hair under the line: step down until it holds.
  let lightness = lo;
  let out = oklchToHex([lightness, C, h]);
  while (!passes(out, against, min) && lightness > 0) {
    lightness = Math.max(0, lightness - 0.002);
    out = oklchToHex([lightness, C, h]);
  }
  return out;
}

/** Plain sRGB mix, the same result as CSS `color-mix(in srgb, a share, b)`. */
function mix(a: string, b: string, shareOfA: number): string {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  const blend = (i: number) => (ra[i] ?? 0) * shareOfA + (rb[i] ?? 0) * (1 - shareOfA);
  return rgbToHex([blend(0), blend(1), blend(2)]);
}

function shiftLightness(hex: string, by: number): string {
  const [L, C, h] = rgbToOklch(hexToRgb(hex));
  return oklchToHex([Math.min(1, Math.max(0, L + by)), C, h]);
}

/** A colour this close to ink would read as text, not as something to press. */
export const MIN_INK_CONTRAST = 2;

/**
 * The darkest version of `hex`, same hue, that stands at least `min` away from ink.
 * Used for navy, maroon and other brand colours too dark to tell from text.
 */
function lightenAwayFromInk(hex: string, min: number = MIN_INK_CONTRAST): string {
  if (contrastRatio(hex, SURFACES.ink) >= min) return hex;
  const [L, C, h] = rgbToOklch(hexToRgb(hex));
  let lo = L;
  let hi = 1; // white always stands clear of ink
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(oklchToHex([mid, C, h]), SURFACES.ink) >= min) hi = mid;
    else lo = mid;
  }
  return oklchToHex([hi, C, h]);
}

/** Every rule an action colour must meet. One place, so the code and the tests agree. */
function isSafeAction(hex: string): boolean {
  return (
    passes(hex, ["#FFFFFF", SURFACES.card], AA_TEXT) && // white words on the fill, coloured words on a card
    contrastRatio(hex, SURFACES.ink) >= MIN_INK_CONTRAST && // not mistaken for ink
    chromaOf(hex) >= MIN_CHROMA // a colour, not a grey
  );
}

/**
 * Turn any brand colour into action colours that pass WCAG AA.
 * Takes anything and never throws. Only a `#RRGGBB` string is treated as a colour.
 * A colour that fails is darkened (too light) or lightened (too close to ink) in its own hue.
 * If no version of it can meet every rule, the default basil is used.
 */
export function themeFromBrand(input: unknown): BrandTheme {
  const chosen = normaliseHex(input);
  const onAction = "#FFFFFF";

  // White text on the fill and the fill colour as text on a white card are the same test.
  const darkened = chosen ? darkenToContrast(chosen, [onAction, SURFACES.card]) : null;
  const derived = darkened ? lightenAwayFromInk(darkened) : null;
  const usable = derived !== null && isSafeAction(derived);
  const brand = chosen ?? DEFAULT_BRAND;
  const action = usable ? derived : DEFAULT_BRAND;
  const adjustment: BrandTheme["adjustment"] = !usable ? "replaced" : action === brand ? "none" : derived === darkened ? "darkened" : "lightened";

  // A faint tint of the action colour for hover. Light enough that it never reads as a fill.
  const actionWash = mix(action, SURFACES.card, 0.08);

  // Coloured text also sits on the slate ground and on the wash, which are darker than white.
  const actionInk = darkenToContrast(action, [SURFACES.ground, SURFACES.card, actionWash]);

  // Hover and hold go one step darker.
  const actionPressed = darkenToContrast(shiftLightness(action, -0.06), [onAction]);

  return {
    brand,
    adjustment,
    action,
    actionInk,
    actionPressed,
    actionWash,
    onAction,
    cssVars: {
      "--rms-action": action,
      "--rms-action-ink": actionInk,
      "--rms-action-pressed": actionPressed,
      "--rms-action-wash": actionWash,
      "--rms-on-action": onAction,
    },
  };
}
