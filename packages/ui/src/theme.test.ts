/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AA_TEXT,
  DEFAULT_BRAND,
  MIN_CHROMA,
  MIN_INK_CONTRAST,
  SURFACES,
  chromaOf,
  contrastRatio,
  darkenToContrast,
  normaliseHex,
  relativeLuminance,
  themeFromBrand,
  type BrandTheme,
} from "./theme";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

// The five colours the brief names: basil (default), Marigold Kitchen orange, Slice Yard
// tomato, a light yellow that failed in the sketch, and a blue.
const BRIEF_COLOURS = ["#12804A", "#E8892B", "#C8372D", "#F2C230", "#1F6FD0"];

// Brand colours too dark to tell from ink: navy, dark blue, maroon.
const DARK_COLOURS = ["#0B1F3A", "#00008B", "#800000"];

// Colours no owner should be able to break the screen with.
const HARD_COLOURS = ["#FFFFFF", "#000000", "#FFFF00", "#00FFFF", "#FF00FF", "#F4EEE6", "#DEE7F2", "#FFD1DC", "#7FFF00", "#0000FF", "#101820"];

// Things that are not a #RRGGBB string at all.
const NOT_COLOURS: unknown[] = [
  null,
  undefined,
  42,
  0x12804a,
  {},
  [],
  true,
  "",
  "tomato",
  "#12",
  "#abc",
  "12804A",
  " #12804A",
  "#12804A ",
  "#GGGGGG",
  "#12804AFF",
  "rgb(1,2,3)",
  "url(x)",
  "}",
  "</style>",
  "#12804A; color: red",
  "#12804A}body{display:none}",
  "var(--rms-ink)",
];

function token(name: string): string {
  const match = new RegExp(`--rms-${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(tokens);
  if (!match?.[1]) throw new Error(`tokens.css has no hex value for --rms-${name}`);
  return match[1].toUpperCase();
}

function hueOf(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return Number.NaN;
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** Every promise themeFromBrand makes, checked on one result. Returns the first one broken. */
function brokenRule(theme: BrandTheme): string | null {
  const hex = /^#[0-9A-F]{6}$/;
  for (const value of [theme.brand, theme.action, theme.actionInk, theme.actionPressed, theme.actionWash, theme.onAction]) {
    if (!hex.test(value)) return `not a hex colour: ${value}`;
  }
  if (contrastRatio(theme.onAction, theme.action) < AA_TEXT) return "white on the fill";
  if (contrastRatio(theme.onAction, theme.actionPressed) < AA_TEXT) return "white on the pressed fill";
  if (contrastRatio(theme.action, SURFACES.card) < AA_TEXT) return "action on card";
  if (contrastRatio(theme.actionInk, SURFACES.card) < AA_TEXT) return "action ink on card";
  if (contrastRatio(theme.actionInk, SURFACES.ground) < AA_TEXT) return "action ink on ground";
  if (contrastRatio(theme.actionInk, theme.actionWash) < AA_TEXT) return "action ink on wash";
  if (relativeLuminance(theme.actionWash) <= 0.8) return "wash is not a faint tint";
  if (chromaOf(theme.action) < MIN_CHROMA) return "action is a grey";
  if (contrastRatio(theme.action, SURFACES.ink) < MIN_INK_CONTRAST) return "action reads as ink";
  return null;
}

describe("WCAG contrast maths", () => {
  it("matches the published reference values", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
    // #767676 is the well-known lightest grey that passes AA on white; #777777 just fails.
    expect(contrastRatio("#767676", "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeLessThan(4.5);
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
  });

  it("does not depend on the order of the two colours", () => {
    expect(contrastRatio("#12804A", "#DEE7F2")).toBeCloseTo(contrastRatio("#DEE7F2", "#12804A"), 10);
  });
});

describe.each([...BRIEF_COLOURS, ...DARK_COLOURS, ...HARD_COLOURS])("themeFromBrand(%s)", (brand) => {
  const theme = themeFromBrand(brand);

  it("white text on a filled button passes AA", () => {
    expect(contrastRatio(theme.onAction, theme.action)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("white text on a hovered or held filled button passes AA", () => {
    expect(contrastRatio(theme.onAction, theme.actionPressed)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("coloured text on a white card passes AA", () => {
    expect(contrastRatio(theme.action, SURFACES.card)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(theme.actionInk, SURFACES.card)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("coloured text on the page ground passes AA", () => {
    expect(contrastRatio(theme.actionInk, SURFACES.ground)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("coloured text on the hover wash passes AA", () => {
    expect(contrastRatio(theme.actionInk, theme.actionWash)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("the action colour is a colour that cannot be mistaken for ink", () => {
    expect(chromaOf(theme.action)).toBeGreaterThanOrEqual(MIN_CHROMA);
    expect(contrastRatio(theme.action, SURFACES.ink)).toBeGreaterThanOrEqual(MIN_INK_CONTRAST);
  });

  it("breaks none of its rules and returns the matching CSS variables", () => {
    expect(brokenRule(theme)).toBeNull();
    expect(theme.cssVars).toEqual({
      "--rms-action": theme.action,
      "--rms-action-ink": theme.actionInk,
      "--rms-action-pressed": theme.actionPressed,
      "--rms-action-wash": theme.actionWash,
      "--rms-on-action": theme.onAction,
    });
  });
});

describe("themeFromBrand across a sweep of every kind of colour", () => {
  it("holds every rule for 4,096 colours spread over the whole RGB cube", () => {
    const steps = [0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255];
    const broken: string[] = [];
    for (const r of steps) {
      for (const g of steps) {
        for (const b of steps) {
          const brand = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
          const rule = brokenRule(themeFromBrand(brand));
          if (rule) broken.push(`${brand}: ${rule}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("themeFromBrand keeps the owner's colour recognisable", () => {
  it("leaves a brand colour that already passes exactly as chosen", () => {
    for (const brand of ["#12804A", "#C8372D", "#1F6FD0"]) {
      expect(themeFromBrand(brand).action).toBe(brand);
      expect(themeFromBrand(brand).adjustment).toBe("none");
    }
  });

  it("darkens a colour that is too light, and says so", () => {
    for (const brand of ["#E8892B", "#F2C230", "#FFFF00", "#FFD1DC"]) {
      const theme = themeFromBrand(brand);
      expect(theme.adjustment).toBe("darkened");
      expect(relativeLuminance(theme.action)).toBeLessThan(relativeLuminance(brand));
    }
  });

  it("goes no darker than it has to", () => {
    for (const brand of ["#E8892B", "#F2C230"]) {
      expect(contrastRatio(themeFromBrand(brand).action, "#FFFFFF")).toBeLessThan(AA_TEXT + 0.15);
    }
  });

  it("lightens navy, dark blue and maroon until they read as a colour, not as ink, and says so", () => {
    for (const brand of DARK_COLOURS) {
      const theme = themeFromBrand(brand);
      expect(contrastRatio(brand, SURFACES.ink)).toBeLessThan(MIN_INK_CONTRAST);
      expect(theme.adjustment).toBe("lightened");
      expect(relativeLuminance(theme.action)).toBeGreaterThan(relativeLuminance(brand));
      expect(contrastRatio(theme.action, SURFACES.ink)).toBeGreaterThanOrEqual(MIN_INK_CONTRAST);
      // Lightened only as far as needed.
      expect(contrastRatio(theme.action, SURFACES.ink)).toBeLessThan(MIN_INK_CONTRAST + 0.15);
    }
  });

  it("keeps the hue", () => {
    // The steps are made in OKLCH, which holds the hue the eye sees. Measured here on the
    // plain HSL wheel, that shows as a few degrees of drift, a little more for deep blues.
    for (const [brands, limit] of [
      [BRIEF_COLOURS, 12],
      [DARK_COLOURS, 20],
    ] as const) {
      for (const brand of brands) {
        const theme = themeFromBrand(brand);
        for (const step of [theme.action, theme.actionInk]) {
          const drift = Math.abs(hueOf(step) - hueOf(brand));
          expect(Math.min(drift, 360 - drift)).toBeLessThan(limit);
        }
      }
    }
  });

  it("replaces black, white and greys with basil, because they would read as ink, not as press", () => {
    const basil = themeFromBrand(DEFAULT_BRAND);
    for (const brand of ["#000000", "#FFFFFF", "#777777", "#101820", "#F4EEE6", "#DEE7F2", "#1E2420"]) {
      const theme = themeFromBrand(brand);
      expect(theme.adjustment).toBe("replaced");
      expect(theme.brand).toBe(brand);
      expect(theme.cssVars).toEqual(basil.cssVars);
    }
  });
});

describe("themeFromBrand input handling", () => {
  it("accepts only a # and six hex digits, in either case", () => {
    expect(normaliseHex("#12804a")).toBe("#12804A");
    expect(normaliseHex("#E8892B")).toBe("#E8892B");
    expect(themeFromBrand("#e8892b").brand).toBe("#E8892B");
  });

  it.each(NOT_COLOURS.map((value) => [JSON.stringify(value) ?? String(value), value] as const))("falls back to basil for %s without throwing", (_name, value) => {
    const basil = themeFromBrand(DEFAULT_BRAND);
    expect(normaliseHex(value)).toBeNull();
    const theme = themeFromBrand(value);
    expect(theme.adjustment).toBe("replaced");
    expect(theme.brand).toBe(DEFAULT_BRAND);
    expect(theme.cssVars).toEqual(basil.cssVars);
  });

  it("never lets anything but hex colours into the CSS variables", () => {
    for (const value of [...NOT_COLOURS, ...BRIEF_COLOURS, ...DARK_COLOURS, ...HARD_COLOURS]) {
      for (const cssValue of Object.values(themeFromBrand(value).cssVars)) {
        expect(cssValue).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
  });

  it("darkenToContrast returns the colour untouched when it already passes", () => {
    expect(darkenToContrast("#1E2420", ["#FFFFFF"])).toBe("#1E2420");
  });
});

describe("tokens.css", () => {
  it("uses the same surface colours as the theme maths", () => {
    expect(token("ground")).toBe(SURFACES.ground);
    expect(token("card")).toBe(SURFACES.card);
    expect(token("ink")).toBe(SURFACES.ink);
    expect(token("line")).toBe(SURFACES.line);
  });

  it("ships the default action steps that themeFromBrand derives for basil", () => {
    const theme = themeFromBrand(DEFAULT_BRAND);
    expect(token("action")).toBe(theme.action);
    expect(token("action-ink")).toBe(theme.actionInk);
    expect(token("action-pressed")).toBe(theme.actionPressed);
    expect(token("action-wash")).toBe(theme.actionWash);
    expect(token("on-action")).toBe(theme.onAction);
  });

  it("ink and secondary text pass AA on the surfaces they are used on", () => {
    expect(contrastRatio(token("ink"), token("ground"))).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(token("ink"), token("card"))).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(token("ink"), token("line"))).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(token("muted-on-card"), token("card"))).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(token("muted-on-ground"), token("ground"))).toBeGreaterThanOrEqual(AA_TEXT);
    // Disabled buttons: muted words on the line colour stay readable.
    expect(contrastRatio(token("muted-on-ground"), token("line"))).toBeGreaterThanOrEqual(AA_TEXT);
    // Solid ink tags: white on ink.
    expect(contrastRatio(token("card"), token("ink"))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("the edge of a text field passes 3 to 1 against card and ground", () => {
    expect(contrastRatio(token("field-line"), token("card"))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(token("field-line"), token("ground"))).toBeGreaterThanOrEqual(3);
  });

  it("the ground is a tint with its own hue, and a white card still lifts off it", () => {
    // Not a cream or off-white: clearly cooler than neutral, but far too faint to read as an action.
    expect(chromaOf(token("ground"))).toBeGreaterThan(0.012);
    expect(chromaOf(token("ground"))).toBeLessThan(MIN_CHROMA);
    expect(contrastRatio(token("card"), token("ground"))).toBeGreaterThanOrEqual(1.2);
  });

  it("chart bars pass 3 to 1 against the card they sit on, and are not mistaken for ink", () => {
    expect(contrastRatio(token("bar"), token("card"))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(token("bar"), token("ink"))).toBeGreaterThanOrEqual(3);
    expect(chromaOf(token("bar"))).toBeLessThan(MIN_CHROMA);
  });
});
