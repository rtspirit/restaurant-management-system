"use client";

import { useState } from "react";
import { Answers, BulletList, Button, Card, Composer, Conversation, Dialog, Heading, Message, Row, Stepper, Tag, Text, Workbench } from "@rms/ui";
import { MoneyApp } from "../money-app";

/** The build conversation beside a live preview, as on the approved sketch. Seeded content. */
export function BuildScreen() {
  const [confirming, setConfirming] = useState(false);
  const [published, setPublished] = useState(false);
  const [said, setSaid] = useState<string[]>([]);

  return (
    <>
      <Workbench
        sideLabel="Build conversation"
        side={
          <>
            <Conversation label="Build conversation">
              <Message from="you">I want to see how much money I’m making</Message>
              <Answers
                label="Your answers"
                items={[
                  { question: "Which locations?", answer: "Both" },
                  { question: "How often do you want to look?", answer: "Every week" },
                ]}
              />
              <Message from="rms" plain={false}>
                <Card title="Here’s what I’ll build" as="article">
                  <BulletList
                    items={["Money in, day by day", "What food, drink and staff cost you", "What’s left each week", "Prime cost, the number most owners watch"]}
                  />
                </Card>
              </Message>
              <Message from="rms" plain={false}>
                <Card title="What I assumed" titleSize="small" action={<Button variant="quiet">Change</Button>} as="article">
                  <Text tone="muted" size="s">
                    Your week runs Monday to Sunday.
                  </Text>
                  <Text tone="muted" size="s">
                    A day ends at 4am, so late tables count for the night before.
                  </Text>
                </Card>
              </Message>
              <Message from="rms" plain={false}>
                <Card as="div">
                  <Stepper
                    label="Progress"
                    steps={[
                      { id: "days", label: "Set up your sales days", state: "done" },
                      { id: "screen", label: "Built your weekly screen", state: "done" },
                      { id: "check", label: "Checking the numbers add up", state: "now" },
                    ]}
                  />
                </Card>
              </Message>
              {said.map((text, index) => (
                <Message key={index} from="you">
                  {text}
                </Message>
              ))}
            </Conversation>
            <Composer label="Tell me what to change" onSend={(text) => setSaid((before) => [...before, text])} />
          </>
        }
        mainLabel="Preview"
        main={
          <>
            <Row gap="s">
              <Heading level={2} size="section">
                Preview
              </Heading>
              <Tag>Sample numbers</Tag>
            </Row>
            <MoneyApp titleLevel={3} show="weeks" />
          </>
        }
        foot={
          <>
            <Button size="l" hideOnPhone>
              Try it on my phone
            </Button>
            <Button size="l" variant="primary" onClick={() => setConfirming(true)} disabled={published}>
              {published ? "Published" : "Publish"}
            </Button>
          </>
        }
      />

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Publish Money?"
        actions={
          <>
            <Button onClick={() => setConfirming(false)}>Not yet</Button>
            <Button
              variant="primary"
              onClick={() => {
                setPublished(true);
                setConfirming(false);
              }}
            >
              Publish
            </Button>
          </>
        }
      >
        <Text>Money will show in Mini-apps for you and your managers at both locations. You can take it down at any time.</Text>
      </Dialog>
    </>
  );
}
