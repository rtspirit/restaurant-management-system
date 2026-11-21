// What `dashboard` and `report_table` share: finding the named query, its period controls, and
// how each column is shown.
import type { NamedCatalogEntry, SandboxCatalog } from "@rms/contracts";
import { ToolRefusal, jsx, lit, pascal } from "../app-files.js";
import { camel } from "./fields.js";

export type Format = "money" | "number" | "percent" | "text" | "date";
export type Column = NonNullable<NamedCatalogEntry["columns"]>[number];

export const findQuery = (catalog: SandboxCatalog, key: string): NamedCatalogEntry & { columns: Column[] } => {
  const q = catalog.namedQueries.find((n) => n.key === key);
  if (!q) {
    const known = catalog.namedQueries.map((n) => n.key).join(", ") || "none";
    throw new ToolRefusal(`"${key}" is not a report this mini-app can use. The ones it can use are: ${known}. If it needs another, say so: the owner changes the plan.`);
  }
  return { ...q, columns: q.columns ?? [] };
};

export const findColumn = (q: { key: string; columns: Column[] }, key: string): Column => {
  const c = q.columns.find((col) => col.key === key);
  if (!c) throw new ToolRefusal(`The report ${q.key} has no column "${key}". Its columns are: ${q.columns.map((col) => col.key).join(", ")}.`);
  return c;
};

/** How a column is shown when nobody said. Shares ("%" or "pct") are percentages. */
export const formatOf = (c: Column): Format => {
  if (c.type === "money") return "money";
  if (c.type === "date" || c.type === "business_date") return "date";
  if (c.type === "decimal") return /pct|percent/.test(c.key) || c.label.includes("%") ? "percent" : "number";
  if (c.type === "integer") return "number";
  return "text";
};

const DATE_TYPES = new Set(["date", "business_date"]);

/**
 * State and controls for the report's period. Every required date starts a week ago (the last
 * full week), with a Pager that steps a week (or a day) at a time. A required parameter that is
 * not a date is refused: the generator cannot guess it.
 */
export const periodCode = (q: NamedCatalogEntry): { state: string[]; params: string; pager: string | null } => {
  const required = q.params.filter((p) => p.required);
  for (const p of required) {
    if (!DATE_TYPES.has(p.type)) throw new ToolRefusal(`The report ${q.key} needs "${p.key}" (${p.type}), which a generated screen cannot choose. Write this screen by hand from the patterns.`);
  }
  const state = required.map((p) => `  const [${camel(p.key)}, set${pascal(camel(p.key))}] = useState(() => dateFromToday(-7));`);
  const params = `{ ${required.map((p) => `${lit(p.key)}: ${camel(p.key)}`).join(", ")} }`;
  const first = required[0];
  if (!first) return { state, params, pager: null };
  const v = camel(first.key);
  const set = `set${pascal(v)}`;
  const week = first.key.includes("week");
  const step = week ? 7 : 1;
  const label = week ? "`Week of ${formatDate(" + v + ", rms.locale)}`" : `formatDate(${v}, rms.locale)`;
  const pager = `<Pager label={${label}} previousLabel=${jsx(week ? "Week before" : "Day before")} nextLabel=${jsx(week ? "Week after" : "Day after")} onPrevious={() => ${set}((d) => addDays(d, -${step}))} onNext={() => ${set}((d) => addDays(d, ${step}))} />`;
  return { state, params, pager };
};
