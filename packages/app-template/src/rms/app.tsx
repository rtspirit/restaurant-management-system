// Locked. Everything under src/rms/ belongs to RMS. The build agent may not change it.
//
// The mini-app's frame: it will connect to RMS through @rms/sdk, apply the restaurant's theme,
// and draw the screens listed in src/screens/index.ts. Task H completes this file. For now it
// draws the first screen so the template builds and can be looked at.
import { Canvas, Theme } from "@rms/ui";
import { useEffect } from "react";
import manifest from "../../rms.config";
import { screens } from "../screens";

export function App() {
  useEffect(() => {
    document.title = manifest.name;
  }, []);

  const Screen = screens[0]?.component;
  return (
    <Theme brand={null}>
      <Canvas>{Screen ? <Screen /> : null}</Canvas>
    </Theme>
  );
}
