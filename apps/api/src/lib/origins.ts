// Which browser origins may call the API. Exact strings only: no wildcard, no pattern, and the
// request's own Origin is never echoed back unless it is on the list.
//
// WEB_URL is the web app's one canonical address. WEB_EXTRA_ORIGINS is an optional short list
// (comma separated) of further exact origins for the SAME web app, used only by phone mode
// (scripts/demo-phone.sh, ADR 0010): the laptop opens RMS on 127.0.0.1 and the phone opens the
// same server by the laptop's network name.

/** At most this many extra origins. Phone mode needs one. */
export const MAX_EXTRA_ORIGINS = 4;

/**
 * The exact origin of one configured address, or null when it is not a plain http(s) address.
 * Refuses anything with a user, a query, a fragment or a path other than "/", so a typo can
 * never widen the list.
 */
export const exactOrigin = (value: string): string | null => {
  const text = value.trim();
  if (text === "" || text.length > 200) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  if (text.includes("*")) return null;
  return url.origin;
};

/** The web app's allowed origins: WEB_URL first, then each valid entry of WEB_EXTRA_ORIGINS. */
export const webOrigins = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const out: string[] = [];
  const main = env.WEB_URL ? exactOrigin(env.WEB_URL) : null;
  if (main) out.push(main);
  const extra = (env.WEB_EXTRA_ORIGINS ?? "").split(",").filter((s) => s.trim() !== "");
  for (const entry of extra.slice(0, MAX_EXTRA_ORIGINS)) {
    const o = exactOrigin(entry);
    if (o && !out.includes(o)) out.push(o);
  }
  return out;
};

/** The origin to put in Access-Control-Allow-Origin, or null to refuse. Exact match only. */
export const allowWebOrigin = (origin: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null => {
  if (!origin) return null;
  const allowed = webOrigins(env);
  return allowed.includes(origin) ? origin : null;
};
