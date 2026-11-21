import type { ReactNode } from "react";
import { cx } from "../cx";

export type ConversationProps = {
  /** Names the thread for screen readers: "Build conversation". */
  label: string;
  children: ReactNode;
};

/** The thread. New messages are announced politely to screen readers. */
export function Conversation({ label, children }: ConversationProps) {
  return (
    <div className="rms-conversation" role="log" aria-label={label} aria-live="polite">
      {children}
    </div>
  );
}

export type MessageProps = {
  /** you: the owner's own words, on the right. rms: what RMS says back, on the left. */
  from: "you" | "rms";
  /**
   * RMS can answer with plain words (a soft bubble) or with cards (a plan, what was assumed,
   * progress). Pass cards as children and set `plain` to false.
   */
  plain?: boolean;
  children: ReactNode;
};

export function Message({ from, plain = true, children }: MessageProps) {
  return (
    <div className={cx("rms-message", `rms-message--${from}`, from === "rms" && plain && "rms-message--plain")}>
      <span className="rms-sr-only">{from === "you" ? "You said: " : "RMS said: "}</span>
      {children}
    </div>
  );
}

export type Answer = { question: string; answer: string };

export type AnswersProps = {
  /** Names the list for screen readers: "Your answers". */
  label: string;
  items: Answer[];
};

/** Questions already answered, kept as quiet chips so the thread stays short. */
export function Answers({ label, items }: AnswersProps) {
  return (
    <ul className="rms-answers" aria-label={label}>
      {items.map((item) => (
        <li key={item.question}>
          {item.question} <b>{item.answer}</b>
        </li>
      ))}
    </ul>
  );
}
