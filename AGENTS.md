# AGENTS.md

Guidance for coding agents (Claude Code, Codex, and anything else) working in
this repository. `CLAUDE.md` imports this file, so both toolchains read the
same rules. Put shared guidance here, not in a tool-specific file.

## What this repository is

Market Ondo is a personal, **read-only** Cloudflare Worker that monitors the
Hyperliquid `xyz:SP500` perpetual market and reports diagnostics to a private
Discord guild. It never places, modifies, or cancels orders, and it holds no
account credentials for any venue.

It is evidence-first research software. Most of the value is in what it
deliberately refuses to claim, so the constraints below are the product, not
red tape around it.

## Layout

| Path | What lives there |
| --- | --- |
| `src/` | The live TypeScript Worker. This is production. |
| `python/reversal_scanner_backtest/` | Offline research: replays, event studies, backtests. Never runs in the Worker. |
| `tests/` | Vitest suites for `src/`. |
| `python/tests/` | pytest suites, including the cross-language contract parity test. |
| `config/signal_frozen_v1.yaml` | The frozen signal contract. See below. |
| `docs/` | Methodology, evidence, operations, and process. `docs/README.md` is the map. |
| `docs/work/` | Per-change artifacts: intent, spec, plan, review, incident. |
| `scripts/` | Local Node utilities for data conversion and Discord registration. |

Python dependencies and generated reports are not part of the Worker runtime.
Keep that separation: do not import research code from `src/`, and do not make
the Worker depend on anything under `python/`.

## Invariants — do not break these

1. **Live market access stays read-only.** Do not add account keys, wallet
   credentials, order routes, or any write endpoint against a trading venue.
   Auto-execution and individualized recommendations are permanently out of
   scope, not un-started features.

2. **The frozen signal contract is enforced by tests.**
   `config/signal_frozen_v1.yaml` pins the reversal thresholds. Those numbers
   exist in three places — `src/signal-engine.ts`,
   `python/reversal_scanner_backtest/signal_engine.py`, and `wrangler.toml` —
   and `python/tests/test_contract_parity.py` regex-matches them against each
   other. Changing a constant in one language alone **fails CI by design**.
   That failure is the guardrail working; do not "fix" it by loosening the
   test. If a threshold genuinely must change, it needs an evidence gate
   (below), a version bump, and all sides updated together.

3. **Shadow telemetry never promotes itself.** `MARKET_ACTIVITY_MODE`,
   `FRAGILITY_PERSISTENCE_MODE`, and `RESILIENCE_DECAY_SHADOW_MODE` gate
   collection at `off` / `shadow` / `display`. Data collected in `shadow` can
   never alter alerts, colors, `@everyone` mentions, eligibility, or
   thresholds without an explicit versioned code or config change that has
   passed a review gate. Parser defaults stay conservative even where this
   deployment opts in.

4. **Fail closed for decisions, fail open for the monitor.** When data health
   is uncertain — stale, gapped, holiday, early close, or overnight — withhold
   eligibility, RVOL-as-live-input, reversal routing, and mentions. But keep
   the read-only monitor itself available: provider, metadata, or KV failures
   must degrade to a partial, clearly labelled brief rather than an outage.

5. **The rejected probability-v2 model stays out of the Worker.** Its
   out-of-sample Brier Skill Score was negative. Do not reintroduce its
   coefficients or wire the v2 research layer into runtime output. See
   [`docs/fragility-v2-evaluation-report.md`](docs/fragility-v2-evaluation-report.md).

6. **No behavior change ships on in-sample tuning.** Every threshold or
   classification change needs chronological, out-of-sample evidence that
   clears the promotion gate in
   [`docs/backtest-evaluation-plan.md`](docs/backtest-evaluation-plan.md).
   Do not tune parameters against a sample that has already been inspected and
   then describe the result as out of sample.

7. **Stay inside the resource budget.** The Worker's cadence, KV operation
   ceilings, and one-request-per-scan discipline are documented in
   [`docs/operations.md`](docs/operations.md). A new diagnostic should reuse
   candles already fetched rather than adding a Hyperliquid request.

8. **Labels are diagnostics, not predictions.** `BREAKING`, `PANIC`, `FADING`,
   `ALERT` and the `0–100` stress score are transparent failure counts and
   heuristics. Do not describe them in code, comments, docs, or Discord output
   as probabilities, confidence intervals, or trade instructions.

## Before you open a PR

Run everything CI runs. These five commands are exactly `.github/workflows/ci.yml`:

```bash
npm ci
npm test
npm run typecheck
uv sync --dev
uv run pytest
```

New business logic needs regression tests. Changes that touch both the live
TypeScript path and the Python research port need tests on both sides, and
must keep `python/tests/test_contract_parity.py` green.

## How work is structured

Non-trivial changes follow a committed artifact chain — intent → spec → plan →
diff → review → incident. Each stage commits a file the next stage reads, so a
human and an agent can pick up the same change from the same place. Read
[`docs/sdlc.md`](docs/sdlc.md) for the stages, the templates, and the human
approval gates.

Use the full chain when a change touches frozen thresholds, a diagnostic's
behavior, KV schema, Discord routing, or the resource budget. Skip it for typo
fixes, dependency bumps, and documentation edits — an ordinary PR is correct
there. Do not open a work item just to have one.

If you are asked to implement something that has a `docs/work/NNNN-*/spec.md`,
read that spec first; it outranks your own reading of the code.

## Commit and PR conventions

Lowercase Conventional Commits, matching the existing history:

```text
fix: handle empty candle responses
test: add rejection-candle regression
docs: clarify hypothetical performance limits
```

Keep public APIs and signal thresholds from changing silently. If a change
affects research validity, say so in the commit body and update the relevant
document in `docs/` in the same change.

## Pre-commit hygiene

This repository is **public**. Its purpose here is to stop a contributor's or
an agent's local environment from being published: filesystem paths, machine
and account names, LLM provider API keys, and service credentials.

A `pre-commit` hook enforces this. It is installed automatically — the
`prepare` script in `package.json` points `core.hooksPath` at `.githooks/`, and
npm runs `prepare` after `npm ci`. Since every contributor and agent runs
`npm ci` first, the hook is present without a separate setup step. A commit
carrying a finding is **rejected**.

Run it directly at any time:

```bash
npm run check:hygiene          # scans staged changes
npm run check:hygiene -- --all # scans the whole tree
```

It scans for local filesystem paths (POSIX, Windows, WSL, `/Volumes`,
`file://`), local machine hostnames, LLM provider API keys, Discord and
Cloudflare credentials, account-specific identifiers, and third-party market
data. Findings print **redacted**, so a terminal or CI log never republishes
the value.

Three layers cover this, and they fail differently:

| Layer | Stops | Weakness |
| --- | --- | --- |
| `pre-commit` hook | The commit being created | `--no-verify` skips it |
| GitHub Push Protection | The push being accepted | Partner patterns only |
| CI `hygiene` job | The merge, via a red check | Runs after the push |

The hook is the control that matters — it acts before the object exists. CI is
not a second chance at catching secrets; it catches the case where **the hook
did not run**. Push Protection is enabled on this repository but only
recognizes known vendor token formats, so it does not cover project-specific
values or local paths.

Never pass `--no-verify` to get a commit through.

CI runs the same check as a `hygiene` job on every push, over the whole tree.
That is a backstop, not the primary control: by the time CI sees a secret it is
already pushed, and pushed means compromised. Catch it locally.

When it reports a finding:

1. **Remove the value from the working tree.** Do not just unstage it.
2. **Rotate the credential** if it ever reached a real service — Discord bot
   token, webhook URL, `MANUAL_SCAN_TOKEN`, Cloudflare API token. Assume any
   value that was written to disk in a shared or synced directory is
   compromised.
3. **If it already reached a commit**, say so explicitly and stop. Rotation
   comes first; history rewriting is a human decision, and a pushed secret is
   not fixed by a follow-up commit that deletes it.
4. **Only if it is genuinely a false positive**, narrow the pattern in
   `scripts/check-commit-hygiene.mjs` and say why in the commit body. Never
   delete a rule, add a blanket ignore, or pass a bypass flag to silence it.

Synthetic values used in tests and `.env.example` are expected to pass. If you
need a new fixture value, make it obviously fake — the checker recognizes
`example`, `replace-with`, `placeholder`, `dummy`, `sample`, and `fake`.

The check is a backstop for judgment, not a replacement for it. It matches
known shapes; it cannot recognize a secret it has no pattern for. Before
staging any file that touches configuration, deployment, or an exported
snapshot, read the diff yourself.

## Never commit

- Credentials of any kind: bot tokens, webhook URLs, `MANUAL_SCAN_TOKEN`,
  Cloudflare API tokens.
- The production Discord webhook URL or the Cloudflare custom hostname.
- Account-specific KV namespace IDs, even if Wrangler writes one into a local
  file. The `SCANNER_STATE` binding in `wrangler.toml` stays ID-free.
- Downloaded third-party market data, under any licence.
- Generated output under `backtest/` or `reports/generated/`.
- Personal information, production logs, or local filesystem paths.

`.gitignore` already covers most of these. If you find yourself adding an
exception to it, that is a signal to stop and ask.
