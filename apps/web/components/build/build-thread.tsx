import type { ReactNode } from "react";
import { Answers, BulletList, Button, Card, Message, Notice, Row, Stack, Stepper, Text } from "@rms/ui";
import type { BuildView, ThreadItem } from "@/lib/agent/reducer";

export type ThreadActions = {
  /** Answer the question that is waiting, with one of its choices. */
  answer: (questionId: string, text: string) => void;
  /** "You already have this": open it, add to it, or build a separate one. */
  choose: (id: string, choice: "open_existing" | "add_to_existing" | "build_anyway", ref?: string) => void;
  /** Build the plan as shown. */
  buildPlan: (planId: string) => void;
  /** The owner wants the plan changed: put them in the box to say how. */
  changePlan: () => void;
  retry: () => void;
  undo: () => void;
};

export type BuildThreadProps = {
  view: BuildView;
  /** The owner's own words, shown at once while they are on their way to RMS. */
  sending: string | null;
  /** A reply is being sent: buttons wait so nothing is sent twice. */
  busy: boolean;
  actions: ThreadActions;
};

type QuestionItem = Extract<ThreadItem, { kind: "question" }>;

/** When the work stopped short, a step that is not done did not finish. "Not started" would be untrue. */
const HALTED_WORDS = { done: "Done", now: "In progress", todo: "Did not finish" };

/** The plan in the owner's words: what it will show, then the smaller print. */
function PlanCards({ item }: { item: Extract<ThreadItem, { kind: "plan" }> }) {
  const { plan } = item;
  const extras: [string, string[]][] = [
    ["It keeps", plan.keeps],
    ["It uses", plan.readsFromRms],
    ["It connects to", plan.connectsTo],
  ];
  return (
    <>
      <Message from="rms" plain={false}>
        <Card title="Here’s what I’ll build" as="article">
          <Stack gap="m">
            <Text>
              <b>{plan.appName}.</b> {plan.summary}
            </Text>
            <BulletList items={plan.screens} />
            {extras.map(([label, list]) =>
              list.length > 0 ? (
                <Text key={label} tone="muted" size="s">
                  {label}: {list.join(", ")}
                </Text>
              ) : null,
            )}
          </Stack>
        </Card>
      </Message>
      {plan.assumptions.length > 0 ? (
        <Message from="rms" plain={false}>
          <Card title="What I assumed" titleSize="small" as="article">
            <Stack gap="xs">
              {plan.assumptions.map((line) => (
                <Text key={line} tone="muted" size="s">
                  {line}
                </Text>
              ))}
            </Stack>
          </Card>
        </Message>
      ) : null}
    </>
  );
}

/**
 * The build conversation, drawn from the view and nothing else. Put it inside a `Conversation`.
 * Only the one thing that is waiting for the owner has buttons: everything older is read-only.
 */
export function BuildThread({ view, sending, busy, actions }: BuildThreadProps) {
  const out: ReactNode[] = [];
  let answered: QuestionItem[] = [];
  const flushAnswered = () => {
    if (answered.length === 0) return;
    out.push(<Answers key={`answers-${answered[0]?.key}`} label="Your answers" items={answered.map((q) => ({ question: q.text, answer: q.answer ?? "" }))} />);
    answered = [];
  };
  const waitingOn = view.pending;

  for (const item of view.items) {
    if (item.kind === "question" && item.answer !== null) {
      answered.push(item);
      continue;
    }
    flushAnswered();
    switch (item.kind) {
      case "you":
        out.push(
          <Message key={item.key} from="you">
            {item.text}
          </Message>,
        );
        break;
      case "rms":
        out.push(
          <Message key={item.key} from="rms">
            {item.text}
          </Message>,
        );
        break;
      case "question": {
        const open = waitingOn?.kind === "question" && waitingOn.id === item.id;
        out.push(
          <Message key={item.key} from="rms">
            {item.text}
          </Message>,
        );
        if (open && item.choices.length > 0) {
          out.push(
            <Row key={`${item.key}-choices`} gap="s">
              {item.choices.map((choice) => (
                <Button key={choice} disabled={busy} onClick={() => actions.answer(item.id, choice)}>
                  {choice}
                </Button>
              ))}
            </Row>,
          );
        }
        break;
      }
      case "duplicate": {
        const open = waitingOn?.kind === "duplicate" && waitingOn.id === item.id;
        const first = item.matches[0];
        out.push(
          <Message key={item.key} from="rms" plain={false}>
            <Card title="You already have this" as="article">
              <Stack gap="m">
                {item.matches.map((match) => (
                  <Stack key={match.appId} gap="xs">
                    <Text strong>{match.appName}</Text>
                    <Text tone="muted">{match.reason}</Text>
                  </Stack>
                ))}
                {open && first ? (
                  <Row gap="s">
                    <Button variant="primary" disabled={busy} onClick={() => actions.choose(item.id, "open_existing", first.appId)}>
                      Open it
                    </Button>
                    <Button disabled={busy} onClick={() => actions.choose(item.id, "add_to_existing", first.appId)}>
                      Add to it
                    </Button>
                    <Button variant="quiet" disabled={busy} onClick={() => actions.choose(item.id, "build_anyway")}>
                      Build a separate one anyway
                    </Button>
                  </Row>
                ) : null}
              </Stack>
            </Card>
          </Message>,
        );
        break;
      }
      case "marketplace": {
        const open = waitingOn?.kind === "marketplace" && waitingOn.id === item.id;
        out.push(
          <Message key={item.key} from="rms" plain={false}>
            <Card title="There’s one in the Marketplace like this" as="article">
              <Stack gap="m">
                {item.listings.map((listing) => (
                  <Stack key={listing.listingId} gap="xs">
                    <Text strong>{listing.title}</Text>
                    <Text tone="muted">{listing.reason}</Text>
                  </Stack>
                ))}
                {open ? (
                  <Row gap="s">
                    <Button disabled={busy} onClick={() => actions.choose(item.id, "build_anyway")}>
                      Build my own
                    </Button>
                  </Row>
                ) : null}
              </Stack>
            </Card>
          </Message>,
        );
        break;
      }
      case "plan": {
        const open = waitingOn?.kind === "plan" && waitingOn.id === item.id;
        out.push(<PlanCards key={item.key} item={item} />);
        if (open) {
          out.push(
            <Row key={`${item.key}-actions`} gap="s">
              <Button variant="primary" disabled={busy} onClick={() => actions.buildPlan(item.id)}>
                Build it
              </Button>
              <Button disabled={busy} onClick={actions.changePlan}>
                Change something
              </Button>
            </Row>,
          );
        }
        break;
      }
      case "steps":
        out.push(
          <Message key={item.key} from="rms" plain={false}>
            <Card as="div">
              <Stepper label="Progress" steps={item.steps} {...(item.halted ? { words: HALTED_WORDS } : {})} />
            </Card>
          </Message>,
        );
        break;
      case "failed": {
        const last = view.items[view.items.length - 1] === item && view.phase === "failed";
        out.push(
          <Message key={item.key} from="rms" plain={false}>
            <Stack gap="m">
              <Notice kind="problem">{item.text}</Notice>
              {last && item.retryable ? (
                <Row gap="s">
                  <Button disabled={busy} onClick={actions.retry}>
                    Try again
                  </Button>
                </Row>
              ) : null}
            </Stack>
          </Message>,
        );
        break;
      }
      case "stopped":
        out.push(
          <Message key={item.key} from="rms">
            Stopped. Nothing else will change until you say so.
          </Message>,
        );
        break;
    }
  }
  flushAnswered();

  if (sending !== null) {
    out.push(
      <Message key="sending" from="you">
        {sending}
      </Message>,
    );
  }

  if (view.typing !== "") {
    out.push(
      <Message key="typing" from="rms">
        {view.typing}
      </Message>,
    );
  } else if (view.phase === "working" || sending !== null) {
    // RMS is working and has nothing to show for it yet: the same ring and words as any step.
    const last = view.items[view.items.length - 1];
    const stepTurning = last?.kind === "steps" && last.steps.some((step) => step.state === "now");
    if (!stepTurning) {
      out.push(
        <Message key="thinking" from="rms" plain={false}>
          <Card as="div">
            <Stepper label="Progress" steps={[{ id: "thinking", label: "Thinking it through", state: "now" }]} />
          </Card>
        </Message>,
      );
    }
  }

  if (view.canUndo && sending === null) {
    out.push(
      <Row key="undo" gap="s">
        <Button variant="quiet" disabled={busy} onClick={actions.undo}>
          Undo that
        </Button>
      </Row>,
    );
  }

  return <>{out}</>;
}
