"use client";

import { useState, type ReactNode } from "react";
import { BarChart, Card, Dashboard, Pager, Stat, StatGroup, StatLead, Tag, Text } from "@rms/ui";
import { LATEST_WEEK, WEEKS, WEEK_IDS, weekView } from "./seeded";

export type MoneyAppProps = {
  /** 1 when the mini-app is the page, 3 when it sits inside the build preview. */
  titleLevel?: 1 | 3;
  /** weeks: eight weeks and by location (the build preview). days: day by day (the phone). */
  show: "weeks" | "days";
  foot?: ReactNode;
};

/**
 * The Money mini-app from the approved sketches, built only from @rms/ui. Seeded figures.
 * The lead number is plain, and its parts add up beside it.
 */
export function MoneyApp({ titleLevel = 1, show, foot }: MoneyAppProps) {
  const [week, setWeek] = useState(LATEST_WEEK);
  const index = WEEK_IDS.indexOf(week);
  const view = weekView(week);
  const cardLevel = titleLevel === 1 ? 2 : 4;
  const step = (by: number) => () => setWeek(WEEK_IDS[index + by] ?? week);

  return (
    <Dashboard
      title="Money"
      titleLevel={titleLevel}
      controls={
        <Pager
          label={view.range}
          previousLabel="Previous week"
          nextLabel="Next week"
          onPrevious={step(-1)}
          onNext={step(1)}
          previousDisabled={index <= 0}
          nextDisabled={index >= WEEK_IDS.length - 1}
        />
      }
      foot={foot}
    >
      <Card as="div">
        <StatLead
          label="Prime cost"
          value={view.prime}
          aside={
            <>
              <Text>Target 60%</Text>
              <Tag weight="outline" icon={view.against.icon}>
                {view.against.words}
              </Tag>
            </>
          }
        />
      </Card>

      <Card as="div">
        <StatGroup>
          <Stat label="Net sales" value={view.net} />
          <Stat label="Food and drink cost" value={view.goods} note={view.goodsShare} />
          <Stat label="Staff cost" value={view.staff} note={view.staffShare} />
        </StatGroup>
      </Card>

      {show === "weeks" ? (
        <>
          <Card title="Net sales, last eight weeks" titleLevel={cardLevel} titleSize="small" density="compact">
            <BarChart label="Net sales, last eight weeks" items={WEEKS.map((item) => ({ ...item, current: item.id === week }))} onSelect={setWeek} />
          </Card>
          <Card title="By location" titleLevel={cardLevel} titleSize="small" density="compact">
            <BarChart label="Net sales by location" direction="rows" items={view.locations} />
          </Card>
        </>
      ) : (
        <Card title="Day by day" titleLevel={cardLevel} action={<Text tone="muted">Net sales</Text>} density="compact">
          <BarChart label="Net sales, day by day" direction="rows" items={view.days} />
        </Card>
      )}
    </Dashboard>
  );
}
