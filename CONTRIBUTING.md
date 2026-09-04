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

CI runs the same check over the whole tree, so a finding will fail the build.
Treat that as a backstop: a secret CI catches has already been pushed.

## Change workflow

Use one pull request for planning, implementation, and review. Include:

- why the change is needed and what is out of scope;
- tests and other verification performed; and
- effects on runtime behavior, evidence, stored data, Discord, and request use.

Do not create per-change process files or pause at document-approval gates.
Ask only when a real product, safety, or evidence decision is unresolved.

Additional requirements:

| Change | Required treatment |
| --- | --- |
| Runtime behavior, KV schema, Discord routing, cadence, or request budget | State the old and new behavior, include focused regression tests, and update the relevant operational or methodology documentation. |
| Frozen threshold, shadow-to-live promotion, or evidence-backed claim | Obtain explicit human approval, satisfy the existing promotion gate, version all affected contracts together, and record the evidence in the relevant methodology or evaluation document. |

Prefer updating an existing canonical document over adding a new process file.
The older `docs/work/` directories are historical context only.

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
