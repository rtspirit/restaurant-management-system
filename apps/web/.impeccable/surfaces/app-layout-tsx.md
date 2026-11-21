---
version: 1
slug: "app-layout-tsx"
primary_target: "app/layout.tsx"
related_targets: []
---

# RMS app surfaces (web shell, Mini-apps, published mini-apps, maintainer console)

Scope: every owner-facing screen in `apps/web`, every mini-app screen built from `@rms/ui`, and the maintainer console in `apps/admin`. Visitor mode: Operate.

Audience and job: a non-technical restaurant owner or manager, at a back-office laptop and on a phone mid-shift, getting a working tool by describing it in plain words and then trusting its numbers. Maintainers use the console to watch and approve changes.

Constraints: `@rms/ui` only. Everyday words only. Touch targets 44px or more. WCAG 2.2 AA. The action colour is replaced by each restaurant's brand colour, so the system must hold for any colour.

Chosen at checkpoint C0 by Rahul on the decision page: "Front of House". Approved sketches: `docs/design/c0/4-front-of-house-desktop.html` and `docs/design/c0/4-front-of-house-phone.html`.

## Direction contract

THESIS: If it has colour, you can press it. Everything else stays calm. Refuses the category default of a grey sidebar, white card grid and blue everything, where colour decorates and nothing tells an owner what is safe to touch.

OWN-WORLD: Slate ground `#DEE7F2` (the blue-grey of a menu board; changed from the sketch's cream `#F4EEE6` by Rahul's decision during the Wave 1 build, with hairlines `#CAD6E2`, bars `#A4B3C3` and secondary text `#4C5661` on ground, `#616C77` on card, all derived from the same hue), white cards, ink `#1E2420`, ONE action colour (basil `#12804A` by default, replaced by the restaurant's brand colour). Colour appears only on pressable things. Fully rounded = a button. 8 to 16px corners = something you read. States (over target, done, slow week) are words plus ink shapes, never colour. Nunito Sans, heavy for figures and headings, tabular figures. Comfortable density with a tighter mode for report rows and charts.

STORY: The owner sees a calm screen, knows at a glance what can be pressed, says what they want, confirms a short plan, and watches a real tool appear with their own numbers. They believe it because the lead number is plain and its parts add up beside it. They publish.

FIRST VIEWPORT: Desktop 1440 x 900. Light side rail on the tinted ground with the RMS wordmark, restaurant name, location switcher and six nav items. Mini-apps title with Build and Marketplace tabs. Left column: the conversation as soft cards (request, two answered questions as quiet chips, the plan, what was assumed, three progress steps), composer pinned at the bottom with a green Send. Right column: Preview with a "Sample numbers" tag, then the Money mini-app as a stack of one-idea cards (prime cost 61.3% largest, three money figures, eight weeks, by location). Primary action "Publish" bottom right in the action colour, "Try it on my phone" beside it. Phone 390 x 844: the published Money mini-app with a thumb-reach bottom bar.

SIGNATURE: "Colour means press." Signature interaction: a soft spring on press for anything coloured, and a disabled action loses its colour entirely. Motion grammar: press feedback only, no entry bounce, reduced motion respected.

FORM: Friendly consumer app surface (catalog world `digital-design-canon-warm-consumer-app-surface`), a competitive challenger the user chose over the assigned direction. seed:1d97ec5b1a76a7a0.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Known gaps to close in the build

- Brand colour safety: derive a darkened "action" step automatically so white text on buttons and coloured text on white both pass AA for any brand colour. Light brand colours failed in the sketch.
- The detector flags the ground as a cream default. Rahul chose the direction with that disclosed. Keep the ground but let cards, ink and the action colour carry the identity.
- Dense screens (report table, maintainer change feed) need the tighter density mode designed, not improvised.
- "Ask" appeared twice on the phone sketch. Keep one entry point.
- Chart labels were 13px in the sketch. Minimum is 14px in the build.
- Still to design: Mini-apps home, Marketplace with "Recommended for you", maintainer change feed, the RMS logo.

## Wave 1 build status (task E)

Built in `packages/ui` and `apps/web`. Review at `/gallery`, `/gallery/build`, `/gallery/money`. Recorded in `DESIGN.md`. Finish review run once by a fresh reviewer; its seven fixes were applied.

- Brand colour safety: closed. `themeFromBrand` in `packages/ui/src/theme.ts`, proven by `theme.test.ts`. Greys, black and white fall back to basil.
- Cream ground: replaced. Rahul asked for a more distinct tint; the ground is now slate `#DEE7F2` with its neutrals derived from it. `/gallery` shows the old ground, slate and one alternative side by side.
- Dense screens: closed. `data-density="compact"`, used by `ReportTable` and `Feed`.
- "Ask" twice: closed. One way in on the Money screen (the button under the numbers). The bottom bar has no Ask.
- Chart labels: closed. 14px minimum everywhere.
- RMS logo: closed. Wordmark with a full stop that takes colour only when it can be pressed.
- Mini-apps home: built (empty state in the shell, filled state in the gallery with seeded content).
- Marketplace with "Recommended for you": empty state in the shell, listing card in the gallery with seeded content. Not wired to data.
- Maintainer change feed: the compact `Feed` component is in the gallery. The console itself (task F) is unskinned.
- Still open: Settings telling the owner their colour was darkened or replaced; skinning sign-in, onboarding and the console; an app icon.
