// A small reporter for scripts/rehearse.sh: one line per test, as JSON, with its file, title,
// project and outcome. Nothing else: no steps (a step title can carry what was typed), no
// errors, no attachments. Written to tests/e2e/results/outcomes.jsonl.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "results", "outcomes.jsonl");

export default class BeatReporter implements Reporter {
  private lines = new Map<string, string>();

  onTestEnd(test: TestCase, result: TestResult): void {
    const project = test.parent.project()?.name ?? "";
    // The last attempt wins (retries).
    this.lines.set(
      test.id,
      JSON.stringify({
        file: relative(HERE, test.location.file),
        title: test.titlePath().slice(3).join(" > "),
        project,
        expected: test.expectedStatus,
        status: result.status,
        outcome: test.outcome(),
      }),
    );
  }

  onEnd(_result: FullResult): void {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, [...this.lines.values()].join("\n") + "\n");
  }

  printsToStdio(): boolean {
    return false;
  }
}
