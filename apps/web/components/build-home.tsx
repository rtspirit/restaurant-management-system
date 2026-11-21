"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Composer, Conversation, Dock, EmptyState, Message, Narrow, Notice, Row, Section, Stack, Text } from "@rms/ui";
import { agentApi } from "@/lib/agent/api";
import { AgentApiError, type AgentApi } from "@/lib/agent/client";
import { MiniAppList } from "./mini-app-list";
import type { MiniAppSummary } from "./shell-data";

// Things owners commonly ask for, in the words they would use. Pressing one fills the box.
const IDEAS = ["See how much money I’m making", "Keep a list of my suppliers", "Count the till at close"];

export type BuildHomeProps = {
  miniApps: MiniAppSummary[];
  /** The build routes to use. Left out everywhere except tests. */
  api?: AgentApi;
};

/**
 * The Build tab. It invites the owner to say what they need and lists their mini-apps.
 * Sending the first message starts a build and goes to its conversation.
 */
export function BuildHome({ miniApps, api = agentApi }: BuildHomeProps) {
  const router = useRouter();
  // In the gallery the conversation opens in the gallery too, so it can be tried without signing in.
  const inGallery = usePathname().startsWith("/gallery");
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // A mini-app RMS keeps for itself is never the owner's to see, whatever the list was given.
  const own = miniApps.filter((app) => (app as { kind?: string }).kind !== "system");

  const onSend = async (text: string) => {
    if (sent !== null) return;
    setSent(text);
    setProblem(null);
    try {
      const { sessionId } = await api.start({ mode: "build", text });
      router.push(inGallery ? `/gallery/build/live?session=${sessionId}` : `/mini-apps/build/${sessionId}`);
    } catch (error) {
      setSent(null);
      setDraft(text);
      setProblem(error instanceof AgentApiError ? error.message : "RMS could not start that just now. Try again in a moment.");
    }
  };

  const composer = <Composer label="Say what you need" value={draft} onChange={setDraft} onSend={onSend} busy={sent !== null} />;

  // Their words show at once, where the conversation is about to open.
  if (sent !== null) {
    return (
      <Narrow>
        <Conversation label="Build conversation">
          <Message from="you">{sent}</Message>
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
            Say it the way you would to a colleague. RMS asks a few short questions, shows you a plan, then builds it where you can try it.
          </Text>
          <Stack gap="m">
            {problem !== null ? <Notice kind="problem">{problem}</Notice> : null}
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
        {own.length > 0 ? (
          <MiniAppList miniApps={own} />
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
