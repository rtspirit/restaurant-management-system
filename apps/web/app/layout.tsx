import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
// The one stylesheet for the whole app. Screens are composed from @rms/ui and write no CSS.
import "@rms/ui/styles.css";

export const metadata: Metadata = {
  title: { default: "RMS", template: "%s · RMS" },
  description: "Run your restaurant, and build the tools you need by saying what you want.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#DEE7F2",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
