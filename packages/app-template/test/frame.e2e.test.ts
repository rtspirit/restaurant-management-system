// Step 1 of task H: the template's dev server shows inside a cross-origin frame of the shell,
// with its styles and fonts, an edit shows after a reload, the policy is a response header,
// and any other origin is refused.
//
// The shell page is on `localhost`, the preview on `127.0.0.1` (never `localhost`: cookies
// ignore the port). Ports are picked free so parallel runs do not collide.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { join } from "node:path";
import { type Browser, chromium } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEMPLATE_DIR, freePort, makeTempApp } from "./helpers.js";
import { shellPage, testContext } from "./shell-page.js";

const SHOTS = join(TEMPLATE_DIR, "test-output");

let app: { dir: string; cleanup: () => void };
let vite: ViteDevServer;
let browser: Browser;
const servers: Server[] = [];
let frameOrigin = "";
let shellUrl = "";
let strangerUrl = "";

const serve = async (html: string): Promise<string> => {
  const port = await freePort();
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  servers.push(server);
  return `http://localhost:${port}`;
};

beforeAll(async () => {
  app = makeTempApp();
  const shellPort = await freePort();
  const vitePort = await freePort();
  frameOrigin = `http://127.0.0.1:${vitePort}`;
  shellUrl = `http://localhost:${shellPort}`;
  // What the runner writes into .env.local. Read by vite.config.ts through loadEnv.
  writeFileSync(join(app.dir, ".env.local"), `VITE_RMS_SHELL_ORIGIN=${shellUrl}\n`);

  vite = await createServer({
    root: app.dir,
    configFile: join(app.dir, "vite.config.ts"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: vitePort, strictPort: true },
  });
  await vite.listen();

  const page = shellPage({ frameUrl: `${frameOrigin}/`, frameOrigin, context: testContext() });
  const shellServer = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
  });
  await new Promise<void>((resolve) => shellServer.listen(shellPort, "127.0.0.1", resolve));
  servers.push(shellServer);

  strangerUrl = await serve(shellPage({ frameUrl: `${frameOrigin}/`, frameOrigin, context: testContext() }));
  browser = await chromium.launch();
  mkdirSync(SHOTS, { recursive: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await vite?.close();
  for (const s of servers) s.close();
  app?.cleanup();
});

describe("the template's dev server inside the shell's frame", () => {
  it("sends its policy as a response header, with only the shell allowed to frame it", async () => {
    const res = await fetch(`${frameOrigin}/`);
    const policy = res.headers.get("content-security-policy") ?? "";
    expect(policy).toContain(`frame-ancestors ${shellUrl}`);
    expect(policy).toContain("connect-src 'self';");
    expect(policy).not.toMatch(/ws:|wss:/);
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("default-src 'self'");
    // Never a meta tag: browsers ignore frame-ancestors there.
    expect(await res.text()).not.toMatch(/http-equiv=["']?content-security-policy/i);
  });

  it("draws the screen with its styles and fonts, and no policy error", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const problems: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" || /content security policy|refused/i.test(m.text())) problems.push(m.text());
    });
    page.on("pageerror", (e) => problems.push(e.message));
    await page.goto(shellUrl);
    const frame = page.frameLocator("iframe#app");
    await expect.poll(async () => frame.getByText("Nothing here yet").count(), { timeout: 20_000 }).toBeGreaterThan(0);

    const inner = page.frames().find((f) => f.url().startsWith(frameOrigin));
    expect(inner).toBeDefined();
    const look = await inner!.evaluate(async () => {
      await document.fonts.ready;
      const body = getComputedStyle(document.body);
      return {
        background: body.backgroundColor,
        font: body.fontFamily,
        fontLoaded: document.fonts.check('16px "Nunito Sans Variable"'),
        sheets: document.styleSheets.length,
      };
    });
    expect(look.sheets).toBeGreaterThan(0);
    expect(look.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(look.font).toContain("Nunito Sans");
    expect(look.fontLoaded).toBe(true);
    await page.screenshot({ path: join(SHOTS, "frame-1440.png") });
    expect(problems).toEqual([]);
    await page.close();
  }, 60_000);

  it("shows an edit with no reload: the dev websocket connects under connect-src 'self'", async () => {
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" || /content security policy|refused/i.test(m.text())) problems.push(m.text());
    });
    await page.goto(shellUrl);
    const frame = page.frameLocator("iframe#app");
    await expect.poll(async () => frame.getByText("Nothing here yet").count(), { timeout: 20_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    const file = join(app.dir, "src/screens/welcome/index.tsx");
    const before = readFileSync(file, "utf8");
    writeFileSync(file, before.replace("Nothing here yet", "Hot edit"));
    await expect.poll(async () => frame.getByText("Hot edit").count(), { timeout: 20_000 }).toBeGreaterThan(0);
    writeFileSync(file, before);
    expect(problems).toEqual([]);
    await page.close();
  }, 60_000);

  it("shows an edit to a screen after a reload", async () => {
    const file = join(app.dir, "src/screens/welcome/index.tsx");
    writeFileSync(file, readFileSync(file, "utf8").replace("Nothing here yet", "Edited just now"));
    const page = await browser.newPage();
    await page.goto(shellUrl);
    await page.reload();
    const frame = page.frameLocator("iframe#app");
    await expect.poll(async () => frame.getByText("Edited just now").count(), { timeout: 20_000 }).toBeGreaterThan(0);
    await page.close();
  }, 60_000);

  it("is refused by the browser when framed by any other origin", async () => {
    const page = await browser.newPage();
    const refusals: string[] = [];
    page.on("console", (m) => {
      if (/frame-ancestors/i.test(m.text())) refusals.push(m.text());
    });
    await page.goto(strangerUrl);
    await page.waitForTimeout(2_000);
    const inner = page.frames().find((f) => f !== page.mainFrame());
    const text = inner ? await inner.evaluate(() => document.body?.innerText ?? "").catch(() => "") : "";
    expect(text).not.toContain("Edited just now");
    expect(text).not.toContain("Nothing here yet");
    expect(refusals.length).toBeGreaterThan(0);
    await page.close();
  }, 60_000);
});
