"use client";

import { useState } from "react";
import { Button, Composer, Conversation, Dock, EmptyState, Message, Narrow, Row, Section, Stack, Text } from "@rms/ui";
import { MiniAppList } from "./mini-app-list";
import type { MiniAppSummary } from "./shell-data";

// Things owners commonly ask for, in the words they would use. Pressing one fills the box.
const IDEAS = ["See how much money I’m making", "Count the till at close", "Keep track of what I owe suppliers"];

type Line = { id: number; from: "you" | "rms"; text: string };

/**
 * The Build tab. Before a conversation starts it invites the owner to say what they need
 * and lists their mini-apps. Once they send something, it becomes the conversation with
 * the box resting at the bottom.
 */
export function BuildHome({ miniApps }: { miniApps: MiniAppSummary[] }) {
  const [draft, setDraft] = useState("");
  const [lines, setLines] = useState<Line[]>([]);

  // STUB: the build conversation is Wave 2. Until then the owner's words are shown back
  // with an honest note that nothing was built. Replace this handler, keep the layout.
  const onSend = (text: string) => {
    setLines((before) => [
      ...before,
      { id: before.length, from: "you", text },
      { id: before.length + 1, from: "rms", text: "Thanks. Building is not switched on yet, so nothing has been made or changed." },
    ]);
  };

  const composer = <Composer label="Say what you need" value={draft} onChange={setDraft} onSend={onSend} />;

  if (lines.length > 0) {
    return (
      <Narrow>
        <Conversation label="Build conversation">
          {lines.map((line) => (
            <Message key={line.id} from={line.from}>
              {line.text}
            </Message>
          ))}
        </Conversation>
        <Dock>{composer}</Dock>
      </Narrow>
    );
  }

  return (
    <>
      <Narrow>
        <Section title="What do you want to build?">
          <Text tone="muted">
            Say it the way you would to a colleague. RMS asks a few short questions, shows you a plan, then builds it with your own numbers.
          </Text>
          <Stack gap="m">
            {composer}
            <Row gap="s">
              {IDEAS.map((idea) => (
                <Button key={idea} onClick={() => setDraft(idea)}>
                  {idea}
                </Button>
              ))}
            </Row>
          </Stack>
        </Section>
      </Narrow>

      <Section title="Your mini-apps">
        {miniApps.length > 0 ? (
          <MiniAppList miniApps={miniApps} />
        ) : (
          <Narrow>
            <EmptyState title="No mini-apps yet" titleLevel={3}>
              When you build one, or pick one from the Marketplace, it shows here and on your Home screen.
            </EmptyState>
          </Narrow>
        )}
      </Section>
    </>
  );
}
