// The `rms` command. Task H owns this file. The command line is fixed by BUILD_TOOL_CLI in @rms/contracts:
//
//   rms catalog --json '<CatalogLookupInput>'
//   rms gen     --json '<RunGeneratorInput>'   (or --file <path>)
//   rms check   [--json '<CheckInput>']
//
// Exactly one JSON object on stdout. Exit 0 = ok, 1 = the tool said no, 2 = the input did not parse.
import { BUILD_TOOL_CLI } from "@rms/contracts";

const main = (): number => {
  process.stdout.write(`${JSON.stringify({ ok: false, notes: ["The rms command is not built yet."] })}\n`);
  return BUILD_TOOL_CLI.exit.refused;
};

process.exitCode = main();
