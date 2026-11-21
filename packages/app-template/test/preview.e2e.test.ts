// The generated vendor mini-app in the dev server, inside the frame of a test shell that plays
// RMS: the list, the detail, adding a vendor through the relay, a money screen with no numbers
// in a preview, a new colour, and the page opened on its own. Screenshots at 1440x900 and 390x844.
import { createServer as createHttpServer, type Server } from "node:http";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";
import { runGenerator, writeLockedHashes } from "@rms/generators";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEMPLATE_DIR, VENDOR_SCREENS, freePort, makeTempApp, prepareApp } from "./helpers.js";
import { shellPage, testContext } from "./shell-page.js";

const SHOTS = join(TEMPLATE_DIR, "test-output");
const id = (n: number) => `0193a3c0-0000-7000-8000-0000000073${n.toString(16).padStart(2, "0")}`;
const VENDORS = [
  { id: id(1), name: "Hill Farm Produce", contact_name: "Ada Hill", phone: "555 0101", email: "orders@hillfarm.example", terms_days: 14, active: true, note: "Delivers Tuesday and Friday" },
  { id: id(2), name: "Harbour Fish Co", contact_name: "Sam Reyes", phone: "555 0102", email: "sam@harbourfish.example", terms_days: 7, active: true, note: null },
  { id: id(3), name: "Linen Line", contact_name: null, phone: "555 0103", email: null, terms_days: 30, active: false, note: "Paused for winter" },
];

let app: { dir: string; cleanup: () => void };
let vite: ViteDevServer;
let browser: Browser;
const servers: Server[] = [];
let frameOrigin = "";
let shellUrl = "";

beforeAll(async () => {
  app = makeTempApp();
  const shellPort = await freePort();
  const vitePort = await freePort();
  frameOrigin = `http://127.0.0.1:${vitePort}`;
  shellUrl = `http://localhost:${shellPort}`;
  prepareApp(app.dir, shellUrl);
  await writeLockedHashes(app.dir);
  for (const input of VENDOR_SCREENS) expect((await runGenerator(app.dir, input)).ok).toBe(true);

  vite = await createServer({ root: app.dir, configFile: join(app.dir, "vite.config.ts"), logLevel: "silent", server: { host: "127.0.0.1", port: vitePort, strictPort: true } });
  await vite.listen();

  const html = shellPage({
    frameUrl: `${frameOrigin}/#/vendors`,
    frameOrigin,
    context: testContext(),
    rows: { vendor: VENDORS },
    // As for a role that may not read the note: the screens must leave it out, not show "Not set".
    masked: { vendor: ["note"] },
    named: { sales_by_day: { columns: [], rows: [] }, prime_cost_by_week: { columns: [], rows: [] } },
  });
  const shell = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => shell.listen(shellPort, "127.0.0.1", resolve));
  servers.push(shell);
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await vite?.close();
  for (const s of servers) s.close();
  app?.cleanup();
});

const open = async (width: number, height: number): Promise<{ page: Page; problems: string[] }> => {
  const page = await browser.newPage({ viewport: { width, height } });
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || /content security policy|refused/i.test(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto(shellUrl);
  return { page, problems };
};

describe("the generated vendor list in the preview frame", () => {
  it("shows the vendors and one vendor's detail at 1440x900", async () => {
    const { page, problems } = await open(1440, 900);
    const frame = page.frameLocator("iframe#app");
    await frame.getByRole("button", { name: /Harbour Fish Co/ }).click({ timeout: 20_000 });
    await expect.poll(() => frame.getByText("Delivers Tuesday and Friday").count()).toBe(0);
    await expect.poll(() => frame.getByText("sam@harbourfish.example").count()).toBeGreaterThan(0);
    expect(await frame.getByText("Note", { exact: true }).count()).toBe(0);
    await page.screenshot({ path: join(SHOTS, "vendors-1440.png") });
    expect(problems).toEqual([]);
    await page.close();
  }, 60_000);

  it("shows the list, then the detail with a way back, at 390x844", async () => {
    const { page, problems } = await open(390, 844);
    const frame = page.frameLocator("iframe#app");
    await frame.getByRole("button", { name: /Hill Farm Produce/ }).waitFor({ timeout: 20_000 });
    await page.screenshot({ path: join(SHOTS, "vendors-390.png") });
    await frame.getByRole("button", { name: /Hill Farm Produce/ }).click();
    await frame.getByRole("button", { name: "Back to the list" }).waitFor();
    await page.screenshot({ path: join(SHOTS, "vendors-390-detail.png") });
    expect(problems).toEqual([]);
    await page.close();
  }, 60_000);

  it("adds a vendor through the shell, and the list shows it", async () => {
    const { page } = await open(1440, 900);
    const frame = page.frameLocator("iframe#app");
    await frame.getByRole("button", { name: "Add a vendor" }).first().click({ timeout: 20_000 });
    expect(await frame.getByLabel("Note").count()).toBe(0);
    await frame.getByLabel("Name").fill("Copper Pot Bakery");
    await frame.getByLabel("Days to pay").fill("ten");
    await frame.getByRole("button", { name: "Save" }).click();
    await frame.getByText("Type a whole number.").waitFor();
    await page.screenshot({ path: join(SHOTS, "vendors-form-error.png") });
    await frame.getByLabel("Days to pay").fill("10");
    await frame.getByRole("button", { name: "Save" }).click();
    await frame.getByRole("button", { name: /Copper Pot Bakery/ }).waitFor({ timeout: 10_000 });
    const seen = (await page.evaluate("window.__seen")) as Array<{ type: string; route?: string; body?: { ops?: Array<{ op: string; values: Record<string, unknown> }> } }>;
    const write = seen.find((m) => m.type === "rms.data" && m.route === "batch");
    expect(Object.keys(write?.body?.ops?.[0]?.values ?? {})).not.toContain("note");
    expect(write?.body?.ops?.[0]).toMatchObject({ op: "insert", model: "vendor", values: { name: "Copper Pot Bakery", terms_days: 10, active: true } });
    for (const m of seen) expect(Object.keys(m).sort()).toEqual(m.type === "rms.ready" ? ["rms", "type"] : ["body", "id", "rms", "route", "type"]);
    await page.close();
  }, 60_000);

  it("says No numbers yet on a money screen in a preview", async () => {
    const { page } = await open(1440, 900);
    const frame = page.frameLocator("iframe#app");
    await frame.getByRole("link", { name: "Money" }).click({ timeout: 20_000 });
    await frame.getByText("No numbers yet").waitFor({ timeout: 10_000 });
    await frame.getByText("They show once the mini-app is published.").waitFor();
    await page.screenshot({ path: join(SHOTS, "money-draft-1440.png") });
    await frame.getByRole("link", { name: "Sales" }).click();
    await frame.getByText("No numbers yet").waitFor();
    await page.close();
  }, 60_000);

  it("takes a new restaurant colour without a reload", async () => {
    const { page } = await open(1440, 900);
    const frame = page.frameLocator("iframe#app");
    await frame.getByRole("button", { name: /Hill Farm Produce/ }).waitFor({ timeout: 20_000 });
    const inner = page.frames().find((f) => f.url().startsWith(frameOrigin));
    const style = () => inner!.evaluate(() => document.querySelector(".rms-theme")?.getAttribute("style") ?? "");
    const before = await style();
    await page.evaluate("window.__theme('#1f6f8b')");
    await expect.poll(style).not.toBe(before);
    await page.close();
  }, 60_000);

  it("says Open this from RMS when opened on its own", async () => {
    const page = await browser.newPage();
    await page.goto(`${frameOrigin}/`);
    await page.getByText("Open this from RMS").waitFor({ timeout: 20_000 });
    await page.screenshot({ path: join(SHOTS, "not-connected.png") });
    await page.close();
  }, 60_000);
});
