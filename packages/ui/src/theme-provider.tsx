import type { CSSProperties, ReactNode } from "react";
import { themeFromBrand } from "./theme";

export type ThemeProps = {
  /** The restaurant's brand colour as #RRGGBB. Anything unreadable falls back to basil. */
  brand: string | null | undefined;
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
