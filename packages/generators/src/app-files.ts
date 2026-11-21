// Reading and writing the few files the tools touch, always relative to the app folder.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_TEMPLATE, SandboxCatalog } from "@rms/contracts";

export class ToolRefusal extends Error {}

/** The runner-written catalog of this mini-app's models, named queries and actions. */
export const readCatalogFile = async (appDir: string): Promise<SandboxCatalog> => {
  let text: string;
  try {
    text = await readFile(join(appDir, APP_TEMPLATE.catalogFile), "utf8");
  } catch {
    throw new ToolRefusal(`There is no catalog file (${APP_TEMPLATE.catalogFile}). RMS writes it when a build starts.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ToolRefusal(`The catalog file (${APP_TEMPLATE.catalogFile}) is not valid JSON.`);
  }
  const parsed = SandboxCatalog.safeParse(raw);
  if (!parsed.success) throw new ToolRefusal(`The catalog file (${APP_TEMPLATE.catalogFile}) does not have the expected shape.`);
  return parsed.data;
};

/** A value as TypeScript source text. Every untrusted string goes into code through this, never by joining it into code. */
export const lit = (value: unknown): string => JSON.stringify(value);

/**
 * A JSX attribute value. A quoted JSX attribute does NOT read backslash escapes, so anything
 * with a quote, backslash, brace, angle bracket, ampersand or line break goes in as an
 * expression: `title={"..."}`. Plain words stay readable: `title="Vendors"`.
 */
export const jsx = (value: string): string => (/^[^"\\{}<>&\r\n\u2028\u2029]*$/.test(value) ? `"${value}"` : `{${lit(value)}}`);

/** "weekly-pnl" as "WeeklyPnl". Screen names are already checked by `ScreenName`. */
export const pascal = (name: string): string =>
  name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join("");

export const componentName = (screen: string): string => `${pascal(screen)}Screen`;

/** "vendor" as "a vendor", "order" as "an order". */
export const withArticle = (noun: string): string => `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
