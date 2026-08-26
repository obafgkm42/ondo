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
