// Change sets: record, confirm, decide. The tier always comes from the signals, the decision
// always from the tier. Each write also appends an outbox row and an audit row in the SAME
// transaction, so a rolled-back change leaves no announcement and no audit trail behind.
import {
  type Actor,
  ChangeOrigin,
  type ChangeSet,
  ChangeSet as ChangeSetSchema,
  type ChangeSignal,
  ChangeSignal as ChangeSignalSchema,
  type OutboxMessage,
  type OwnerChangeNotice,
  type Role,
  type Tier,
  toPublicId,
  toUuid,
  tierForSignals,
} from "@rms/contracts";
import { type Sql, type Tx, actorText, newUuid } from "@rms/db";
import { orgUuidOf, writeAudit } from "./audit.js";
import { maintainerSummary, ownerSummaryFor, safeOwnerSummary, sortSignals } from "./summaries.js";

type Origin = (typeof ChangeOrigin.options)[number];
export type Decision = ChangeSet["decision"];

/** What `TIER_POLICY` means for a brand-new change set. Matches the database policy (ADR 0004). */
export const INITIAL_DECISION: Record<Tier, Decision> = {
  T0: "applied",
  T1: "applied",
  T2: "pending_owner",
  T3: "pending_maintainer",
};

export class GovernanceError extends Error {
  constructor(readonly reason: "not_found" | "not_pending" | "not_allowed") {
    super(reason);
  }
}

/**
 * A change set plus the governance-only columns the console and owner notices need.
 * `mismatch` is true when the stored row does not pass the ChangeSet contract (for example its
 * tier disagrees with its signals). Such a row is still returned, with its stored values, so the
 * console can show it as "needs a look" instead of failing.
 */
export type RecordedChange = ChangeSet & { ownerSummary: string; actor: string; mismatch?: true };

export type ChangeRow = {
  id: string;
  org_id: string;
  app_id: string | null;
  origin: Origin;
  actor: string;
  signals: string[];
  tier: Tier;
  summary: string;
  owner_summary: string;
  decision: Decision;
  decided_at: Date | null;
  created_at: Date;
};

/** Maps a stored row. Never throws on a malformed row: it is flagged with `mismatch: true`. */
export const toChangeSet = (r: ChangeRow): RecordedChange => {
  const raw = {
    id: toPublicId("chg", r.id),
    orgId: toPublicId("org", r.org_id),
    appId: r.app_id ? toPublicId("app", r.app_id) : null,
    origin: r.origin,
    signals: r.signals,
    tier: r.tier,
    summary: r.summary,
    decision: r.decision,
    createdAt: r.created_at.toISOString(),
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
  };
  const parsed = ChangeSetSchema.safeParse(raw);
  if (parsed.success) return { ...parsed.data, ownerSummary: r.owner_summary, actor: r.actor };
  return { ...(raw as unknown as ChangeSet), ownerSummary: r.owner_summary, actor: r.actor, mismatch: true };
};

const changeUuidOf = (id: string): string => (id.startsWith("chg_") ? toUuid(id) : id);

const writeOutbox = async (tx: Tx, msg: OutboxMessage): Promise<void> => {
  await tx`
    insert into platform.outbox (topic, org_id, change_set_id, payload)
    values (${msg.topic}, ${orgUuidOf(msg.orgId)}, ${msg.changeSetId ? changeUuidOf(msg.changeSetId) : null}, ${tx.json(msg.payload as never)})`;
};

export type RecordChangeInput = {
  /** Raw uuid or `org_` id. MUST come from a verified session or token, or a platform job. */
  orgUuid: string;
  appUuid?: string | null;
  origin: Origin;
  actor: Actor;
  signals: readonly ChangeSignal[];
  /** Maintainer summary. Defaults to a rule-based one. */
  summary?: string;
  /** Owner summary, plain words. Replaced by a rule-based one if it is not plain words. */
  ownerSummary?: string;
  /** Keys and shapes only, never field values tagged personal, payroll or financial. */
  diff?: Record<string, unknown>;
  runUuid?: string | null;
  requestId?: string | null;
};

/**
 * Records one change set in the caller's transaction, with its outbox row and audit row.
 * `tx` may come from `withOrg(apiDb(), org, ...)` (restaurant-facing) or `adminDb().begin` (jobs).
 */
export const recordChange = async (tx: Tx, input: RecordChangeInput): Promise<RecordedChange> => {
  const origin = ChangeOrigin.parse(input.origin);
  const signals = sortSignals(input.signals.map((s) => ChangeSignalSchema.parse(s)));
  const tier = tierForSignals(signals);
  const decision = INITIAL_DECISION[tier];
  const orgUuid = orgUuidOf(input.orgUuid);
  const appUuid = input.appUuid ? (input.appUuid.startsWith("app_") ? toUuid(input.appUuid) : input.appUuid) : null;
  const summary = (input.summary?.trim() || maintainerSummary(origin, signals)).slice(0, 500);
  const ownerSummary = safeOwnerSummary(input.ownerSummary, signals);
  const id = newUuid();

  const [row] = await tx<ChangeRow[]>`
    insert into platform.change_sets
      (id, org_id, app_id, origin, run_id, actor, signals, tier, summary, owner_summary, diff, decision, applied_at)
    values
      (${id}, ${orgUuid}, ${appUuid}, ${origin}, ${input.runUuid ?? null}, ${actorText(input.actor)}, ${signals}::text[],
       ${tier}, ${summary}, ${ownerSummary}, ${tx.json((input.diff ?? {}) as never)}, ${decision},
       ${decision === "applied" ? tx`now()` : null})
    returning id, org_id, app_id, origin, actor, signals, tier, summary, owner_summary, decision, decided_at, created_at`;
  if (!row) throw new Error("Change set was not recorded");

  await writeOutbox(tx, {
    topic: "change_set.created",
    orgId: toPublicId("org", orgUuid),
    changeSetId: toPublicId("chg", id),
    payload: { tier, decision, origin },
  });
  await writeAudit(tx, {
    orgUuid,
    actor: input.actor,
    action: "change.record",
    targetType: "change_set",
    targetId: id,
    meta: { tier, decision, origin, signalCount: signals.length },
    requestId: input.requestId ?? null,
  });
  return toChangeSet(row);
};

const RETURNING = "id, org_id, app_id, origin, actor, signals, tier, summary, owner_summary, decision, decided_at, created_at";

/**
 * The owner says yes to a change waiting for them (T2). Admin connection only: the database
 * refuses change set updates from `rms_api`. `orgUuid` and `role` MUST come from the caller's
 * verified session, so only an owner, and only of that restaurant, can confirm.
 */
export const confirmByOwner = async (
  adminSql: Sql,
  input: { orgUuid: string; changeSetId: string; actor: Actor; role: Role; requestId?: string | null },
): Promise<RecordedChange> => {
  if (input.role !== "owner") throw new GovernanceError("not_allowed");
  const orgUuid = orgUuidOf(input.orgUuid);
  const id = changeUuidOf(input.changeSetId);
  return adminSql.begin(async (tx) => {
    const [current] = await tx<{ decision: Decision }[]>`
      select decision from platform.change_sets where id = ${id} and org_id = ${orgUuid} for update`;
    if (!current) throw new GovernanceError("not_found");
    if (current.decision !== "pending_owner") throw new GovernanceError("not_pending");
    const [row] = await tx.unsafe<ChangeRow[]>(
      `update platform.change_sets set decision = 'applied', applied_at = now(), decided_at = now()
       where id = $1 and org_id = $2 returning ${RETURNING}`,
      [id, orgUuid],
    );
    if (!row) throw new GovernanceError("not_found");
    await writeOutbox(tx, {
      topic: "change_set.decided",
      orgId: toPublicId("org", orgUuid),
      changeSetId: toPublicId("chg", id),
      payload: { tier: row.tier, decision: "applied", by: "owner" },
    });
    await writeAudit(tx, {
      orgUuid,
      actor: input.actor,
      action: "change.confirm",
      targetType: "change_set",
      targetId: id,
      meta: { tier: row.tier },
      requestId: input.requestId ?? null,
    });
    return toChangeSet(row);
  }) as Promise<RecordedChange>;
};

/**
 * A maintainer approves or rejects a change held for them (T3). Admin connection only.
 * Writes the review row, the decision, an outbox row and an audit row in one transaction.
 */
export const decideByStaff = async (
  adminSql: Sql,
  input: {
    changeSetId: string;
    staffUuid: string;
    decision: "approve" | "reject";
    note?: string | null;
    requestId?: string | null;
  },
): Promise<RecordedChange> => {
  const id = changeUuidOf(input.changeSetId);
  const decision: Decision = input.decision === "approve" ? "approved" : "rejected";
  const note = input.note?.trim() ? input.note.trim().slice(0, 1000) : null;
  return adminSql.begin(async (tx) => {
    const [current] = await tx<{ decision: Decision; org_id: string }[]>`
      select decision, org_id from platform.change_sets where id = ${id} for update`;
    if (!current) throw new GovernanceError("not_found");
    if (current.decision !== "pending_maintainer") throw new GovernanceError("not_pending");
    await tx`
      insert into platform.change_reviews (id, change_set_id, staff_id, decision, note)
      values (${newUuid()}, ${id}, ${input.staffUuid}, ${decision}, ${note})`;
    const [row] = await tx.unsafe<ChangeRow[]>(
      `update platform.change_sets
         set decision = $2, decided_by_staff_id = $3, decided_at = now(),
             applied_at = case when $2 = 'approved' then now() else applied_at end
       where id = $1 returning ${RETURNING}`,
      [id, decision, input.staffUuid],
    );
    if (!row) throw new GovernanceError("not_found");
    await writeOutbox(tx, {
      topic: "change_set.decided",
      orgId: toPublicId("org", current.org_id),
      changeSetId: toPublicId("chg", id),
      payload: { tier: row.tier, decision, by: "maintainer" },
    });
    // This audit row sits under the restaurant's org, which the restaurant-facing login can
    // read: it says a maintainer decided, nothing more. Who decided, and the note, stay in
    // change_reviews (maintainer-only).
    await writeAudit(tx, {
      orgUuid: current.org_id,
      actor: { type: "system", id: "maintainer" },
      action: decision === "approved" ? "change.approve" : "change.reject",
      targetType: "change_set",
      targetId: id,
      meta: { decision: decision === "approved" ? "approved" : "declined" },
      requestId: input.requestId ?? null,
    });
    return toChangeSet(row);
  }) as Promise<RecordedChange>;
};

export const OWNER_STATUS: Record<Decision, OwnerChangeNotice["status"]> = {
  applied: "done",
  pending_owner: "needs_your_ok",
  pending_maintainer: "waiting_for_rms",
  approved: "approved",
  rejected: "declined",
};

/** The change as the owner sees it: plain words, no tier codes, no signal names. */
export const ownerNotice = (change: ChangeSet & { ownerSummary?: string }): OwnerChangeNotice => ({
  id: change.id,
  summary: change.ownerSummary !== undefined ? safeOwnerSummary(change.ownerSummary, change.signals) : ownerSummaryFor(change.signals),
  status: OWNER_STATUS[change.decision],
  at: change.decidedAt ?? change.createdAt,
});
