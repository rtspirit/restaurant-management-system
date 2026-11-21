// Locked. The build agent may not change this file.
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

// The one origin allowed to show this mini-app in a frame: the RMS web app. Written by the
// runner into `.env.local` (VITE_RMS_SHELL_ORIGIN, FRAME_ENV in @rms/contracts). Same rule as
// `Origin` in @rms/contracts frame.ts, repeated here because this file is loaded by Node before
// anything is compiled. Anything that does not parse means "nobody may frame this".
const ORIGIN = /^https?:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;
const LOCAL_HTTP = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

export const shellOriginFrom = (value: string | undefined): string | null => {
  if (value === undefined || value.length > 200 || !ORIGIN.test(value)) return null;
  return value.startsWith("https://") || LOCAL_HTTP.test(value) ? value : null;
};

/**
 * The dev server's content policy. It is a response HEADER: browsers ignore `frame-ancestors`
 * in a `<meta>` tag. Vite and React refresh inject an inline script and style tags, and the
 * dev client talks to the server over a websocket, so the dev policy allows those.
 *
 * The built files (Wave 3) get their policy from the apps host, also as a header:
 *   default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
 *   font-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none';
 *   frame-ancestors <shell origin>
 */
export const devPolicy = (shellOrigin: string | null): string =>
  [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    // 'self' covers the dev server's own websocket (ws/wss to the same host and port), and
    // nothing else: no other host, no other port.
    "connect-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${shellOrigin ?? "'none'"}`,
  ].join("; ");

// Screens only: this builds to static files in dist/. There is no server code in a mini-app.
export default defineConfig(({ mode }) => {
  const shellOrigin = shellOriginFrom(loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "VITE_").VITE_RMS_SHELL_ORIGIN);
  const headers = { "Content-Security-Policy": devPolicy(shellOrigin), "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      // The preview is opened through the build sandbox's own address, or 127.0.0.1 on this
      // machine. Never localhost: the web app lives there and cookies ignore the port.
      allowedHosts: [".vercel.run", "127.0.0.1"],
      headers,
    },
    preview: { headers },
    build: { outDir: "dist", sourcemap: false },
  };
});
