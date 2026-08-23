# Third-Party Notices

This file summarizes direct dependencies for convenience. It is not a
substitute for the license shipped with each exact package version. Transitive
dependencies may add further notices.

## Runtime data services

The Worker reads public market metadata and asset contexts from Hyperliquid's
documented `info` API. The repository contains no copied market-data dataset;
it calculates transient, source-labelled diagnostics at runtime. Hyperliquid's
official documentation describes the `metaAndAssetCtxs` and `perpCategories`
requests and states that API users may record additional historical datasets.
Operators remain responsible for reviewing the current provider terms and
rate limits before deployment.

- API overview: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
- Perpetual metadata and categories: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
- Historical-data guidance: https://hyperliquid.gitbook.io/hyperliquid-docs/historical-data

## Node.js development dependencies

| Package | Declared license in `package-lock.json` |
| --- | --- |
| `@cloudflare/workers-types` | MIT OR Apache-2.0 |
| `@types/node` | MIT |
| `typescript` | Apache-2.0 |
| `vitest` | MIT |
| `wrangler` | MIT OR Apache-2.0 |

These packages are development and deployment dependencies; their code is not
relicensed under this project's MIT License.

## Python core dependencies

| Package | License family |
| --- | --- |
| NumPy | BSD-3-Clause and bundled permissive component licenses |
| pandas | BSD-3-Clause and bundled component licenses |
| SciPy | BSD-3-Clause and bundled component licenses |

Consult the license files installed with each distribution before
redistributing binaries.
