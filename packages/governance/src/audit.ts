import { type Actor, AuditAction, toUuid } from "@rms/contracts";
import { type Tx, actorText, newUuid } from "@rms/db";

export type AuditInput = {
  /** Raw uuid or `org_` public id. Must come from a verified session, token or a platform job. */
  orgUuid: string;
  actor: Actor;
  /** `area.verb`, for example "change.record". */
  action: string;
  targetType: string;
  targetId?: string | null;
  /** Counts, keys and ids only. Never field values. */
  meta?: Record<string, unknown>;
  requestId?: string | null;
};

export const orgUuidOf = (id: string): string => (id.startsWith("org_") ? toUuid(id) : id);

/**
 * Appends one audit row in the caller's transaction. Works with a `withOrg(apiDb(), ...)`
 * transaction (rms_api may insert its own org's rows) and with an `adminDb()` transaction.
 */
export const writeAudit = async (tx: Tx, entry: AuditInput): Promise<string> => {
  const action = AuditAction.parse(entry.action);
  if (entry.targetType.length === 0 || entry.targetType.length > 60) throw new Error("Audit target type must be 1 to 60 characters");
  if (entry.targetId && entry.targetId.length > 120) throw new Error("Audit target id is too long");
  const id = newUuid();
  await tx`
    insert into platform.audit_log (id, org_id, actor, action, target_type, target_id, meta, request_id)
    values (${id}, ${orgUuidOf(entry.orgUuid)}, ${actorText(entry.actor)}, ${action}, ${entry.targetType},
            ${entry.targetId ?? null}, ${tx.json((entry.meta ?? {}) as never)}, ${entry.requestId ?? null})`;
  return id;
};
