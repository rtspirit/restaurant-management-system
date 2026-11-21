import type { ReactNode } from "react";
// The one stylesheet for the whole console. Screens are composed from @rms/ui and write no CSS.
import "@rms/ui/styles.css";
import { ConsoleFrame } from "@/components/console-frame";

export const metadata = { title: "RMS maintainer console" };

export const viewport = { width: "device-width", initialScale: 1, themeColor: "#DEE7F2" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ConsoleFrame>{children}</ConsoleFrame>
      </body>
    </html>
  );
}
