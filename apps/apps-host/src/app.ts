// The apps host: hands out the built files of PUBLISHED mini-apps, and nothing else.
// Task N owns this app. Brief: docs/briefs/wave3.md, task N. Contract: publish.ts in @rms/contracts.
//
// It runs on its own origin, away from the RMS web app and the API, so a mini-app's files never
// share an origin, or a cookie, with RMS. What must hold, every one with a test:
//   - GET and HEAD only. No request body is read. No cookie is read or set. No query is used.
//   - an address is /a/<app id>/<version id>/<path> and nothing else (`parseAppsHostPath`)
//   - the file is found by (mini-app, version, path). No storage key comes from the address
//   - nothing is served unless that version is the mini-app's published version right now
//   - every answer, a refusal included, carries the content policy and the fixed headers:
//     the mini-app may call nothing on the network and may be framed only by the RMS web app
//   - the content type comes from the path's ending, from a fixed list
import { type AppId, type AppVersionId, APPS_HOST_HEADERS, appsHostPolicy, parseAppsHostPath } from "@rms/contracts";
import { Hono } from "hono";

export type ServedFile = { bytes: Uint8Array; contentType: string; sha256: string; size: number };

export type AppsHostOptions = {
  /** Finds one built file of a published version, or null. In production: `readPublishedScreen` from @rms/db. */
  read: (appId: AppId, versionId: AppVersionId, path: string) => Promise<ServedFile | null>;
  /** The RMS web app's origin or origins, read from settings on every request (`exactOrigins(WEB_URL)`). */
  shellOrigins: () => readonly string[];
};

const plain = (status: number, text: string, headers: Record<string, string>): Response =>
  new Response(text, { status, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });

export const createAppsHost = (opts: AppsHostOptions): Hono => {
  const app = new Hono();
  const fixed = (): Record<string, string> => ({ ...APPS_HOST_HEADERS, "content-security-policy": appsHostPolicy(opts.shellOrigins()) });

  app.get("/health", () => plain(200, "ok", fixed()));

  app.all("*", async (c) => {
    const headers = fixed();
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") return plain(405, "Not allowed.", { ...headers, allow: "GET, HEAD" });

    // The raw path, exactly as it was sent. Anything encoded, doubled or climbing is "not found".
    const target = parseAppsHostPath(new URL(c.req.url).pathname);
    if (!target) return plain(404, "Not found.", headers);

    let file: ServedFile | null;
    try {
      file = await opts.read(target.appId, target.versionId, target.path);
    } catch {
      // The reason goes nowhere near the answer.
      console.error(JSON.stringify({ at: "apps-host", error: "read failed" }));
      return plain(503, "This is not available just now.", headers);
    }
    if (!file) return plain(404, "Not found.", headers);

    const answer = { ...headers, "content-type": file.contentType, "content-length": String(file.size), etag: `"${file.sha256}"` };
    if (method === "HEAD") return new Response(null, { status: 200, headers: answer });
    return new Response(file.bytes as unknown as BodyInit, { status: 200, headers: answer });
  });

  return app;
};
