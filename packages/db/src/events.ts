// Storing agent events. Lead-owned. The ONE way a row gets into platform.agent_events.
//
// Events are numbered across a whole session (1, 2, 3, ...). Two things can want the next
// number at the same moment: the request moving a run along, and a cancel (or a second
// reader). "Read the highest number, add one" from both would give both the same number. So
// every append first LOCKS THE SESSION ROW. The second writer waits for the first to commit and
// then reads the right number. The database also refuses a repeated (session, seq) as a last wall.
import { AgentEvent, type AgentEventType, LIVE_ONLY_EVENTS, Uuid } from "@rms/contracts";
import type { Tx } from "./index.js";

type Stored<E> = E extends unknown ? Omit<E, "seq" | "at"> : never;
/** An event before it is stored: everything but its number and its time, which this module sets. */
export type NewAgentEvent = Stored<AgentEvent>;

export type AgentEventTarget = { orgUuid: string; sessionUuid: string; runUuid: string };

/**
 * Appends events to a session, in order, and returns them as stored (with `seq` and `at`).
 *
 * `tx` MUST be a transaction fenced to the restaurant (`withOrg`), and the ids must come from a
 * verified session plus a lookup inside that fence, never from a request. The session row is
 * locked until the caller's transaction ends, so do the append last and keep the transaction short.
 * Live-only events (`message.delta`, `run.paused`) are refused: they are sent, never stored.
 * Every event is parsed with `AgentEvent` before it is written, so nothing off-contract is kept.
 */
export const appendAgentEvents = async (tx: Tx, target: AgentEventTarget, events: readonly NewAgentEvent[]): Promise<AgentEvent[]> => {
  if (events.length === 0) return [];
  const org = Uuid.parse(target.orgUuid);
  const session = Uuid.parse(target.sessionUuid);
  const run = Uuid.parse(target.runUuid);

  const locked = await tx`select id from platform.agent_sessions where id = ${session} and org_id = ${org} for update`;
  if (locked.length !== 1) throw new Error("Unknown session");
  const owns = await tx`select id from platform.agent_runs where id = ${run} and session_id = ${session} and org_id = ${org}`;
  if (owns.length !== 1) throw new Error("Unknown run");

  const [last] = await tx<{ seq: number }[]>`select coalesce(max(seq), 0)::int as seq from platform.agent_events where session_id = ${session}`;
  let seq = last?.seq ?? 0;
  const at = new Date().toISOString();
  const stored: AgentEvent[] = [];
  for (const e of events) {
    if ((LIVE_ONLY_EVENTS as readonly AgentEventType[]).includes(e.type)) throw new Error(`"${e.type}" is sent, never stored`);
    seq += 1;
    const event = AgentEvent.parse({ ...e, seq, at });
    await tx`insert into platform.agent_events (run_id, seq, session_id, org_id, type, payload, at)
             values (${run}, ${seq}, ${session}, ${org}, ${event.type}, ${JSON.stringify(event)}::text::jsonb, ${at})`;
    stored.push(event);
  }
  return stored;
};

/**
 * Stored events of a session after number `after` (0 = from the start), oldest first.
 * `tx` must be fenced to the restaurant. Rows that no longer parse are skipped, not sent.
 */
export const readAgentEvents = async (tx: Tx, target: Pick<AgentEventTarget, "orgUuid" | "sessionUuid">, after = 0, limit = 500): Promise<AgentEvent[]> => {
  const from = Number.isSafeInteger(after) && after > 0 ? after : 0;
  const cap = Math.min(Math.max(1, Math.trunc(limit)), 1000);
  const rows = await tx<{ payload: string }[]>`
    select payload::text as payload from platform.agent_events
    where session_id = ${Uuid.parse(target.sessionUuid)} and org_id = ${Uuid.parse(target.orgUuid)} and seq > ${from}
    order by seq limit ${cap}`;
  const out: AgentEvent[] = [];
  for (const r of rows) {
    const parsed = AgentEvent.safeParse(JSON.parse(r.payload));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
};
