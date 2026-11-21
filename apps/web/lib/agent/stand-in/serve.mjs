// Serves the stand-in mini-app frame on 127.0.0.1, for trying the build screen's preview before
// the real app template (Wave 2, task H) is merged. Local only. Not part of the web app.
//
//   node apps/web/lib/agent/stand-in/serve.mjs
//
// RMS_SHELL_ORIGIN   the one origin allowed to frame it and talk to it (default http://localhost:3000)
// RMS_STAND_IN_PORT  the port (default 5673). Never 5173: that is the real template's.
//
// Like the real template's dev server, the policy is a response HEADER: only the shell may
// frame it, and it may not call the network at all (connect-src 'none'). It is served from
// 127.0.0.1 and never from localhost, so it shares no cookies with the web app.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ui = join(here, "..", "..", "..", "..", "..", "packages", "ui");
const font = join(ui, "node_modules", "@fontsource-variable", "nunito-sans");
const shell = process.env.RMS_SHELL_ORIGIN ?? "http://localhost:3000";
const port = Number(process.env.RMS_STAND_IN_PORT ?? 5673);

if (!/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(shell)) throw new Error("RMS_SHELL_ORIGIN must be an origin, like http://localhost:3000");
if (port === 5173) throw new Error("Port 5173 belongs to the real app template");

const policy = `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-ancestors ${shell}`;
const withoutImports = (css) => css.split("\n").filter((line) => !line.startsWith("@import")).join("\n");

async function stylesheet() {
  const [faces, tokens, styles] = await Promise.all([
    readFile(join(font, "index.css"), "utf8"),
    readFile(join(ui, "src", "tokens.css"), "utf8"),
    readFile(join(ui, "src", "styles.css"), "utf8"),
  ]);
  return [faces.split("url(./files/").join("url(/files/"), tokens, withoutImports(styles)].join("\n");
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const send = (status, type, body) => {
    response.writeHead(status, { "content-type": type, "content-security-policy": policy, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    response.end(body);
  };
  try {
    if (request.method !== "GET") return send(405, "text/plain", "Not allowed");
    if (path === "/") {
      const page = await readFile(join(here, "frame.html"), "utf8");
      return send(200, "text/html; charset=utf-8", page.split("__RMS_SHELL_ORIGIN__").join(shell));
    }
    if (path === "/ui.css") return send(200, "text/css; charset=utf-8", await stylesheet());
    const file = /^\/files\/([a-z0-9-]+\.woff2)$/.exec(path);
    if (file) return send(200, "font/woff2", await readFile(join(font, "files", file[1])));
    return send(404, "text/plain", "Not found");
  } catch {
    return send(500, "text/plain", "Something went wrong");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Stand-in mini-app frame on http://127.0.0.1:${port}/ for a shell at ${shell}`);
});
