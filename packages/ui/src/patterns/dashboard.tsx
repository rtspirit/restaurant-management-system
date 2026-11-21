import type { ReactNode } from "react";
import { Heading } from "../components/text";

export type DashboardProps = {
  /** The mini-app's name: "Money". */
  title: string;
  /** Heading level for the title: 1 when it is the page, 3 inside a preview. */
  titleLevel?: 1 | 2 | 3;
  /** Controls for what is shown, such as a Pager for the week. */
  controls?: ReactNode;
  /**
   * Cards, one idea each, most important first. Lead with a Card holding a StatLead,
   * then a StatGroup, then charts.
   */
  children: ReactNode;
  /** Actions at the bottom, such as "Ask about your numbers". */
  foot?: ReactNode;
};

/**
 * Pattern: dashboard. A title, the period on screen, then a stack of one-idea cards.
 * The lead number is plain and its parts add up beside it.
 */
export function Dashboard({ title, titleLevel = 1, controls, children, foot }: DashboardProps) {
  return (
    <div className="rms-dashboard">
      <header className="rms-dashboard__head">
        <Heading level={titleLevel} size={titleLevel === 1 ? "page" : "app"}>
          {title}
        </Heading>
        {controls}
      </header>
      {children}
      {foot ? <footer className="rms-dashboard__foot">{foot}</footer> : null}
    </div>
  );
}
