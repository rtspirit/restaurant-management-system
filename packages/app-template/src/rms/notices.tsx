// Locked. Plain words the generated screens share, so every mini-app says them the same way.
import { useRms, type RmsDataError } from "@rms/sdk";
import { EmptyState, Notice } from "@rms/ui";

/**
 * For a screen that reads sales or money and got no rows. In a preview the draft store has no
 * numbers yet (they show once the mini-app is published), so the screen says that rather than
 * "nothing happened".
 */
export function NoNumbers({ what }: { what: string }) {
  const { env } = useRms();
  if (env === "draft") {
    return <EmptyState title="No numbers yet">They show once the mini-app is published.</EmptyState>;
  }
  return <EmptyState title={`No ${what} yet`}>They show here as soon as there are some.</EmptyState>;
}

/** A data call that failed, in the plain words RMS sent. Never the technical detail. */
export function Problem({ error }: { error: RmsDataError | null }) {
  if (error === null) return null;
  return <Notice kind="problem">{error.message}</Notice>;
}
