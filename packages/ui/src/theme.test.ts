/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AA_TEXT, DEFAULT_BRAND, MIN_CHROMA, SURFACES, chromaOf, contrastRatio, darkenToContrast, normaliseHex, relativeLuminance, themeFromBrand } from "./theme";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

// The five colours the brief names: basil (default), Marigold Kitchen orange, Slice Yard
// tomato, a light yellow that failed in the sketch, and a blue.
const BRIEF_COLOURS = ["#12804A", "#E8892B", "#C8372D", "#F2C230", "#1F6FD0"];

// Colours no owner should be able to break the screen with.
const HARD_COLOURS = ["#FFFFFF", "#000000", "#FFFF00", "#00FFFF", "#FF00FF", "#F4EEE6", "#DEE7F2", "#FFD1DC", "#7FFF00", "#0000FF", "#101820"];

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
    expect(contrastRatio("#12804A", "#F4EEE6")).toBeCloseTo(contrastRatio("#F4EEE6", "#12804A"), 10);
  });
});

describe.each([...BRIEF_COLOURS, ...HARD_COLOURS])("themeFromBrand(%s)", (brand) => {
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

  it("the hover wash stays a faint tint, never a fill", () => {
    expect(relativeLuminance(theme.actionWash)).toBeGreaterThan(0.8);
  });

  it("the action colour is a colour, never a grey, black or white", () => {
    expect(chromaOf(theme.action)).toBeGreaterThanOrEqual(MIN_CHROMA);
    expect(chromaOf(theme.actionInk)).toBeGreaterThanOrEqual(MIN_CHROMA);
  });

  it("returns well-formed colours and the matching CSS variables", () => {
    for (const value of [theme.brand, theme.action, theme.actionInk, theme.actionPressed, theme.actionWash, theme.onAction]) {
      expect(value).toMatch(/^#[0-9A-F]{6}$/);
    }
    expect(theme.cssVars).toEqual({
      "--rms-action": theme.action,
      "--rms-action-ink": theme.actionInk,
      "--rms-action-pressed": theme.actionPressed,
      "--rms-action-wash": theme.actionWash,
      "--rms-on-action": theme.onAction,
    });
  });
});

describe("themeFromBrand keeps the owner's colour recognisable", () => {
  it("leaves a brand colour that already passes exactly as chosen", () => {
    for (const brand of ["#12804A", "#C8372D", "#1F6FD0"]) {
      expect(themeFromBrand(brand).action).toBe(brand);
      expect(themeFromBrand(brand).adjustment).toBe("none");
    }
  });

  it("says when it darkened the colour", () => {
    for (const brand of ["#E8892B", "#F2C230"]) {
      expect(themeFromBrand(brand).adjustment).toBe("darkened");
    }
  });

  it("replaces black, white and greys with basil, because they would read as ink, not as press", () => {
    const basil = themeFromBrand(DEFAULT_BRAND);
    for (const brand of ["#000000", "#FFFFFF", "#777777", "#101820", "#F4EEE6", "#1E2420"]) {
      const theme = themeFromBrand(brand);
      expect(theme.adjustment).toBe("replaced");
      expect(theme.brand).toBe(brand);
      expect(theme.cssVars).toEqual(basil.cssVars);
    }
  });

  it("only ever darkens a colour that fails", () => {
    for (const brand of ["#E8892B", "#F2C230", "#FFFF00", "#FFD1DC"]) {
      const { action } = themeFromBrand(brand);
      expect(action).not.toBe(brand);
      expect(relativeLuminance(action)).toBeLessThan(relativeLuminance(brand));
    }
  });

  it("goes no darker than it has to", () => {
    // The derived step sits just over the line, not far past it.
    for (const brand of ["#E8892B", "#F2C230"]) {
      expect(contrastRatio(themeFromBrand(brand).action, "#FFFFFF")).toBeLessThan(AA_TEXT + 0.15);
    }
  });

  it("keeps the hue within a few degrees", () => {
    for (const brand of ["#E8892B", "#F2C230", "#C8372D", "#1F6FD0", "#12804A"]) {
      const theme = themeFromBrand(brand);
      for (const step of [theme.action, theme.actionInk]) {
        const drift = Math.abs(hueOf(step) - hueOf(brand));
        expect(Math.min(drift, 360 - drift)).toBeLessThan(12);
      }
    }
  });
});

describe("themeFromBrand input handling", () => {
  it("accepts short hex, lower case and a missing hash", () => {
    expect(themeFromBrand("12804a").brand).toBe("#12804A");
    expect(themeFromBrand("#abc").brand).toBe("#AABBCC");
    expect(normaliseHex("  #E8892B ")).toBe("#E8892B");
  });

  it("falls back to basil for anything that is not a hex colour", () => {
    for (const bad of ["", "tomato", "#12", "#GGGGGG", "rgb(1,2,3)", "#12804A; color: red"]) {
      expect(normaliseHex(bad)).toBeNull();
      expect(themeFromBrand(bad).cssVars).toEqual(themeFromBrand(DEFAULT_BRAND).cssVars);
      expect(themeFromBrand(bad).adjustment).toBe("replaced");
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

  it("chart bars stand clear of the card they sit on", () => {
    expect(contrastRatio(token("bar"), token("card"))).toBeGreaterThanOrEqual(2);
  });
});
