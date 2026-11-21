# 0005: The Vercel guard and the login's other teams

Date: 2026-11-21. Status: decided by Rahul ("Allow but don't access it. Stay focused on the personal project team.").

## Context

The personal Vercel login `rtspirit` is also a member of a TradeEngage team. The first version of `scripts/preflight-vercel.sh` stopped whenever the login could see such a team, which blocked all Vercel work.

## Decision

- The guard no longer stops because the login is a member of another team.
- The guard never lists, reads or switches to another team. It checks the personal team directly with a command scoped to it.
- Everything else is unchanged: every command is pinned to `team_RM4toarAtl8vljERLdxRvfeh` (`rtspirits-projects`), and the guard stops on any argument, environment variable, linked project or project name that points at another team or contains "tradeengage" or "te-team". Tokens are refused: only the personal `vercel login` session is used.
- The Vercel connector attached to this session is still not used. All Vercel work goes through the CLI and the guard.

## Checked

Guard passes for `rtspirit` on the personal team. It still stops on: a banned project name, another team as scope, another team id in the environment, and a token argument.
