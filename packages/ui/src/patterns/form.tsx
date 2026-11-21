import type { FormEvent, ReactNode } from "react";
import { Card } from "../components/card";
import { Text } from "../components/text";

export type FormLayoutProps = {
  /** What this form is for: "Add a bill". */
  title: string;
  /** One sentence on what happens when it is saved. */
  description?: string;
  /** TextField, Select and FieldPair, in the order the owner would say them aloud. */
  children: ReactNode;
  /** Buttons. Put the main action last: it sits on the right, and at the top of the stack on a phone. */
  actions: ReactNode;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
};

/**
 * Pattern: form. One card, one column, labels above fields, the main action last.
 * Errors appear under the field they belong to, in plain words.
 */
export function FormLayout({ title, description, children, actions, onSubmit }: FormLayoutProps) {
  return (
    <form
      className="rms-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.(event);
      }}
    >
      <Card title={title} as="div">
        <div className="rms-form__fields">
          {description ? <Text tone="muted">{description}</Text> : null}
          {children}
        </div>
      </Card>
      <div className="rms-form__actions">{actions}</div>
    </form>
  );
}
