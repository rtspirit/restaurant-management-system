// Phone mode (ADR 0010): the start script and the redirects a phone follows.
//
// The script's own address guard is run for real (bash), with hostile addresses. The rest is read
// from the source: where the script listens, what it writes to its settings file, and where the
// web app's redirects can point.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repoPath } from "../helpers/env.js";

const script = readFileSync(repoPath("scripts/demo-phone.sh"), "utf8");

/** One function of the script, cut out so it can be run alone. */
const shellFunction = (name: string): string => {
  const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m").exec(script);
  if (!m) throw new Error(`scripts/demo-phone.sh has no function ${name}`);
  return m[0];
};

const isPrivate = (address: string): boolean => {
  try {
    execFileSync("bash", ["-c", `${shellFunction("is_private_ipv4")}\nis_private_ipv4 "$1"`, "guard", address], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("phone mode only starts on a private network address", () => {
  it("accepts home and office addresses (so the refusals below are not a guard that refuses everything)", () => {
    for (const ok of ["192.168.1.5", "192.168.0.1", "10.0.0.7", "172.16.0.1", "172.31.255.254"]) expect(isPrivate(ok), ok).toBe(true);
  });

  for (const bad of [
    "8.8.8.8",
    "1.1.1.1",
    "172.15.255.255",
    "172.32.0.1",
    "192.169.1.1",
    "193.168.1.1",
    "11.0.0.1",
    "100.64.0.1", // carrier network
    "169.254.10.10", // self-assigned
    "0.0.0.0",
    "",
    " ",
    "192.168.1",
    "192.168.1.5.6",
    "192.168.1.5.evil.test",
    "evil.test",
    "192.168.1.5 ",
    " 192.168.1.5",
    "192.168.1.5;id",
    "192.168.1.5\n8.8.8.8",
    "8.8.8.8\n192.168.1.5",
    "$(echo 10.0.0.1)",
    "::ffff:192.168.1.5",
    "fe80::1",
    "10.0.0.1/8",
    "http://10.0.0.1",
  ]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      expect(isPrivate(bad)).toBe(false);
    });
  }

  it("checks the address before it writes its settings, builds or starts anything", () => {
    const guard = script.indexOf('is_private_ipv4 "$ip" || die');
    expect(guard).toBeGreaterThan(0);
    for (const later of ['>"$ENV_PHONE"', "pnpm turbo run build", "start_bg api", "start_bg web"]) {
      const at = script.indexOf(later, script.indexOf("\nstart() {"));
      expect(at, later).toBeGreaterThan(guard);
    }
  });

  it("refuses to run unless .env.local points at the local sign-in service", () => {
    expect(script).toMatch(/case "\$\(host_of "\$sb_local"\)" in 127\.0\.0\.1\|localhost\) ;; \*\) die /);
  });
});

describe("phone mode: what listens where, and what it writes down", () => {
  it("the console is never started on every address", () => {
    const lines = script.split("\n");
    const at = lines.findIndex((l) => l.includes("start_bg console"));
    expect(at).toBeGreaterThan(0);
    expect(lines[at]).toContain('--hostname "$console_host"');
    // Only the API, the web app and (later) the mini-app host may be opened to the network.
    const open = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.includes("0.0.0.0") && !l.trim().startsWith("#"));
    expect(open.length).toBeGreaterThan(0);
    for (const { l, i } of open) {
      const command = l.trimEnd().endsWith("\\") ? `${l}\n${lines[i + 1] ?? ""}` : l;
      expect(/start_bg (api|web|apps) /.test(command), l).toBe(true);
      expect(/console|admin\b|CONSOLE_PORT" "\$ROOT\/apps\/admin/.test(command.replace(/ADMIN_URL="[^"]*"/, "")), l).toBe(false);
    }
  });

  it("outside phone mode, the API, the web app and the console listen on this laptop only", () => {
    const dev = readFileSync(repoPath("apps/api/src/dev.ts"), "utf8");
    expect(dev).toMatch(/process\.env\.API_HOST \?\? "127\.0\.0\.1"/);
    expect(dev).toMatch(/serve\(\{[^}]*\bhostname\b[^}]*\}/);
    for (const pkg of ["apps/web/package.json", "apps/admin/package.json"]) {
      const scripts = (JSON.parse(readFileSync(repoPath(pkg), "utf8")) as { scripts: Record<string, string> }).scripts;
      for (const name of ["dev", "start"]) expect(scripts[name], `${pkg} ${name}`).toMatch(/--hostname 127\.0\.0\.1(\s|$)/);
    }
    // Phone mode is the only place that asks the API for more.
    const asks = execFileSync("git", ["grep", "-l", "API_HOST=", "--", "scripts", "apps", "packages", "package.json", ".env.example"], { cwd: repoPath(), encoding: "utf8" }).split("\n").filter(Boolean);
    expect(asks).toEqual(["scripts/demo-phone.sh"]);
  });

  it("the console is built with laptop-only addresses, never the phone's", () => {
    const builds = script.split("\n").filter((l) => l.includes("@rms/admin build") && !l.includes("stop"));
    const consoleBuild = builds.find((l) => l.includes("NEXT_PUBLIC_API_URL="));
    expect(consoleBuild).toContain('NEXT_PUBLIC_API_URL="http://127.0.0.1:$API_PORT"');
    expect(consoleBuild).toContain('NEXT_PUBLIC_SUPABASE_URL="$sb_local"');
  });

  it("its settings file holds addresses and one on/off flag only: no key, password, token or database address", () => {
    const block = /\n {2}\{\n([\s\S]*?)\n {2}\} >"\$ENV_PHONE"/.exec(script);
    expect(block).not.toBeNull();
    const names = [...(block?.[1] ?? "").matchAll(/echo "([A-Z0-9_]+)=/g)].map((m) => m[1] as string);
    expect(names.length).toBeGreaterThanOrEqual(4);
    const ALLOWED = ["RMS_LOCAL_DEMO", "WEB_URL", "APPS_URL", "RMS_LOCAL_DEMO_ORIGINS", "NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_SUPABASE_URL"];
    for (const name of names) {
      expect(ALLOWED, name).toContain(name);
      expect(name).not.toMatch(/SECRET|PASSWORD|KEY|TOKEN|DATABASE/);
    }
    // Nothing read from .env.local is copied in, and every value is built from the checked address.
    expect(block?.[1]).not.toMatch(/local_setting|ENV_LOCAL|cat /);
    const values = [...(block?.[1] ?? "").matchAll(/echo "[A-Z0-9_]+=([^"]*)"/g)].map((m) => m[1] as string);
    for (const v of values) expect(v, v).toMatch(/^(1|\$web_origin|\$apps_origin|\$api_url|\$web_origin\$\{apps_origin:\+,\$apps_origin\}|http:\/\/\$web_host:\$sb_port)$/);
  });

  it("it reads only address settings out of .env.local, and never prints the file", () => {
    const read = [...script.matchAll(/local_setting ([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(read.length).toBeGreaterThan(0);
    for (const name of read) {
      expect(["NEXT_PUBLIC_SUPABASE_URL", "WEB_URL", "ADMIN_URL"], name).toContain(name);
      expect(name).not.toMatch(/SECRET|PASSWORD|KEY|TOKEN|DATABASE/);
    }
    expect(script).not.toMatch(/cat\s+"?\$ENV_LOCAL|set -x|printenv|\benv\b\s*$/m);
    // Only the phone settings file is ever sourced into the script's own environment.
    expect([...script.matchAll(/^\s*\. "?(\$[A-Z_]+)"?/gm)].map((m) => m[1])).toEqual(["$ENV_PHONE"]);
  });

  it("the extra origin it gives the API is the phone's one address, built from the checked address", () => {
    expect(script).toContain('web_origin="http://$web_host:$WEB_PORT"');
    const given = [...script.matchAll(/WEB_EXTRA_ORIGINS=("[^"]*"|\S+)/g)].map((m) => m[1]);
    expect(given.length).toBeGreaterThan(0);
    for (const g of given) expect(g).toBe('"$web_origin"');
    // The local-demo list is the shell and the mini-app host, nothing else, never a pattern.
    const demo = [...script.matchAll(/RMS_LOCAL_DEMO_ORIGINS=([^"\n]*)/g)].map((m) => m[1]);
    for (const d of demo) expect(d).toBe("$web_origin${apps_origin:+,$apps_origin}");
    expect(script).not.toMatch(/ORIGINS=[^\n]*\*/);
  });

  it("the settings and logs it writes are git-ignored", () => {
    const ignore = readFileSync(repoPath(".gitignore"), "utf8");
    expect(ignore).toMatch(/^\.env\.phone$/m);
    expect(ignore).toMatch(/^\.phone-mode\/$/m);
  });
});

describe("redirects a phone follows cannot be pointed somewhere else", () => {
  const signOut = readFileSync(repoPath("apps/web/app/(auth)/sign-out/route.ts"), "utf8");
  const proxy = readFileSync(repoPath("apps/web/lib/supabase/proxy.ts"), "utf8");

  it("sign-out never looks at the request: no address, header or query value can steer it", () => {
    expect(signOut).toMatch(/export async function POST\(\)/);
    const code = signOut.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/request|headers\(\)|searchParams|nextUrl|x-forwarded|\bhost\b|NextResponse\.redirect/i);
    expect(code).toContain('location: "/sign-in"');
    expect(code).toContain("status: 303");
    // Only POST signs out: a link or an image on another page cannot do it with a GET.
    expect(code).not.toMatch(/export (async )?function (GET|HEAD)/);
  });

  it("the session proxy only ever redirects to a fixed path on the address the browser is already on", () => {
    const code = proxy.replace(/\/\/.*$/gm, "");
    const targets = [...code.matchAll(/return redirect\(([^)]*)\)/g)].map((m) => m[1]);
    expect(targets.sort()).toEqual(['"/"', '"/sign-in"']);
    expect(code).toContain("target.pathname = to");
    expect(code).toContain('target.search = ""');
    expect(code).not.toMatch(/searchParams|x-forwarded|headers\.get\(|\.host\s*=|\.hostname\s*=|\.protocol\s*=|\.port\s*=/);
  });

  it("no page or route in the web app redirects to an address taken from the request", () => {
    const files = execFileSync("git", ["ls-files", "-z", "apps/web"], { cwd: repoPath(), encoding: "utf8" }).split("\0").filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(10);
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(repoPath(f), "utf8");
      if (/(redirect|router\.(push|replace)|location\.(assign|replace|href\s*=))\s*\(?[^)\n]*(searchParams|get\(["'](next|redirect|return|returnTo|to|url)["']\))/i.test(text)) hits.push(f);
      if (/NextResponse\.redirect\(\s*new URL\([^)]*request\.(url|headers)/.test(text)) hits.push(f);
    }
    expect(hits).toEqual([]);
  });
});

describe("the session cookie stays on the web app's own host", () => {
  it("the web app never widens the cookie to other hosts (no Domain attribute is ever set)", () => {
    const files = execFileSync("git", ["ls-files", "-z", "apps/web", "apps/admin"], { cwd: repoPath(), encoding: "utf8" }).split("\0").filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
    const hits = files.filter((f) => /\bdomain\s*:|Domain=/i.test(readFileSync(repoPath(f), "utf8")));
    expect(hits).toEqual([]);
  });

  it("phone mode puts the mini-app host on the laptop's OTHER name, or does not start it", () => {
    // Cookies ignore the port. So a mini-app served on the web app's host would be sent the session.
    expect(script).toMatch(/if \[ "\$PHONE_ADDRESS" = ip \] \|\| \[ -z "\$name" \]; then\n\s*web_host="\$ip"; apps_host="\$name"\n\s*else\n\s*web_host="\$name"; apps_host="\$ip"/);
    // The mini-app host's address is only ever built from that other name.
    const appsAddresses = [...script.matchAll(/(?:apps_origin|APPS_URL|RMS_APPS_PUBLIC_URL)=("?http[^"\n]*)/g)].map((m) => m[1] as string);
    expect(appsAddresses.length).toBeGreaterThan(0);
    for (const a of appsAddresses) expect(a, a).toContain("$apps_host:");
    // And the line that starts it is only reached when there is such a name.
    const lines = script.split("\n");
    const startAt = lines.findIndex((l) => l.includes("start_bg apps "));
    expect(startAt).toBeGreaterThan(0);
    const guard = lines.slice(Math.max(0, startAt - 4), startAt + 1).join("\n");
    expect(guard).toMatch(/\[ -z "\$apps_host" \]|\[ -n "\$apps_host" \]/);
  });
});
