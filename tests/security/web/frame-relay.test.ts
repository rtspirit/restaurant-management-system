// The shell side of the mini-app hand-off (ADR 0008), attacked the way a hostile framed page would.
// Wave 2, task J: apps/web/lib/agent/frame-host.ts, the build screen around it, and the frame element.
//
// No database and no browser: the host is handed message events directly, exactly as `window`
// would hand them over. Every test has a control (the honest version of the same message works),
// so a test here cannot pass just because nothing was listening.
//
// KNOWN GAP tests use `it.fails`: the body states the rule we want, and today it does not hold.
// The day one is fixed its test goes red. That is the signal to remove `.fails`, nothing else.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DATA_ROUTES, FRAME_ATTRIBUTES, FRAME_LIMITS } from "@rms/contracts";
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
  onReady?: () => void;
  onUnauthenticated?: () => Promise<boolean>;
}) => Host | null;

// Loaded by path so this suite does not take on the web app's own build settings.
const { createFrameHost } = (await import(repoPath("apps/web/lib/agent/frame-host.ts"))) as { createFrameHost: MakeHost };

const SHELL = "http://localhost:3000";
const FRAME = "http://127.0.0.1:5673";
const RUN_TOKEN = "run-token-0123456789abcdef-for-one-frame";
const FIVE_PATHS = Object.values(DATA_ROUTES) as string[];

const grant = () => ({
  kind: "preview",
  appId: "app_0193a3c00000700080000000000000ea",
  appName: "Suppliers",
  url: `${FRAME}/`,
  frameOrigin: FRAME,
  token: RUN_TOKEN,
  expiresAt: "2026-11-21T16:00:00.000Z",
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

type Posted = { message: { type?: string; id?: string; status?: number; body?: unknown }; to: string };

function attack(options: { call?: Call; onUnauthenticated?: () => Promise<boolean> } = {}) {
  const listeners = new Set<Listener>();
  const posted: Posted[] = [];
  const frameWindow = { postMessage: (message: Posted["message"], to: string) => posted.push({ message, to }) };
  const calls: { path: string; token: string; body: string }[] = [];
  let hellos = 0;
  const host = createFrameHost({
    frame: { contentWindow: frameWindow },
    grant: grant(),
    shellOrigin: SHELL,
    messages: { addEventListener: (_type, listener) => listeners.add(listener), removeEventListener: (_type, listener) => listeners.delete(listener) },
    call: async (path, token, body, signal) => {
      calls.push({ path, token, body });
      return options.call ? options.call(path, token, body, signal) : { status: 200, body: { rows: [] } };
    },
    onReady: () => {
      hellos += 1;
    },
    ...(options.onUnauthenticated ? { onUnauthenticated: options.onUnauthenticated } : {}),
  });
  if (!host) throw new Error("the honest grant must load, or nothing below proves anything");
  const deliver = (data: unknown, from: { origin?: string; source?: unknown } = {}) => {
    for (const listener of [...listeners]) listener({ origin: from.origin ?? FRAME, source: "source" in from ? from.source : frameWindow, data });
  };
  const hello = (from: { origin?: string; source?: unknown } = {}) => deliver({ rms: 1, type: "rms.ready" }, from);
  const data = (id: string, over: Record<string, unknown> = {}, from: { origin?: string; source?: unknown } = {}) =>
    deliver({ rms: 1, type: "rms.data", id, route: "query", body: { model: "vendor" }, ...over }, from);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const answers = (id: string) => posted.filter((p) => p.message.type === "rms.data.result" && p.message.id === id);
  return { host, posted, calls, frameWindow, deliver, hello, data, settle, answers, hellos: () => hellos };
}

describe("a hostile frame: who the shell listens to", () => {
  it("an origin that only looks like the frame's is dropped, with the frame's own window as the sender", async () => {
    const lookalikes = [
      `${FRAME}.evil.example`, // the right text, then more host
      `${FRAME}0`, // the right text, then more port
      "http://127.0.0.1:567",
      "http://127.0.0.1",
      "https://127.0.0.1:5673",
      "HTTP://127.0.0.1:5673",
      `${FRAME}/`,
      `http://evil.example/${FRAME}`,
      `http://evil.example/?${FRAME}`,
      "http://localhost:5673",
      "null",
      "",
      "*",
    ];
    for (const origin of lookalikes) {
      const a = attack();
      a.hello({ origin });
      a.data("lookalike-0001", {}, { origin });
      await a.settle();
      expect({ origin, hellos: a.hellos(), calls: a.calls.length, posted: a.posted.length }).toEqual({ origin, hellos: 0, calls: 0, posted: 0 });
    }
    // Control: the exact origin, same window, same messages.
    const honest = attack();
    honest.hello();
    honest.data("lookalike-0001");
    await honest.settle();
    expect(honest.calls).toHaveLength(1);
    expect(honest.answers("lookalike-0001")).toHaveLength(1);
  });

  it("a frame that said hello, then navigated itself to another site and keeps posting: nothing is called, nothing is posted to it", async () => {
    const a = attack();
    a.hello();
    const before = a.posted.length;
    for (const origin of ["https://evil.example", "null", "http://127.0.0.1:5684"]) {
      a.hello({ origin });
      a.data("navigated-0001", { route: "batch", body: { ops: [{ op: "insert", model: "vendor", values: { name: "X" } }] } }, { origin });
    }
    await a.settle();
    expect(a.calls).toHaveLength(0);
    expect(a.posted.length).toBe(before);
    // Whatever was ever posted went to the one origin the grant named, never to "any".
    expect(a.posted.every((p) => p.to === FRAME)).toBe(true);
    // Control: back on its own origin the same window is heard again.
    a.data("navigated-0002");
    await a.settle();
    expect(a.calls).toHaveLength(1);
  });

  it("the right origin from any other window is dropped: no sender, a nested frame, a pop-up, the shell's own window", async () => {
    const a = attack();
    a.hello();
    const others: unknown[] = [null, undefined, {}, { postMessage: () => undefined }, { ...a.frameWindow }, globalThis];
    for (const source of others) a.data("otherwindow-01", {}, { source });
    await a.settle();
    expect(a.calls).toHaveLength(0);
    expect(a.answers("otherwindow-01")).toHaveLength(0);
    a.data("otherwindow-02");
    await a.settle();
    expect(a.calls).toHaveLength(1);
  });
});

describe("a hostile frame: what it may say", () => {
  it("messages shaped like the shell's own (a result, an init, a theme) are dropped", async () => {
    const a = attack();
    a.hello();
    const before = a.posted.length;
    a.deliver({ rms: 1, type: "rms.data.result", id: "forged-result-1", status: 200, body: { rows: [{ name: "FORGED" }] } });
    a.deliver({ rms: 1, type: "rms.init", context: grant().context });
    a.deliver({ rms: 1, type: "rms.theme", brandColour: "#000000" });
    a.deliver({ rms: 1, type: "rms.grant", token: "x".repeat(40) });
    a.deliver("rms.ready");
    a.deliver(null);
    await a.settle();
    expect(a.calls).toHaveLength(0);
    expect(a.posted.length).toBe(before);
  });

  it("a route is one of five names: paths, addresses, prototype names, other spellings and other types call nothing and get no answer", async () => {
    const a = attack();
    a.hello();
    const routes: unknown[] = [
      "admin", "../../agent/v1/runs", "/data/v1/query", "query/../batch", "query?x=1", "query#x", "query ", " query", "QUERY", "Query",
      "http://127.0.0.1:5684/steal", "//evil.example/x", "__proto__", "constructor", "toString", "hasOwnProperty", "valueOf",
      "", null, 0, ["query"], { toString: () => "query" },
    ];
    routes.forEach((route, index) => a.data(`badroute-${String(index).padStart(4, "0")}`, { route }));
    await a.settle();
    expect(a.calls).toHaveLength(0);
    expect(a.posted.filter((p) => p.message.type === "rms.data.result")).toHaveLength(0);
    // Control: each real name goes to its own fixed path and nowhere else.
    Object.keys(DATA_ROUTES).forEach((route, index) => a.data(`goodroute-${String(index).padStart(3, "0")}`, { route }));
    await a.settle();
    expect(a.calls.map((c) => c.path).sort()).toEqual([...FIVE_PATHS].sort());
  });

  it("a message that names a restaurant, a role, a token or an address is dropped whole", async () => {
    const a = attack();
    a.hello();
    const extras: Record<string, unknown>[] = [
      { orgId: "org_0193a3c00000700080000000000000b1" },
      { restaurant: "Other Place" },
      { role: "owner" },
      { env: "live" },
      { token: "x".repeat(40) },
      { authorization: "Bearer x" },
      { headers: { authorization: "Bearer x" } },
      { url: "http://127.0.0.1:5684/" },
      { apiUrl: "http://127.0.0.1:5684/" },
      { path: "/agent/v1/runs" },
      { method: "DELETE" },
      { storePrefix: "o_other" },
    ];
    extras.forEach((extra, index) => a.data(`identity-${String(index).padStart(4, "0")}`, extra));
    // An own "__proto__" key, made the way a page can make one. It survives the browser's copy.
    a.deliver(JSON.parse('{"rms":1,"type":"rms.data","id":"identity-proto","route":"query","body":{},"__proto__":{"route":"batch","polluted":"yes"}}'));
    await a.settle();
    expect(a.calls).toHaveLength(0);
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
    a.data("identity-honest");
    await a.settle();
    expect(a.calls).toHaveLength(1);
  });

  it("whatever the body claims, the call is one fixed path, the grant's own token, and the body as plain data", async () => {
    const a = attack();
    a.hello();
    const body = JSON.parse(
      '{"model":"vendor","orgId":"org_0193a3c00000700080000000000000b1","role":"owner","env":"live","token":"other-token-0123456789abcdef","url":"http://127.0.0.1:5684/","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}',
    ) as unknown;
    a.data("bodyclaims-001", { body });
    await a.settle();
    expect(a.calls).toHaveLength(1);
    // The path and the token come from the shell. Nothing in the body moves either.
    expect(a.calls[0]?.path).toBe(DATA_ROUTES.query);
    expect(a.calls[0]?.token).toBe(RUN_TOKEN);
    // The body is passed on untouched, as text, for the Data API's own strict shapes to refuse.
    expect(JSON.parse(a.calls[0]?.body ?? "null")).toEqual(body);
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});

describe("a hostile frame: piling work on the shell", () => {
  it("a flood while calls hang: four in flight, fifty waiting, every other one refused at once, and nothing is called beyond that", async () => {
    const hold: { release: () => void } = { release: () => undefined };
    const gate = new Promise<void>((resolve) => {
      hold.release = resolve;
    });
    const a = attack({ call: async () => (await gate, { status: 200, body: { rows: [] } }) });
    a.hello();
    const total = 1000;
    for (let i = 0; i < total; i += 1) a.data(`flood-${String(i).padStart(6, "0")}`);
    await a.settle();
    expect(a.calls).toHaveLength(FRAME_LIMITS.maxInFlight);
    const refused = a.posted.filter((p) => p.message.type === "rms.data.result" && p.message.status === 429);
    expect(refused).toHaveLength(total - FRAME_LIMITS.maxInFlight - FRAME_LIMITS.maxQueued);
    hold.release();
    await a.settle();
    await a.settle();
    expect(a.calls).toHaveLength(FRAME_LIMITS.maxInFlight + FRAME_LIMITS.maxQueued);
  });

  it("when the token is refused, a flood cannot make the shell ask for more new grants at once than it has calls in flight", async () => {
    let asking = 0;
    let most = 0;
    const a = attack({
      call: async () => ({ status: 401, body: { error: { code: "unauthenticated", message: "no", requestId: "t" } } }),
      onUnauthenticated: async () => {
        asking += 1;
        most = Math.max(most, asking);
        await new Promise((resolve) => setTimeout(resolve, 5));
        asking -= 1;
        return false;
      },
    });
    a.hello();
    for (let i = 0; i < 200; i += 1) a.data(`renew-${String(i).padStart(6, "0")}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(FRAME_LIMITS.maxInFlight);
  });

  it("an oversized body is refused by the shell and never sent on, however it is padded", async () => {
    const a = attack();
    a.hello();
    a.data("oversized-0001", { body: { pad: "x".repeat(FRAME_LIMITS.maxBodyBytes + 1) } });
    a.data("oversized-0002", { body: { pad: "é".repeat(FRAME_LIMITS.maxBodyBytes / 2 + 10) } }); // short in characters, long in bytes
    a.data("oversized-0003", { body: Array.from({ length: 60_000 }, () => ({ k: "0123456789" })) });
    await a.settle();
    expect(a.calls).toHaveLength(0);
    for (const id of ["oversized-0001", "oversized-0002", "oversized-0003"]) expect(a.answers(id)[0]?.message.status).toBe(400);
  });

  // KNOWN GAP (task J review): frame-host.ts writes the body as JSON with no guard. A body JSON
  // cannot hold makes the shell's message listener throw: an uncaught error on the RMS page and
  // no answer to the frame. Seen in a real browser. Smallest fix: catch it and answer 400.
  it("a body that cannot be written as JSON (a big integer, a loop) is refused cleanly, not thrown", async () => {
    const a = attack();
    a.hello();
    const loop: Record<string, unknown> = { model: "vendor" };
    loop.self = loop;
    expect(() => a.data("unwritable-001", { body: { n: 10n } })).not.toThrow();
    expect(() => a.data("unwritable-002", { body: loop })).not.toThrow();
    await a.settle();
    expect(a.calls).toHaveLength(0);
    expect(a.answers("unwritable-001")[0]?.message.status).toBe(400);
    expect(a.answers("unwritable-002")[0]?.message.status).toBe(400);
  });
});

describe("the token never leaves the shell's memory", () => {
  it("nothing posted to the frame holds the token, even when the Data API's answer echoes it back", async () => {
    const a = attack({ call: async (_path, token) => ({ status: 200, body: { rows: [{ note: `echo ${token}` }], debug: { authorization: `Bearer ${token}` } } }) });
    a.hello();
    a.data("echo-00000001");
    await a.settle();
    expect(a.answers("echo-00000001")).toHaveLength(1);
    expect(JSON.stringify(a.posted)).not.toContain(RUN_TOKEN);
  });

  it("a thrown call never shows its error text to the frame", async () => {
    const a = attack({
      call: async (_path, token) => {
        throw new Error(`connect ECONNREFUSED with Bearer ${token} at http://127.0.0.1:8787/data/v1/query`);
      },
    });
    a.hello();
    a.data("thrown-000001");
    await a.settle();
    const text = JSON.stringify(a.answers("thrown-000001"));
    expect(text).not.toContain(RUN_TOKEN);
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("8787");
  });
});

// ---------------------------------------------------------------- read from the source

const read = (path: string) => readFileSync(repoPath(path), "utf8");
/** The build screen's own code: everything but its tests, the practice stand-in and the recorded sessions. */
const AGENT_FILES = readdirSync(repoPath("apps/web/lib/agent"))
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "mock.ts" && name !== "fixtures.ts")
  .map((name) => `apps/web/lib/agent/${name}`);
const SCREEN_FILES = readdirSync(repoPath("apps/web/components/build")).map((name) => `apps/web/components/build/${name}`);
const BUILD_SCREEN_FILES = [...AGENT_FILES, ...SCREEN_FILES, "packages/ui/src/components/frame.tsx"];
/** Places a token could be kept or shown, and ways server text could become markup or a link. */
const SINKS: [string, RegExp][] = [
  ["browser storage", /\b(localStorage|sessionStorage|indexedDB)\b/],
  ["cookies", /document\.cookie/],
  ["a log line", /\bconsole\.\w+\s*\(/],
  ["markup from text", /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/],
  ["running text as code", /\beval\s*\(|new Function\s*\(/],
  ["a new window", /window\.open\s*\(/],
  ["a message to any origin", /postMessage\([^)]*["'`]\*["'`]\s*\)/],
];

describe("the build screen's own code", () => {
  it("keeps nothing in storage or cookies, logs nothing, and never turns text into markup or code", () => {
    expect(BUILD_SCREEN_FILES.length).toBeGreaterThan(10);
    const hits = BUILD_SCREEN_FILES.flatMap((path) => SINKS.filter(([, pattern]) => pattern.test(read(path))).map(([what]) => `${path}: ${what}`));
    expect(hits).toEqual([]);
    // Control: the same search does find storage where it is really used (the practice stand-in).
    expect(SINKS[0]?.[1].test(read("apps/web/lib/agent/mock.ts"))).toBe(true);
  });

  it("makes no link out of anything the server said: the only addresses are ones the app wrote itself", () => {
    const dynamic = SCREEN_FILES.flatMap((path) => [...read(path).matchAll(/\b(?:href|src|formAction|srcDoc)=\{([^}\n]*)\}/g)].map((m) => ({ path, value: (m[1] ?? "").trim() })));
    // `homeHref` is a prop the app sets itself. The frame's address comes from the grant, checked by `canLoadGrant`.
    const allowed = [/^homeHref$/, /^shown\??\.url( \?\? "")?$/];
    expect(dynamic.length).toBeGreaterThan(0);
    expect(dynamic.filter((d) => !allowed.some((ok) => ok.test(d.value))).map((d) => `${d.path}: ${d.value}`)).toEqual([]);
    expect(SCREEN_FILES.filter((path) => /<a\b|srcDoc|target=/.test(read(path)))).toEqual([]);
  });

  it("nothing a page can set (an address, a query string, storage, a cookie) chooses which build routes are used", () => {
    const source = read("apps/web/lib/agent/api.ts");
    expect(source).toMatch(/realAgentApi/);
    expect(source).not.toMatch(/\b(window|document|location|navigator|searchParams|localStorage|sessionStorage|globalThis)\b/);
    const imports = (path: string) => [...read(path).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    // The real routes and the frame host never load the stand-in, and the frame host never loads sign-in code.
    expect(imports("apps/web/lib/agent/client.ts").filter((from) => /mock|fixtures/.test(from))).toEqual([]);
    expect(imports("apps/web/lib/agent/frame-host.ts").filter((from) => /mock|fixtures|supabase|\/api$/.test(from))).toEqual([]);
  });

  // At the reviewed commit (c624378) this was open: `api.ts` picked the practice stand-in unless a
  // setting said otherwise, on the signed-in screen too. A deploy that forgot the setting would
  // show owners a practice run and frame whatever answered on 127.0.0.1:5673 on their own machine.
  it("the practice stand-in is reachable only under /gallery: the signed-in app's own routes never fall back to it", () => {
    const walk = (dir: string): string[] =>
      readdirSync(repoPath(dir), { withFileTypes: true }).flatMap((entry) =>
        entry.name === "node_modules" || entry.name.startsWith(".") ? [] : entry.isDirectory() ? walk(`${dir}/${entry.name}`) : /\.tsx?$/.test(entry.name) ? [`${dir}/${entry.name}`] : [],
      );
    const users = walk("apps/web").filter((path) => !path.endsWith(".test.ts") && path !== "apps/web/lib/agent/mock.ts" && /from\s+["'][^"']*agent\/mock["']|from\s+["']\.\/mock["']/.test(read(path)));
    expect(users.length).toBeGreaterThan(0); // control: the search does find the gallery's use
    // The one place the signed-in app takes its routes from has no stand-in in it at all.
    expect(users).not.toContain("apps/web/lib/agent/api.ts");
    // Anything outside the gallery pages that loads the stand-in may hand it out for a /gallery address only,
    // and never because of something a page can set.
    const GALLERY_ONLY = /pathname === "\/gallery" \|\| pathname\.startsWith\("\/gallery\/"\) \? practiceAgentApi : /;
    const PAGE_SET = /searchParams|localStorage|sessionStorage|document\.cookie|location\.(search|hash)|process\.env/;
    const loose = users
      .filter((path) => !path.startsWith("apps/web/app/gallery/"))
      .filter((path) => !GALLERY_ONLY.test(read(path)) || PAGE_SET.test(read(path)) || (read(path).match(/practiceAgentApi/g) ?? []).length !== 2);
    expect(loose).toEqual([]);
  });

  it("the frame element: scripts, its own storage and forms only. No top navigation, pop-ups, downloads or devices", () => {
    const allowed = new Set(["allow-scripts", "allow-same-origin", "allow-forms"]);
    const tokens = FRAME_ATTRIBUTES.sandbox.split(/\s+/).filter(Boolean);
    expect(tokens.filter((t) => !allowed.has(t))).toEqual([]);
    expect(FRAME_ATTRIBUTES.referrerPolicy).toBe("no-referrer");
    expect(FRAME_ATTRIBUTES.allow).toBe("");
    const frame = read("packages/ui/src/components/frame.tsx");
    expect(frame).toContain(`FRAME_SANDBOX = "${FRAME_ATTRIBUTES.sandbox}"`);
    expect(frame).toContain(`FRAME_REFERRER_POLICY = "${FRAME_ATTRIBUTES.referrerPolicy}"`);
    expect(frame).toMatch(/sandbox=\{FRAME_SANDBOX\}/);
    expect(frame).toMatch(/referrerPolicy=\{FRAME_REFERRER_POLICY\}/);
    expect(frame).toMatch(/allow=\{FRAME_ALLOW\}/);
    // Every iframe in the web app and the UI library is this one.
    const elsewhere = [...BUILD_SCREEN_FILES, "apps/web/components/build-home.tsx"].filter((path) => path !== "packages/ui/src/components/frame.tsx" && /<iframe\b/.test(read(path)));
    expect(elsewhere).toEqual([]);
  });

  // KNOWN GAP (task J review, also in the author's notes): the web app sends no `frame-src`. A
  // mini-app that navigates its own frame to any other site stays on screen inside RMS's
  // "Preview" pane (seen in a real browser), with forms allowed: a place to imitate a sign-in.
  // It gets no token and no data. Smallest fix: `frame-src` listing the preview and apps hosts.
  it("the web app's content policy names the only sites it will show in a frame", () => {
    expect(read("apps/web/next.config.ts")).toMatch(/frame-src\s+[^;'"]+/);
  });
});
