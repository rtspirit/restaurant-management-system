import type { ReactNode } from "react";
import { Button, Canvas, Heading, Logo, Text } from "@rms/ui";
import { RmsShell } from "@/components/rms-shell";
import { loadShell } from "@/components/shell-data";
import { SignOutNow } from "@/lib/sign-out";

// Every signed-in RMS screen sits inside this frame.
export default async function ShellLayout({ children }: { children: ReactNode }) {
  const load = await loadShell();

  // The API refused this session. Sign out here rather than redirect, or the proxy loops.
  if (load.status === "signed-out") {
    return (
      <Canvas narrow header={<Logo />}>
        <SignOutNow />
      </Canvas>
    );
  }

  // The API did not answer. Say so plainly; the reason stays on the server.
  if (load.status === "unavailable") {
    return (
      <Canvas narrow header={<Logo />}>
        <Heading level={1} size="page">
          RMS is not answering just now
        </Heading>
        <Text>Nothing has been lost. Give it a moment, then try again.</Text>
        <div>
          <Button variant="primary" href="/">
            Try again
          </Button>
        </div>
      </Canvas>
    );
  }

  return <RmsShell data={load.data}>{children}</RmsShell>;
}
