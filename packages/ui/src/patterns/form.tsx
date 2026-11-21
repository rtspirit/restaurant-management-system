import type { FormEvent, ReactNode } from "react";
import { Card } from "../components/card";
import { Heading, Text } from "../components/text";

export type FormLayoutProps = {
  /** What this form is for: "Add a bill". */
  title: string;
  /** 1 when the form is the whole page (sign-in). Defaults to 2. */
  titleLevel?: 1 | 2 | 3;
  /** One sentence on what happens when it is saved. */
  description?: string;
  /** TextField, Select and FieldPair, in the order the owner would say them aloud. */
  children: ReactNode;
  /** A Notice about the whole form, shown between the fields and the buttons. */
  message?: ReactNode;
  /** Buttons. Put the main action last: it sits on the right, and at the top of the stack on a phone. */
  actions: ReactNode;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
};

/**
 * Pattern: form. One card, one column, labels above fields, the main action last.
 * Errors appear under the field they belong to, in plain words.
 */
export function FormLayout({ title, titleLevel = 2, description, children, message, actions, onSubmit }: FormLayoutProps) {
  return (
    <form
      className="rms-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.(event);
      }}
    >
      <Card as="div">
        <div className="rms-form__fields">
          <Heading level={titleLevel} size={titleLevel === 1 ? "app" : "card"}>
            {title}
          </Heading>
          {description ? <Text tone="muted">{description}</Text> : null}
          {children}
        </div>
      </Card>
      {message}
      <div className="rms-form__actions">{actions}</div>
    </form>
  );
}
