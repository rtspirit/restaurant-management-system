import type { CSSProperties, ReactNode } from "react";
import { themeFromBrand } from "./theme";

export type ThemeProps = {
  /** The restaurant's brand colour as #RRGGBB. Anything unreadable falls back to basil. */
  brand: string;
  children: ReactNode;
};

/**
 * Sets the action colour for everything inside it. Layout is untouched (display: contents).
 * This is the only place a restaurant's colour enters the page.
 */
export function Theme({ brand, children }: ThemeProps) {
  return (
    <div className="rms-theme" style={themeFromBrand(brand).cssVars as CSSProperties}>
      {children}
    </div>
  );
}

export type GroundSampleProps = {
  /** The page ground to try, and the neutrals that belong to it. All #RRGGBB. */
  ground: string;
  line: string;
  mutedOnGround: string;
  children: ReactNode;
};

/**
 * For design review pages only: a patch of a different page ground, with its own hairline
 * and secondary-text colours, so two grounds can be compared side by side. Product screens
 * never use this. RMS has one ground, the same for every restaurant.
 */
export function GroundSample({ ground, line, mutedOnGround, children }: GroundSampleProps) {
  const vars = {
    "--rms-ground": ground,
    "--rms-surface": ground,
    "--rms-line": line,
    "--rms-muted-on-ground": mutedOnGround,
    "--rms-muted": mutedOnGround,
  } as CSSProperties;
  return (
    <div className="rms-ground-sample" style={vars}>
      {children}
    </div>
  );
}
