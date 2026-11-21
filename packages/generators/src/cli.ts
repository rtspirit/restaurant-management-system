// The `rms` command. The command line is fixed by BUILD_TOOL_CLI in @rms/contracts:
//
//   rms catalog --json '<CatalogLookupInput>'        or   rms catalog models [words to search for]
//   rms gen     --json '<RunGeneratorInput>'          or   rms gen list_detail --model vendor --screen vendors --title "Vendors" [--fields a,b] [--form]
//   rms gen     --file <path to a JSON file>
//   rms check   [--json '<CheckInput>']
//   rms lock    (writes .rms/locked.json: for trying the template by hand only)
//
// Exactly one JSON object on stdout. Exit 0 = ok, 1 = the tool said no, 2 = the input did not parse.
import { readFileSync } from "node:fs";
import { BUILD_TOOL_CLI, CatalogKind, CatalogLookupInput, CheckInput, RunGeneratorInput } from "@rms/contracts";
import { lookupCatalog, runCheck, runGenerator, writeLockedHashes } from "./index.js";

type Outcome = { code: number; body: unknown };

const bad = (note: string): Outcome => ({ code: BUILD_TOOL_CLI.exit.badInput, body: { ok: false, notes: [note] } });

const flags = (args: string[]): { positional: string[]; named: Map<string, string | true> } => {
  const positional: string[] = [];
  const named = new Map<string, string | true>();
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? "";
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        named.set(a.slice(2), next);
        i += 1;
      } else named.set(a.slice(2), true);
    } else positional.push(a);
  }
  return { positional, named };
};

const jsonInput = (named: Map<string, string | true>): { value: unknown } | { error: string } | null => {
  const json = named.get("json");
  const file = named.get("file");
  try {
    if (typeof json === "string") return { value: JSON.parse(json) };
    if (typeof file === "string") return { value: JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return { error: "The input is not valid JSON." };
  }
  if (json === true || file === true) return { error: "--json needs a value, and --file needs a path." };
  return null;
};

const list = (v: string | true | undefined): string[] | undefined => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

const shortGen = (positional: string[], named: Map<string, string | true>): unknown => {
  const generator = positional[0];
  const str = (k: string): string | undefined => (typeof named.get(k) === "string" ? (named.get(k) as string) : undefined);
  const out: Record<string, unknown> = { generator, screen: str("screen"), title: str("title") };
  if (generator === "list_detail" || generator === "form") {
    out.model = str("model");
    if (named.has("fields")) out.fields = list(named.get("fields"));
    if (generator === "list_detail" && named.has("form")) out.form = true;
  } else {
    out.query = str("query");
    if (named.has("columns")) out.columns = list(named.get("columns"));
  }
  return out;
};

const issues = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string =>
  error.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join(".") || "input"}: ${i.message}`)
    .join("; ");

export const main = async (argv: string[], appDir: string): Promise<Outcome> => {
  const [sub, ...rest] = argv;
  const { positional, named } = flags(rest);
  const given = jsonInput(named);
  if (given && "error" in given) return bad(given.error);

  if (sub === BUILD_TOOL_CLI.subcommands.catalog_lookup) {
    const raw = given ? given.value : { kind: positional[0], ...(positional.length > 1 ? { search: positional.slice(1).join(" ") } : {}) };
    const parsed = CatalogLookupInput.safeParse(raw);
    if (!parsed.success) return bad(`Say what to look up: one of ${CatalogKind.options.join(", ")}. ${issues(parsed.error)}`);
    return { code: BUILD_TOOL_CLI.exit.ok, body: await lookupCatalog(appDir, parsed.data) };
  }
  if (sub === BUILD_TOOL_CLI.subcommands.run_generator) {
    const parsed = RunGeneratorInput.safeParse(given ? given.value : shortGen(positional, named));
    if (!parsed.success) return bad(`The generator input does not fit. ${issues(parsed.error)}. See \`rms catalog generators\` for a full example of each.`);
    const out = await runGenerator(appDir, parsed.data);
    return { code: out.ok ? BUILD_TOOL_CLI.exit.ok : BUILD_TOOL_CLI.exit.refused, body: out };
  }
  if (sub === BUILD_TOOL_CLI.subcommands.check) {
    const parsed = CheckInput.safeParse(given ? given.value : {});
    if (!parsed.success) return bad(`The check input does not fit. ${issues(parsed.error)}`);
    const out = await runCheck(appDir, parsed.data);
    return { code: out.ok ? BUILD_TOOL_CLI.exit.ok : BUILD_TOOL_CLI.exit.refused, body: out };
  }
  if (sub === "lock") {
    const hashes = await writeLockedHashes(appDir);
    return { code: BUILD_TOOL_CLI.exit.ok, body: { ok: true, files: Object.keys(hashes.files).length } };
  }
  return bad("Use one of: rms catalog, rms gen, rms check.");
};

/** Runs the command for this process: reads argv, writes one JSON line, sets the exit code. */
export const run = (): Promise<void> =>
  main(process.argv.slice(2), process.cwd()).then(
    ({ code, body }) => {
      process.stdout.write(`${JSON.stringify(body)}\n`);
      process.exitCode = code;
    },
    () => {
      process.stdout.write(`${JSON.stringify({ ok: false, notes: ["The tool stopped unexpectedly. Try again; if it happens again, say so in your last message."] })}\n`);
      process.exitCode = BUILD_TOOL_CLI.exit.refused;
    },
  );
