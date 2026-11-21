// A one-file page that plays the RMS shell for tests (task J builds the real one).
//
// It holds the frame with exactly FRAME_ATTRIBUTES, answers `rms.ready` with `rms.init`, and
// answers `rms.data` from a small in-memory store, following the same origin rules as the
// real shell: only messages from the frame's own window and the frame's origin, and replies
// only to that origin. Every message it acts on is kept in `window.__seen` for the test.
import { FRAME_ATTRIBUTES, FRAME_PROTOCOL, type FrameContext } from "@rms/contracts";

export type ShellPageOptions = {
  frameUrl: string;
  frameOrigin: string;
  context: FrameContext;
  /** Rows per model key, as the Data API would return them. */
  rows?: Record<string, Array<Record<string, unknown>>>;
  /** Catalog answer for the `catalog` route. */
  catalog?: unknown;
  /** Named query answers by key. */
  named?: Record<string, { columns: Array<{ key: string; label: string; type: string }>; rows: Array<Record<string, unknown>> }>;
  /** When true the shell never answers `rms.ready`. */
  silent?: boolean;
  width?: string;
  height?: string;
};

const json = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

export const shellPage = (o: ShellPageOptions): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>Test shell</title>
<style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:${o.width ?? "100%"};height:${o.height ?? "100vh"};display:block}</style>
</head><body>
<iframe id="app" title="Mini-app preview" src="${o.frameUrl}" sandbox="${FRAME_ATTRIBUTES.sandbox}" referrerpolicy="${FRAME_ATTRIBUTES.referrerPolicy}" allow="${FRAME_ATTRIBUTES.allow}"></iframe>
<script>
const FRAME_ORIGIN = ${json(o.frameOrigin)};
const CONTEXT = ${json(o.context)};
const store = ${json(o.rows ?? {})};
const CATALOG = ${json(o.catalog ?? { models: [], namedQueries: [], actions: [] })};
const NAMED = ${json(o.named ?? {})};
const SILENT = ${o.silent ? "true" : "false"};
const frame = document.getElementById("app");
window.__seen = [];
let n = 0;
const send = (msg) => frame.contentWindow.postMessage(Object.assign({ rms: ${FRAME_PROTOCOL} }, msg), FRAME_ORIGIN);
const answer = (route, body) => {
  if (route === "catalog") return [200, CATALOG];
  if (route === "named") {
    const q = NAMED[body.query];
    return q ? [200, { columns: q.columns, rows: q.rows, masked: [] }] : [403, { error: { code: "forbidden_model", message: "This mini-app cannot read that.", requestId: "req_test" } }];
  }
  if (route === "query") {
    const rows = (store[body.model] || []).filter((r) => !r.deleted_at);
    return [200, { rows, nextCursor: null, masked: [] }];
  }
  if (route === "batch") {
    const results = [];
    for (const op of body.ops) {
      const list = (store[op.model] = store[op.model] || []);
      if (op.op === "insert") {
        const id = op.id || ("0193a3c0-0000-7000-8000-0000000072" + (n++ % 256).toString(16).padStart(2, "0"));
        list.push(Object.assign({ id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, op.values));
        results.push({ op: "insert", model: op.model, id });
      } else if (op.op === "update") {
        const row = list.find((r) => r.id === op.id);
        if (!row) return [404, { error: { code: "not_found", message: "That record is gone.", requestId: "req_test" } }];
        Object.assign(row, op.values, { updated_at: new Date().toISOString() });
        results.push({ op: "update", model: op.model, id: op.id });
      } else if (op.op === "delete") {
        const i = list.findIndex((r) => r.id === op.id);
        if (i >= 0) list.splice(i, 1);
        results.push({ op: "delete", model: op.model, id: op.id });
      }
    }
    return [200, { results }];
  }
  return [400, { error: { code: "invalid_request", message: "That request was not understood.", requestId: "req_test" } }];
};
window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow || event.origin !== FRAME_ORIGIN) return;
  const m = event.data;
  if (!m || m.rms !== ${FRAME_PROTOCOL}) return;
  window.__seen.push(m);
  if (m.type === "rms.ready") { if (!SILENT) send({ type: "rms.init", context: CONTEXT }); return; }
  if (m.type === "rms.data") {
    const [status, body] = answer(m.route, m.body);
    send({ type: "rms.data.result", id: m.id, status, body });
  }
});
window.__theme = (brandColour) => send({ type: "rms.theme", brandColour });
</script>
</body></html>`;

export const testContext = (over: Partial<FrameContext> = {}): FrameContext => ({
  app: { id: "app_0193a3c0000070008000000000000070", name: "Vendors" },
  env: "draft",
  user: { name: "Mara Quinn", role: "owner" },
  restaurant: { name: "Marigold", brandColour: "#b4532a" },
  locations: [{ id: "0193a3c0-0000-7000-8000-000000000071", name: "Marigold Main Street" }],
  currency: "USD",
  locale: "en-US",
  ...over,
});
