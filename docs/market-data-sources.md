# Market-data sources and usage boundaries

This document records the project's runtime data sources and the design
choices used to avoid silently redistributing third-party market data. It is
not legal advice. Terms can change, and each operator is responsible for the
terms and laws that apply to their deployment.

## Hyperliquid runtime data

The Worker calls Hyperliquid's documented public `info` API for:

- `candleSnapshot` on `xyz:SP500`;
- `metaAndAssetCtxs` for current asset contexts; and
- `perpCategories` to identify contracts categorized by the provider as
  `stocks`.

The expanded equity-breadth context is an original calculation over the
current response: the percentage of active `xyz` stock-perp contexts whose
mark price is at least 0.5% below the provider's previous-day price. The code
does not ship or republish a historical provider dataset. The derived value is
labelled as a Hyperliquid stock-perp proxy and is not presented as cash-market
or official-index breadth.

Relevant official documentation, reviewed 2026-08-17:

- [Hyperliquid API overview](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api)
- [Perpetual metadata, contexts, and categories](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)
- [Historical-data guidance](https://hyperliquid.gitbook.io/hyperliquid-docs/historical-data)
- [Rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits)

Public API documentation is not a warranty of perpetual availability or a
blanket license for every commercial use. Before selling, syndicating, or
redistributing derived alerts, obtain advice appropriate to the planned use
and review the provider's then-current terms.

## Interpretation boundary

The two live breadth readings have different meanings:

| Reading | Coverage | Role |
| --- | --- | --- |
| Frozen mega-cap breadth | Seven named `xyz` mega-cap contracts | One of six fragility mechanisms |
| Expanded equity breadth | Active `xyz` contracts categorized as stocks | Display-only context |

Neither reading is NYSE advance/decline volume, an official S&P 500
constituent breadth measure, or a substitute for licensed cash-market data.
