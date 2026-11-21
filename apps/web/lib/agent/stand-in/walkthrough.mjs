// The build screen in a real browser (Playwright, headless Chromium), with no sign-in:
// every recorded state from /gallery/build, then one whole practice build at
// /gallery/build/live with a real frame on another site and the data hand-off through it.
// It CHECKS what it sees and saves screenshots to docs/design/wave2/task-j/.
//
// Before running: build and serve the web app on a spare port with PREVIEW_URL set to the
// stand-in's address (the app frames nothing else), and start the stand-in frame for that
// origin (docs/briefs/wave2-task-j-notes.md has the three commands).
//   RMS_WEB=http://localhost:3060 node apps/web/lib/agent/stand-in/walkthrough.mjs
//
// Local only. No sign-in, no model, no database, no real restaurant.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const WEB = (process.env.RMS_WEB ?? "http://localhost:3060").replace(/\/$/, "");
const FRAME = (process.env.RMS_STAND_IN ?? "http://127.0.0.1:5673").replace(/\/$/, "");
for (const url of [WEB, FRAME]) {
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error("The walkthrough only runs against this computer");
}
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "docs", "design", "wave2", "task-j");
mkdirSync(OUT, { recursive: true });

const SIZES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

let passed = 0;
const failed = [];
const check = (name, ok) => {
  if (ok) passed += 1;
  else failed.push(name);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};

// One screen's worth, as the owner sees it. On a phone the newest thing is brought into view first.
const shot = async (page, name, size, show = "conversation") => {
  if (size === "phone") {
    await page.evaluate((what) => {
      const target = what === "preview" ? document.querySelector('[aria-label="Preview"]') : document.querySelector('[role="log"]')?.lastElementChild;
      target?.scrollIntoView({ block: what === "preview" ? "start" : "center" });
    }, show);
  }
  await page.waitForTimeout(350); // let a dialog finish arriving
  await page.screenshot({ path: join(OUT, `${name}-${size}.png`) });
};

// What each recorded state must show, in the owner's words.
const RECORDED = {
  first: ["I want to see how much money I’m making", "Thinking it through", "Stop", "Your preview shows here"],
  question: ["Which locations?", "Both", "How often do you want to look?", "Every week"],
  duplicate: ["You already have this", "Money", "Open it", "Add to it", "Build a separate one anyway"],
  plan: ["Here’s what I’ll build", "What I assumed", "Your week runs Monday to Sunday.", "Build it", "Change something"],
  progress: ["Set up your sales days", "Done", "Checking the numbers add up", "In progress", "Stop", "Building your preview"],
  preview: ["Money is ready to try. Tell me if anything looks off.", "Not published yet", "Prime cost"],
  changed: ["Put Riverside first", "Made that change", "Undo that"],
  confirm: ["Go ahead with this?", "Money will show Downtown only.", "Yes, go ahead", "No, leave it"],
  failure: ["That took too long and was stopped.", "Try again", "Checking the numbers add up", "Did not finish"],
  dropped: ["Reconnecting", "Your build carries on. Nothing is lost.", "Building your weekly screen"],
};
// Words that must never reach an owner's screen.
const MACHINERY = /\b(undefined|null|NaN|Error|exception|stack|token|sandbox|localhost|127\.0\.0\.1|seq|run_[0-9a-f]|ses_[0-9a-f]|app_[0-9a-f]|json|http)\b/i;

const browser = await chromium.launch();
try {
  for (const [size, device] of Object.entries(SIZES)) {
    const context = await browser.newContext(device);
    const page = await context.newPage();
    const problems = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });
    page.on("pageerror", (error) => problems.push(String(error)));

    // 1. Every recorded state.
    for (const [state, words] of Object.entries(RECORDED)) {
      await page.goto(`${WEB}/gallery/build?state=${state}`, { waitUntil: "networkidle" });
      const text = await page.locator("main").innerText();
      for (const word of words) check(`${size} ${state}: shows “${word}”`, text.includes(word));
      const said = await page.locator('[aria-label="Build conversation"]').first().innerText();
      check(`${size} ${state}: no machinery in the conversation`, !MACHINERY.test(said));
      const publish = page.getByRole("button", { name: "Publish", exact: true });
      check(`${size} ${state}: Publish is shown and switched off`, (await publish.isDisabled()) && text.includes("Publishing comes next. For now, try it here."));
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${size} ${state}: nothing runs off the side`, wide <= 0);
      await shot(page, `recorded-${state}`, size);
      if (state === "preview") await shot(page, "recorded-preview-below", size, "preview");
    }

    // 2. One practice build, start to finish, on the real stream client and a real frame.
    await page.goto(`${WEB}/gallery/build/live`, { waitUntil: "networkidle" });
    await page.getByRole("textbox", { name: "Say what you need" }).fill("Keep a list of my suppliers");
    await page.getByRole("button", { name: "Send" }).click();
    await page.waitForURL(/session=ses_/);
    const question = page.getByText("Is this one list for both locations, or one each?");
    await question.waitFor();
    await shot(page, "live-1-question", size);
    await page.getByRole("button", { name: "One list for both" }).click();
    await page.getByText("Anything you want to note about each one").waitFor();
    await page.getByRole("textbox", { name: "Type your answer" }).fill("What they deliver");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: "Build it" }).waitFor();
    check(`${size} live: the answers fold into chips`, (await page.getByRole("list", { name: "Your answers" }).innerText()).includes("One list for both"));
    check(`${size} live: the plan says what was assumed`, await page.getByText("What I assumed").isVisible());
    await shot(page, "live-2-plan", size);

    // A reload in the middle loses nothing.
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Build it" }).waitFor();
    check(`${size} live: a reload replays the conversation`, await page.getByText("Keep a list of my suppliers").first().isVisible());

    await page.getByRole("button", { name: "Build it" }).click();
    await page.getByText("Setting up your supplier list").waitFor();
    check(`${size} live: Stop replaces the box while RMS works`, (await page.getByRole("button", { name: "Stop" }).isVisible()) && (await page.getByRole("textbox").count()) === 0);
    await shot(page, "live-3-building", size);

    // The preview: a real frame, from another site, talking through the shell.
    const frame = page.frameLocator('iframe[title="Preview of Suppliers"]');
    await frame.getByText("No suppliers yet").waitFor({ timeout: 30_000 });
    await page.getByText("Here’s your supplier list.").waitFor();
    const attrs = await page.locator("iframe").evaluate((el) => ({ src: el.src, sandbox: el.getAttribute("sandbox"), referrer: el.getAttribute("referrerpolicy"), allow: el.getAttribute("allow") }));
    check(`${size} live: the frame is on another site, never localhost`, new URL(attrs.src).origin === FRAME && new URL(attrs.src).hostname !== new URL(WEB).hostname);
    check(`${size} live: the frame carries the agreed attributes`, attrs.sandbox === "allow-scripts allow-same-origin allow-forms" && attrs.referrer === "no-referrer" && attrs.allow === "");
    check(`${size} live: the frame's address holds no token`, !/token|practice-run/i.test(attrs.src));
    check(`${size} live: the frame was told which restaurant it is in`, await frame.getByText("Marigold Kitchen").isVisible());
    await frame.getByLabel("Name").fill("Green Valley Produce");
    await frame.getByLabel("Phone").fill("555-0142");
    await frame.getByLabel("What they deliver").fill("Vegetables, Tuesdays and Fridays");
    await frame.getByRole("button", { name: "Add supplier" }).click();
    await frame.getByText("Green Valley Produce").waitFor();
    check(`${size} live: a row typed in the preview is saved and read back through the shell`, await frame.getByText("555-0142").isVisible());
    const leaked = await page.evaluate(() => {
      const everywhere = document.documentElement.outerHTML + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie + location.href;
      return /practice-run-[0-9a-f]{8}/.test(everywhere);
    });
    check(`${size} live: the preview token is not in the page, the address, storage or cookies`, !leaked);
    await page.getByRole("textbox", { name: "Tell me what to change" }).waitFor();
    await shot(page, "live-4-preview", size, "preview");

    // "Try it on my phone" (the button is left out on a phone).
    if (size === "desktop") {
      await page.getByRole("button", { name: "Try it on my phone" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText("Open this link on your phone").waitFor();
      check(`${size} live: the phone link is this build on the web app's own address`, (await dialog.getByLabel("Link to this build").inputValue()).startsWith(`${WEB}/`));
      check(`${size} live: it says plainly that the link only works on this computer`, await dialog.getByText("This link only works on this computer.").isVisible());
      await shot(page, "live-5-phone-link", size);
      await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
    }

    // A change, with the connection cut part-way. The screen says so, then picks up where it was.
    await page.getByRole("textbox", { name: "Tell me what to change" }).fill("Add a phone number");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("Making that change").waitFor();
    await page.evaluate(() => (window.rmsPractice.offline = true));
    await page.getByText("Reconnecting").waitFor({ timeout: 15_000 });
    check(`${size} live: a dropped connection says so in plain words`, await page.getByText("Your build carries on. Nothing is lost.").isVisible());
    await shot(page, "live-6-reconnecting", size);
    await page.evaluate(() => (window.rmsPractice.offline = false));
    await page.getByText("Done. Take a look.").waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Undo that" }).waitFor();
    check(`${size} live: it recovers, and Reconnecting goes away`, (await page.getByText("Reconnecting").count()) === 0);
    check(`${size} live: every message shows once after the drop`, (await page.getByText("Add a phone number").count()) === 1 && (await page.getByText("Made that change").count()) === 1);
    await frame.getByText("Green Valley Produce").waitFor({ timeout: 30_000 });
    check(`${size} live: the rebuilt preview still has the row, read with the new run's token`, await frame.getByText("555-0142").isVisible());
    await shot(page, "live-7-recovered", size);

    // A build that stops short.
    await page.goto(`${WEB}/gallery/build/live`, { waitUntil: "networkidle" });
    await page.getByRole("textbox", { name: "Say what you need" }).fill("Print my supplier list every Monday");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("I can’t set up printing yet.").waitFor();
    check(`${size} live: a failure is plain words with no retry it cannot keep`, (await page.getByRole("alert").first().innerText()).includes("Tell me what else it should do") && (await page.getByRole("button", { name: "Try again" }).count()) === 0);
    await shot(page, "live-8-failure", size);

    // Asking for the same thing again.
    await page.goto(`${WEB}/gallery/build/live`, { waitUntil: "networkidle" });
    await page.getByRole("textbox", { name: "Say what you need" }).fill("Keep a list of my suppliers");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("You already have this").waitFor();
    check(`${size} live: asking again says you already have this, with three choices`, (await page.getByRole("button", { name: "Open it" }).isVisible()) && (await page.getByRole("button", { name: "Add to it" }).isVisible()) && (await page.getByRole("button", { name: "Build a separate one anyway" }).isVisible()));
    await shot(page, "live-9-duplicate", size);

    check(`${size}: the browser console has no errors or policy refusals`, problems.length === 0);
    if (problems.length > 0) console.log(problems.slice(0, 5).join("\n"));
    await context.close();
  }

  // 3. The other side of the wall: the stand-in refuses to be framed by anyone but the shell,
  // and shown on its own it says to open it from RMS.
  const context = await browser.newContext(SIZES.desktop);
  const page = await context.newPage();
  await page.goto(`${FRAME}/`, { waitUntil: "networkidle" });
  check("stand-in: opened on its own it says “Open this from RMS”", await page.getByText("Open this from RMS").isVisible());
  const policy = (await (await page.request.get(`${FRAME}/`)).headers())["content-security-policy"] ?? "";
  check("stand-in: only the shell may frame it, and it may not call the network", policy.includes(`frame-ancestors ${WEB}`) && policy.includes("connect-src 'none'"));
  const shellPolicy = (await (await page.request.get(`${WEB}/gallery/build`)).headers())["content-security-policy"] ?? "";
  check("web app: it may frame the preview's own site and no other, and nobody may frame it", shellPolicy === `frame-ancestors 'none'; frame-src ${FRAME}`);

  // A mini-app that sends its own frame somewhere else is refused by the browser.
  await page.goto(`${WEB}/gallery/build?state=first`, { waitUntil: "networkidle" });
  const refused = await page.evaluate(
    () =>
      new Promise((resolve) => {
        document.addEventListener("securitypolicyviolation", (event) => resolve(event.violatedDirective), { once: true });
        const frame = document.createElement("iframe");
        frame.src = "https://example.com/";
        document.body.append(frame);
        setTimeout(() => resolve("shown"), 4000);
      }),
  );
  check("web app: a frame pointed at any other site is refused", refused === "frame-src");
  await context.close();
} finally {
  await browser.close();
}

console.log(`\n${passed} checks passed, ${failed.length} failed. Screenshots in ${OUT}`);
if (failed.length > 0) {
  console.log(failed.map((name) => ` - ${name}`).join("\n"));
  process.exit(1);
}
