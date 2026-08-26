# Contributing

Contributions should keep the Worker read-only and preserve the separation
between live TypeScript code and local Python research.

[`AGENTS.md`](AGENTS.md) states the invariants that must not be broken —
read-only market access, the parity-tested frozen signal contract, the
shadow-never-promotes rule, and the fail-closed/fail-open split. It applies to
human contributors as much as to coding agents.

## Before opening a pull request

Run everything CI runs:

```bash
npm ci
npm test
npm run typecheck
uv sync --dev
uv run pytest
```

New business logic should include regression tests. Public APIs and signal
thresholds must not change silently; document the reason and the research
impact in the same change.

The repository is public, and a `pre-commit` hook blocks any commit that would
publish your local environment — filesystem paths, machine name, LLM API keys,
or service credentials. It installs itself: `npm ci` runs the `prepare` script,
which points `core.hooksPath` at `.githooks/`.

To run it by hand:

```bash
npm run check:hygiene
```

If it reports something that already reached a commit, rotate the credential
first and say so — deleting it in a later commit does not remove it from
history. Never use `--no-verify` to get around it. See
[Pre-commit hygiene](AGENTS.md#pre-commit-hygiene).

## Larger changes

A change that touches frozen thresholds, a diagnostic's behavior, KV schema,
Discord routing, or the request budget goes through the artifact chain in
[`docs/sdlc.md`](docs/sdlc.md): an intent, then a spec, then a plan, each
committed and approved before the next begins. Typo fixes, dependency bumps,
and documentation edits do not — an ordinary pull request is correct there.

## Commit messages

Use lowercase Conventional Commit messages, for example:

```text
fix: handle empty candle responses
test: add rejection-candle regression
docs: clarify hypothetical performance limits
```

## Do not commit

Credentials, personal information, production logs, downloaded market data,
generated backtest output, account-specific KV namespace IDs, the Cloudflare
custom hostname, or local paths.
