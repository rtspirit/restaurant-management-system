// Needs the local database. Ids: the lead's own range for this file (uuid suffix 80 to 89). Cleans up after itself.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toPublicId } from "@rms/contracts";
import { type NewAgentEvent, adminDb, apiDb, appendAgentEvents, closeAll, readAgentEvents, withOrg } from "./index.js";
import { requireTestEnv } from "./testing.js";

const id = (suffix: string) => `0193a3c0-0000-7000-8000-0000000000${suffix}`;
const ORG = id("80");
const OTHER_ORG = id("81");
const SESSION = id("82");
const RUN = id("83");
const RUN_2 = id("84");
const target = { orgUuid: ORG, sessionUuid: SESSION, runUuid: RUN };

const clean = async () => {
  const admin = adminDb();
  await admin`delete from platform.agent_events where org_id in (${ORG}, ${OTHER_ORG})`;
  await admin`delete from platform.agent_runs where org_id in (${ORG}, ${OTHER_ORG})`;
  await admin`delete from platform.agent_sessions where org_id in (${ORG}, ${OTHER_ORG})`;
  await admin`delete from platform.organizations where id in (${ORG}, ${OTHER_ORG})`;
};

beforeAll(async () => {
  requireTestEnv("DATABASE_URL", "DATABASE_ADMIN_URL");
  await clean();
  const admin = adminDb();
  await admin`insert into platform.organizations (id, slug, name, store_prefix) values
    (${ORG}, 'lead-events-a', 'Events A', 'o_8080808080a1'), (${OTHER_ORG}, 'lead-events-b', 'Events B', 'o_8080808080b1')`;
  await admin`insert into platform.agent_sessions (id, org_id, user_id, mode, model) values (${SESSION}, ${ORG}, ${id("85")}, 'build', 'test-model')`;
  await admin`insert into platform.agent_runs (id, session_id, org_id, status) values (${RUN}, ${SESSION}, ${ORG}, 'done'), (${RUN_2}, ${SESSION}, ${ORG}, 'running')`;
});

afterAll(async () => {
  await clean();
  await closeAll();
});

const msg = (text: string): NewAgentEvent => ({ type: "message.done", text });

describe("appending agent events", () => {
  it("numbers events across the session, from 1, with no gap", async () => {
    const first = await withOrg(apiDb(), ORG, (tx) =>
      appendAgentEvents(tx, target, [{ type: "run.started", runId: toPublicId("run", RUN), sessionId: toPublicId("ses", SESSION), mode: "build" }, { type: "user.message", text: "A vendor list" }]),
    );
    expect(first.map((e) => e.seq)).toEqual([1, 2]);
    // A second run in the same session carries on from where the first stopped.
    const second = await withOrg(apiDb(), ORG, (tx) => appendAgentEvents(tx, { ...target, runUuid: RUN_2 }, [msg("On it")]));
    expect(second.map((e) => e.seq)).toEqual([3]);
  });

  it("two writers at the same moment never take the same number", async () => {
    const before = (await withOrg(apiDb(), ORG, (tx) => readAgentEvents(tx, target))).length;
    const writers = Array.from({ length: 8 }, (_, w) =>
      withOrg(apiDb(), ORG, (tx) => appendAgentEvents(tx, { ...target, runUuid: w % 2 === 0 ? RUN : RUN_2 }, [msg(`writer ${w} a`), msg(`writer ${w} b`), msg(`writer ${w} c`)])),
    );
    const results = await Promise.all(writers);
    const seqs = results.flat().map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 24 }, (_, i) => before + 1 + i));
    // Each writer's own events stayed together and in order.
    for (const r of results) expect(r.map((e) => e.seq)).toEqual([r[0]!.seq, r[0]!.seq + 1, r[0]!.seq + 2]);
    const all = await withOrg(apiDb(), ORG, (tx) => readAgentEvents(tx, target));
    expect(all.map((e) => e.seq)).toEqual(Array.from({ length: before + 24 }, (_, i) => i + 1));
  });

  it("reads on from a number", async () => {
    const all = await withOrg(apiDb(), ORG, (tx) => readAgentEvents(tx, target));
    const rest = await withOrg(apiDb(), ORG, (tx) => readAgentEvents(tx, target, 3));
    expect(rest.map((e) => e.seq)).toEqual(all.filter((e) => e.seq > 3).map((e) => e.seq));
    expect((await withOrg(apiDb(), ORG, (tx) => readAgentEvents(tx, target, 10_000))).length).toBe(0);
  });

  it("refuses live-only events, events off the contract, and a run that is not in the session", async () => {
    const append = (events: NewAgentEvent[], t = target) => withOrg(apiDb(), ORG, (tx) => appendAgentEvents(tx, t, events));
    await expect(append([{ type: "message.delta", text: "x" }])).rejects.toThrow(/never stored/);
    await expect(append([{ type: "run.paused" }])).rejects.toThrow(/never stored/);
    await expect(append([{ type: "tool.output", text: "raw" } as never])).rejects.toThrow();
    await expect(append([msg("x")], { ...target, runUuid: id("89") })).rejects.toThrow(/Unknown run/);
    // A refused append stores nothing, not even the events before the bad one.
    const before = (await withOrg(apiDb(), ORG, (tx) => readAgentEvents(tx, target))).length;
    await expect(append([msg("kept?"), { type: "run.paused" }])).rejects.toThrow();
    expect((await withOrg(apiDb(), ORG, (tx) => readAgentEvents(tx, target))).length).toBe(before);
  });

  it("another restaurant can neither append to this session nor read it", async () => {
    await expect(withOrg(apiDb(), OTHER_ORG, (tx) => appendAgentEvents(tx, target, [msg("from B")]))).rejects.toThrow();
    await expect(withOrg(apiDb(), OTHER_ORG, (tx) => appendAgentEvents(tx, { ...target, orgUuid: OTHER_ORG }, [msg("from B")]))).rejects.toThrow(/Unknown session/);
    expect(await withOrg(apiDb(), OTHER_ORG, (tx) => readAgentEvents(tx, target))).toEqual([]);
    expect(await withOrg(apiDb(), OTHER_ORG, (tx) => readAgentEvents(tx, { ...target, orgUuid: OTHER_ORG }))).toEqual([]);
  });
});
