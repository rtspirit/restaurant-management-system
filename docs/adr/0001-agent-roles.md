# 0001: Agent roles for the demo build

Date: 2026-11-21. Status: decided by the lead.

## Decisions

1. **Seven agent definitions** in `.claude/agents/`: architect-reviewer, implementer, designer, domain-modeller, code-reviewer, security-reviewer, qa. The lead is the main session and has no file.
2. **One implementer definition, not two.** It defaults to Opus 5.5. For starred tasks in `03-demo-build.md` the lead overrides the model to the most capable one when it starts the agent.
3. **The security reviewer may write attack tests, and nothing else.** The plan's table says it cannot edit, and also says it writes attack tests. Resolved as: read-only on product code, write access only under `tests/security/`.
4. **Reviewers have no edit tools.** architect-reviewer and code-reviewer get read, search and shell only.
5. **`Claude outputs/` is git-ignored.** It holds the old v0 plan. `docs/plan/` is the source of truth.

## Not decided here

The push-to-`main` hook on this machine blocks direct pushes. Whether the lead pushes to `main` or works through branches and pull requests is Rahul's call.
