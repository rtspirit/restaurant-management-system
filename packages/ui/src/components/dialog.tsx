"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconButton } from "./button";
import { Heading } from "./text";

export type DialogProps = {
  open: boolean;
  /** Called when the owner closes it: the close button, the Escape key or a tap outside. */
  onClose: () => void;
  title: string;
  /** Buttons at the bottom. Put the main action last. Every confirmation says what will happen. */
  actions?: ReactNode;
  closeLabel?: string;
  children: ReactNode;
};

/**
 * For a decision that needs the owner's full attention, such as confirming a change.
 * Uses the platform dialog, so focus is held inside and Escape closes it.
 * On a phone it rises from the bottom as a sheet.
 */
export function Dialog({ open, onClose, title, actions, closeLabel = "Close", children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // Start at the top of the dialog so the title is read first, not the close button.
      inner.current?.focus({ preventScroll: true });
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="rms-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A press on the dimmed area lands on the dialog element itself, not on its contents.
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="rms-dialog__inner" ref={inner} tabIndex={-1}>
        <header className="rms-dialog__head">
          <Heading level={2} size="section" id={titleId}>
            {title}
          </Heading>
          <IconButton icon="close" label={closeLabel} onClick={onClose} />
        </header>
        <div className="rms-dialog__body">{children}</div>
        {actions ? <footer className="rms-dialog__actions">{actions}</footer> : null}
      </div>
    </dialog>
  );
}
