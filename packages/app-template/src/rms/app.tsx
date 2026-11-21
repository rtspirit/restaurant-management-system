// Locked. Everything under src/rms/ belongs to RMS. The build agent may not change it.
//
// The mini-app's frame: it connects to RMS through @rms/sdk, applies the restaurant's colour,
// and draws the screens listed in src/screens/index.ts with navigation between them.
// Opened anywhere but inside RMS, it says so and does nothing else.
import { type Connection, RmsProvider, connect } from "@rms/sdk";
import { Canvas, CanvasHeader, EmptyState, Skeleton, Stack, Tag, TabLinks, Theme } from "@rms/ui";
import { useEffect, useState } from "react";
import manifest from "../../rms.config";
import { screens } from "../screens";
import { ScreenBoundary } from "./boundary";
import { useScreenName } from "./route";

// One connection for the life of the page (React may mount the app twice in development).
const connection: Promise<Connection> = connect({ shellOrigin: import.meta.env.VITE_RMS_SHELL_ORIGIN });

export function App() {
  const [conn, setConn] = useState<Connection | null>(null);
  const [brand, setBrand] = useState<string | null>(null);
  const current = useScreenName(screens.map((s) => s.name));

  useEffect(() => {
    document.title = manifest.name;
    let stop = (): void => undefined;
    let live = true;
    void connection.then((c) => {
      if (!live) return;
      setConn(c);
      if (c.connected) {
        setBrand(c.context.restaurant.brandColour);
        stop = c.onTheme(setBrand);
      }
    });
    return () => {
      live = false;
      stop();
    };
  }, []);

  if (conn === null) {
    return (
      <Theme brand={null}>
        <Canvas narrow>
          <Stack gap="m">
            <Skeleton shape="figure" width="m" label="Opening" />
            <Skeleton shape="block" />
          </Stack>
        </Canvas>
      </Theme>
    );
  }

  if (!conn.connected) {
    return (
      <Theme brand={null}>
        <Canvas narrow>
          <EmptyState title="Open this from RMS" titleLevel={2}>
            This mini-app works inside RMS. Open RMS and choose it from your mini-apps.
          </EmptyState>
        </Canvas>
      </Theme>
    );
  }

  const screen = screens.find((s) => s.name === current) ?? screens[0];
  const Screen = screen?.component;
  const nav =
    screens.length > 1 ? (
      <TabLinks label={manifest.name} items={screens.map((s) => ({ href: `#/${s.name}`, label: s.title, current: s.name === screen?.name }))} />
    ) : undefined;

  return (
    <Theme brand={brand}>
      <RmsProvider context={conn.context} client={conn.client}>
        <Canvas header={<CanvasHeader logo={null} title={conn.context.app.name} nav={nav} end={conn.context.env === "draft" ? <Tag weight="outline">Preview</Tag> : undefined} />}>
          <ScreenBoundary key={screen?.name ?? ""}>{Screen ? <Screen /> : null}</ScreenBoundary>
        </Canvas>
      </RmsProvider>
    </Theme>
  );
}
