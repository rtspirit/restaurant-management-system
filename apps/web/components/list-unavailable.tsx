import { Button, EmptyState } from "@rms/ui";

/** Shown in place of a list RMS could not load. The reason stays on the server. */
export function ListUnavailable({ title, href }: { title: string; href: string }) {
  return (
    <EmptyState title={title} action={<Button href={href}>Try again</Button>}>
      Nothing has been lost. Give it a moment, then try again.
    </EmptyState>
  );
}
