"use client";

import { useMemo, useState } from "react";
import type { AgentEvent, RunReply } from "@rms/contracts";
import { Frame, Heading, Text } from "@rms/ui";
import { BuildWorkbench } from "@/components/build/build-workbench";
import { RECORDED, record, type EventBody, type RecordedState } from "@/lib/agent/fixtures";
import { reduceEvents } from "@/lib/agent/reducer";
import { MoneyApp } from "../money-app";

/**
 * The real build screen, drawn from a recorded list of events instead of a live run, so every
 * state can be looked at without building anything. What you press here is added to the
 * recording as the events RMS would store, and goes no further.
 */
export function BuildScreen({ state }: { state: RecordedState }) {
  const [extra, setExtra] = useState<EventBody[]>([]);
  const view = useMemo(() => {
    const recorded = RECORDED[state];
    const last = recorded[recorded.length - 1]?.seq ?? 0;
    const added = record(extra).map((event): AgentEvent => ({ ...event, seq: event.seq + last }));
    return reduceEvents([...recorded, ...added]);
  }, [state, extra]);

  const add = (...events: EventBody[]) => setExtra((before) => [...before, ...events]);
  const reply = (r: RunReply) => add({ type: "user.reply", reply: r }, { type: "run.waiting", for: "reply" });

  const building = view.phase === "working" && view.items.some((item) => item.kind === "plan" && item.confirmed);
  const preview = view.preview ? (
    // The gallery has no mini-app to frame, so the approved Money screen stands in for the preview.
    <MoneyApp titleLevel={3} show="weeks" />
  ) : building ? (
    <Frame title="Preview" state="loading" loadingLabel="Building your preview" />
  ) : (
    <Frame title="Preview" state="empty">
      <Heading level={3} size="card">
        Your preview shows here
      </Heading>
      <Text tone="muted">Agree a plan with RMS and it builds your mini-app in this space. You can try it before anyone else sees it.</Text>
    </Frame>
  );

  return (
    <BuildWorkbench
      view={view}
      connection={state === "dropped" ? "reconnecting" : view.phase === "working" ? "live" : "idle"}
      problem={null}
      sending={null}
      busy={false}
      stopping={false}
      canRetry
      practice={false}
      preview={preview}
      phoneLink={() => `${window.location.origin}/mini-apps/build/ses_0193a3c0000070008000000000000060`}
      actions={{
        say: (text) => add({ type: "user.message", text }, { type: "run.waiting", for: view.preview ? "review" : "reply" }),
        answer: (to, text) => reply({ kind: "answer", to, text }),
        choose: (to, choice) => reply({ kind: "choose", to, choice }),
        buildPlan: (to) => add({ type: "user.reply", reply: { kind: "confirm", to, ok: true } }, { type: "plan.confirmed" }, { type: "run.waiting", for: "reply" }),
        confirm: (to, ok) => reply({ kind: "confirm", to, ok }),
        retry: () => add({ type: "run.started", runId: "run_0193a3c0000070008000000000000069", sessionId: "ses_0193a3c0000070008000000000000060", mode: "build" }),
        undo: () => add({ type: "user.message", text: "Undo that last change" }, { type: "run.waiting", for: "review" }),
        stop: () => add({ type: "run.cancelled" }),
      }}
    />
  );
}
