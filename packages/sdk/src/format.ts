// Turning Data API values into words for a screen, by the field-type table in
// @rms/contracts data-api.ts. Plain functions: no network, no storage.

const decimals = (currency: string, locale: string): number => {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
};

/** Money travels as whole minor units (cents). `formatMoney(128450, "USD", "en-US")` is "$1,284.50". Blank for no value. */
export const formatMoney = (minor: unknown, currency: string, locale: string): string => {
  if (typeof minor !== "number" || !Number.isFinite(minor)) return "";
  const places = decimals(currency, locale);
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 10 ** places);
  } catch {
    return (minor / 100).toFixed(2);
  }
};

/** What an owner typed ("1,284.50", "$12") as whole minor units, or null when it is not an amount. */
export const moneyToMinor = (text: string, currency = "USD", locale = "en-US"): number | null => {
  const cleaned = text.replace(/[^0-9.-]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const places = decimals(currency, locale);
  const value = Math.round(Number(cleaned) * 10 ** places);
  return Number.isSafeInteger(value) ? value : null;
};

/** Integers, and decimals that travel as text ("12.50"). */
export const formatNumber = (value: unknown, locale: string): string => {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n);
};

/** A share already in percent ("61.3" is 61.3%), as named queries return it. */
export const formatPercent = (value: unknown, locale: string): string => {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n)}%`;
};

/** "2026-11-09" as "Mon 9 Nov 2026" in the owner's locale. Timestamps show their date and time. */
export const formatDate = (value: unknown, locale: string): string => {
  if (typeof value !== "string" || value.length === 0) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-").map(Number) as [number, number, number];
    return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
  }
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(t);
};

/** Today's date as "YYYY-MM-DD" (UTC), moved by `days`. Named queries take dates in this form. */
export const dateFromToday = (days = 0): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** "2026-11-09" moved by `days`, as "YYYY-MM-DD". */
export const addDays = (date: string, days: number): string => {
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(t) ? date : new Date(t + days * 86_400_000).toISOString().slice(0, 10);
};

/** A figure for a stat or a chart, by how the generator was asked to show it. */
export const formatAs = (value: unknown, format: "money" | "number" | "percent" | "text" | "date", place: Place): string => {
  switch (format) {
    case "money":
      return formatMoney(value, place.currency, place.locale);
    case "number":
      return formatNumber(value, place.locale);
    case "percent":
      return formatPercent(value, place.locale);
    case "date":
      return formatDate(value, place.locale);
    default:
      if (typeof value === "boolean") return value ? "Yes" : "No";
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
  }
};

/** "all_locations" as "All locations". For enum values and keys. */
export const humanize = (value: string): string => {
  const words = value.replace(/[_-]+/g, " ").trim();
  return words.length === 0 ? "" : (words[0] ?? "").toUpperCase() + words.slice(1);
};

/** Where a value is shown: the currency and locale from `useRms()`. */
export type Place = { currency: string; locale: string };

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * One field of a row as words, by its catalog type. Refs show their label (`<key>_label`),
 * never a raw id. Empty is "".
 */
export const showValue = (row: Record<string, unknown>, key: string, type: string, place: Place): string => {
  const value = row[key];
  switch (type) {
    case "ref":
    case "parent_ref": {
      const label = row[`${key}_label`] ?? record(value)?.label;
      return typeof label === "string" ? label : "";
    }
    case "money":
      return formatMoney(value, typeof row.currency === "string" ? row.currency : place.currency, place.locale);
    case "date":
    case "business_date":
    case "timestamp":
      return formatDate(value, place.locale);
    case "boolean":
      return value === true ? "Yes" : value === false ? "No" : "";
    case "integer":
    case "decimal":
      return formatNumber(value, place.locale);
    case "enum":
      return typeof value === "string" ? humanize(value) : "";
    case "quantity": {
      const q = record(value);
      return q && typeof q.value === "string" && typeof q.unit === "string" ? `${formatNumber(q.value, place.locale)} ${q.unit}` : "";
    }
    case "text":
      return typeof value === "string" ? value : "";
    default:
      return "";
  }
};

/** A stored value as the text a form field starts with. */
export const toInput = (value: unknown, type: string, place: Place): string => {
  if (value === null || value === undefined) return "";
  switch (type) {
    case "money": {
      if (typeof value !== "number") return "";
      const places = decimals(place.currency, place.locale);
      return (value / 10 ** places).toFixed(places);
    }
    case "parent_ref": {
      const id = record(value)?.id;
      return typeof id === "string" ? id : typeof value === "string" ? value : "";
    }
    case "boolean":
      return value === true ? "true" : "false";
    case "date":
    case "business_date":
      return typeof value === "string" ? value.slice(0, 10) : "";
    default:
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
  }
};

export type FromInput = { ok: true; value: unknown } | { ok: false; message: string };

/**
 * What the owner typed, as the value the Data API takes (data-api.ts). Blank is `null`; the
 * screen decides whether a blank is allowed. `message` is plain words for under the field.
 */
export const fromInput = (text: string, type: string, place: Place): FromInput => {
  const t = text.trim();
  if (type === "boolean") return { ok: true, value: t === "true" };
  if (t === "") return { ok: true, value: null };
  const plain = t.replace(/,/g, "");
  switch (type) {
    case "money": {
      const minor = moneyToMinor(t, place.currency, place.locale);
      return minor === null ? { ok: false, message: "Type an amount, such as 12.50." } : { ok: true, value: minor };
    }
    case "integer":
      return /^-?\d{1,15}$/.test(plain) ? { ok: true, value: Number(plain) } : { ok: false, message: "Type a whole number." };
    case "decimal":
      return /^-?\d{1,15}(\.\d{1,6})?$/.test(plain) ? { ok: true, value: plain } : { ok: false, message: "Type a number, such as 2.5." };
    case "date":
    case "business_date":
      return /^\d{4}-\d{2}-\d{2}$/.test(t) ? { ok: true, value: t } : { ok: false, message: "Pick a date." };
    default:
      return { ok: true, value: t };
  }
};
