# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

From the plan docs (D3, D11, D12, D27), confirmed by Rahul's work order: TypeScript everywhere, one pnpm + Turborepo monorepo, Next.js apps on Vercel (`rms-web`, `rms-admin`, `rms-apps`), a Hono API on Vercel functions, Supabase for the database, sign-in and files. All UI comes from one in-house library, `@rms/ui`.

## Users

**Primary: a restaurant owner or manager who is not technical** and may never have used an AI agent. They describe what they want in everyday words. They use RMS in two settings, equally:

- At a laptop in the back office: building a mini-app, reading reports, connecting systems.
- On a phone or a kitchen tablet, on the floor, mid-shift: daily entry, quick checks, often one-handed and interrupted.

**Staff** (shift leads, servers, cooks) use published mini-apps on phones and tablets, scoped to their role and location.

**Maintainers** (us) use a separate console to watch changes, approve what needs approval, and review marketplace listings.

## Product Purpose

RMS is a restaurant management system. Its **Mini-apps** area lets a restaurant build its own tools by talking to an agent (Build), or install one that already exists (Marketplace).

The owner says "I want to see how much money I'm making". The agent asks at most three plain questions, shows a plan, and builds a real working mini-app on the restaurant's own data, with a live preview.

Success: an owner gets a working, correct tool without ever seeing code, a table name or an error message, and trusts the numbers in it.

## Positioning

- The agent produces a **real app per restaurant**, not a configured template, yet every mini-app is built only from the maintainers' design system and shared data models. So it looks and behaves like part of RMS, and cannot be built insecurely.
- **Reuse before build.** RMS checks for an existing mini-app, an existing table and an existing component before making a new one. It will say "you already have this".
- **Restaurant-shaped data.** Business date, prime cost, tips and tax as liabilities, delivery payouts: built into the models, so no mini-app gets them wrong.

## Operating Context

- Restaurants run on a **business day** that ends around 4am, not midnight. Weeks and periods matter more than calendar months.
- The numbers owners watch: net sales, cost of goods, labour, and **prime cost** as a share of sales.
- **Parent data** is what RMS holds about the restaurant: profile, locations, staff, menu, tax rates, licences, equipment. Read-only to the restaurant and the agent.
- **Child data** is the restaurant's own: sales days, ledger, vendors, bills. It arrives by typing, upload, or a connected system (point of sale).
- A published mini-app appears in the RMS navigation and can be opened on its own from a phone home screen.
- Sharing a mini-app publicly needs maintainer approval. A listing never names the restaurant that made it.
- Five surfaces carry the demo: Mini-apps home (Build and Marketplace tabs), the build conversation with a live preview, a finished mini-app on a phone, the Marketplace with "Recommended for you", and the maintainer change feed.

## Capabilities and Constraints

- **Language for owners:** everyday words only. No code, table names, model names or raw error text on any owner-facing screen. When something fails, the owner sees "still working" or a plain explanation.
- **Conversation rules:** at most three questions before showing something. Always show what was assumed. Every confirmation says what will happen in one sentence. Undo is always offered.
- **Design system only.** Mini-app screens are composed from `@rms/ui` tokens, components and four patterns today: list with detail, form, dashboard, report table. No other UI library, no hand-written stylesheets.
- **Theming:** a restaurant may change its brand colour and logo. Nothing else. The look must survive any brand colour.
- **Terms that are fixed:** RMS, Mini-apps, Build, Marketplace, Recommended for you, parent data and child data (internal words, not shown to owners), maintainer console, change feed.
- **Tiers** in the maintainer feed: T0 cosmetic, T1 minor, T2 major and tenant-scoped, T3 touches the platform and waits for approval.
- English, US, US dollars to start.
- Not in the first version: offline mode, printing, realtime sync, native apps.
- **Undecided:** production domains (O4). Franchise depth (O5).

## Brand Commitments

- The product name shown to users is **RMS**.
- There is no logo yet. Rahul asked for one to be created as part of the design work.
- Voice: plain, short, calm. Speaks like a capable colleague, not like software. Never blames the owner.

## Evidence on Hand

- Demo data is **seeded and fictional**: Marigold Kitchen (full service, 2 locations, 24 staff, about 40 menu items) and Slice Yard (counter-service pizza, 1 location, 9 staff, about 20 items), with eight weeks of sales through a "Demo POS" connection.
- There are no real customers, testimonials, logos, press, pricing or usage numbers. Do not invent any.
- Domain research and sources: `docs/plan/02-restaurant-domain.md`.

## Product Principles

1. **The owner never sees the machinery.** Plain words in, a working tool out.
2. **Reuse before build.** Existing mini-app, then existing table, then existing component.
3. **Secure by construction.** The safe way is the only way the parts fit together. Security sometimes says no, and says it plainly.
4. **Parent data flows one way.** Read it, build on it, never change it.
5. **Numbers must be trusted.** Show where a number came from and what was assumed.

## Accessibility & Inclusion

- Touch-first: large targets, usable one-handed, readable at arm's length on a kitchen tablet in bright or dim light.
- Target WCAG 2.2 AA for contrast, focus and keyboard use. Set by the lead as a default, not yet confirmed by Rahul.
- Never rely on colour alone for money states (over, short, due) or for tiers.
