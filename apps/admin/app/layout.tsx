import type { ReactNode } from "react";

export const metadata = { title: "RMS maintainer console" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
