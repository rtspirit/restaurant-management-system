"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "./button";

export type ComposerProps = {
  /** What to type, in plain words: "Tell me what to change". Used as the label and the placeholder. */
  label: string;
  /** Called with the trimmed text when the owner sends. The box then clears. */
  onSend: (text: string) => void;
  sendLabel?: string;
  /** RMS is working: the box stays readable but Send loses its colour. */
  busy?: boolean;
  /** Control the text from outside, for example to drop a suggestion in. */
  value?: string;
  onChange?: (text: string) => void;
};

/**
 * The box the owner talks to RMS through. Enter sends, Shift and Enter makes a new line.
 * Send only has colour when there is something to send.
 */
export function Composer({ label, onSend, sendLabel = "Send", busy = false, value, onChange }: ComposerProps) {
  const [inner, setInner] = useState("");
  const text = value ?? inner;
  const setText = (next: string) => {
    if (value === undefined) setInner(next);
    onChange?.(next);
  };
  const ready = text.trim().length > 0 && !busy;

  const send = () => {
    if (!ready) return;
    onSend(text.trim());
    setText("");
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  return (
    <form className="rms-composer" onSubmit={onSubmit}>
      <textarea
        className="rms-composer__input"
        rows={1}
        aria-label={label}
        placeholder={label}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        enterKeyHint="send"
      />
      <Button type="submit" variant="primary" disabled={!ready}>
        {sendLabel}
      </Button>
    </form>
  );
}
