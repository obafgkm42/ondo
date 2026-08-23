# Contributing

Contributions should keep the Worker read-only and preserve the separation
between live TypeScript code and local Python research.

Before opening a pull request:

```bash
npm ci
npm test
npm run typecheck
uv sync --dev
uv run pytest
```

Do not commit credentials, personal information, production logs, downloaded
market data, generated backtest output, or local paths. New business logic
should include regression tests. Public APIs and signal thresholds must not
change silently; document the reason and research impact.

Use lowercase Conventional Commit messages, for example:

```text
fix: handle empty candle responses
test: add rejection-candle regression
docs: clarify hypothetical performance limits
```
