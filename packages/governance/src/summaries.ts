// Rule-based wording for change sets. No model and no caller writes these sentences. Two audiences:
//   - maintainers see tier codes and signal names (their own words),
//   - owners see plain everyday words, never a tier code or a signal name.
// The only caller-supplied text is a subject name, which is treated as data: cleaned, capped and
// always placed in quotes inside a fixed sentence.
import { type ChangeSignal, SIGNAL_TIER } from "@rms/contracts";

/** What a change is about. `name` is data (an app or connection name), never wording. */
export type ChangeSubject = { kind: "app" | "connection" | "settings" | "listing"; name?: string | undefined };

/** One plain phrase per signal, for the owner. */
const OWNER_PHRASE: Record<ChangeSignal, string> = {
  theme_change: "Changed colours or layout",
  screen_change: "Changed a screen",
  new_model: "Added a new kind of record",
  new_optional_field: "Added an optional detail to a record",
  new_index: "Made a list quicker to search",
  new_required_field: "Made a detail required on a record",
  new_unique_rule: "Stopped duplicate entries on a record",
  new_connection: "Connected another system",
  new_write_access: "Let a mini-app change your records",
  new_action: "Added a new action",
  new_job: "Added a task that runs on its own",
  role_change: "Changed who can do what",
  first_publish: "Published a mini-app for your team",
  touches_payroll_or_financial: "Touches pay or money records",
  public_share: "Shared a mini-app with other restaurants",
  new_dependency: "Uses new outside code",
  security_check_blocked: "A safety check stopped something",
};

const KIND_WORD: Record<ChangeSubject["kind"], string> = {
  app: "mini-app",
  connection: "connection",
  settings: "settings",
  listing: "Marketplace listing",
};

/** Signals, strongest first, without repeats. Unknown names are dropped. */
export const sortSignals = (signals: readonly ChangeSignal[]): ChangeSignal[] =>
  [...new Set(signals)]
    .filter((s) => s in SIGNAL_TIER)
    .sort((a, b) => (SIGNAL_TIER[b] > SIGNAL_TIER[a] ? 1 : SIGNAL_TIER[b] < SIGNAL_TIER[a] ? -1 : a.localeCompare(b)));

/**
 * Cleans a subject name: control characters and angle brackets removed, quotes replaced,
 * whitespace collapsed, trimmed, at most 60 characters. Returns "" when nothing is left.
 */
export const cleanName = (name: string | undefined): string =>
  (name ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]/g, " ")
    .replace(/["\u201c\u201d]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();

const subjectText = (subject: ChangeSubject | undefined): string => {
  if (!subject) return "";
  const name = cleanName(subject.name);
  return name ? `the ${KIND_WORD[subject.kind]} "${name}"` : `the ${KIND_WORD[subject.kind]}`;
};

/** Maintainer summary: fixed sentence with origin, signal names (strongest first) and subject. */
export const maintainerSummary = (origin: string, signals: readonly ChangeSignal[], subject?: ChangeSubject): string => {
  const sorted = sortSignals(signals);
  const what = sorted.length === 0 ? "no signals" : sorted.join(", ");
  const about = subjectText(subject);
  return about ? `${origin} change to ${about}: ${what}` : `${origin} change: ${what}`;
};

/** Owner summary in plain words, at most 240 characters. */
export const ownerSummaryFor = (signals: readonly ChangeSignal[], subject?: ChangeSubject): string => {
  const sorted = sortSignals(signals);
  const first = sorted.length === 0 ? "A small change" : OWNER_PHRASE[sorted[0] as ChangeSignal];
  const rest = sorted.length - 1;
  const main = rest > 0 ? `${first}, and ${rest} other ${rest === 1 ? "change" : "changes"}` : first;
  let about = subjectText(subject);
  // A name that happens to look like maintainer words is left out of the owner's sentence.
  if (hasMaintainerWords(about)) about = subject ? `the ${KIND_WORD[subject.kind]}` : "";
  return (about ? `${main}, for ${about}` : main).slice(0, 240);
};

const TIER_CODE = /\bT[0-3]\b/i;
const SIGNAL_NAMES = Object.keys(SIGNAL_TIER);

/** True when text holds a tier code or a signal name (maintainer words). */
export const hasMaintainerWords = (text: string): boolean =>
  TIER_CODE.test(text) || SIGNAL_NAMES.some((s) => text.toLowerCase().includes(s));
