/// <reference types="node" />
// The rules that matter, checked on the markup the components produce. No browser needed.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BarChart, BottomBar, BottomBarItem, Button, Dialog, Feed, Icon, NavItem, NavList, Notice, Stepper, TabLinks, Tabs, Tag, TextField, Theme } from "./index";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The selector must start a rule: straight after the previous rule or a comment, not as the tail of a list.
  const match = new RegExp(`(?:^|\\}|\\*/)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match?.[1]) throw new Error(`styles.css has no rule for ${selector}`);
  return match[1];
}

describe("Button", () => {
  it("a disabled primary button carries no filled class, so it has no action colour", () => {
    const html = renderToStaticMarkup(
      <Button variant="primary" disabled>
        Publish
      </Button>,
    );
    expect(html).toContain("disabled");
    expect(html).not.toContain("rms-button--primary");
  });

  it("a busy button is disabled, says so to screen readers, and loses the filled class too", () => {
    const html = renderToStaticMarkup(
      <Button variant="primary" busy>
        Publishing
      </Button>,
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("disabled");
    expect(html).not.toContain("rms-button--primary");
  });

  it("an enabled primary button is filled", () => {
    expect(renderToStaticMarkup(<Button variant="primary">Publish</Button>)).toContain("rms-button--primary");
  });

  it("the disabled style in the stylesheet uses no action colour", () => {
    const disabled = rule('.rms-button:disabled,\n.rms-button[aria-disabled="true"]');
    expect(disabled).not.toContain("--rms-action");
    expect(disabled).not.toContain("--rms-on-action");
    expect(rule(".rms-icon-button:disabled")).not.toContain("--rms-action");
  });

  it("takes no className or style from the caller", () => {
    // @ts-expect-error className is not a prop
    const withClass = <Button className="mine">Save</Button>;
    // @ts-expect-error style is not a prop
    const withStyle = <Button style={{ color: "red" }}>Save</Button>;
    expect(withClass).toBeTruthy();
    expect(withStyle).toBeTruthy();
  });
});

describe("Stepper", () => {
  const html = renderToStaticMarkup(
    <Stepper
      label="Progress"
      steps={[
        { id: "a", label: "Set up your sales days", state: "done" },
        { id: "b", label: "Checking the numbers add up", state: "now" },
        { id: "c", label: "Ready to publish", state: "todo" },
      ]}
    />,
  );

  it("says every state in words", () => {
    expect(html).toContain("Done");
    expect(html).toContain("In progress");
    expect(html).toContain("Not started");
  });

  it("marks the step in progress for screen readers", () => {
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain('data-state="now" aria-current="step"');
  });

  const stopped = renderToStaticMarkup(
    <Stepper
      label="Progress"
      steps={[
        { id: "a", label: "Set up your vendor list", state: "done" },
        { id: "b", label: "Building the screen", state: "stopped" },
        { id: "c", label: "Checking it works", state: "todo" },
      ]}
    />,
  );

  it("a step that did not finish says so in words, and is not the current step", () => {
    expect(stopped).toContain('data-state="stopped"');
    expect(stopped).toContain("Did not finish");
    expect(stopped).not.toContain("aria-current");
  });

  it("a step that did not finish has its own ink shape, and no colour", () => {
    expect(rule('.rms-step[data-state="stopped"] .rms-step__mark')).toContain("border: 2px solid var(--rms-ink)");
    expect(rule('.rms-step[data-state="stopped"] .rms-step__mark::after')).toContain("background: var(--rms-ink)");
    for (const block of css.match(/\.rms-step\[data-state="stopped"\][^{]*\{[^}]*\}/g) ?? []) expect(block).not.toContain("--rms-action");
  });

  it("changing one state's word keeps the usual words for the rest", () => {
    const html = renderToStaticMarkup(
      <Stepper label="Progress" words={{ stopped: "Stopped" }} steps={[{ id: "a", label: "One", state: "done" }, { id: "b", label: "Two", state: "stopped" }]} />,
    );
    expect(html).toContain("Done");
    expect(html).toContain("Stopped");
    expect(html).not.toContain("Did not finish");
  });
});

describe("BarChart", () => {
  const items = [
    { id: "oct12", label: "Oct 12", value: 84870, display: "$84,870" },
    { id: "oct19", label: "Oct 19", value: 61480, display: "$61,480", state: "Slow week" },
    { id: "nov9", label: "Nov 9", value: 84310, display: "$84,310", current: true },
  ];

  it("prints every value, every label and the state in words", () => {
    const html = renderToStaticMarkup(<BarChart label="Net sales" items={items} />);
    for (const item of items) {
      expect(html).toContain(item.display);
      expect(html).toContain(item.label);
    }
    expect(html).toContain("Slow week");
    expect(html).toContain('data-marked="true"');
    expect(html).toContain('aria-label="Net sales"');
  });

  it("read only: no buttons, and the current bar is marked for ink", () => {
    const html = renderToStaticMarkup(<BarChart label="Net sales" items={items} />);
    expect(html).not.toContain("<button");
    expect(html).toContain('data-current="true"');
  });

  it("pressable: every bar is a button and only the chosen one is pressed", () => {
    const html = renderToStaticMarkup(<BarChart label="Net sales" items={items} onSelect={() => undefined} />);
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).not.toContain('data-current="true"');
  });

  it("only a pressable bar may take the action colour", () => {
    const coloured = css.match(/[^{}]*\{[^}]*background:\s*var\(--rms-action(?:-pressed)?\)[^}]*\}/g) ?? [];
    const chart = coloured.filter((block) => block.includes("rms-chart"));
    expect(chart.length).toBeGreaterThan(0);
    for (const block of chart) expect(block).toContain(".rms-chart__press");
  });
});

describe("navigation", () => {
  it("NavItem marks the current page and only that one", () => {
    const html = renderToStaticMarkup(
      <NavList>
        <NavItem icon="home" label="Home" href="/" />
        <NavItem icon="apps" label="Mini-apps" href="/mini-apps" current />
      </NavList>,
    );
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/href="\/mini-apps"[^>]*aria-current="page"/);
  });

  it("TabLinks mark the current page", () => {
    const html = renderToStaticMarkup(
      <TabLinks
        label="Mini-apps"
        items={[
          { href: "/mini-apps", label: "Build", current: true },
          { href: "/mini-apps/marketplace", label: "Marketplace" },
        ]}
      />,
    );
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/href="\/mini-apps"[^>]*aria-current="page"/);
  });

  it("Tabs mark the chosen tab and tie it to its panel", () => {
    const html = renderToStaticMarkup(
      <Tabs
        label="Period"
        value="week"
        onChange={() => undefined}
        items={[
          { value: "week", label: "This week", content: "Week panel" },
          { value: "all", label: "Eight weeks", content: "All panel" },
        ]}
      />,
    );
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain("Week panel");
    expect(html).not.toContain("All panel");
  });

  it("BottomBar marks the current place, and More is a button that opens something", () => {
    const html = renderToStaticMarkup(
      <BottomBar label="Main">
        <BottomBarItem icon="home" label="Home" href="/" current />
        <BottomBarItem icon="more" label="More" onPress={() => undefined} expanded={false} />
      </BottomBar>,
    );
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('aria-haspopup="dialog"');
  });
});

describe("states are words and ink, never colour", () => {
  it("an icon has no way to take the action colour by itself", () => {
    // @ts-expect-error there is no colour prop on Icon
    const html = renderToStaticMarkup(<Icon name="up" go />);
    expect(html).not.toContain("rms-icon--go");
    expect(css).not.toContain("rms-icon--go");
  });

  it("tags, notices, field errors and flagged rows use no action colour", () => {
    for (const selector of [".rms-tag", ".rms-tag--outline", ".rms-tag--solid", ".rms-notice--problem", '.rms-input[aria-invalid="true"]', '.rms-feed__item[data-flagged="true"]']) {
      expect(rule(selector)).not.toContain("--rms-action");
    }
  });

  it("a field error is announced and tied to its field", () => {
    const html = renderToStaticMarkup(<TextField label="Due date" id="due" error="November has 30 days." />);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="due-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("November has 30 days.");
  });

  it("a flagged feed row says why in words", () => {
    const html = renderToStaticMarkup(<Feed label="Changes" items={[{ id: "1", tag: <Tag>T2 major</Tag>, what: "Published Money", when: "2 min ago", flag: "Needs a look" }]} />);
    expect(html).toContain('data-flagged="true"');
    expect(html).toContain("Needs a look");
    expect(html).toContain("T2 major");
  });

  it("a problem notice is an alert, a status notice is polite", () => {
    expect(renderToStaticMarkup(<Notice kind="problem">Try again.</Notice>)).toContain('role="alert"');
    expect(renderToStaticMarkup(<Notice kind="status">Saved.</Notice>)).toContain('role="status"');
  });
});

describe("Theme and Dialog", () => {
  it("Theme writes only checked hex colours into the page, whatever it is given", () => {
    for (const brand of ["#E8892B", "red;background:url(x)", "</style><script>", null, undefined]) {
      const html = renderToStaticMarkup(<Theme brand={brand}>x</Theme>);
      const style = /style="([^"]*)"/.exec(html)?.[1] ?? "";
      expect(style).toMatch(/^(--rms-[a-z-]+:#[0-9A-F]{6};?)+$/);
      expect(html).not.toContain("url(");
      expect(html).not.toContain("script");
    }
  });

  it("Dialog listens for Escape only, so closing calls onClose once", () => {
    const html = renderToStaticMarkup(
      <Dialog open={false} onClose={() => undefined} title="Publish Money?">
        Body
      </Dialog>,
    );
    expect(html).toContain("<dialog");
    expect(html).toContain("Publish Money?");
    const source = readFileSync(new URL("./components/dialog.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/\sonClose=\{onClose\}/);
    expect(source).toContain("onCancel=");
  });
});

describe("touch targets in the stylesheet", () => {
  it("everything pressable is at least 44px", () => {
    expect(tokens).toMatch(/--rms-target: 2\.75rem;/);
    expect(tokens).toMatch(/--rms-target-nav: 3rem;/);
    expect(tokens).toMatch(/--rms-target-large: 3\.25rem;/);
  });

  it("pressable chart bars are a full target in both layouts", () => {
    expect(rule(".rms-chart--rows .rms-chart__press")).toContain("min-height: var(--rms-target)");
    expect(css).toMatch(/@container \(max-width: 30rem\) \{\s*\.rms-chart--columns \.rms-chart__press \{\s*min-height: var\(--rms-target\);/);
  });

  it("buttons, icon buttons, sort headers, selects and choices name a target size", () => {
    expect(rule(".rms-button")).toContain("min-height: var(--rms-target)");
    expect(rule(".rms-icon-button")).toContain("width: var(--rms-target)");
    expect(rule(".rms-table__sort")).toContain("min-height: var(--rms-target)");
    expect(rule(".rms-select__control")).toContain("min-height: var(--rms-target)");
    expect(rule(".rms-choice")).toContain("min-height: var(--rms-target-nav)");
    expect(rule(".rms-nav-item")).toContain("min-height: var(--rms-target-nav)");
  });
});
