# Wave 4: critique, audit and polish of the screens that already exist

Date: 2026-11-21. Branch `worktree-agent-a833fe34997c6af9c`. Refinement of the approved look ("Front of House"), not a redesign.

Screens covered: web sign-in, sign-up, onboarding, the shell, Home, Menu, Staff, Locations, Mini-apps (Build and Marketplace as they stand), Settings, `/gallery`; console sign-in, change feed, review queue. Each at 1280x800 and 390x844, as Marigold Kitchen (orange) and Slice Yard (red), plus a staff member and the maintainer.

## Not done, or not proven

- **The location switcher still does nothing.** It is the worst thing left on screen. Hiding it changes the approved shell, so it is a lead decision (below).
- **Home is still nearly empty** for a new sign-up. Fixing it means loading the menu, staff and location counts on Home, which is data loading and a page other agents may be editing. Lead decision (below).
- **The browser tests in `tests/e2e/` were not run.** They run against the shared servers on 3000 and 3001, not this branch's build. I read them and kept every word they wait for. What should change in them is listed at the end.
- **A feed row "Waiting for us" was not seen with live data.** The queue was empty when the after pictures were taken. The row uses the same outlined-row path the gallery and the UI tests already cover.
- **The sign-in limit was checked by playing the sign-in service's answer back inside the browser**, not by tripping the real limit. Both pages then said "Too many tries. Wait a minute and try again."
- **I made about 45 real sign-ins on the shared local sign-in service in about ten minutes** while re-running my own checks. All succeeded, so the limit did not trip, but that was more than it should have been.
- The "after" critique score is my own re-score in one context. The "before" score came from a separate reviewer that had not seen the detector's output.
- The critique was not saved to `.impeccable/critique/`. This file is the record.

## Critique (Nielsen's ten, 0 to 4 each)

| # | Heuristic | Before | After | What moved it |
|---|---|---|---|---|
| 1 | Status is visible | 3 | 3 | "More" is now marked on Locations and Settings. The switcher still implies a filter. |
| 2 | Matches the real world | 3 | 3 | "Eastern Time", not "America/New York". Dates are still "11 Sept 2023". |
| 3 | Control and freedom | 3 | 3 | Reject in the queue is still instant. |
| 4 | Consistency | 3 | 3 | Menu no longer prints dishes as quiet labels. Empty-state widths still differ. |
| 5 | Error prevention | 2 | 3 | Password mismatch is said at its field. A non-maintainer never reaches the console. |
| 6 | Recognition | 3 | 3 | No more cut-off columns on Staff. |
| 7 | Flexibility | 2 | 2 | No search or sort on Staff or Menu. Feed filters still need "Apply filters". |
| 8 | Minimal | 3 | 3 | Feed times are shorter. Feed sentences come from the API and are still noisy. |
| 9 | Error recovery | 3 | 4 | Every refusal I could reach now says what to do next. |
| 10 | Help | 2 | 2 | Good one-line explanations, no help entry. |
| | **Total** | **27/40** | **29/40** | Good band both times. |

Method: design review by one sub-agent from screenshots and source; detector scan by a second, kept apart. Questions skipped: delegated run.

## Audit (0 to 4 each)

| Dimension | Before | After | Key finding |
|---|---|---|---|
| Accessibility | 3 | 3 | Contrast passes on both brands on all 64 captured screens. Focus ring is strong. |
| Performance | 3 | 3 | Nothing found by reading. Not measured. |
| Theming | 3 | 3 | No hard-coded colour in the stylesheet. No dark theme, by decision. |
| Responsive | 2 | 3 | Staff table was cut off on a laptop and unusable on a phone. Fixed. |
| Integrity | 4 | 4 | Detector: no findings in 63 source files and 12 page scans. UI only from `@rms/ui`. |
| **Total** | **15/20** | **16/20** | |

### Findings and what was done

| # | Sev | Finding | Done |
|---|---|---|---|
| 1 | P1 | Staff (owner), 1280 wide: the Phone column was cut to "+1 202" under the pinned pay column. | **Fixed.** The job sits under each name, so five columns fit with room to spare. |
| 2 | P1 | Staff, phone: job titles cut off in a 70px strip between two pinned columns. | **Fixed.** On a phone, Started, Email and Phone move under the name; Name and Hourly rate stay as columns. |
| 3 | P1 | Console: an owner saw the filters, tier names and navigation around the refusal. | **Fixed** (lead's bug 2). The frame asks the API once and draws nothing of the console until it says "maintainer". |
| 4 | P1 | Onboarding hid the API's plain reason for a refusal behind a generic line. | **Fixed** (lead's bug 1). |
| 5 | P1 | Sign-in, web and console: the attempt limit showed the wrong-password line. | **Fixed** (lead's bug 3). Sign-up gets the same line. |
| 6 | P2 | Menu: dish names in quiet grey, prices heavy, description run into the name with a colon. | **Fixed.** Name in ink, description under it, price beside it. Summary now counts the extras. |
| 7 | P2 | Shell: the seeded account read "Owner" over "Owner". | **Fixed.** A name that is only the role again shows the restaurant under it. |
| 8 | P2 | Phone: nothing in the bottom bar was marked on Locations or Settings. | **Fixed.** "More" takes the marker. |
| 9 | P2 | Sign-up: "The two passwords are not the same." sat below the card, fields unmarked. | **Fixed.** Said at the second password box, with how to fix it. |
| 10 | P2 | Locations: "America/New York". | **Fixed.** "Eastern Time". |
| 11 | P2 | Console feed: times like "11/21/2026, 3:31:42 PM"; rows waiting for us looked like any other. | **Fixed.** "Nov 21, 3:31 PM"; a row waiting for a maintainer is outlined and labelled in the feed. |
| 12 | P2 | Console: empty feed and empty queue were a bare line of text. | **Fixed.** Empty states that say what shows there. |
| 13 | P3 | Console on a phone: "Sign out" alone on its own row. | **Fixed.** It sits on the top line; navigation takes the line under it. |
| 14 | P1 | Location switcher changes nothing. | **Left.** Lead decision. |
| 15 | P1 | Home is nearly empty for a new sign-up. | **Left.** Lead decision. |
| 16 | P2 | Dates are British ("11 Sept 2023") in a US-dollar product. | **Left.** The format lives in `apps/web/lib/parent-server.ts`, which is not mine. |
| 17 | P2 | Review queue: Approve is the filled button on every row; Reject is instant, with no confirm. | **Left.** Changes how deciding works, and browser tests press these buttons. Lead decision. |
| 18 | P2 | A staff account is offered "Build a mini-app" and Settings. | **Left.** A product rule, not a look. |
| 19 | P3 | Console says "Loading..." with three dots; the web app uses "…". | **Left standing.** The browser tests wait on the exact words "Loading...". |
| 20 | P3 | Marketplace's empty state is full width; Home's and Build's are capped. | **Left.** Marketplace pages belong to another agent. |
| 21 | P3 | "Create an account" and "Sign in" links are 22px tall. | **Left.** Links inside a sentence are the allowed exception. |
| 22 | P3 | Every table is a keyboard stop, even when it does not scroll. | **Left.** Harmless; not seen in a demo. |
| 23 | P3 | Menu, Staff and Locations show nothing while they load; the old page stays. | **Left.** A skeleton would flash on every click on a fast machine. Worth a look on the hosted app. |
| 24 | P3 | Feed sentences read like a program wrote them (`new_model`, `user:0193...`). | **Left.** The text comes from the API. Fine for maintainers. |

Detector hook: it reported after every edit and found nothing. Fixed 0, suppressed 0, left standing 0. It stopped reporting on `styles.css` after six edits; one last manual scan of the changed sources also found nothing.

## Shared components changed (all backward compatible)

| Component | Change |
|---|---|
| `Stepper` | New step state `stopped` ("Did not finish"): an ink ring around a solid ink square, heavy words, no colour. `words` now takes any subset of states. In `/gallery` and the UI tests. |
| `DataTable` (and `ReportTable` through it) | Rows take an optional `subtitle`. Columns take optional `onPhone: "under-name"` or `"under-name-bare"`. Tables that use neither are drawn exactly as before. |
| `DetailList` | Rows take an optional `note`. New optional `lead="label"` for a list of things. Default look unchanged. |
| `BottomBarItem` | The button form (More) now honours `current`. |
| `CanvasHeader` (style only) | On a phone, navigation moves to its own line under the logo and the sign-out button. |

`DESIGN.md` does not mention the `stopped` step, the table options or `lead="label"` yet. I left it alone: it is not in my brief.

`packages/ui/src/styles.css` was edited for these (component rules only, no token values). It is not named in my brief, but it is where every component's look lives and the UI tests read it. No token needs to change.

Also edited outside `app/`: `apps/web/components/rms-shell.tsx` (account lines, More marker), `apps/admin/components/change-table.tsx`, `console-frame.tsx` and `sign-out-button.tsx`. These are the shell and the console frame themselves.

## Lead decisions

1. **Location switcher.** Hide it until it filters, or keep it and do not touch it in the demo. I would hide it.
2. **Home.** Add one card, "Your restaurant": menu items, people, locations, each a count. It proves beat 1 at a glance. Needs three list reads on Home.
3. **Console "who am I".** Today the frame learns who is a maintainer by asking for the review queue (one refused request per page load for an owner; the feed is never asked for). To make that zero requests to data routes, the API needs a small route such as `GET /admin/me`. Then it is a one-line change in `console-frame.tsx`.
4. **Review queue.** Confirm before Reject, and quieter row buttons.
5. **Date format** in `parent-server.ts`: "Sep 11, 2023".

## Browser tests: what should change (I did not edit them)

- `tests/e2e/specs/console.spec.ts`, "an owner in the console": the comment "The filter form (with its tier names) stays on screen for an owner" is no longer true. Add: no "Tier" or "Status" control, no "Apply filters", no "Change feed" or "Review queue" heading or link, one "Sign out" button. `expectCleanScreen(page, "maintainer")` can become the owner rule. The request checks (two or more, all 403) still pass as written. If decision 3 lands, change them to "no request to `/admin/feed` or `/admin/queue`".
- `tests/e2e/beats/beat-1-sign-up-and-onboarding.spec.ts`: only the comment ("the page then says it could not set up the restaurant"). The page now says the API's own sentence.
- `tests/e2e/specs/sign-in.spec.ts`: nothing to change. A new test could play back a 429 from the sign-in service and expect "Too many tries. Wait a minute and try again."
- Nothing else. "Loading...", "No changes match these filters.", "Nothing is waiting for review." and "Changes held until a maintainer approves them" are all still on screen where the tests look.

## Pictures

In this folder, `before-*` and `after-*` with the same name:

- Home, both brands, desktop and phone: `*-marigold-home-*`, `*-sliceyard-home-*`
- Staff, both brands, desktop and phone: `*-marigold-staff-*`, `*-sliceyard-staff-*`
- Menu: `*-marigold-menu-desktop.png`, `*-marigold-menu-phone.png`
- Locations on a phone (More marker, time zone): `*-marigold-locations-phone.png`
- Sign-up error on a phone: `*-web-sign-up-error-phone.png`
- Console: `*-console-feed-desktop.png`, `*-console-feed-phone.png`, `*-console-queue-desktop.png`, `*-console-owner-refused-desktop.png`

After only: `after-gallery-stepper-stopped-desktop.png` and `-phone.png`, `after-web-onboarding-refused-desktop.png`, `after-console-owner-refused-phone.png`, `after-web-not-answering-desktop.png`, `after-console-not-answering-desktop.png`.

The before pictures are of the shared servers on `main`. The after pictures are of this branch, built and run on other ports, against the same local database. Other agents' test rows were in the feed at the time, so the feed rows differ between the two.
