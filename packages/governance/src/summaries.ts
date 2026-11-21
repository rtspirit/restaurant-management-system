// Rule-based wording for change sets. No model writes these. Two audiences:
//   - maintainers see tier codes and signal names (their own words),
//   - owners see plain everyday words, never a tier code or a signal name.
import { type ChangeSignal, ChangeSignal as ChangeSignalSchema, SIGNAL_TIER } from "@rms/contracts";

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

/** Signals, strongest first, without repeats. */
export const sortSignals = (signals: readonly ChangeSignal[]): ChangeSignal[] =>
  [...new Set(signals)].sort((a, b) => (SIGNAL_TIER[b] > SIGNAL_TIER[a] ? 1 : SIGNAL_TIER[b] < SIGNAL_TIER[a] ? -1 : a.localeCompare(b)));

/** Maintainer summary: origin plus signal names, strongest first. */
export const maintainerSummary = (origin: string, signals: readonly ChangeSignal[]): string => {
  const sorted = sortSignals(signals);
  return sorted.length === 0 ? `${origin}: no signals` : `${origin}: ${sorted.join(", ")}`;
};

/** Owner summary in plain words, at most 240 characters. */
export const ownerSummaryFor = (signals: readonly ChangeSignal[]): string => {
  const sorted = sortSignals(signals);
  if (sorted.length === 0) return "A small change";
  const first = OWNER_PHRASE[sorted[0] as ChangeSignal];
  const rest = sorted.length - 1;
  return rest === 0 ? first : `${first}, and ${rest} other ${rest === 1 ? "change" : "changes"}`;
};

const TIER_CODE = /\bT[0-3]\b/i;
const SIGNAL_NAMES = ChangeSignalSchema.options;

/**
 * Keeps a caller-written owner summary only if it is plain words: short, one line, no tier
 * code and no signal name. Otherwise the rule-based summary is used.
 */
export const safeOwnerSummary = (text: string | undefined, signals: readonly ChangeSignal[]): string => {
  const t = text?.trim() ?? "";
  if (t.length === 0 || t.length > 240 || /[\r\n]/.test(t) || TIER_CODE.test(t)) return ownerSummaryFor(signals);
  const lower = t.toLowerCase();
  if (SIGNAL_NAMES.some((s) => lower.includes(s))) return ownerSummaryFor(signals);
  return t;
};
