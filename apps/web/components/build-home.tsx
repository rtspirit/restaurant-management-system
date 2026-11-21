"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Composer, Conversation, Dock, EmptyState, Message, Narrow, Notice, Row, Section, Stack, Text } from "@rms/ui";
import { agentApi } from "@/lib/agent/api";
import { AgentApiError, type AgentApi } from "@/lib/agent/client";
import { practiceAgentApi } from "@/lib/agent/mock";
import { MiniAppList } from "./mini-app-list";
import type { MiniAppSummary } from "./shell-data";

// Things owners commonly ask for, in the words they would use. Pressing one fills the box.
const IDEAS = ["See how much money I’m making", "Keep a list of my suppliers", "Count the till at close"];

export type BuildHomeProps = {
  miniApps: MiniAppSummary[];
  /** The build routes to use. For tests only: left out, the page's own place decides. */
  api?: AgentApi;
};

/**
 * Which routes a first message goes to. A page under /gallery ALWAYS gets the practice
 * stand-in, whatever the rest of the app uses: the gallery is open without signing in, and a
 * message typed there must never start a real build or spend anything.
 */
export const buildApiFor = (pathname: string, signedIn: AgentApi = agentApi): AgentApi =>
  pathname === "/gallery" || pathname.startsWith("/gallery/") ? practiceAgentApi : signedIn;

/**
 * The Build tab. It invites the owner to say what they need and lists their mini-apps.
 * Sending the first message starts a build and goes to its conversation.
 */
export function BuildHome({ miniApps, api: given }: BuildHomeProps) {
  const router = useRouter();
  const pathname = usePathname();
  // In the gallery the conversation opens in the gallery too, so it can be tried without signing in.
  const inGallery = pathname === "/gallery" || pathname.startsWith("/gallery/");
  const api = given ?? buildApiFor(pathname);
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
      // The build routes are not there to answer: say so plainly, and that nothing happened.
      const notReady = error instanceof AgentApiError && error.code === "not_found";
      setProblem(notReady ? "Building is not switched on yet. Nothing was made or changed." : error instanceof AgentApiError ? error.message : "RMS could not start that just now. Try again in a moment.");
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
