// What every screen must get right, whoever is looking: plain words only.
import { type Page, expect } from "@playwright/test";
import { words } from "./session.js";

/** Words that only a program should ever say. None may reach a screen. */
const LEAKS: { what: string; pattern: RegExp }[] = [
  { what: '"undefined"', pattern: /\bundefined\b/i },
  { what: '"null"', pattern: /\bnull\b/i },
  { what: '"NaN"', pattern: /\bNaN\b/ },
  { what: '"[object Object]"', pattern: /\[object \w+\]/ },
  { what: "raw error text", pattern: /\b(TypeError|ReferenceError|SyntaxError|RangeError|Unhandled|ECONNREFUSED|ETIMEDOUT|SQLSTATE|stack trace|Internal Server Error|Application error|digest:)/ },
  { what: "a database message", pattern: /\b(relation "|permission denied for|violates|duplicate key|syntax error at)/i },
  { what: "an error code", pattern: /\b(invalid_request|not_found|rate_limited|unauthorized|forbidden_role|internal_error)\b/ },
];

/** Things an OWNER or STAFF screen must never show. The maintainer console may use tier codes and signals. */
const OWNER_LEAKS: { what: string; pattern: RegExp }[] = [
  { what: "a schema or table name", pattern: /\b(platform\.\w+|o_[0-9a-f]{6,}\w*|public\.\w+|auth\.users)\b/ },
  { what: "a snake_case code word", pattern: /\b[a-z]+_[a-z0-9]+(_[a-z0-9]+)*\b/ },
  { what: "a tier code", pattern: /\bT[0-3]\b/ },
  { what: "a public id", pattern: /\b(org|app|run|loc)_[0-9a-z]{8,}\b/ },
  { what: "a model name", pattern: /\b(gpt-|claude-|openrouter|o\d-mini)\b/i },
];

export type Audience = "owner" | "maintainer";

/** The page's words carry nothing a program should have said. */
export const expectPlainWords = async (page: Page, audience: Audience = "owner"): Promise<void> => {
  const text = await words(page);
  const rules = audience === "owner" ? [...LEAKS, ...OWNER_LEAKS] : LEAKS;
  const found = rules.flatMap(({ what, pattern }) => {
    const m = pattern.exec(text);
    return m ? [`${what} ("${m[0]}")`] : [];
  });
  expect(found, `${new URL(page.url()).pathname} shows ${found.join(", ")}`).toEqual([]);
};

/** On a phone, nothing sticks out sideways: the page never scrolls left and right. */
export const expectNoSidewaysScroll = async (page: Page): Promise<void> => {
  const { scroll, view, culprits } = await page.evaluate(() => {
    const view = document.documentElement.clientWidth;
    const culprits: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > view + 1) {
        // Skip anything inside a box that scrolls sideways on purpose (a wide table in its own scroller).
        let p: HTMLElement | null = el.parentElement;
        let contained = false;
        while (p && p !== document.body) {
          const ox = getComputedStyle(p).overflowX;
          if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") {
            contained = true;
            break;
          }
          p = p.parentElement;
        }
        if (!contained) culprits.push(`${el.tagName.toLowerCase()} "${(el.innerText || "").trim().slice(0, 40)}"`);
      }
    }
    return { scroll: document.documentElement.scrollWidth, view, culprits: culprits.slice(0, 3) };
  });
  expect(scroll, `${new URL(page.url()).pathname} scrolls sideways on a phone (${scroll}px wide in a ${view}px screen). Sticking out: ${culprits.join("; ") || "unknown"}`).toBeLessThanOrEqual(view);
};

export const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 1280) < 700;

/** Plain words always, and on a phone no sideways scroll. */
export const expectCleanScreen = async (page: Page, audience: Audience = "owner"): Promise<void> => {
  await expectPlainWords(page, audience);
  if (isPhone(page)) await expectNoSidewaysScroll(page);
};
