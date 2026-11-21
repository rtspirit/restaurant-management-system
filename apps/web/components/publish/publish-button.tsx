"use client";

// Task N owns this file. Brief: docs/briefs/wave3.md, task N.
// The owner's Publish action for one of their mini-apps: reads PublishStatus, shows the one
// sentence to confirm in a Dialog, sends PublishRequest, shows the steps while it runs and the
// plain result. The build screen (task J) and the mini-app's own page both place it. The
// props are fixed by the brief.

export type PublishButtonProps = {
  /** The mini-app's public id (`app_...`). It names WHICH of the owner's mini-apps, nothing more: the server decides whose it is. */
  appId: string;
  /** Called after a publish that went live, with the mini-app's address inside RMS (`/apps/<slug>`). */
  onPublished?: (href: string) => void;
};

/** Draws nothing until task N lands. */
export function PublishButton(_props: PublishButtonProps) {
  return null;
}
