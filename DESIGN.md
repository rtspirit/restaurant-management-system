---
name: RMS
description: Front of House. If it has colour, you can press it.
colors:
  ground: "#DEE7F2"
  card: "#FFFFFF"
  ink: "#1E2420"
  line: "#CAD6E2"
  bar: "#A4B3C3"
  field-line: "#76828E"
  muted-on-card: "#616C77"
  muted-on-ground: "#4C5661"
  action: "#12804A"
  action-ink: "#007742"
  action-pressed: "#006D3C"
  action-wash: "#ECF5F1"
  on-action: "#FFFFFF"
typography:
  hero:
    fontFamily: "Nunito Sans Variable, Nunito Sans, ui-rounded, system-ui, sans-serif"
    fontSize: "2.75rem"
    fontWeight: 800
    lineHeight: "3rem"
    letterSpacing: "-0.02em"
  page-title:
    fontFamily: "Nunito Sans Variable, Nunito Sans, ui-rounded, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 800
    lineHeight: "3rem"
    letterSpacing: "-0.01em"
  app-title:
    fontFamily: "Nunito Sans Variable, Nunito Sans, ui-rounded, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 800
    lineHeight: "2.75rem"
    letterSpacing: "-0.01em"
  stat:
    fontFamily: "Nunito Sans Variable, Nunito Sans, ui-rounded, system-ui, sans-serif"
    fontSize: "1.625rem"
    fontWeight: 800
    lineHeight: "2.125rem"
    letterSpacing: "-0.01em"
  section-title:
    fontFamily: "Nunito Sans Variable, Nunito Sans, ui-rounded, system-ui, sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 800
    lineHeight: "1.75rem"
  card-title:
    fontFamily: "Nunito Sans Variable, Nunito Sans, ui-rounded, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 800
    lineHeight: "1.5rem"
  body:
    fontFamily: "Nunito Sans Variable, Nunito Sans, ui-rounded, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "tnum"
  label:
    fontFamily: "Nunito Sans Variable, Nunito Sans, ui-rounded, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: "1.25rem"
  small:
    fontFamily: "Nunito Sans Variable, Nunito Sans, ui-rounded, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 700
    lineHeight: "1.25rem"
  stat-row:
    fontFamily: "Nunito Sans Variable, Nunito Sans, ui-rounded, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 800
    lineHeight: "2.125rem"
  logo:
    fontFamily: "Nunito Sans Variable, Nunito Sans, ui-rounded, system-ui, sans-serif"
    fontSize: "1.625rem"
    fontWeight: 900
    lineHeight: "2rem"
    letterSpacing: "-0.03em"
  logo-small:
    fontFamily: "Nunito Sans Variable, Nunito Sans, ui-rounded, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 900
    lineHeight: "1.5rem"
    letterSpacing: "-0.03em"
rounded:
  foot: "3px"
  tail: "6px"
  label: "8px"
  chip: "10px"
  field: "12px"
  card: "16px"
  bubble: "20px"
  composer: "30px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.on-action}"
    rounded: "{rounded.pill}"
    padding: "8px 20px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.action-pressed}"
    textColor: "{colors.on-action}"
  button-primary-large:
    backgroundColor: "{colors.action}"
    textColor: "{colors.on-action}"
    rounded: "{rounded.pill}"
    padding: "8px 28px"
    height: "52px"
  button-secondary:
    backgroundColor: "{colors.card}"
    textColor: "{colors.action-ink}"
    rounded: "{rounded.pill}"
    padding: "8px 20px"
    height: "44px"
  button-secondary-hover:
    backgroundColor: "{colors.action-wash}"
    textColor: "{colors.action-ink}"
  button-disabled:
    backgroundColor: "{colors.line}"
    textColor: "{colors.muted-on-ground}"
    rounded: "{rounded.pill}"
  text-field:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "8px 16px"
    height: "48px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "20px 24px"
  tag-quiet:
    backgroundColor: "{colors.line}"
    textColor: "{colors.ink}"
    rounded: "{rounded.label}"
    padding: "8px 12px"
  tag-solid:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.card}"
    rounded: "{rounded.label}"
    padding: "8px 12px"
  nav-item-current:
    backgroundColor: "{colors.card}"
    textColor: "{colors.action-ink}"
    rounded: "{rounded.pill}"
    padding: "8px 16px"
    height: "48px"
  message-you:
    backgroundColor: "{colors.line}"
    textColor: "{colors.ink}"
    padding: "12px 20px"
---

# Design System: RMS

Written from the code as built in Wave 1 (`packages/ui`, `apps/web`). The source of truth is `packages/ui/src/tokens.css`, `packages/ui/src/styles.css` and `packages/ui/src/theme.ts`. If this file and the code disagree, the code is right and this file is stale.

## Overview

**Creative North Star: "Front of House"**

A restaurant owner looks at a calm screen and knows at a glance what is safe to touch. Colour is not decoration here. It is the one signal the whole system teaches: **if it has colour, you can press it.** Everything you only read is the slate ground, a white card, ink, or a hairline.

The audience is a non-technical owner or manager at a back-office laptop, on a phone mid-shift, or at a kitchen tablet. So the type is large and heavy for figures, targets are 44px or more, and every state is said in words. The system refuses the category default of a grey sidebar, a white card grid and blue everywhere, where colour decorates and nothing says what can be pressed.

**Key Characteristics:**

- One action colour. It is the restaurant's own brand colour, made safe by code.
- Shape carries meaning: fully rounded is a button, 8 to 16px corners are something you read.
- States are words plus ink shapes (outline, solid, tick, ring). Never colour.
- One family, Nunito Sans, heavy for figures and headings, tabular figures everywhere.
- Two densities: comfortable for talking and deciding, compact for report rows, charts and feeds.
- Motion is press feedback only.

## Colors

One slate neutral set that never changes, and one action colour that changes per restaurant.

### Primary

- **Action** (`#12804A` basil by default): filled buttons, the chosen bar in a pressable chart, the tab and bottom-bar marker, the full stop in the logo when the logo is a link.
- **Action ink** (`#007742`): coloured words and icons on the ground, on a card and on the hover wash. A hair darker than the fill so it passes 4.5 to 1 on the ground.
- **Action pressed** (`#006D3C`): a filled button while hovered or held.
- **Action wash** (`#ECF5F1`): the faint tint behind an outlined or quiet button, or a list row, while hovered.
- **On action** (`#FFFFFF`): words on a filled button. Always white.

### Neutral

- **Ground** (`#DEE7F2`, slate): the page, the same for every restaurant. The blue-grey of a slate menu board. It is cool so that every brand colour stands off it, most of all the oranges and yellows that sank into the first sketch's cream (`#F4EEE6`, retired). Faint enough (OKLCH chroma 0.018) that it never reads as something to press.
- **Card** (`#FFFFFF`): anything you read sits on white.
- **Ink** (`#1E2420`): text, figures, focus rings, and every state shape.
- **Line** (`#CAD6E2`): hairlines, quiet tags, your own message bubble, disabled buttons.
- **Bar** (`#A4B3C3`): chart bars that are not the current one, the dashed edge of an empty state. 2.1 to 1 against a card, with the figure always printed beside it.
- **Field line** (`#76828E`): the edge of a text field and a disabled arrow. 3 to 1 against card and ground.
- **Muted on card** (`#616C77`) and **muted on ground** (`#4C5661`): secondary words. Components pick the right one through `--rms-muted`, which a card redefines.

### Named Rules

**The One Family Rule.** Ground, line, bar, field line and both muted greys are the same hue (OKLCH 250) at six lightness steps. Change the ground and all six move together, and `SURFACES` in `theme.ts` moves with them. A test checks the pairs that carry text.

**The Press Rule.** If it has colour, you can press it. Nothing coloured that cannot be pressed. A disabled action loses its colour entirely.

**The Brand Safety Rule.** A restaurant's colour never reaches the page directly. `themeFromBrand(hex)` keeps the hue and darkens only as far as it must so that white words on the fill and coloured words on card, ground and wash all pass WCAG AA (4.5 to 1). A colour that already passes is used exactly as chosen. Black, white and greys have no colour to keep, so they are replaced by basil and `adjustment` reports `"replaced"`. `packages/ui/src/theme.test.ts` proves this for `#12804A`, `#E8892B`, `#C8372D`, `#F2C230`, `#1F6FD0` and ten hostile colours.

**The Ink State Rule.** Over target, slow week, done, in progress, needs approval: each is a word plus an ink shape. A slow week is an outlined bar and the words "Slow week". Three weights of tag (soft, outlined, solid ink) rank how much something matters. An error is a heavier ink edge, an ink mark and plain words.

## Typography

**Family:** Nunito Sans (variable, 200 to 1000), shipped with the package through `@fontsource-variable/nunito-sans`, with `ui-rounded, system-ui, sans-serif` behind it.

**Character:** round and friendly at body weight, confident at 800 for figures. One family does every job.

### Hierarchy

- **Hero** (800, 44px/48px, -0.02em): the one lead figure on a screen. Once per screen.
- **Page title** (800, 28px/48px): the `h1` of a shell page.
- **App title** (800, 24px/44px): a mini-app's name inside a preview.
- **Stat** (800, 26px/34px): a figure in a group.
- **Section title** (800, 19px/28px), **card title** (800, 18px/24px), **small title** (800, 16px/22px).
- **Body** (400, 16px/1.5): prose, capped at 32rem, about 70 characters.
- **Label** (600 to 700, 15px/20px): stat labels, table headers, hints, secondary words.
- **Small** (700, 14px/20px): chart labels, bottom-bar labels, compact tags.

Buttons are 16px/700, and 19px/800 at the large size. Tabs are 19px/700, 800 when chosen, with the width of the heavy label reserved so choosing a tab moves nothing.

### Named Rules

**The 14 Rule.** Nothing is smaller than 14px. Chart labels were 13px in the sketch and are 14px in the build.

**The Lined-up Figures Rule.** `font-variant-numeric: tabular-nums` is set on `body`. Money and counts are right-aligned in tables.

## Layout

- **Shell.** From 900px: a 224px side rail on the ground (logo, restaurant name, location switcher, six places, who is signed in) beside the page. Below 900px: a top strip (logo, name, location) and a bottom bar with four places and "More", which opens the rest in a sheet. Only one set of navigation shows at a time.
- **Page.** A title, optional tabs on the same line, a hairline, then the work. Page edge is 32px on a desktop and 16px on a phone.
- **Workbench** (build screen). Conversation in a 560px column, preview beside it, a hairline between. From 1024px it fills the window: each side scrolls on its own, and the composer and the main actions stay on the bottom edge. Below 1024px the preview moves under the conversation and the actions pin to the bottom of the screen.
- **Density.** `data-density="compact"` on any container drops table rows from 52px to 36px, bar rows from 36px to 30px, data text from 16px to 15px and tags to 24px tall. Card padding (20px by 24px) is the same in both, so card edges always line up. Report tables and the change feed are always compact.
- **Responsive behaviour is structural.** A stat group becomes rows under 448px of card width. Upright bars become rows under 480px. A wide table scrolls sideways inside its card with the name column and the strongest column pinned. A dialog becomes a bottom sheet on a phone. Type does not scale with the window.
- **Touch.** 44px minimum for anything pressable, 48px for navigation and fields, 52px for the main action of a page.

## Elevation & Depth

Nearly flat. Depth comes from white cards on the slate ground (1.25 to 1) and one quiet shadow.

- **Card lift** (`0 1px 2px rgb(30 36 32 / 0.06)`): cards, the composer, the current rail item, RMS speech bubbles.
- **Raised** (`0 16px 40px -12px rgb(30 36 32 / 0.28), 0 2px 6px rgb(30 36 32 / 0.08)`): dialogs and sheets only, over a `rgb(30 36 32 / 0.45)` scrim.

No coloured glows, no hard offset shadows, no glass.

## Shapes

**The Shape Rule.** Fully rounded (999px) means you can press it: buttons, icon buttons, the select, the week picker, rail items, the composer. 8 to 16px corners mean you read it: tags and notes 8px, answer chips 10px, text fields 12px (you type in them), cards and dialogs 16px. Speech is its own shape: a 20px bubble with one 6px corner on the speaker's side. The composer keeps a 30px corner, a pill at one line that holds its shape when it grows.

Other forms: a 3px ink focus ring 2px off the element; 1px hairlines in Line; a 2px ink rule above a table total; a 1.5px ink outline for a note or a marked bar; a 1.5px dashed edge for an empty slot. Icons are one hand-drawn set on a 24px grid with a 1.75 stroke and round caps (`packages/ui/src/icons.tsx`).

**The logo** is the wordmark "RMS" at weight 900 with a round full stop. The full stop takes the action colour only when the logo is a link, and is ink when it is not.

## Components

All in `@rms/ui`. They take no `className` and no `style`, so screens are composed without writing CSS. Review them at `/gallery`.

- **Button.** `primary` (filled, one per screen), `secondary` (white pill, hairline, coloured words), `quiet` (coloured words only). Sizes 44px and 52px. Hover goes darker or to the wash. Press scales to 0.965 and springs back. `busy` shows a turning ring and blocks presses. Disabled turns Line with muted words.
- **IconButton.** A 44px circle with a coloured icon and a required label.
- **TextField.** Label above, optional hint, 48px box, 12px corners. Error: heavier ink edge, ink mark, plain words under the field.
- **Select.** The platform's own picker drawn as a pill: ink words, coloured chevron.
- **Tabs and TabLinks.** Ink words; the chosen one is coloured, heavier, with a 3px coloured underline. Tabs swap content in place with arrow keys; TabLinks are separate pages.
- **Card.** White, 16px corners, one idea each. Never nested.
- **Tag.** `quiet`, `outline` (optional ink arrow) and `solid`. A label you read, so 8px corners.
- **Stat, StatLead, StatGroup.** Label, figure, note. The lead figure sits beside what it is measured against.
- **DataTable.** First column names the row. Sortable headers carry a coloured sort mark. Totals under a 2px ink rule.
- **BarChart.** Same-scale bars with the figure written on every one. Read-only: the current bar is solid ink. Pressable: the chosen bar takes the action colour.
- **Stepper.** Done is a solid ink disc with a tick. In progress is an open ring that turns. Not started is a hollow ring. Each with its word.
- **Conversation, Message, Answers, Composer.** Your words in a Line bubble on the right. RMS answers in white, as a bubble or as cards. Answered questions fold into quiet chips. Send only has colour when there is something to send.
- **Dialog.** The platform dialog, for decisions that need full attention. A bottom sheet on a phone.
- **NavItem, BottomBar, Pager, Account, Logo, Skeleton, EmptyState.**
- **Patterns:** `Dashboard`, `ListDetail`, `FormLayout`, `ReportTable`, plus `Workbench` and `Feed`.

## Do's and Don'ts

- Do give colour only to things that can be pressed.
- Do say every state in words, with an ink shape beside it.
- Do pass the restaurant's colour through `themeFromBrand` or `<Theme brand>`. Never paint it directly.
- Do put anything you read on a white card, and use `--rms-muted` for secondary words.
- Do use compact density for report rows, charts and feeds, and comfortable for everything else.
- Do write in everyday words. No code, table names, tier codes or raw error text on owner screens.
- Don't colour a status, a tag, a chart series, a heading or an icon that cannot be pressed.
- Don't use red, amber or green to mean bad, warning or good.
- Don't round a label fully, or square off a button.
- Don't set text below 14px.
- Don't nest cards, add a second accent colour, or add entry animations.
- Don't write CSS, class names or inline styles in an app or a mini-app.
- Don't show a second way in to "Ask" on a screen that already has one.

## Known gaps

- The Marketplace listing card and a filled Mini-apps home exist only in the gallery, with seeded content. They are not wired to data.
- Settings does not yet tell the owner when their colour was darkened or replaced. `themeFromBrand` reports it; the screen is not built.
- Chart bars in Bar (`#A4B3C3`) are 2.1 to 1 against white, under the 3 to 1 asked of standalone graphics. Every bar carries its figure in text, so no information depends on the bar.
- Sign-in, onboarding and the maintainer console are plain HTML until they are skinned.
- No dark theme. The use scene is a lit kitchen or office, and the direction was approved light.
