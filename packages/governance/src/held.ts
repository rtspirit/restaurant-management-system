// Held actions: recording what a change is waiting to do, and doing it (or cancelling it) when
// someone decides. Task O owns this file. Brief: docs/briefs/wave3.md, task O.
// Contract: `HeldAction` and `HeldState` in packages/contracts/src/changes.ts.
//
// The types and `holdAction` are final. `decideAndResume` and `confirmAndResume` are stubs
// until task O lands: they refuse, so nothing can be approved by a half-built path.
import { type Actor, HeldAction, type HeldActionKind, type HeldState, type Role, toUuid } from "@rms/contracts";
import type { Sql, Tx } from "@rms/db";
import { GovernanceError, type RecordedChange } from "./changes.js";

/** What a handler is told. `orgUuid` is the restaurant the CHANGE belongs to, read from the change set row. */
export type HeldContext = { orgUuid: string; changeSetUuid: string; requestId?: string | null };

/**
 * The two things that can happen to a held action. Both run inside the decision's own
 * transaction (`tx` is the platform login), so the decision and its effect land together or
 * not at all. A handler MUST first check that the thing the action names belongs to
 * `ctx.orgUuid` and is still waiting, and throw `GovernanceError("not_allowed")` if not: the ids
 * in a held action are a pointer, never a permission.
 */
export type HeldHandler<A extends HeldAction = HeldAction> = {
  approve(tx: Tx, ctx: HeldContext, action: A): Promise<void>;
  reject(tx: Tx, ctx: HeldContext, action: A): Promise<void>;
};

/** One handler per kind, given by the code that wires the routes. A kind with no handler cannot be approved. */
export type HeldHandlers = { [K in HeldActionKind]?: HeldHandler<Extract<HeldAction, { kind: K }>> };

const uuidOf = (id: string, prefix: string): string => (id.startsWith(`${prefix}_`) ? toUuid(id) : id);

/**
 * Puts a held action on a change that is waiting for a maintainer. Platform login only: the
 * database refuses these columns from the restaurant-facing login. Call it in the same
 * transaction that recorded the change. `orgUuid` is the restaurant of the verified session.
 */
export const holdAction = async (adminTx: Tx, input: { orgUuid: string; changeSetId: string; action: HeldAction }): Promise<void> => {
  const action = HeldAction.parse(input.action);
  const rows = await adminTx`
    update platform.change_sets
       set held_action = ${adminTx.json(action as never)}, held_state = 'waiting'
     where id = ${uuidOf(input.changeSetId, "chg")} and org_id = ${uuidOf(input.orgUuid, "org")}
       and decision = 'pending_maintainer' and held_state = 'none'
    returning id`;
  // An update that matches nothing is silent. A change that cannot hold the action is an error.
  if (rows.length !== 1) throw new GovernanceError("not_pending");
};

export type DecideInput = { changeSetId: string; staffUuid: string; decision: "approve" | "reject"; note?: string | null; requestId?: string | null };

/**
 * A maintainer approves or rejects, and the held action is carried out or cancelled in the SAME
 * transaction. Task O builds this (it replaces `decideByStaff` in the console's decision route).
 * Rules: an approval of a held action with no handler is refused; a handler that throws rolls
 * the decision back; a change that holds nothing is simply decided.
 */
export const decideAndResume = async (_adminSql: Sql, _input: DecideInput, _handlers: HeldHandlers): Promise<{ change: RecordedChange; heldState: HeldState }> => {
  throw new GovernanceError("not_allowed");
};

export type ConfirmInput = { orgUuid: string; changeSetId: string; actor: Actor; role: Role; requestId?: string | null };

/**
 * The owner says yes to a change waiting for them, and anything it holds is carried out in the
 * same transaction. Task O builds this on `confirmByOwner`. `orgUuid`, `actor` and `role` come
 * from the caller's verified session.
 */
export const confirmAndResume = async (_adminSql: Sql, _input: ConfirmInput, _handlers: HeldHandlers): Promise<{ change: RecordedChange; heldState: HeldState }> => {
  throw new GovernanceError("not_allowed");
};
