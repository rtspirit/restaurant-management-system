import type { ReactNode } from "react";
import { cx } from "./cx";

// One hand-drawn set: 24px grid, 1.75 stroke, round caps and joins. No other icon source.
const PATHS = {
  home: <path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />,
  menu: <path d="M5 3v5a2 2 0 0 0 4 0V3M7 3v18M17 21V3c-2 2-3 5-3 9h3" />,
  staff: (
    <path d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14.5a6.5 6.5 0 0 1 3.5 5.5" />
  ),
  locations: (
    <>
      <path d="M12 21s7-6.2 7-11.5a7 7 0 0 0-14 0C5 14.8 12 21 12 21z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </>
  ),
  apps: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="2" />
      <rect x="13" y="4" width="7" height="7" rx="2" />
      <rect x="4" y="13" width="7" height="7" rx="2" />
      <rect x="13" y="13" width="7" height="7" rx="2" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h8M18 7h2M4 17h2M12 17h8" />
      <circle cx="15" cy="7" r="2.5" />
      <circle cx="9" cy="17" r="2.5" />
    </>
  ),
  ask: <path d="M5 4.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z" />,
  more: <path strokeWidth="3" d="M5 12h.01M12 12h.01M19 12h.01" />,
  down: <path d="M6 9l6 6 6-6" />,
  prev: <path d="M15 6l-6 6 6 6" />,
  next: <path d="M9 6l6 6-6 6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  up: <path d="M12 19V5M6 11l6-6 6 6" />,
  fall: <path d="M12 5v14M6 13l6 6 6-6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5h.01" />
    </>
  ),
  sort: <path d="M8 10l4-4 4 4M8 14l4 4 4-4" />,
  sortUp: <path d="M8 14l4-4 4 4" />,
  sortDown: <path d="M8 10l4 4 4-4" />,
  phone: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2.5" />
      <path d="M11 17.5h2" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export type IconProps = {
  name: IconName;
  /** s is 16px for inside a tag, m is 20px, l is 24px for the bottom bar. */
  size?: "s" | "m" | "l";
  /** Paint it in the action colour. Only for icons that are part of something pressable. */
  go?: boolean;
  /** Icons are decoration by default. Give a label only when the icon stands alone. */
  label?: string;
};

export function Icon({ name, size = "m", go = false, label }: IconProps) {
  return (
    <svg
      className={cx("rms-icon", size !== "m" && `rms-icon--${size}`, go && "rms-icon--go")}
      viewBox="0 0 24 24"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {PATHS[name]}
    </svg>
  );
}
