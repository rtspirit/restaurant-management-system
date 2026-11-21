"use client";

// Task P owns this file. Brief: docs/briefs/wave3.md, task P.
// The owner's Share action for one of their published mini-apps: reads ShareStatus, lets the
// owner set a title and a summary, shows the one sentence to confirm (what is shared and what
// never is), sends ShareRequest and shows the plain result. The mini-app's page (task N)
// places it. The props are fixed by the brief.

export type ShareButtonProps = {
  /** The mini-app's public id (`app_...`). It names WHICH of the owner's mini-apps, nothing more. */
  appId: string;
};

/** Draws nothing until task P lands. */
export function ShareButton(_props: ShareButtonProps) {
  return null;
}
