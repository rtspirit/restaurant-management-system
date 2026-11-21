// One test per rule of the hand-off (ADR 0008, docs/briefs/wave2.md task J step 4).
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DATA_ROUTES, FRAME_ATTRIBUTES, FRAME_LIMITS, ShellToFrame, type PreviewGrant } from "@rms/contracts";
import { FRAME_ALLOW, FRAME_REFERRER_POLICY, FRAME_SANDBOX, Frame } from "@rms/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataCall } from "./client";
import { canLoadGrant, createFrameHost, grantNeedsRefresh, type FrameHost } from "./frame-host";

const SHELL = "http://localhost:3000";
const FRAME = "http://127.0.0.1:5673";
const RUN_TOKEN = "run-token-0123456789abcdef-frame-only";
const OWNER_SESSION_TOKEN = "owner-session-token-never-for-a-frame";

const grant = (over: Partial<PreviewGrant> = {}): PreviewGrant => ({
  kind: "preview",
  appId: "app_0193a3c000007000800000000000006a",
  appName: "Suppliers",
  url: `${FRAME}/`,
  frameOrigin: FRAME,
  token: RUN_TOKEN,
  expiresAt: "2026-11-21T16:00:00.000Z",
  runId: "run_0193a3c0000070008000000000000061",
  context: {
    app: { id: "app_0193a3c000007000800000000000006a", name: "Suppliers" },
    env: "draft",
    user: { name: "Asha Verma", role: "owner" },
    restaurant: { name: "Marigold Kitchen", brandColour: null },
    locations: [{ id: "0193a3c0-0000-7000-8000-000000000061", name: "Downtown" }],
    currency: "USD",
    locale: "en-US",
  },
  ...over,
});

type Posted = { message: unknown; to: string };
type Listener = (event: { origin: string; source: unknown; data: unknown }) => void;

function setup(options: { grant?: PreviewGrant; shellOrigin?: string; call?: DataCall; onUnauthenticated?: () => Promise<boolean> } = {}) {
  const listeners = new Set<Listener>();
  const posted: Posted[] = [];
  const frameWindow = { postMessage: (message: unknown, to: string) => posted.push({ message, to }) };
  const frame: { contentWindow: unknown } = { contentWindow: frameWindow };
  const calls: { path: string; token: string; body: string }[] = [];
  const call: DataCall =
    options.call ??
    (async (path, token, body) => {
      calls.push({ path, token, body });
      return { status: 200, body: { rows: [], nextCursor: null, masked: [] } };
    });
  const ready = vi.fn();
  const host = createFrameHost({
    frame,
    grant: options.grant ?? grant(),
    shellOrigin: options.shellOrigin ?? SHELL,
    messages: { addEventListener: (_type, listener) => listeners.add(listener), removeEventListener: (_type, listener) => listeners.delete(listener) },
    call: async (path, token, body, signal) => {
      if (options.call) calls.push({ path, token, body });
      return call(path, token, body, signal);
    },
    onReady: ready,
    ...(options.onUnauthenticated ? { onUnauthenticated: options.onUnauthenticated } : {}),
  });
  const deliver = (data: unknown, from: { origin?: string; source?: unknown } = {}) => {
    for (const listener of [...listeners]) listener({ origin: from.origin ?? FRAME, source: "source" in from ? from.source : frameWindow, data });
  };
  const hello = () => deliver({ rms: 1, type: "rms.ready" });
  const ask = (id: string, route: unknown = "query", body: unknown = { model: "vendor" }, extra: Record<string, unknown> = {}) => deliver({ rms: 1, type: "rms.data", id, route, body, ...extra });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { host: host as FrameHost, made: host !== null, listeners, posted, frame, frameWindow, calls, ready, deliver, hello, ask, settle };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the hello", () => {
  it("answers rms.ready with rms.init, to the frame's own origin and never to any", () => {
    const t = setup();
    t.hello();
    t.hello(); // the frame repeats itself until it hears back
    expect(t.posted).toHaveLength(2);
    for (const { message, to } of t.posted) {
      expect(to).toBe(FRAME);
      expect(to).not.toBe("*");
      expect(ShellToFrame.safeParse(message).success).toBe(true);
      expect(message).toMatchObject({ rms: 1, type: "rms.init", context: { restaurant: { name: "Marigold Kitchen" }, env: "draft" } });
    }
    expect(t.ready).toHaveBeenCalledTimes(1);
  });

  it("a data call before the hello is dropped", async () => {
    const t = setup();
    t.ask("aaaaaaaa0001");
    await t.settle();
    expect(t.calls).toEqual([]);
    expect(t.posted).toEqual([]);
  });

  it("before there is a grant there is no host, so nothing is listening at all", () => {
    const t = setup({ grant: grant({ frameOrigin: "http://localhost:5673", url: "http://localhost:5673/" }) });
    expect(t.made).toBe(false);
    expect(t.listeners.size).toBe(0);
  });
});

describe("one grant, one frame, one origin", () => {
  it("a message from another origin is dropped without an answer", async () => {
    const t = setup();
    t.hello();
    t.posted.length = 0;
    t.ask("aaaaaaaa0001", "query", {}, {});
    t.deliver({ rms: 1, type: "rms.data", id: "aaaaaaaa0002", route: "query", body: {} }, { origin: "https://evil.example" });
    t.deliver({ rms: 1, type: "rms.ready" }, { origin: "http://127.0.0.1:9999" });
    t.deliver({ rms: 1, type: "rms.ready" }, { origin: SHELL });
    await t.settle();
    expect(t.calls).toHaveLength(1);
    expect(t.posted).toHaveLength(1);
    expect(t.posted[0]?.message).toMatchObject({ id: "aaaaaaaa0001" });
  });

  it("a message from another window is dropped, a second frame on the same origin included", async () => {
    const t = setup();
    const secondFrame = { postMessage: vi.fn() };
    t.deliver({ rms: 1, type: "rms.ready" }, { source: secondFrame });
    t.deliver({ rms: 1, type: "rms.ready" }, { source: null });
    t.deliver({ rms: 1, type: "rms.ready" }, { source: {} });
    await t.settle();
    expect(t.posted).toEqual([]);
    expect(secondFrame.postMessage).not.toHaveBeenCalled();
    expect(t.ready).not.toHaveBeenCalled();
  });

  it("after the frame element is replaced, the old host answers nothing", async () => {
    const t = setup();
    t.hello();
    t.posted.length = 0;
    // The element is gone from the page: it has no window any more. A new frame on the same origin says hello.
    const oldWindow = t.frameWindow;
    t.frame.contentWindow = null;
    t.deliver({ rms: 1, type: "rms.ready" }, { source: oldWindow });
    t.ask("aaaaaaaa0001");
    t.deliver({ rms: 1, type: "rms.data", id: "aaaaaaaa0002", route: "query", body: {} }, { source: { postMessage: vi.fn() } });
    await t.settle();
    expect(t.posted).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it("a thrown-away host stops listening, forgets its token and never posts a late answer", async () => {
    let release: (value: { status: number; body: unknown }) => void = () => undefined;
    const seen: string[] = [];
    const t = setup({
      call: (_path, token) => {
        seen.push(token);
        return new Promise((resolve) => (release = resolve));
      },
    });
    t.hello();
    t.posted.length = 0;
    t.ask("aaaaaaaa0001");
    await t.settle();
    t.host.dispose();
    release({ status: 200, body: { rows: [] } });
    await t.settle();
    t.hello();
    t.ask("aaaaaaaa0002");
    await t.settle();
    expect(t.listeners.size).toBe(0);
    expect(t.posted).toEqual([]);
    expect(seen).toEqual([RUN_TOKEN]);
    expect(t.host.replaceGrant(grant({ token: "another-run-token-0123456789" }))).toBe(false);
  });

  it("a newer grant with the same origin swaps the token inside the same host", async () => {
    const t = setup();
    t.hello();
    t.ask("aaaaaaaa0001");
    await t.settle();
    expect(t.host.replaceGrant(grant({ token: "second-run-token-0123456789abc" }))).toBe(true);
    t.ask("aaaaaaaa0002");
    await t.settle();
    expect(t.calls.map((c) => c.token)).toEqual([RUN_TOKEN, "second-run-token-0123456789abc"]);
  });

  it("a newer grant with another origin is refused: the host must be thrown away", async () => {
    const t = setup();
    t.hello();
    expect(t.host.replaceGrant(grant({ url: "https://sandbox-b.example/", frameOrigin: "https://sandbox-b.example", token: "second-run-token-0123456789abc" }))).toBe(false);
    t.ask("aaaaaaaa0001");
    await t.settle();
    expect(t.calls.map((c) => c.token)).toEqual([RUN_TOKEN]);
    expect(t.host.frameOrigin).toBe(FRAME);
  });
});

describe("separate sites", () => {
  it("a grant for a localhost frame is not loaded", () => {
    const local = { ...grant(), url: "http://localhost:5173/", frameOrigin: "http://localhost:5173" };
    expect(canLoadGrant(local, SHELL)).toBe(false);
    expect(setup({ grant: local }).made).toBe(false);
  });

  it("a grant for the web app's own host, or a parent or child of it, is not loaded", () => {
    // Same host, another port: cookies ignore the port.
    expect(canLoadGrant(grant(), "http://127.0.0.1:3000")).toBe(false);
    expect(setup({ shellOrigin: "http://127.0.0.1:3000" }).made).toBe(false);
    const child = grant({ url: "https://preview.rms.example/", frameOrigin: "https://preview.rms.example" });
    expect(canLoadGrant(child, "https://rms.example")).toBe(false);
    const parent = grant({ url: "https://rms.example/", frameOrigin: "https://rms.example" });
    expect(canLoadGrant(parent, "https://app.rms.example")).toBe(false);
    // A sandbox address beside a deployed web app is fine.
    expect(canLoadGrant(grant({ url: "https://sb-123.sandbox.example/", frameOrigin: "https://sb-123.sandbox.example" }), "https://rms.example")).toBe(true);
    expect(canLoadGrant(grant(), SHELL)).toBe(true);
  });

  it("a grant whose origin is not the origin of its address, or that is not a grant, is not loaded", () => {
    expect(canLoadGrant({ ...grant(), url: "https://elsewhere.example/" }, SHELL)).toBe(false);
    expect(canLoadGrant({ ...grant(), token: "short" }, SHELL)).toBe(false);
    expect(canLoadGrant(null, SHELL)).toBe(false);
  });
});

describe("routes by name only", () => {
  it("each of the five names goes to its own Data API route", async () => {
    const t = setup();
    t.hello();
    const names = ["query", "batch", "named", "action", "catalog"] as const;
    for (const [i, name] of names.entries()) {
      t.ask(`aaaaaaaa000${i}`, name, {});
      await t.settle();
    }
    expect(t.calls.map((c) => c.path)).toEqual(names.map((name) => DATA_ROUTES[name]));
  });

  it("an address or a path as the route is dropped: nothing is called and nothing is answered", async () => {
    const t = setup();
    t.hello();
    t.posted.length = 0;
    for (const route of ["https://evil.example/steal", "/data/v1/query", "../auth/me", "//evil.example", "constructor", "__proto__", "toString", "", 7, null, { path: "/x" }]) {
      t.ask("aaaaaaaa0001", route);
    }
    await t.settle();
    expect(t.calls).toEqual([]);
    expect(t.posted).toEqual([]);
  });
});

describe("no identity in a message", () => {
  it("a message with a token, a restaurant or any other extra field is dropped", async () => {
    const t = setup();
    t.hello();
    t.posted.length = 0;
    t.ask("aaaaaaaa0001", "query", {}, { token: OWNER_SESSION_TOKEN });
    t.ask("aaaaaaaa0002", "query", {}, { orgId: "org_0193a3c0000070008000000000000060" });
    t.ask("aaaaaaaa0003", "query", {}, { url: "https://evil.example" });
    t.deliver({ rms: 1, type: "rms.ready", token: "x" });
    t.deliver({ rms: 2, type: "rms.ready" });
    t.deliver({ rms: 1, type: "rms.give-me-the-token" });
    t.deliver("rms.ready");
    t.deliver(null);
    t.ask("short");
    await t.settle();
    expect(t.calls).toEqual([]);
    expect(t.posted).toEqual([]);
  });
});

describe("body cap", () => {
  it("a body over the limit is answered here with a plain refusal and never sent on", async () => {
    const t = setup();
    t.hello();
    t.posted.length = 0;
    t.ask("aaaaaaaa0001", "batch", { ops: "x".repeat(FRAME_LIMITS.maxBodyBytes) });
    await t.settle();
    expect(t.calls).toEqual([]);
    expect(t.posted).toEqual([
      {
        to: FRAME,
        message: { rms: 1, type: "rms.data.result", id: "aaaaaaaa0001", status: 400, body: { error: { code: "invalid_request", message: "That is too much to send at once.", requestId: "shell" } } },
      },
    ]);
  });

  it("the size is counted in bytes, and a body just under the limit goes through as it came", async () => {
    const t = setup();
    t.hello();
    // Two bytes each in UTF-8: half the characters, the same weight.
    t.ask("aaaaaaaa0001", "batch", { ops: "é".repeat(FRAME_LIMITS.maxBodyBytes / 2) });
    const fits = { ops: "x".repeat(FRAME_LIMITS.maxBodyBytes - 100) };
    t.ask("aaaaaaaa0002", "batch", fits);
    await t.settle();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.body).toBe(JSON.stringify(fits));
  });
});

describe("the call", () => {
  it("passes the answer back as it came, status and body, to the frame's origin", async () => {
    const t = setup({ call: async () => ({ status: 403, body: { error: { code: "forbidden_model", message: "This mini-app can’t use that.", requestId: "req_1" } } }) });
    t.hello();
    t.posted.length = 0;
    t.ask("aaaaaaaa0001");
    await t.settle();
    expect(t.posted).toEqual([{ to: FRAME, message: { rms: 1, type: "rms.data.result", id: "aaaaaaaa0001", status: 403, body: { error: { code: "forbidden_model", message: "This mini-app can’t use that.", requestId: "req_1" } } } }]);
    expect(ShellToFrame.safeParse(t.posted[0]?.message).success).toBe(true);
  });

  it("at most four at once, fifty waiting, and the rest are refused", async () => {
    const releases: Array<() => void> = [];
    let running = 0;
    let most = 0;
    const t = setup({
      call: () =>
        new Promise((resolve) => {
          running += 1;
          most = Math.max(most, running);
          releases.push(() => {
            running -= 1;
            resolve({ status: 200, body: {} });
          });
        }),
    });
    t.hello();
    t.posted.length = 0;
    const total = FRAME_LIMITS.maxInFlight + FRAME_LIMITS.maxQueued + 3;
    for (let i = 0; i < total; i += 1) t.ask(`aaaaaaaa${String(i).padStart(4, "0")}`);
    await t.settle();
    expect(running).toBe(FRAME_LIMITS.maxInFlight);
    const refused = t.posted.filter((p) => (p.message as { status: number }).status === 429);
    expect(refused).toHaveLength(3);
    expect(refused[0]?.message).toMatchObject({ body: { error: { code: "limit" } } });
    while (releases.length > 0) {
      releases.shift()?.();
      await t.settle();
    }
    expect(most).toBe(FRAME_LIMITS.maxInFlight);
    expect(t.posted.filter((p) => (p.message as { status: number }).status === 200)).toHaveLength(FRAME_LIMITS.maxInFlight + FRAME_LIMITS.maxQueued);
  });

  it("a call that breaks is answered in plain words, with no error text", async () => {
    const t = setup({
      call: async () => {
        throw new TypeError("connect ECONNREFUSED 127.0.0.1:8787");
      },
    });
    t.hello();
    t.posted.length = 0;
    t.ask("aaaaaaaa0001");
    await t.settle();
    expect(JSON.stringify(t.posted)).not.toContain("ECONNREFUSED");
    expect(t.posted[0]?.message).toMatchObject({ status: 500, body: { error: { code: "internal", message: "RMS is not answering just now. Try again in a moment." } } });
  });
});

describe("the token", () => {
  it("the frame's calls carry the grant's token and nothing else", async () => {
    const t = setup();
    t.hello();
    t.ask("aaaaaaaa0001");
    await t.settle();
    expect(t.calls).toEqual([{ path: "/data/v1/query", token: RUN_TOKEN, body: '{"model":"vendor"}' }]);
  });

  it("the run token never appears in anything posted to the frame, even if an answer echoes it", async () => {
    const t = setup({ call: async () => ({ status: 200, body: { rows: [{ note: `Bearer ${RUN_TOKEN}` }] } }) });
    t.hello();
    t.ask("aaaaaaaa0001");
    t.host.setTheme("#C2410C");
    await t.settle();
    expect(t.posted.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(t.posted)).not.toContain(RUN_TOKEN);
    expect(t.posted.find((p) => (p.message as { type: string }).type === "rms.data.result")?.message).toMatchObject({ id: "aaaaaaaa0001", status: 500 });
  });

  it("when the Data API refuses the token it asks for a new grant and tries once more", async () => {
    const tokens: string[] = [];
    let host: FrameHost | null = null;
    const renew = vi.fn(async () => host?.replaceGrant(grant({ token: "renewed-run-token-0123456789ab" })) ?? false);
    const t = setup({
      call: async (_path, token) => {
        tokens.push(token);
        return token === RUN_TOKEN ? { status: 401, body: { error: { code: "unauthenticated", message: "Please open this again from RMS.", requestId: "r" } } } : { status: 200, body: { rows: [] } };
      },
      onUnauthenticated: renew,
    });
    host = t.host;
    t.hello();
    t.posted.length = 0;
    t.ask("aaaaaaaa0001");
    await t.settle();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(tokens).toEqual([RUN_TOKEN, "renewed-run-token-0123456789ab"]);
    expect(t.posted[0]?.message).toMatchObject({ status: 200 });
  });

  it("the frame host has no way to reach the owner's session: it imports no sign-in code and stores nothing", () => {
    const source = readFileSync(new URL("./frame-host.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/apiFetch|supabase|getSession|localStorage|sessionStorage|document\.cookie|console\./);
    expect(source).not.toMatch(/postMessage\([^)]*["']\*["']/);
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["@rms/contracts", "./client"]);
  });

  it("the real Data API call sends the frame's token, never the owner's session token or cookies", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://127.0.0.1:8787");
    // If anything asked for the owner's session, this would hand it over. Nothing may ask.
    const getSession = vi.fn(async () => ({ data: { session: { access_token: OWNER_SESSION_TOKEN } } }));
    vi.doMock("../supabase/client", () => ({ createClient: () => ({ auth: { getSession } }) }));
    const requests: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ rows: [] }), { status: 200 });
    });
    const { realAgentApi } = await import("./client");
    const t = setup({ call: realAgentApi.data });
    t.hello();
    t.ask("aaaaaaaa0001");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toHaveLength(1);
    const sent = requests[0];
    expect(sent?.url).toBe("http://127.0.0.1:8787/data/v1/query");
    expect(sent?.init.method).toBe("POST");
    expect(sent?.init.credentials).toBe("omit");
    expect(new Headers(sent?.init.headers).get("authorization")).toBe(`Bearer ${RUN_TOKEN}`);
    expect(JSON.stringify(sent)).not.toContain(OWNER_SESSION_TOKEN);
    expect(getSession).not.toHaveBeenCalled();
    vi.doUnmock("../supabase/client");
    vi.unstubAllEnvs();
  });

  it("asks for a new grant when under two minutes remain", () => {
    const now = Date.parse("2026-11-21T15:00:00.000Z");
    expect(grantNeedsRefresh({ expiresAt: "2026-11-21T15:10:00.000Z" }, now)).toBe(false);
    expect(grantNeedsRefresh({ expiresAt: "2026-11-21T15:01:59.000Z" }, now)).toBe(true);
    expect(grantNeedsRefresh({ expiresAt: "2026-11-21T14:00:00.000Z" }, now)).toBe(true);
    expect(grantNeedsRefresh({ expiresAt: "soon" }, now)).toBe(true);
  });
});

describe("the frame element", () => {
  it("carries exactly the attributes the contract names, a title, and nothing that grants a device", () => {
    expect({ sandbox: FRAME_SANDBOX, referrerPolicy: FRAME_REFERRER_POLICY, allow: FRAME_ALLOW }).toEqual(FRAME_ATTRIBUTES);
    const html = renderToStaticMarkup(createElement(Frame, { title: "Preview of Suppliers", src: `${FRAME}/`, state: "ready" }));
    expect(html).toContain(`sandbox="${FRAME_ATTRIBUTES.sandbox}"`);
    expect(html.toLowerCase()).toContain(`referrerpolicy="${FRAME_ATTRIBUTES.referrerPolicy}"`);
    expect(html).toContain('allow=""');
    expect(html).toContain('title="Preview of Suppliers"');
    expect(html).not.toMatch(/allow-top-navigation|allow-popups|camera|microphone|geolocation/);
  });

  it("has a loading state with words and an empty state, and never draws a frame with nothing to show", () => {
    const loading = renderToStaticMarkup(createElement(Frame, { title: "Preview", state: "loading", loadingLabel: "Building your preview" }));
    expect(loading).toContain('role="status"');
    expect(loading).toContain("Building your preview");
    expect(loading).not.toContain("<iframe");
    const empty = renderToStaticMarkup(createElement(Frame, { title: "Preview", state: "empty", src: `${FRAME}/` }, "Your preview shows here"));
    expect(empty).toContain("Your preview shows here");
    expect(empty).not.toContain("<iframe");
  });
});
