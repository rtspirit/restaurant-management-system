// The one pattern the web app's frame rule may hold (`https://*.<suffix>`, for build sandboxes),
// attacked two ways (task J fix round: apps/web/next.config.ts and lib/agent/frame-host.ts):
//
//   1. the validator: can a setting put any other wildcard, or a second rule, in the header?
//   2. the grant: now that the browser may LOAD any sandbox under the suffix, does a sandbox
//      that is not the one the server named get an answer, a token, or a swapped grant?
//
// No database and no browser: the host is handed message events directly, exactly as `window`
// would hand them over. Every refusal has a control beside it.
//
// KNOWN GAP tests use `it.fails`: the body states the rule we want, and today it does not hold.
// The day one is fixed its test goes red. That is the signal to remove `.fails`, nothing else.
import { describe, expect, it } from "vitest";
import { repoPath } from "../helpers/env.js";

type Call = (path: string, token: string, body: string, signal?: AbortSignal) => Promise<{ status: number; body: unknown }>;
type Listener = (event: { origin: string; source: unknown; data: unknown }) => void;
type Host = { frameOrigin: string; replaceGrant: (grant: unknown) => boolean; dispose: () => void };
type MakeHost = (options: {
  frame: { contentWindow: unknown };
  grant: unknown;
  shellOrigin: string;
  messages: { addEventListener: (type: "message", listener: Listener) => void; removeEventListener: (type: "message", listener: Listener) => void };
  call: Call;
}) => Host | null;
type Env = Record<string, string | undefined>;

// Loaded by path so this suite does not take on the web app's own build settings.
const { createFrameHost, canLoadGrant } = (await import(repoPath("apps/web/lib/agent/frame-host.ts"))) as { createFrameHost: MakeHost; canLoadGrant: (grant: unknown, shell: string) => boolean };
const { frameSources, frameWildcard } = (await import(repoPath("apps/web/next.config.ts"))) as { frameSources: (env: Env) => string; frameWildcard: (value: string) => string | null };

const SHELL = "https://app.rms.example";
const SUFFIX = "sandbox.example";
const MINE = `https://one.${SUFFIX}`; // the sandbox the server named in the grant
const SIBLING = `https://two.${SUFFIX}`; // another sandbox the pattern also lets the browser load
const TOKEN = "run-token-0123456789abcdef-for-one-frame";
const OTHER_TOKEN = "run-token-fedcba9876543210-for-another";

const grant = (origin: string, token = TOKEN) => ({
  kind: "preview",
  appId: "app_0193a3c00000700080000000000000ea",
  appName: "Suppliers",
  url: `${origin}/`,
  frameOrigin: origin,
  token,
  expiresAt: "2026-11-21T23:00:00.000Z",
  runId: "run_0193a3c00000700080000000000000e1",
  context: {
    app: { id: "app_0193a3c00000700080000000000000ea", name: "Suppliers" },
    env: "draft",
    user: { name: "Asha Verma", role: "owner" },
    restaurant: { name: "Marigold Kitchen", brandColour: null },
    locations: [{ id: "0193a3c0-0000-7000-8000-0000000000e1", name: "Downtown" }],
    currency: "USD",
    locale: "en-US",
  },
});

function bound() {
  const listeners = new Set<Listener>();
  const posted: { message: { type?: string; id?: string }; to: string }[] = [];
  const frameWindow = { postMessage: (message: { type?: string; id?: string }, to: string) => posted.push({ message, to }) };
  const calls: { token: string }[] = [];
  const host = createFrameHost({
    frame: { contentWindow: frameWindow },
    grant: grant(MINE),
    shellOrigin: SHELL,
    messages: { addEventListener: (_t, l) => listeners.add(l), removeEventListener: (_t, l) => listeners.delete(l) },
    call: async (_path, token) => {
      calls.push({ token });
      return { status: 200, body: { rows: [] } };
    },
  });
  if (!host) throw new Error("the honest grant must load, or nothing below proves anything");
  const deliver = (data: unknown, origin = MINE) => {
    for (const l of [...listeners]) l({ origin, source: frameWindow, data });
  };
  const hello = (origin?: string) => deliver({ rms: 1, type: "rms.ready" }, origin);
  const data = (id: string, origin?: string) => deliver({ rms: 1, type: "rms.data", id, route: "query", body: { model: "vendor" } }, origin);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { host, posted, calls, hello, data, settle };
}

describe("the frame rule's one pattern: what a setting can put in the header", () => {
  it("control: the pattern is listed once, beside exact origins, and is the only wildcard", () => {
    const value = frameSources({ PREVIEW_URL: "http://127.0.0.1:5173", APPS_URL: "https://apps.rms.example", PREVIEW_FRAME_SUFFIX: SUFFIX });
    expect(value).toBe(`http://127.0.0.1:5173 https://apps.rms.example https://*.${SUFFIX}`);
    expect(value.split("*")).toHaveLength(2);
  });

  it("no other spelling of a wildcard gets through, as a suffix or in the list", () => {
    for (const suffix of ["a.b.", "a.b c.d", "a.b,c.d", "a.b\nc.d", "*.a.b", "a.*.b", "a_b.c", "a.b#x", "a.b/x", "a.b:443", "localhost", "com", "*", "**.a.b", "%2a.a.b", "a.b;x.y"]) {
      expect(frameSources({ PREVIEW_FRAME_SUFFIX: suffix }), JSON.stringify(suffix)).toBe("'none'");
    }
    for (const entry of ["https://＊.a.b", "https://%2A.a.b", "https://xn--*.a.b", "https://a.b*", "https://*a.b.c", "https://*.a.b\nhttps://*", "https://*.a.b https://*", "https://**.a.b", "https://*.*.a.b", "http://*.a.b", "//*.a.b", "*.a.b"]) {
      expect(frameSources({ PREVIEW_URL: entry, APPS_URL: entry }), JSON.stringify(entry)).toBe("'none'");
      expect(frameWildcard(entry), JSON.stringify(entry)).toBeNull();
    }
  });

  // KNOWN GAP. Two labels are enough for the suffix, and some two-label names are shared by
  // everybody (`co.uk`, `github.io`, `vercel.app`). Only the person who sets the settings can do
  // this, and it widens what may be SHOWN in a frame, never who gets a grant (see below).
  it.fails("KNOWN GAP: a suffix that is a shared public name is not listed", () => {
    for (const suffix of ["co.uk", "github.io", "vercel.app"]) expect(frameSources({ PREVIEW_FRAME_SUFFIX: suffix }), suffix).toBe("'none'");
  });

  // KNOWN GAP. An exact entry is rebuilt from `new URL(...).origin`, which keeps `;` `,` and `'`
  // in a host name. A setting can so add an empty rule or a second policy to the header. It can
  // only make the policy stricter (a source needs a space, and a space never survives), so this
  // breaks pages rather than opening anything.
  it.fails("KNOWN GAP: an exact entry cannot carry a rule separator into the header", () => {
    for (const entry of ["https://a.b;sandbox", "https://a.b;script-src", "https://a.b,https://c.d", "https://a.b'"]) {
      expect(frameSources({ APPS_URL: entry }), entry).toMatch(/^('none'|https:\/\/[a-z0-9.-]+(:\d+)?)$/);
    }
  });

  // KNOWN GAP. Nothing stops the suffix from covering the web app's own site. The grant check
  // would still refuse a frame on the web app's own host or a parent or child of it, but a
  // sibling under the same parent shares cookies set for that parent.
  it.fails("KNOWN GAP: a suffix that covers the web app's own site is not listed", () => {
    expect(frameSources({ WEB_URL: SHELL, PREVIEW_FRAME_SUFFIX: "rms.example" })).toBe("'none'");
  });
});

describe("the pattern lets the browser load a sandbox. It gives that sandbox nothing", () => {
  it("a grant cannot name a pattern, or anything but one exact origin, as its frame", () => {
    for (const origin of [`https://*.${SUFFIX}`, `https://*`, `*.${SUFFIX}`, `https://one.${SUFFIX} https://two.${SUFFIX}`, `https://one.${SUFFIX},https://two.${SUFFIX}`, `https://one.${SUFFIX}/`]) {
      expect(canLoadGrant(grant(origin), SHELL), origin).toBe(false);
      expect(canLoadGrant({ ...grant(MINE), frameOrigin: origin }, SHELL), origin).toBe(false);
    }
    expect(canLoadGrant(grant(MINE), SHELL)).toBe(true); // control
  });

  it("another sandbox under the same suffix, in the bound frame's own window, is not heard and not answered", async () => {
    const a = bound();
    // The frame navigates itself to a sibling sandbox (the pattern lets the browser load it) before saying hello.
    a.hello(SIBLING);
    a.data("sibling-00000001", SIBLING);
    await a.settle();
    expect({ calls: a.calls.length, posted: a.posted.length }).toEqual({ calls: 0, posted: 0 });
    // And after the honest mini-app said hello.
    a.hello();
    const before = a.posted.length;
    a.data("sibling-00000002", SIBLING);
    a.hello(SIBLING);
    await a.settle();
    expect(a.calls).toHaveLength(0);
    expect(a.posted.length).toBe(before);
    // Control: the sandbox the server named is heard, and answered with that grant's token only.
    a.data("sibling-00000003");
    await a.settle();
    expect(a.calls).toEqual([{ token: TOKEN }]);
    // Everything ever posted went to the one exact origin: never "*", never the pattern, never the sibling.
    expect(a.posted.length).toBeGreaterThan(0);
    expect(a.posted.every((p) => p.to === MINE)).toBe(true);
    expect(JSON.stringify(a.posted)).not.toContain(TOKEN);
  });

  it("a new grant for another sandbox under the suffix is not swapped in: the token stays the first sandbox's", async () => {
    const a = bound();
    a.hello();
    expect(a.host.replaceGrant(grant(SIBLING, OTHER_TOKEN))).toBe(false);
    expect(a.host.replaceGrant({ ...grant(MINE, OTHER_TOKEN), frameOrigin: `https://*.${SUFFIX}` })).toBe(false);
    a.data("swap-000000000001");
    a.data("swap-000000000002", SIBLING);
    await a.settle();
    expect(a.calls).toEqual([{ token: TOKEN }]);
    expect(a.host.frameOrigin).toBe(MINE);
    // Control: a new grant for the SAME sandbox is swapped in.
    expect(a.host.replaceGrant(grant(MINE, OTHER_TOKEN))).toBe(true);
    a.data("swap-000000000003");
    await a.settle();
    expect(a.calls.at(-1)).toEqual({ token: OTHER_TOKEN });
  });
});
