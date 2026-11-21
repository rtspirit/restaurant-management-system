import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FRAME_LIMITS, type FrameContext } from "@rms/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RmsDataError } from "./client";
import { type Connection, type FrameWindow, connect } from "./frame";
import { addDays, formatMoney, formatPercent, fromInput, moneyToMinor, showValue, toInput } from "./format";

const SHELL = "http://localhost:3000";
const ID = /^[A-Za-z0-9_-]{8,64}$/;

const context: FrameContext = {
  app: { id: "app_0193a3c0000070008000000000000070", name: "Vendors" },
  env: "draft",
  user: { name: "Mara Quinn", role: "owner" },
  restaurant: { name: "Marigold", brandColour: "#b4532a" },
  locations: [],
  currency: "USD",
  locale: "en-US",
};

type Posted = { message: Record<string, unknown>; origin: string };

const fakeWindow = () => {
  const listeners = new Set<(event: MessageEvent) => void>();
  const posted: Posted[] = [];
  const parent = { postMessage: (message: unknown, origin: string) => void posted.push({ message: message as Record<string, unknown>, origin }) };
  const win: FrameWindow = {
    parent,
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
    setTimeout: (h, ms) => setTimeout(h, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const deliver = (data: unknown, origin = SHELL, source: unknown = parent) => {
    for (const l of [...listeners]) l({ data, origin, source } as unknown as MessageEvent);
  };
  return { win, parent, posted, deliver, listeners };
};

const init = { rms: 1, type: "rms.init", context };

const connected = async (): Promise<{ conn: Extract<Connection, { connected: true }>; w: ReturnType<typeof fakeWindow> }> => {
  const w = fakeWindow();
  const p = connect({ shellOrigin: SHELL, window: w.win });
  w.deliver(init);
  const conn = await p;
  if (!conn.connected) throw new Error("expected a connection");
  return { conn, w };
};

const dataMessages = (w: ReturnType<typeof fakeWindow>) => w.posted.filter((p) => p.message.type === "rms.data");

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("connect", () => {
  it("is not connected outside a frame, and sends nothing", async () => {
    const w = fakeWindow();
    const self = { ...w.win } as FrameWindow & { parent: unknown };
    (self as { parent: unknown }).parent = self;
    expect(await connect({ shellOrigin: SHELL, window: self })).toEqual({ connected: false, reason: "not_framed" });
    expect(w.posted).toEqual([]);
  });

  it.each([undefined, "", "*", "null", "http://example.com", "https://rms.example/path", "https://rms.example/", "javascript:alert(1)"])(
    "is not connected with no valid shell origin (%s), and sends nothing",
    async (shellOrigin) => {
      const w = fakeWindow();
      expect(await connect({ shellOrigin, window: w.win })).toEqual({ connected: false, reason: "no_shell_origin" });
      expect(w.posted).toEqual([]);
    },
  );

  it("announces rms.ready to the exact shell origin, never *, and gives up after the retries", async () => {
    const w = fakeWindow();
    const p = connect({ shellOrigin: SHELL, window: w.win });
    await vi.advanceTimersByTimeAsync(FRAME_LIMITS.readyEveryMs * (FRAME_LIMITS.readyRetries + 2));
    expect(await p).toEqual({ connected: false, reason: "no_answer" });
    expect(w.posted).toHaveLength(FRAME_LIMITS.readyRetries);
    for (const p of w.posted) {
      expect(p.origin).toBe(SHELL);
      expect(p.message).toEqual({ rms: 1, type: "rms.ready" });
    }
    expect(w.listeners.size).toBe(0);
  });

  it("connects on rms.init from the parent at the shell origin, and stops announcing", async () => {
    const { conn, w } = await connected();
    expect(conn.context).toEqual(context);
    const before = w.posted.length;
    await vi.advanceTimersByTimeAsync(FRAME_LIMITS.readyEveryMs * 5);
    expect(w.posted.length).toBe(before);
  });

  const dropped: Array<[string, unknown, string?, "other"?]> = [
    ["from another origin", init, "http://127.0.0.1:3000"],
    ["from a look-alike origin", init, "http://localhost:30000"],
    ["from another window", init, SHELL, "other"],
    ["with an extra key", { ...init, token: "x".repeat(30) }],
    ["with an extra key in the context", { ...init, context: { ...context, org: "org_1" } }],
    ["of an unknown type", { rms: 1, type: "rms.hello", context }],
    ["of another protocol", { ...init, rms: 2 }],
    ["that is a string", JSON.stringify(init)],
    ["that is a data result before rms.init", { rms: 1, type: "rms.data.result", id: "abcdefgh", status: 200, body: {} }],
    ["that is a theme before rms.init", { rms: 1, type: "rms.theme", brandColour: "#000000" }],
  ];

  it.each(dropped)("drops a message %s", async (_name, data, origin = SHELL, source) => {
    const w = fakeWindow();
    const p = connect({ shellOrigin: SHELL, window: w.win });
    w.deliver(data, origin, source === "other" ? {} : w.parent);
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(FRAME_LIMITS.readyEveryMs * 2);
    expect(settled).toBe(false);
    // Still waiting: the real init still works.
    w.deliver(init);
    expect((await p).connected).toBe(true);
  });

  it("drops messages with no source", async () => {
    const w = fakeWindow();
    const p = connect({ shellOrigin: SHELL, window: w.win });
    w.deliver(init, SHELL, null);
    await vi.advanceTimersByTimeAsync(FRAME_LIMITS.readyEveryMs * (FRAME_LIMITS.readyRetries + 2));
    expect((await p).connected).toBe(false);
  });

  it("passes theme changes on, and only from the shell", async () => {
    const { conn, w } = await connected();
    const seen: Array<string | null> = [];
    conn.onTheme((c) => seen.push(c));
    w.deliver({ rms: 1, type: "rms.theme", brandColour: "#112233" });
    w.deliver({ rms: 1, type: "rms.theme", brandColour: "#445566" }, "https://evil.example");
    w.deliver({ rms: 1, type: "rms.theme", brandColour: "red" });
    w.deliver({ rms: 1, type: "rms.theme", brandColour: null });
    expect(seen).toEqual(["#112233", null]);
  });
});

describe("the data client", () => {
  it("posts one rms.data naming the route, with a fresh id, to the shell origin only", async () => {
    const { conn, w } = await connected();
    const p = conn.client.query({ model: "vendor" });
    const [sent] = dataMessages(w);
    expect(sent?.origin).toBe(SHELL);
    expect(sent?.message).toMatchObject({ rms: 1, type: "rms.data", route: "query", body: { model: "vendor", limit: 50 } });
    expect(String(sent?.message.id)).toMatch(ID);
    expect(Object.keys(sent?.message ?? {}).sort()).toEqual(["body", "id", "rms", "route", "type"]);
    w.deliver({ rms: 1, type: "rms.data.result", id: sent?.message.id, status: 200, body: { rows: [{ id: "a", name: "Hill Farm" }], nextCursor: null } });
    const result = await p;
    expect(result.rows).toEqual([{ id: "a", name: "Hill Farm" }]);
    expect(result.masked).toEqual([]);
    conn.client.catalog().catch(() => undefined);
    const ids = dataMessages(w).map((d) => d.message.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names each of the five routes and nothing else", async () => {
    const { conn, w } = await connected();
    void conn.client.query({ model: "vendor" }).catch(() => undefined);
    void conn.client.batch({ ops: [{ op: "delete", model: "vendor", id: "0193a3c0-0000-7000-8000-000000000070" }] }).catch(() => undefined);
    void conn.client.named({ query: "weekly_pnl" }).catch(() => undefined);
    void conn.client.action({ action: "close_week" }).catch(() => undefined);
    await Promise.resolve();
    void conn.client.catalog().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(dataMessages(w).map((d) => d.message.route).sort()).toEqual(["action", "batch", "named", "query"]);
    conn.close();
  });

  it("turns a Data API refusal into an RmsDataError with its plain message", async () => {
    const { conn, w } = await connected();
    const p = conn.client.query({ model: "vendor" });
    const id = dataMessages(w)[0]?.message.id;
    w.deliver({ rms: 1, type: "rms.data.result", id, status: 403, body: { error: { code: "forbidden_model", message: "This mini-app cannot read that.", requestId: "req_1" } } });
    await expect(p).rejects.toMatchObject({ name: "RmsDataError", code: "forbidden_model", message: "This mini-app cannot read that.", status: 403 });
  });

  it("drops a result from another origin, another window, or with an extra key, then times out", async () => {
    const { conn, w } = await connected();
    const p = conn.client.query({ model: "vendor" });
    const caught = p.catch((e: unknown) => e);
    const id = dataMessages(w)[0]?.message.id;
    const ok = { rms: 1, type: "rms.data.result", id, status: 200, body: { rows: [], nextCursor: null } };
    w.deliver(ok, "https://evil.example");
    w.deliver(ok, SHELL, {});
    w.deliver({ ...ok, token: "t".repeat(30) });
    w.deliver({ ...ok, id: "someoneelse" });
    await vi.advanceTimersByTimeAsync(FRAME_LIMITS.requestTimeoutMs + 1);
    const error = await caught;
    expect(error).toBeInstanceOf(RmsDataError);
    expect((error as RmsDataError).code).toBe("timeout");
    // A late answer after the timeout changes nothing.
    w.deliver(ok);
    expect(conn.client.load).toEqual({ inFlight: 0, queued: 0 });
  });

  it("keeps at most maxInFlight requests out and queues the rest", async () => {
    const { conn, w } = await connected();
    const calls = Array.from({ length: FRAME_LIMITS.maxInFlight + 2 }, () => conn.client.query({ model: "vendor" }).catch(() => undefined));
    expect(dataMessages(w)).toHaveLength(FRAME_LIMITS.maxInFlight);
    expect(conn.client.load).toEqual({ inFlight: FRAME_LIMITS.maxInFlight, queued: 2 });
    const first = dataMessages(w)[0]?.message.id;
    w.deliver({ rms: 1, type: "rms.data.result", id: first, status: 200, body: { rows: [], nextCursor: null } });
    expect(dataMessages(w)).toHaveLength(FRAME_LIMITS.maxInFlight + 1);
    conn.close();
    await Promise.all(calls);
  });

  it("refuses more than maxQueued waiting requests", async () => {
    const { conn } = await connected();
    const calls = Array.from({ length: FRAME_LIMITS.maxInFlight + FRAME_LIMITS.maxQueued }, () => conn.client.query({ model: "vendor" }).catch(() => undefined));
    await expect(conn.client.query({ model: "vendor" })).rejects.toMatchObject({ code: "limit" });
    conn.close();
    await Promise.all(calls);
  });

  it("refuses a body over maxBodyBytes before sending it", async () => {
    const { conn, w } = await connected();
    const big = "x".repeat(1_900);
    const ops = Array.from({ length: 300 }, () => ({ op: "insert" as const, model: "vendor", values: { notes: big } }));
    await expect(conn.client.batch({ ops })).rejects.toMatchObject({ code: "invalid_request" });
    expect(dataMessages(w)).toHaveLength(0);
  });

  it("refuses a request that does not parse before sending it", async () => {
    const { conn, w } = await connected();
    await expect(conn.client.query({ model: "vendor; drop table x" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(conn.client.query({ model: "vendor", org: "org_x" } as never)).rejects.toMatchObject({ code: "invalid_request" });
    expect(dataMessages(w)).toHaveLength(0);
  });
});

describe("the SDK's own source", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."));
  const banned = [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /postMessage\([^)]*["'`]\*["'`]/, /import\.meta\.env/];
  it.each(files)("%s uses no network, storage or cookies", (file) => {
    const code = readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
      .join("\n");
    for (const pattern of banned) expect(code, String(pattern)).not.toMatch(pattern);
  });
});

describe("formatting", () => {
  it("shows minor units as currency and reads them back", () => {
    expect(formatMoney(128450, "USD", "en-US")).toBe("$1,284.50");
    expect(formatMoney(null, "USD", "en-US")).toBe("");
    expect(moneyToMinor("$1,284.50")).toBe(128450);
    expect(moneyToMinor("twelve")).toBeNull();
    expect(formatPercent("61.3", "en-US")).toBe("61.3%");
  });

  const place = { currency: "USD", locale: "en-US" };

  it("shows fields by type, refs by their label and never a raw id", () => {
    const row = { name: "Hill Farm", account: "0193a3c0-0000-7000-8000-000000000070", account_label: "Food cost", loc: { id: "x", label: "Main Street" }, status: "all_locations", active: false, total: 1250, due: "2026-11-09" };
    expect(showValue(row, "name", "text", place)).toBe("Hill Farm");
    expect(showValue(row, "account", "ref", place)).toBe("Food cost");
    expect(showValue({ account: "0193a3c0-0000-7000-8000-000000000070" }, "account", "ref", place)).toBe("");
    expect(showValue(row, "loc", "parent_ref", place)).toBe("Main Street");
    expect(showValue(row, "status", "enum", place)).toBe("All locations");
    expect(showValue(row, "active", "boolean", place)).toBe("No");
    expect(showValue(row, "total", "money", place)).toBe("$12.50");
    expect(showValue(row, "due", "date", place)).toBe("Mon, Nov 9, 2026");
  });

  it("reads form text into Data API values, with plain words when it cannot", () => {
    expect(fromInput("12.50", "money", place)).toEqual({ ok: true, value: 1250 });
    expect(fromInput("", "money", place)).toEqual({ ok: true, value: null });
    expect(fromInput("ten", "integer", place)).toEqual({ ok: false, message: "Type a whole number." });
    expect(fromInput("1,000", "integer", place)).toEqual({ ok: true, value: 1000 });
    expect(fromInput("2.5", "decimal", place)).toEqual({ ok: true, value: "2.5" });
    expect(fromInput("true", "boolean", place)).toEqual({ ok: true, value: true });
    expect(fromInput("9 Nov", "date", place)).toMatchObject({ ok: false });
    expect(toInput(1250, "money", place)).toBe("12.50");
    expect(toInput({ id: "abc", label: "x" }, "parent_ref", place)).toBe("abc");
    expect(addDays("2026-11-09", 7)).toBe("2026-11-16");
  });
});
