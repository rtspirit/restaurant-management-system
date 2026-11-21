// The preview's rules, driven the way the screen drives them: what the conversation says goes
// in through `update`, the frame element through `attach`, and frame messages through `window`.
import type { PreviewGrant } from "@rms/contracts";
import { describe, expect, it, vi } from "vitest";
import { AgentApiError, type DataCall } from "./client";
import { createPreview, type PreviewInput } from "./preview";

const SHELL = "http://localhost:3000";
const FRAME = "http://127.0.0.1:5673";

const grant = (n: number, over: Partial<PreviewGrant> = {}): PreviewGrant => ({
  kind: "preview",
  appId: "app_0193a3c000007000800000000000006a",
  appName: "Suppliers",
  url: `${FRAME}/`,
  frameOrigin: FRAME,
  token: `run-token-number-${n}-0123456789abcdef`,
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  runId: "run_0193a3c0000070008000000000000061",
  context: {
    app: { id: "app_0193a3c000007000800000000000006a", name: "Suppliers" },
    env: "draft",
    user: { name: "Asha Verma", role: "owner" },
    restaurant: { name: "Marigold Kitchen", brandColour: null },
    locations: [],
    currency: "USD",
    locale: "en-US",
  },
  ...over,
});

type Listener = (event: { origin: string; source: unknown; data: unknown }) => void;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const alive = (version: number, runCount: number): PreviewInput => ({ version, runCount, run: "alive", settled: true });

function setup(options: { data?: DataCall; grants?: (n: number) => PreviewGrant | Promise<PreviewGrant> } = {}) {
  const listeners = new Set<Listener>();
  const asked: number[] = [];
  const calls: { token: string; body: string }[] = [];
  const preview = vi.fn(async () => {
    asked.push(asked.length + 1);
    return (options.grants ?? grant)(asked.length);
  });
  const data: DataCall = async (path, token, body, signal) => {
    calls.push({ token, body });
    return options.data ? options.data(path, token, body, signal) : { status: 200, body: { rows: [] } };
  };
  const controller = createPreview({
    api: { preview, data },
    sessionId: "ses_0193a3c0000070008000000000000060",
    shellOrigin: SHELL,
    messages: { addEventListener: (_type, listener) => listeners.add(listener), removeEventListener: (_type, listener) => listeners.delete(listener) },
  });
  /** A frame element as the page would make it for the current mount, already attached. */
  const frame = () => {
    const posted: unknown[] = [];
    const contentWindow = { postMessage: (message: unknown) => posted.push(message) };
    const element = { contentWindow };
    const detach = controller.attach(element);
    const deliver = (message: unknown) => {
      for (const listener of [...listeners]) listener({ origin: FRAME, source: contentWindow, data: message });
    };
    return { posted, detach, hello: () => deliver({ rms: 1, type: "rms.ready" }), ask: (id: string) => deliver({ rms: 1, type: "rms.data", id, route: "query", body: {} }) };
  };
  return { controller, preview, calls, frame, listeners };
}

/** From nothing to a frame that has said hello. */
async function showing(t: ReturnType<typeof setup>, version = 1, runCount = 4) {
  t.controller.update(alive(version, runCount));
  await tick();
  const f = t.frame();
  f.hello();
  expect(t.controller.getSnapshot().phase).toBe("ready");
  return f;
}

describe("when the preview is asked for", () => {
  it("nothing is asked until the stored conversation has been replayed", async () => {
    const t = setup();
    t.controller.update({ version: 1, runCount: 4, run: "alive", settled: false });
    await tick();
    expect(t.preview).not.toHaveBeenCalled();
    expect(t.controller.getSnapshot()).toEqual({ phase: "none", shown: null });
  });

  it("a built preview is asked for once, shown in a fresh frame, and ready when the frame says hello", async () => {
    const t = setup();
    t.controller.update(alive(1, 4));
    expect(t.controller.getSnapshot().phase).toBe("asking");
    await tick();
    expect(t.controller.getSnapshot()).toEqual({ phase: "loading", shown: { url: `${FRAME}/`, mount: 1 } });
    // The same news again (a re-render) asks for nothing more.
    t.controller.update(alive(1, 4));
    await tick();
    expect(t.preview).toHaveBeenCalledTimes(1);
    const f = t.frame();
    f.hello();
    expect(t.controller.getSnapshot().phase).toBe("ready");
    expect(f.posted[0]).toMatchObject({ type: "rms.init", context: { restaurant: { name: "Marigold Kitchen" } } });
  });

  it("the token is never in what the screen is given to draw", async () => {
    const t = setup();
    await showing(t);
    expect(JSON.stringify(t.controller.getSnapshot())).not.toMatch(/run-token/);
  });

  it("a rebuilt preview (preview.ready again) gets a fresh frame, and the old one answers nothing", async () => {
    const t = setup();
    const first = await showing(t);
    t.controller.update(alive(2, 5));
    await tick();
    expect(t.controller.getSnapshot()).toEqual({ phase: "loading", shown: { url: `${FRAME}/`, mount: 2 } });
    first.detach();
    first.posted.length = 0;
    first.hello();
    first.ask("aaaaaaaa0001");
    await tick();
    expect(first.posted).toEqual([]);
    const second = t.frame();
    second.hello();
    second.ask("aaaaaaaa0002");
    await tick();
    expect(t.calls.at(-1)?.token).toBe(grant(2).token);
  });
});

describe("a new run under a preview that is showing", () => {
  it("run.done then run.started, arriving separately, does not reload the frame: the token is swapped under it", async () => {
    const t = setup();
    const f = await showing(t, 1, 4);
    const before = t.controller.getSnapshot();

    // The owner sent the next thing: the waiting run is closed first...
    t.controller.update({ version: 1, runCount: 4, run: "between", settled: true });
    await tick();
    expect(t.controller.getSnapshot()).toBe(before);
    expect(t.preview).toHaveBeenCalledTimes(1);

    // ...and the new run starts in the next piece.
    t.controller.update(alive(1, 5));
    await tick();
    expect(t.preview).toHaveBeenCalledTimes(2);
    expect(t.controller.getSnapshot()).toEqual(before); // same frame, same mount, still ready
    f.ask("aaaaaaaa0001");
    await tick();
    expect(t.calls.at(-1)?.token).toBe(grant(2).token);
    expect(f.posted.at(-1)).toMatchObject({ type: "rms.data.result", id: "aaaaaaaa0001", status: 200 });
  });

  it("a run that failed or was stopped takes its preview with it", async () => {
    const t = setup();
    const f = await showing(t);
    t.controller.update({ version: 1, runCount: 4, run: "ended", settled: true });
    expect(t.controller.getSnapshot()).toEqual({ phase: "unavailable", shown: null });
    f.posted.length = 0;
    f.ask("aaaaaaaa0001");
    await tick();
    expect(f.posted).toEqual([]);
    expect(t.listeners.size).toBe(0);
  });

  it("a session opened after it was closed has no run to ask, and says the preview is resting", async () => {
    const t = setup();
    t.controller.update({ version: 1, runCount: 4, run: "between", settled: true });
    await tick();
    expect(t.preview).not.toHaveBeenCalled();
    expect(t.controller.getSnapshot()).toEqual({ phase: "unavailable", shown: null });
  });
});

describe("a refused token", () => {
  it("four calls refused at the same moment share ONE new grant, and every one of them is tried again", async () => {
    const t = setup({
      data: async (_path, token) =>
        token === grant(1).token ? { status: 401, body: { error: { code: "unauthenticated", message: "Please open this again from RMS.", requestId: "r" } } } : { status: 200, body: { rows: [] } },
    });
    const f = await showing(t);
    f.posted.length = 0;
    for (const id of ["aaaaaaaa0001", "aaaaaaaa0002", "aaaaaaaa0003", "aaaaaaaa0004"]) f.ask(id);
    await tick();
    await tick();
    expect(t.preview).toHaveBeenCalledTimes(2); // the first grant, and one refresh for all four
    expect(t.calls.filter((c) => c.token === grant(1).token)).toHaveLength(4);
    expect(t.calls.filter((c) => c.token === grant(2).token)).toHaveLength(4);
    expect(f.posted).toHaveLength(4);
    for (const message of f.posted) expect(message).toMatchObject({ type: "rms.data.result", status: 200 });
    expect(t.controller.getSnapshot().shown?.mount).toBe(1); // and the frame was not reloaded
  });

  it("when no new grant can be had, each call gets the refusal back and the frame stays", async () => {
    let n = 0;
    const t = setup({
      grants: (count) => {
        n = count;
        if (count > 1) throw new AgentApiError("unavailable", "The preview is not running just now.");
        return grant(count);
      },
      data: async () => ({ status: 401, body: { error: { code: "unauthenticated", message: "Please open this again from RMS.", requestId: "r" } } }),
    });
    const f = await showing(t);
    f.posted.length = 0;
    f.ask("aaaaaaaa0001");
    f.ask("aaaaaaaa0002");
    await tick();
    await tick();
    expect(n).toBe(2);
    expect(f.posted).toHaveLength(2);
    for (const message of f.posted) expect(message).toMatchObject({ status: 401 });
    expect(t.controller.getSnapshot().phase).toBe("ready");
  });
});

describe("a preview that cannot be shown", () => {
  it("a grant for a frame on localhost is never loaded", async () => {
    const t = setup({ grants: (n) => ({ ...grant(n), url: "http://localhost:5173/", frameOrigin: "http://localhost:5173" }) });
    t.controller.update(alive(1, 4));
    await tick();
    expect(t.controller.getSnapshot()).toEqual({ phase: "blocked", shown: null });
    expect(t.listeners.size).toBe(0);
  });

  it("when RMS will not hand one out, the screen says the preview is resting, and Try again asks once more", async () => {
    let refuse = true;
    const t = setup({
      grants: (n) => {
        if (refuse) throw new AgentApiError("unavailable", "The preview is not running just now.");
        return grant(n);
      },
    });
    t.controller.update(alive(1, 4));
    await tick();
    expect(t.controller.getSnapshot()).toEqual({ phase: "unavailable", shown: null });
    refuse = false;
    t.controller.again();
    await tick();
    expect(t.controller.getSnapshot().phase).toBe("loading");
  });

  it("torn down and set up again (as a screen is in development), it comes back by itself", async () => {
    const t = setup();
    await showing(t);
    t.controller.dispose();
    expect(t.controller.getSnapshot()).toEqual({ phase: "none", shown: null });
    expect(t.listeners.size).toBe(0);
    t.controller.update(alive(1, 4));
    await tick();
    expect(t.controller.getSnapshot()).toEqual({ phase: "loading", shown: { url: `${FRAME}/`, mount: 2 } });
  });

  it("an answer that arrives after it was torn down changes nothing", async () => {
    let release: (g: PreviewGrant) => void = () => undefined;
    const t = setup({ grants: () => new Promise<PreviewGrant>((resolve) => (release = resolve)) });
    t.controller.update(alive(1, 4));
    t.controller.dispose();
    release(grant(1));
    await tick();
    expect(t.controller.getSnapshot()).toEqual({ phase: "none", shown: null });
  });
});
