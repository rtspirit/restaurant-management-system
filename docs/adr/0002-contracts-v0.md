# 0002: Contracts v0 decisions

Date: 2026-11-21. Status: decided by the lead after the architect review ("fix first", ten findings, all addressed in contracts 0.2.0).

## Decisions

1. **Money is whole minor units as a JSON number. Currency is one column per row**, not per field. A ledger line has a debit and a credit in the same currency, and the balance rule checks one currency per entry.
2. **Rows use raw uuids. Platform objects use prefixed ids** (`org_`, `app_`, ...) in tokens, platform APIs and URLs. Convert at the edge.
3. **RMS tokens are HS256 JWTs** signed with `RMS_TOKEN_SECRET`, sent as a bearer header. An app token is live-only and pins a published version. A run token is draft-only.
4. **No free text reaches SQL from a definition.** Check rules are an expression tree. Identifiers match one strict pattern.
5. **The agent can only create "custom" models with check rules.** Library models are used through `use_template`. Ledger rules (balanced, open period, liabilities never revenue) are library-only.
6. **Named queries are read-only. Named actions do writes.** Both are written by maintainers. Posting a day of sales to the ledger is a named action. Mini-apps still have no server logic of their own today.
7. **The server sets `source`, `created_by` and the other system fields.** A caller may set only `location_id` and `currency`, and `location_id` is checked against the token.
8. **A role that cannot read a field cannot write, filter, sort or total on it either.**
9. **Nothing internal goes to the browser in agent events**: no manifest, no match score, no tier code. Owners get an `OwnerChangeNotice` in plain words.

## New demo shortcut (undo before real users)

**The Ask agent is owner-only today.** There is one `_ask` database login per restaurant, and it can read every column. Masking free-form SQL after the fact can be beaten with an alias, so staff do not get Ask until there is a second login with column-level grants.

## Follow-ups owned by the lead

- One provisioning function for schemas, roles and grants, used by parent data (B) and the model compiler (C).
- Schema must have: unique `store_prefix`, an idempotency table keyed by org, app, env and user, unique (run, seq) on agent events, a public listings view with no publisher column, tenant roles with no rights on `platform` or `public`, append-only by grants, millisecond `updated_at`.
- The accounts mini-app needs `vendor`, `vendor_bill`, `vendor_bill_line` and `labour_day`, which sit outside the three packs. They ship today under their own packs.
- Still to add before Wave 2: connect and frame-token shapes. Before Wave 3: publish, share and install shapes.
