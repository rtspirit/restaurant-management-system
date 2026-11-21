import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, ChangeSignal, OwnerChangeNotice, SIGNAL_TIER, TIER_POLICY, toPublicId } from "@rms/contracts";
import { type Sql, adminDb, apiDb, closeAll, withOrg } from "@rms/db";
import {
  GovernanceError,
  INITIAL_DECISION,
  confirmByOwner,
  decideByStaff,
  drainOutbox,
  listFeed,
  listQueue,
  ownerNotice,
  recordChange,
  safeOwnerSummary,
  writeAudit,
} from "./index.js";

const envFile = resolve(import.meta.dirname, "../../../.env.local");
const mainEnv = "/Users/rahultiwari/github/restaurant-management-system/.env.local";
if (existsSync(envFile)) process.loadEnvFile(envFile);
else if (existsSync(mainEnv)) process.loadEnvFile(mainEnv);
const hasDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_ADMIN_URL && process.env.SUPABASE_URL);

// Task F id range: 0193a3c0-0000-7000-8000-0000000000f0 .. ff. Store prefixes o_f1f1f1f1f1xx.
const ORG_A = "0193a3c0-0000-7000-8000-0000000000f1";
const ORG_B = "0193a3c0-0000-7000-8000-0000000000f2";
const STAFF = "0193a3c0-0000-7000-8000-0000000000f3";
const PA = "o_f1f1f1f1f1f1";
const PB = "o_f1f1f1f1f1f2";

const owner: Actor = { type: "user", id: toPublicId("usr", "0193a3c0-0000-7000-8000-0000000000fe") };
const job: Actor = { type: "job", id: "governance_test" };

const supabase = () => (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
let staffUserId: string | undefined;

const createAuthUser = async (): Promise<string> => {
  const res = await fetch(`${supabase()}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "", "content-type": "application/json" },
    body: JSON.stringify({ email: `gov-${crypto.randomUUID()}@f.rms.test`, password: crypto.randomUUID() + crypto.randomUUID() }),
  });
  if (!res.ok) throw new Error(`sign-up failed with ${res.status}`);
  const body = (await res.json()) as { user: { id: string } };
  return body.user.id;
};

const deleteAuthUser = async (id: string) => {
  await fetch(`${supabase()}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: { apikey: process.env.SUPABASE_SECRET_KEY ?? "" } });
};

const cleanup = async (sql: Sql) => {
  const orgs = [ORG_A, ORG_B];
  await sql`delete from platform.notifications where org_id = any(${orgs}::uuid[])`;
  await sql`delete from platform.change_reviews where change_set_id in (select id from platform.change_sets where org_id = any(${orgs}::uuid[]))`;
  await sql`delete from platform.change_sets where org_id = any(${orgs}::uuid[])`;
  await sql`delete from platform.outbox where org_id = any(${orgs}::uuid[])`;
  await sql`delete from platform.audit_log where org_id = any(${orgs}::uuid[])`;
  await sql`delete from platform.staff_users where id = ${STAFF}`;
  await sql`delete from platform.organizations where id = any(${orgs}::uuid[])`;
};

const counts = async (changeUuid: string) => {
  const [r] = await adminDb()<{ cs: number; ob: number; au: number }[]>`
    select (select count(*)::int from platform.change_sets where id = ${changeUuid}) as cs,
           (select count(*)::int from platform.outbox where change_set_id = ${changeUuid}) as ob,
           (select count(*)::int from platform.audit_log where target_id = ${changeUuid}) as au`;
  return r;
};

const uuidOf = (publicId: string) => {
  const h = publicId.slice(4);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

describe("tier policy (no database)", () => {
  it("maps every signal's tier to the decision the policy table says", () => {
    for (const s of ChangeSignal.options) {
      const tier = SIGNAL_TIER[s];
      const d = INITIAL_DECISION[tier];
      if (TIER_POLICY[tier].hold) expect(d).toBe("pending_maintainer");
      else if (TIER_POLICY[tier].action === "apply_after_owner_confirm") expect(d).toBe("pending_owner");
      else expect(d).toBe("applied");
    }
  });

  it("never lets a tier code or signal name reach the owner", () => {
    expect(safeOwnerSummary("T3 change: public_share", ["public_share"])).toBe("Shared a mini-app with other restaurants");
    expect(safeOwnerSummary("Changed the menu screen", ["screen_change"])).toBe("Changed the menu screen");
    expect(safeOwnerSummary("x".repeat(300), ["theme_change"])).toBe("Changed colours or layout");
    expect(safeOwnerSummary(undefined, ["new_connection", "screen_change"])).toBe("Connected another system, and 1 other change");
    const notice = ownerNotice({
      id: toPublicId("chg", "0193a3c0-0000-7000-8000-0000000000ff"),
      orgId: toPublicId("org", ORG_A),
      appId: null,
      origin: "share",
      signals: ["public_share", "new_dependency"],
      tier: "T3",
      summary: "share: public_share, new_dependency",
      ownerSummary: "T3 hold",
      decision: "pending_maintainer",
      createdAt: new Date().toISOString(),
      decidedAt: null,
    });
    expect(OwnerChangeNotice.parse(notice).status).toBe("waiting_for_rms");
    const text = JSON.stringify(notice);
    expect(text).not.toMatch(/\bT[0-3]\b/);
    for (const s of ChangeSignal.options) expect(text).not.toContain(s);
  });
});

describe.skipIf(!hasDb)("change sets against the database", () => {
  beforeAll(async () => {
    const sql = adminDb();
    await cleanup(sql);
    await sql`insert into platform.organizations (id, slug, name, store_prefix)
              values (${ORG_A}, 'gov-test-a', 'Governance Test A', ${PA}), (${ORG_B}, 'gov-test-b', 'Governance Test B', ${PB})`;
    staffUserId = await createAuthUser();
    await sql`insert into platform.staff_users (id, user_id, name) values (${STAFF}, ${staffUserId}, 'Test Maintainer F')`;
  });

  afterAll(async () => {
    await cleanup(adminDb());
    if (staffUserId) await deleteAuthUser(staffUserId);
    await closeAll();
  });

  it("T0 and T1 apply straight away, from the restaurant-facing login", async () => {
    for (const [signals, tier] of [[["theme_change"], "T0"], [["screen_change", "new_model"], "T1"]] as const) {
      const cs = await withOrg(apiDb(), ORG_A, (tx) => recordChange(tx, { orgUuid: ORG_A, origin: "build", actor: owner, signals }));
      expect(cs.tier).toBe(tier);
      expect(cs.decision).toBe("applied");
      expect(cs.orgId).toBe(toPublicId("org", ORG_A));
      expect(await counts(uuidOf(cs.id))).toEqual({ cs: 1, ob: 1, au: 1 });
      const [row] = await adminDb()<{ applied_at: Date | null; actor: string }[]>`select applied_at, actor from platform.change_sets where id = ${uuidOf(cs.id)}`;
      expect(row?.applied_at).not.toBeNull();
      expect(row?.actor).toBe(`user:0193a3c0-0000-7000-8000-0000000000fe`);
    }
  });

  it("T2 waits for the owner; only the owner's own restaurant can confirm it", async () => {
    const cs = await withOrg(apiDb(), ORG_A, (tx) =>
      recordChange(tx, { orgUuid: ORG_A, origin: "connection", actor: owner, signals: ["new_connection", "screen_change"] }),
    );
    expect(cs.tier).toBe("T2");
    expect(cs.decision).toBe("pending_owner");
    expect(ownerNotice(cs).status).toBe("needs_your_ok");

    await expect(confirmByOwner(adminDb(), { orgUuid: ORG_B, changeSetId: cs.id, actor: owner, role: "owner" })).rejects.toThrow(GovernanceError);
    // A staff-role member of the right restaurant cannot confirm.
    await expect(confirmByOwner(adminDb(), { orgUuid: ORG_A, changeSetId: cs.id, actor: owner, role: "staff" })).rejects.toMatchObject({
      reason: "not_allowed",
    });
    const [still] = await adminDb()<{ decision: string }[]>`select decision from platform.change_sets where id = ${uuidOf(cs.id)}`;
    expect(still?.decision).toBe("pending_owner");
    const done = await confirmByOwner(adminDb(), { orgUuid: ORG_A, changeSetId: cs.id, actor: owner, role: "owner" });
    expect(done.decision).toBe("applied");
    expect(ownerNotice(done).status).toBe("done");
    await expect(confirmByOwner(adminDb(), { orgUuid: ORG_A, changeSetId: cs.id, actor: owner, role: "owner" })).rejects.toMatchObject({
      reason: "not_pending",
    });
    // A T2 change cannot be decided by a maintainer: it is the owner's call.
    const other = await withOrg(apiDb(), ORG_A, (tx) => recordChange(tx, { orgUuid: ORG_A, origin: "settings", actor: owner, signals: ["role_change"] }));
    await expect(
      decideByStaff(adminDb(), { changeSetId: other.id, staffUuid: STAFF, decision: "approve" }),
    ).rejects.toMatchObject({ reason: "not_pending" });
  });

  it("T3 is held until a maintainer decides, and the decision is recorded in change_reviews", async () => {
    const a = await withOrg(apiDb(), ORG_A, (tx) => recordChange(tx, { orgUuid: ORG_A, origin: "share", actor: owner, signals: ["public_share"] }));
    const b = await adminDb().begin((tx) => recordChange(tx, { orgUuid: ORG_B, origin: "system", actor: job, signals: ["new_dependency"] }));
    expect([a.tier, a.decision, b.tier, b.decision]).toEqual(["T3", "pending_maintainer", "T3", "pending_maintainer"]);

    const approved = await decideByStaff(adminDb(), { changeSetId: a.id, staffUuid: STAFF, decision: "approve", note: "Looks fine" });
    const rejected = await decideByStaff(adminDb(), { changeSetId: b.id, staffUuid: STAFF, decision: "reject" });
    expect(approved.decision).toBe("approved");
    expect(approved.decidedAt).not.toBeNull();
    expect(rejected.decision).toBe("rejected");
    expect(ownerNotice(rejected).status).toBe("declined");

    const reviews = await adminDb()<{ change_set_id: string; decision: string; note: string | null; staff_id: string }[]>`
      select change_set_id, decision, note, staff_id from platform.change_reviews
      where change_set_id in (${uuidOf(a.id)}, ${uuidOf(b.id)}) order by decision`;
    expect(reviews).toEqual([
      { change_set_id: uuidOf(a.id), decision: "approved", note: "Looks fine", staff_id: STAFF },
      { change_set_id: uuidOf(b.id), decision: "rejected", note: null, staff_id: STAFF },
    ]);
    await expect(decideByStaff(adminDb(), { changeSetId: a.id, staffUuid: STAFF, decision: "reject" })).rejects.toMatchObject({
      reason: "not_pending",
    });

    // The audit row under the restaurant's org says a maintainer decided, and nothing about who.
    const audit = await adminDb()<{ actor: string; meta: Record<string, unknown> }[]>`
      select actor, meta from platform.audit_log where target_id = ${uuidOf(a.id)} and action = 'change.approve'`;
    expect(audit).toEqual([{ actor: "system:maintainer", meta: { decision: "approved" } }]);
    expect(JSON.stringify(audit)).not.toContain(STAFF);
    expect(JSON.stringify(audit)).not.toContain(staffUserId as string);
    // Outbox payloads carry no signal names.
    const payloads = await adminDb()<{ payload: Record<string, unknown> }[]>`
      select payload from platform.outbox where change_set_id in (${uuidOf(a.id)}, ${uuidOf(b.id)})`;
    expect(payloads.length).toBe(4);
    for (const { payload } of payloads) {
      expect(payload).not.toHaveProperty("signals");
      for (const sig of ChangeSignal.options) expect(JSON.stringify(payload)).not.toContain(sig);
    }
  });

  it("writes the outbox and audit rows in the caller's transaction: roll back and they are gone", async () => {
    let id = "";
    await expect(
      withOrg(apiDb(), ORG_A, async (tx) => {
        const cs = await recordChange(tx, { orgUuid: ORG_A, origin: "build", actor: owner, signals: ["new_required_field"] });
        id = uuidOf(cs.id);
        expect(await tx`select 1 from platform.outbox where change_set_id = ${id}`).toHaveLength(1);
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    expect(id).not.toBe("");
    expect(await counts(id)).toEqual({ cs: 0, ob: 0, au: 0 });
  });

  it("the restaurant-facing login can neither decide a change nor record one for another restaurant", async () => {
    const cs = await withOrg(apiDb(), ORG_A, (tx) => recordChange(tx, { orgUuid: ORG_A, origin: "share", actor: owner, signals: ["public_share"] }));
    await expect(
      withOrg(apiDb(), ORG_A, (tx) => tx`update platform.change_sets set decision = 'approved' where id = ${uuidOf(cs.id)}`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withOrg(apiDb(), ORG_A, (tx) => recordChange(tx, { orgUuid: ORG_B, origin: "build", actor: owner, signals: ["theme_change"] })),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withOrg(apiDb(), ORG_A, (tx) => writeAudit(tx, { orgUuid: ORG_B, actor: owner, action: "change.record", targetType: "x" })),
    ).rejects.toThrow(/row-level security/);
  });

  it("drainOutbox notifies maintainers always and owners for T2 and T3", async () => {
    await drainOutbox(adminDb(), { orgUuids: [ORG_A, ORG_B] });
    const t0 = await withOrg(apiDb(), ORG_A, (tx) => recordChange(tx, { orgUuid: ORG_A, origin: "build", actor: owner, signals: ["theme_change"] }));
    const t2 = await withOrg(apiDb(), ORG_A, (tx) => recordChange(tx, { orgUuid: ORG_A, origin: "publish", actor: owner, signals: ["first_publish"] }));
    const t3 = await withOrg(apiDb(), ORG_B, (tx) => recordChange(tx, { orgUuid: ORG_B, origin: "share", actor: owner, signals: ["public_share"] }));

    const res = await drainOutbox(adminDb(), { orgUuids: [ORG_A, ORG_B] });
    expect(res).toEqual({ sent: 3, failed: 0, notifications: 5 });

    const notes = await adminDb()<{ change_set_id: string; audience: string; title: string; body: string }[]>`
      select change_set_id, audience, title, body from platform.notifications
      where change_set_id in (${uuidOf(t0.id)}, ${uuidOf(t2.id)}, ${uuidOf(t3.id)})`;
    const by = (id: string) => notes.filter((n) => n.change_set_id === uuidOf(id)).map((n) => n.audience).sort();
    expect(by(t0.id)).toEqual(["maintainer"]);
    expect(by(t2.id)).toEqual(["maintainer", "owner"]);
    expect(by(t3.id)).toEqual(["maintainer", "owner"]);
    expect(notes.find((n) => n.audience === "maintainer" && n.change_set_id === uuidOf(t3.id))?.title).toMatch(/^Governance Test B: /);
    for (const n of notes.filter((x) => x.audience === "owner")) {
      expect(`${n.title} ${n.body}`).not.toMatch(/\bT[0-3]\b/);
      for (const s of ChangeSignal.options) expect(`${n.title} ${n.body}`).not.toContain(s);
    }

    const pending = await adminDb()<{ n: number }[]>`
      select count(*)::int as n from platform.outbox where org_id = any(${[ORG_A, ORG_B]}::uuid[]) and status <> 'sent'`;
    expect(pending[0]?.n).toBe(0);
    // Draining again sends nothing new.
    expect(await drainOutbox(adminDb(), { orgUuids: [ORG_A, ORG_B] })).toEqual({ sent: 0, failed: 0, notifications: 0 });
  });

  it("notifications describe each event, even if the change moved on before the drain", async () => {
    await drainOutbox(adminDb(), { orgUuids: [ORG_A, ORG_B] });
    const t2 = await withOrg(apiDb(), ORG_A, (tx) => recordChange(tx, { orgUuid: ORG_A, origin: "settings", actor: owner, signals: ["role_change"] }));
    await confirmByOwner(adminDb(), { orgUuid: ORG_A, changeSetId: t2.id, actor: owner, role: "owner" });
    const t3 = await withOrg(apiDb(), ORG_B, (tx) => recordChange(tx, { orgUuid: ORG_B, origin: "share", actor: owner, signals: ["public_share"] }));
    await decideByStaff(adminDb(), { changeSetId: t3.id, staffUuid: STAFF, decision: "approve" });

    // Drain after the decisions; two drains at once never notify twice.
    const [r1, r2] = await Promise.all([
      drainOutbox(adminDb(), { orgUuids: [ORG_A, ORG_B] }),
      drainOutbox(adminDb(), { orgUuids: [ORG_A, ORG_B] }),
    ]);
    expect(r1.sent + r2.sent).toBe(4);
    expect(r1.notifications + r2.notifications).toBe(8);

    const owners = async (id: string) =>
      (
        await adminDb()<{ kind: string; body: string }[]>`
          select kind, body from platform.notifications where change_set_id = ${uuidOf(id)} and audience = 'owner' order by created_at, kind`
      ).map((n) => `${n.kind} | ${n.body}`);
    expect((await owners(t2.id)).sort()).toEqual([
      "change_set.created | Please look at this change and confirm it.",
      "change_set.decided | This change is now live.",
    ]);
    expect((await owners(t3.id)).sort()).toEqual([
      "change_set.created | Our team is checking this change. We will tell you when it is done.",
      "change_set.decided | Our team approved this change. It is now live.",
    ]);
    const [maint] = await adminDb()<{ n: number }[]>`
      select count(*)::int as n from platform.notifications where change_set_id in (${uuidOf(t2.id)}, ${uuidOf(t3.id)}) and audience = 'maintainer'`;
    expect(maint?.n).toBe(4);
  });

  it("a stored row whose tier disagrees with its signals does not break the feed, the queue or the drain", async () => {
    await drainOutbox(adminDb(), { orgUuids: [ORG_A, ORG_B] });
    const bad = "0193a3c0-0000-7000-8000-0000000000fa";
    const sql = adminDb();
    // Hand-made, as an old fixture would be: T0 with a T3 signal, held for a maintainer.
    await sql`insert into platform.change_sets (id, org_id, origin, actor, signals, tier, summary, decision)
              values (${bad}, ${ORG_B}, 'system', 'system:fixture', ${["public_share"]}::text[], 'T0', 'hand-made', 'pending_maintainer')`;
    await sql`insert into platform.outbox (topic, org_id, change_set_id, payload)
              values ('change_set.created', ${ORG_B}, ${bad}, ${sql.json({ tier: "T0", decision: "pending_maintainer" })})`;

    const feed = await listFeed(sql, { orgUuid: ORG_B, limit: 100 });
    const item = feed.items.find((i) => i.id === toPublicId("chg", bad));
    expect(item).toMatchObject({ mismatch: true, tier: "T0", signals: ["public_share"], restaurantName: "Governance Test B" });
    expect(feed.items.filter((i) => i.id !== toPublicId("chg", bad)).every((i) => i.mismatch === undefined)).toBe(true);
    const queue = await listQueue(sql, { orgUuid: ORG_B });
    expect(queue.find((i) => i.id === toPublicId("chg", bad))?.mismatch).toBe(true);

    expect(await drainOutbox(sql, { orgUuids: [ORG_A, ORG_B] })).toEqual({ sent: 1, failed: 0, notifications: 1 });
    const notes = await sql<{ audience: string; severity: string; kind: string }[]>`
      select audience, severity, kind from platform.notifications where change_set_id = ${bad}`;
    expect(notes).toEqual([{ audience: "maintainer", severity: "urgent", kind: "change_set.needs_a_look" }]);
    const [ob] = await sql<{ status: string; attempts: number }[]>`select status, attempts from platform.outbox where change_set_id = ${bad}`;
    expect(ob).toEqual({ status: "sent", attempts: 1 });
  });

  it("the restaurant-facing login cannot mark outbox rows sent or create notifications", async () => {
    await expect(withOrg(apiDb(), ORG_A, (tx) => tx`update platform.outbox set status = 'sent' where org_id = ${ORG_A}`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      withOrg(apiDb(), ORG_A, (tx) => tx`insert into platform.notifications (id, audience, org_id, kind, title) values (gen_random_uuid(), 'owner', ${ORG_A}, 'x', 'x')`),
    ).rejects.toThrow(/permission denied/);
  });
});
