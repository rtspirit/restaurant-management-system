"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Account,
  Answers,
  BarChart,
  BottomBar,
  BottomBarItem,
  BulletList,
  Button,
  Canvas,
  Card,
  Choice,
  ChoiceList,
  Columns,
  Composer,
  Conversation,
  DataTable,
  DetailList,
  Dialog,
  EmptyState,
  Feed,
  FieldGroup,
  FieldPair,
  FormLayout,
  Heading,
  IconButton,
  ListDetail,
  Logo,
  Message,
  NavItem,
  NavList,
  Notice,
  Pager,
  ReportTable,
  Row,
  Section,
  Select,
  Skeleton,
  Stack,
  Stat,
  StatGroup,
  StatLead,
  Stepper,
  Tabs,
  Tag,
  Text,
  TextArea,
  TextField,
  Theme,
  contrastRatio,
  themeFromBrand,
  type DataTableSort,
} from "@rms/ui";
import { MarketplaceList } from "@/components/marketplace-list";
import { MiniAppList } from "@/components/mini-app-list";
import { MoneyApp } from "./money-app";
import { BILLS, CHANGES, LISTINGS, MINI_APPS, REPORT_COLUMNS, REPORT_DAYS, REPORT_TOTAL, WEEKS, reportRow, weekView, type ReportDay } from "./seeded";

// The five colours the brief asks the system to survive, and one that is too dark to tell from ink.
const BRANDS = [
  { name: "RMS basil", hex: "#12804A" },
  { name: "Marigold Kitchen", hex: "#E8892B" },
  { name: "Slice Yard", hex: "#C8372D" },
  { name: "A pale yellow", hex: "#F2C230" },
  { name: "A blue", hex: "#1F6FD0" },
  { name: "A navy, too dark", hex: "#0B1F3A" },
];

const TIER_WEIGHT = { T0: "quiet", T1: "quiet", T2: "outline", T3: "solid" } as const;

function sortDays(sort: DataTableSort): ReportDay[] {
  const pick = (row: ReportDay) => (sort.key === "net" ? row.net : sort.key === "prime" ? row.prime : row.order);
  const sorted = [...REPORT_DAYS].sort((a, b) => pick(a) - pick(b));
  return sort.direction === "ascending" ? sorted : sorted.reverse();
}

export function Gallery() {
  const [tab, setTab] = useState("week");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sort, setSort] = useState<DataTableSort>({ key: "day", direction: "ascending" });
  const [billId, setBillId] = useState<string | undefined>("b1");
  const [said, setSaid] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // /gallery?open=dialog opens the confirmation straight away, for review screenshots.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("open") === "dialog") setDialogOpen(true);
  }, []);

  const bill = BILLS.find((item) => item.id === billId) ?? BILLS[0];
  const latest = weekView("nov9");
  const onSort = (key: string) =>
    setSort((before) => ({ key, direction: before.key === key && before.direction === "ascending" ? "descending" : "ascending" }));

  return (
    <Canvas>
      <Stack gap="xl">
        <Stack gap="m">
          <Logo />
          <Heading level={1} size="page">
            Front of House
          </Heading>
          <Text>
            If it has colour, you can press it. Everything else stays calm: a slate ground, white cards, ink. Fully rounded means press it. Square-ish
            corners mean read it. States are words and ink shapes, never colour.
          </Text>
          <Row>
            <Button variant="primary" href="/gallery/build" linkAs={Link}>
              See the build screen
            </Button>
            <Button href="/gallery/money" linkAs={Link}>
              See Money on a phone
            </Button>
            <Button href="/mini-apps" linkAs={Link}>
              Open the RMS shell
            </Button>
          </Row>
        </Stack>

        <Section title="Any brand colour stays readable">
          <Text tone="muted">
            A restaurant picks one colour. RMS keeps the hue and darkens it only as far as it must, so white words on a button and coloured words on
            a card both pass the AA contrast line (4.5 to 1).
          </Text>
          <Columns>
            {BRANDS.map((brand) => {
              const theme = themeFromBrand(brand.hex);
              return (
                <Theme key={brand.hex} brand={brand.hex}>
                  <Card title={brand.name} titleLevel={3} titleSize="small" as="article">
                    <Stack gap="m">
                      <Text tone="muted" size="s">
                        Picked {brand.hex}.{" "}
                        {theme.adjustment === "none"
                          ? "Used as it is."
                          : theme.adjustment === "lightened"
                            ? `Too close to ink, so buttons use ${theme.action}.`
                            : `Buttons use ${theme.action}.`}{" "}
                        White on the button is{" "}
                        {contrastRatio(theme.onAction, theme.action).toFixed(1)} to 1.
                      </Text>
                      <Row gap="s">
                        <Button variant="primary">Publish</Button>
                        <Button>Try it</Button>
                        <Button variant="quiet">Change</Button>
                      </Row>
                    </Stack>
                  </Card>
                </Theme>
              );
            })}
          </Columns>
        </Section>

        <Section title="Type">
          <Card as="div">
            <Stack gap="m">
              <Heading level={3} size="page">
                Mini-apps
              </Heading>
              <Heading level={3} size="app">
                Money
              </Heading>
              <Heading level={3} size="section">
                Recommended for you
              </Heading>
              <Heading level={3} size="card">
                Here’s what I’ll build
              </Heading>
              <Text>Nunito Sans, one family. Body text is 16px. Figures line up in columns: $84,310 and $61,480.</Text>
              <Text tone="muted" size="s">
                Supporting words are 15px in a softer ink. Nothing is smaller than 14px.
              </Text>
            </Stack>
          </Card>
        </Section>

        <Section title="Buttons">
          <Card as="div">
            <Stack>
              <Row>
                <Button variant="primary">Publish</Button>
                <Button>Try it on my phone</Button>
                <Button variant="quiet">Change</Button>
                <Button icon="plus">Add a bill</Button>
              </Row>
              <Row>
                <Button variant="primary" size="l" icon="ask">
                  Ask about your numbers
                </Button>
                <Button size="l">Not now</Button>
              </Row>
              <Row>
                <Button variant="primary" disabled>
                  Save bill
                </Button>
                <Button disabled>Cancel</Button>
                <Button variant="primary" busy>
                  Publishing
                </Button>
                <Text tone="muted" size="s">
                  A button that cannot be pressed loses its colour.
                </Text>
              </Row>
              <Row>
                <IconButton icon="prev" label="Previous week" />
                <IconButton icon="next" label="Next week" outlined />
                <IconButton icon="close" label="Close" />
                <IconButton icon="next" label="Next week" disabled />
                <Pager label="Nov 9 to Nov 15" previousLabel="Previous week" nextLabel="Next week" onPrevious={() => undefined} nextDisabled />
              </Row>
            </Stack>
          </Card>
        </Section>

        <Section title="Fields">
          <Card as="div">
            <Stack gap="l">
              <FieldPair>
                <TextField label="Supplier" placeholder="Who sent the bill" defaultValue="Harbor Lane Produce" autoComplete="off" />
                <TextField label="Amount" money defaultValue="1,284.50" hint="In dollars, as written on the bill." autoComplete="off" />
              </FieldPair>
              <FieldPair>
                <TextField label="Due date" defaultValue="Nov 31" error="November has 30 days. Pick a date up to Nov 30." autoComplete="off" />
                <TextField label="Bill number" defaultValue="HL-20418" disabled />
              </FieldPair>
              <FieldPair>
                <Select
                  label="Location"
                  defaultValue="downtown"
                  options={[
                    { value: "all", label: "Both locations" },
                    { value: "downtown", label: "Downtown" },
                    { value: "riverside", label: "Riverside" },
                  ]}
                />
                <Select label="Paid from" hint="Set by your accounts." disabled options={[{ value: "main", label: "Main bank account" }]} />
              </FieldPair>
            </Stack>
          </Card>
        </Section>

        <Section title="Tabs">
          <Card as="div">
            <Tabs
              label="Period"
              value={tab}
              onChange={setTab}
              items={[
                { value: "week", label: "This week", content: <Text>Net sales this week are {latest.net}.</Text> },
                { value: "month", label: "Last eight weeks", content: <Text>The slowest week started Oct 19, at $61,480.</Text> },
              ]}
            />
          </Card>
        </Section>

        <Section title="Labels and states">
          <Card as="div">
            <Stack>
              <Row>
                <Tag>Sample numbers</Tag>
                <Tag weight="outline" icon="up">
                  1.3 points over
                </Tag>
                <Tag weight="outline" icon="fall">
                  0.5 points under
                </Tag>
                <Tag weight="solid">Needs approval</Tag>
              </Row>
              <Text tone="muted" size="s">
                Three weights of ink, no colour: a soft label, a note worth reading, something waiting on a person.
              </Text>
              <Stepper
                label="Progress"
                steps={[
                  { id: "a", label: "Set up your sales days", state: "done" },
                  { id: "b", label: "Checking the numbers add up", state: "now" },
                  { id: "c", label: "Ready to publish", state: "todo" },
                ]}
              />
            </Stack>
          </Card>
        </Section>

        <Section title="Figures">
          <Columns>
            <Card as="div">
              <StatLead
                label="Prime cost"
                value="61.3%"
                aside={
                  <>
                    <Text>Target 60%</Text>
                    <Tag weight="outline" icon="up">
                      1.3 points over
                    </Tag>
                  </>
                }
              />
            </Card>
            <Card as="div">
              <StatGroup>
                <Stat label="Net sales" value="$84,310" />
                <Stat label="Food and drink cost" value="$25,460" note="30.2% of sales" />
                <Stat label="Staff cost" value="$26,220" note="31.1% of sales" />
              </StatGroup>
            </Card>
          </Columns>
        </Section>

        <Section title="Bar charts">
          <Columns>
            <Card title="Net sales, last eight weeks" titleLevel={3} titleSize="small" density="compact">
              <BarChart label="Net sales, last eight weeks" items={WEEKS.map((item) => ({ ...item, current: item.id === "nov9" }))} />
            </Card>
            <Card title="Day by day" titleLevel={3} titleSize="small" density="compact">
              <BarChart label="Net sales, day by day" direction="rows" items={latest.days} />
            </Card>
          </Columns>
          <Text tone="muted" size="s">
            Every bar carries its figure. The slow week is an ink outline and the words “Slow week”. When you only read a chart, the current bar is
            solid ink. When bars can be pressed, as in the build screen, the chosen one takes the action colour.
          </Text>
        </Section>

        <Section title="Table">
          <Card as="div">
            <DataTable
              caption="Sales by day, Nov 9 to Nov 15"
              columns={REPORT_COLUMNS}
              rows={sortDays(sort).map(reportRow)}
              total={REPORT_TOTAL}
              sort={sort}
              onSort={onSort}
            />
          </Card>
        </Section>

        <Section title="Conversation">
          <Columns>
            <Stack>
              <Conversation label="Build conversation">
                <Message from="you">I want to see how much money I’m making</Message>
                <Message from="rms">Sure. Two quick questions first.</Message>
                <Answers
                  label="Your answers"
                  items={[
                    { question: "Which locations?", answer: "Both" },
                    { question: "How often do you want to look?", answer: "Every week" },
                  ]}
                />
                <Message from="rms" plain={false}>
                  <Card title="Here’s what I’ll build" titleLevel={3} as="article">
                    <BulletList items={["Money in, day by day", "What food, drink and staff cost you", "What’s left each week"]} />
                  </Card>
                </Message>
                {said.map((text, index) => (
                  <Message key={index} from="you">
                    {text}
                  </Message>
                ))}
              </Conversation>
              <Composer label="Tell me what to change" onSend={(text) => setSaid((before) => [...before, text])} />
            </Stack>
            <Stack>
              <Card title="Loading" titleLevel={3} titleSize="small" as="div">
                <Stack gap="m">
                  <Skeleton shape="figure" label="Loading your sales" />
                  <Skeleton width="l" />
                  <Skeleton width="m" />
                </Stack>
              </Card>
              <EmptyState title="No bills yet" titleLevel={3} action={<Button icon="plus">Add a bill</Button>}>
                When a supplier sends you a bill, add it here and RMS will remind you before it is due.
              </EmptyState>
            </Stack>
          </Columns>
        </Section>

        <Section title="Dialog">
          <Row>
            <Button onClick={() => setDialogOpen(true)}>Open a confirmation</Button>
            <Text tone="muted" size="s">
              Only for a decision that needs full attention. On a phone it rises from the bottom.
            </Text>
          </Row>
          <Dialog
            open={dialogOpen}
            onClose={() => setDialogOpen(false)}
            title="Publish Money?"
            actions={
              <>
                <Button onClick={() => setDialogOpen(false)}>Not yet</Button>
                <Button variant="primary" onClick={() => setDialogOpen(false)}>
                  Publish
                </Button>
              </>
            }
          >
            <Text>Money will show in Mini-apps for you and your managers at both locations. You can take it down at any time.</Text>
          </Dialog>
        </Section>

        <Section title="Navigation">
          <Columns>
            <Stack>
              <NavList>
                <NavItem icon="home" label="Home" href="#navigation" />
                <NavItem icon="apps" label="Mini-apps" href="#navigation" current />
                <NavItem icon="settings" label="Settings" href="#navigation" />
              </NavList>
              <Account name="Asha Verma" initials="AV" role="Owner" />
            </Stack>
            <Stack>
              <BottomBar label="Example bottom bar">
                <BottomBarItem icon="home" label="Home" href="#navigation" />
                <BottomBarItem icon="menu" label="Menu" href="#navigation" />
                <BottomBarItem icon="apps" label="Mini-apps" href="#navigation" current />
                <BottomBarItem icon="more" label="More" onPress={() => undefined} />
              </BottomBar>
              <Text tone="muted" size="s">
                On a phone the side rail becomes this bar, within reach of a thumb.
              </Text>
            </Stack>
          </Columns>
        </Section>

        <Section title="Mini-apps home, once a restaurant has some">
          <MiniAppList miniApps={MINI_APPS} />
        </Section>

        <Section title="Marketplace: Recommended for you">
          <MarketplaceList listings={LISTINGS} onAdd={() => undefined} />
          <Text tone="muted" size="s">
            A listing says what it does and why it suits this restaurant. It never names the restaurant that made it.
          </Text>
        </Section>

        <Section title="Pattern: dashboard">
          <MoneyApp titleLevel={3} show="weeks" />
        </Section>

        <Section title="Pattern: list with detail">
          <ListDetail
            label="Bills"
            items={BILLS}
            {...(billId ? { selectedId: billId } : {})}
            onSelect={setBillId}
            onBack={() => setBillId(undefined)}
            detail={
              bill ? (
                <Card title={bill.title} titleLevel={3} action={<Tag weight={bill.status === "Not paid" ? "outline" : "quiet"}>{bill.status}</Tag>}>
                  <DetailList
                    rows={[
                      { label: "Amount", value: bill.meta },
                      { label: "Due", value: bill.due },
                      { label: "For", value: bill.forWhat },
                      { label: "Location", value: bill.location },
                    ]}
                  />
                </Card>
              ) : null
            }
          />
        </Section>

        <Section title="Pattern: form">
          <FormLayout
            title="Add a bill"
            description="Saving adds the bill to what you owe. Nothing is paid until you say so."
            onSubmit={() => {
              setSaving(true);
              window.setTimeout(() => setSaving(false), 1200);
            }}
            actions={
              <>
                <Button>Cancel</Button>
                <Button type="submit" variant="primary" busy={saving}>
                  {saving ? "Saving" : "Save bill"}
                </Button>
              </>
            }
          >
            <TextField label="Supplier" placeholder="Who sent the bill" autoComplete="off" />
            <FieldPair>
              <TextField label="Amount" money placeholder="0.00" autoComplete="off" />
              <TextField label="Due date" placeholder="Nov 18" autoComplete="off" />
            </FieldPair>
            <Select
              label="Location"
              block
              options={[
                { value: "all", label: "Both locations" },
                { value: "downtown", label: "Downtown" },
                { value: "riverside", label: "Riverside" },
              ]}
            />
          </FormLayout>
        </Section>

        <Section title="Pattern: report table" aside={<Tag>Compact</Tag>}>
          <ReportTable
            title="Sales by day"
            titleLevel={3}
            controls={<Pager label="Nov 9 to Nov 15" previousLabel="Previous week" nextLabel="Next week" onPrevious={() => undefined} nextDisabled />}
            columns={REPORT_COLUMNS}
            rows={sortDays(sort).map(reportRow)}
            total={REPORT_TOTAL}
            sort={sort}
            onSort={onSort}
            source="From your till, both locations. A day ends at 4am, so late tables count for the night before."
          />
        </Section>

        <Section title="Change feed" aside={<Tag>Compact</Tag>}>
          <Card density="compact" as="div">
            <Feed
              label="Changes"
              items={CHANGES.map((change) => ({
                id: change.id,
                tag: <Tag weight={TIER_WEIGHT[change.tier]}>{change.tierWords}</Tag>,
                what: (
                  <>
                    <b>{change.restaurant}</b> <small>({change.shortId})</small> {change.summary}
                  </>
                ),
                when: change.when,
                detail: change.detail,
                ...(change.flag ? { flag: change.flag } : {}),
                ...(change.waiting
                  ? {
                      actions: (
                        <FieldGroup legend="Decide on this change">
                          <TextArea label="Note (optional)" maxLength={1000} />
                          <Row>
                            <Button variant="primary">Approve</Button>
                            <Button>Reject</Button>
                          </Row>
                        </FieldGroup>
                      ),
                    }
                  : {}),
              }))}
            />
          </Card>
          <Text tone="muted" size="s">
            The maintainer console. A tier is written out and its weight of ink rises with it. The one row that needs a look is the only one with an
            ink outline, and it says why.
          </Text>
        </Section>

        <Section title="One question per screen">
          <Row>
            <Button href="/gallery/onboarding" linkAs={Link}>
              See the five onboarding questions
            </Button>
          </Row>
          <Columns>
            <ChoiceList>
              <Choice type="radio" name="gallery-style" label="Table service: guests order from a server" defaultChecked />
              <Choice type="radio" name="gallery-style" label="Counter service: guests order at the counter" />
              <Choice type="checkbox" name="gallery-systems" label="Square" defaultChecked />
            </ChoiceList>
            <Stack>
              <Notice kind="problem">We could not set up your restaurant just now. Please try again.</Notice>
              <Notice kind="status">Check your email for a link to finish signing up.</Notice>
            </Stack>
          </Columns>
        </Section>
      </Stack>
    </Canvas>
  );
}
