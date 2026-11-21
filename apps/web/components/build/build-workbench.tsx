"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Composer, Conversation, Dialog, Heading, Notice, Row, Stack, Tag, Text, TextField, Workbench } from "@rms/ui";
import type { BuildView } from "@/lib/agent/reducer";
import type { StreamStatus } from "@/lib/agent/stream";
import { BuildThread, type ThreadActions } from "./build-thread";

export type BuildActions = ThreadActions & {
  /** The owner typed something and sent it. */
  say: (text: string) => void;
  /** Yes or no to "this will happen". */
  confirm: (id: string, ok: boolean) => void;
  stop: () => void;
};

export type BuildWorkbenchProps = {
  view: BuildView;
  connection: StreamStatus;
  /** Something the owner tried did not go through, in plain words. */
  problem: string | null;
  sending: string | null;
  busy: boolean;
  /** Stop has been pressed and RMS has not answered yet. */
  stopping: boolean;
  /** A practice run: nothing is built or saved, and the screen says so. */
  practice: boolean;
  /** The preview itself: a `Frame`, or a stand-in for it in the gallery. */
  preview: ReactNode;
  /** The address of this build on the web app, for "Try it on my phone". Worked out in the browser. */
  phoneLink: () => string;
  actions: Omit<BuildActions, "changePlan">;
};

const CONVERSATION = "Build conversation";

/** What the box asks for, given whose turn it is. */
function composerLabel(view: BuildView): string {
  if (view.pending?.kind === "question") return view.pending.choices.length > 0 ? "Or type your answer" : "Type your answer";
  if (view.preview !== null || view.items.some((item) => item.kind === "plan")) return "Tell me what to change";
  return "Say what you need";
}

/** True on this computer only: a phone cannot open a link to `localhost`. */
const onThisComputerOnly = (link: string): boolean => {
  try {
    const host = new URL(link).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return true;
  }
};

/**
 * The build screen: the conversation beside the preview, with the main actions bottom right.
 * It holds no data of its own. The real screen and the gallery both draw it from a view.
 */
export function BuildWorkbench({ view, connection, problem, sending, busy, stopping, practice, preview, phoneLink, actions }: BuildWorkbenchProps) {
  const [phone, setPhone] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState("");
  const working = view.phase === "working";
  const confirm = view.pending?.kind === "confirm" ? view.pending : null;

  // Keep the newest thing in view. On a wide screen the conversation scrolls on its own. On a
  // phone the page scrolls, so only follow along until there is a preview to look at instead.
  const count = view.items.length + (sending === null ? 0 : 1) + (view.typing === "" ? 0 : 1);
  const hasPreview = view.preview !== null;
  const mounted = useRef(false);
  useEffect(() => {
    const log = document.querySelector<HTMLElement>(`[role="log"][aria-label="${CONVERSATION}"]`);
    if (!log) return;
    if (log.scrollHeight > log.clientHeight + 1) log.scrollTop = log.scrollHeight;
    else if (mounted.current && !hasPreview) log.lastElementChild?.scrollIntoView({ block: "nearest" });
    mounted.current = true;
  }, [count, hasPreview, view.typing, connection, problem]);

  const say = (text: string) => {
    if (view.pending?.kind === "question") actions.answer(view.pending.id, text);
    else actions.say(text);
  };

  const changePlan = () => {
    // The box is the way to say what to change. Put the owner in it.
    document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="Tell me what to change"]`)?.focus();
  };

  const openPhone = () => {
    setCopied(false);
    setPhone(phoneLink());
  };
  const copy = async () => {
    if (phone === null) return;
    try {
      await navigator.clipboard.writeText(phone);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <Workbench
        sideLabel={CONVERSATION}
        side={
          <>
            <Conversation label={CONVERSATION}>
              <BuildThread view={view} sending={sending} busy={busy} actions={{ ...actions, changePlan }} />
            </Conversation>
            {connection === "reconnecting" ? (
              <Row gap="s">
                <Tag weight="outline">Reconnecting</Tag>
                <Notice kind="status">Your build carries on. Nothing is lost.</Notice>
              </Row>
            ) : null}
            {problem !== null ? <Notice kind="problem">{problem}</Notice> : null}
            {working ? (
              <Row justify="between" wrap={false}>
                <Text tone="muted">{stopping ? "Stopping." : "RMS is working on it."}</Text>
                <Button busy={stopping} onClick={actions.stop}>
                  Stop
                </Button>
              </Row>
            ) : (
              <Composer label={composerLabel(view)} value={draft} onChange={setDraft} onSend={say} busy={busy} />
            )}
          </>
        }
        mainLabel="Preview"
        main={
          <>
            <Row gap="s">
              <Heading level={2} size="section">
                Preview
              </Heading>
              {hasPreview ? <Tag>Not published yet</Tag> : null}
              {practice ? <Tag weight="outline">Practice run: nothing is saved</Tag> : null}
            </Row>
            {preview}
          </>
        }
        foot={
          <>
            <Button size="l" hideOnPhone disabled={!hasPreview} onClick={openPhone}>
              Try it on my phone
            </Button>
            <Button size="l" variant="primary" disabled>
              Publish
            </Button>
            {/* Last, so that when the row is full the reason sits under the button it explains. */}
            <Text tone="muted" size="s">
              Publishing comes next. For now, try it here.
            </Text>
          </>
        }
      />

      <Dialog
        open={phone !== null}
        onClose={() => setPhone(null)}
        title="Try it on your phone"
        actions={
          <>
            <Button onClick={() => setPhone(null)}>Close</Button>
            <Button variant="primary" onClick={copy}>
              {copied ? "Copied" : "Copy the link"}
            </Button>
          </>
        }
      >
        <Stack gap="m">
          <Text>Open this link on your phone and sign in to RMS. You’ll see the same preview, laid out for a phone.</Text>
          <TextField label="Link to this build" value={phone ?? ""} readOnly onFocus={(event) => event.currentTarget.select()} />
          {phone !== null && onThisComputerOnly(phone) ? (
            <Notice kind="problem">This link only works on this computer. RMS is running here, not on the internet, so a phone cannot reach it yet.</Notice>
          ) : null}
          {copied ? <Notice kind="status">Copied. Paste it into a message to yourself.</Notice> : null}
        </Stack>
      </Dialog>

      <Dialog
        open={confirm !== null}
        onClose={() => confirm && actions.confirm(confirm.id, false)}
        title="Go ahead with this?"
        closeLabel="No, leave it"
        actions={
          <>
            <Button disabled={busy} onClick={() => confirm && actions.confirm(confirm.id, false)}>
              No, leave it
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => confirm && actions.confirm(confirm.id, true)}>
              Yes, go ahead
            </Button>
          </>
        }
      >
        <Text>{confirm?.text ?? ""}</Text>
      </Dialog>
    </>
  );
}
