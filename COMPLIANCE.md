# Compliance and Third-Party Services

This document is a technical risk review, not legal advice. Terms and laws can
change. Operators must review the current versions before deployment.

## Current project boundary

The repository:

- reads public market candles;
- sends messages only to an operator-configured Discord webhook;
- does not request a Hyperliquid private key or account identifier;
- does not submit, modify, or cancel orders;
- does not tailor output to a person's finances or risk tolerance; and
- does not include third-party historical market data.

That boundary materially reduces risk, but it is not a universal exemption.
Monetization, personalization, discretionary account access, auto-execution,
copy trading, or public promotion can change the regulatory analysis.

## Hyperliquid

The Worker uses the documented public `info` API with `candleSnapshot`,
`metaAndAssetCtxs`, and `perpCategories` requests:

- [Official API documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api)
- [Info endpoint and candle snapshots](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
- [Perpetual metadata, contexts, and categories](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)
- [Rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits)
- [Platform terms](https://app.hyperliquid.xyz/terms)

Operators must respect current rate limits, geographic restrictions, and
platform terms. Do not evade blocks, rotate identities to bypass limits, or add
trading endpoints without a new security and compliance review. The default
single-market cadence is intentionally low frequency and the runtime treats
HTTP 429 responses as rate limits rather than attempting to bypass them.

## Discord

Discord documents incoming webhooks as a one-way integration for monitoring
and scheduled notifications:

- [Webhook documentation](https://docs.discord.com/developers/platform/webhooks)
- [Developer Terms](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service)
- [Developer Policy](https://support-dev.discord.com/hc/articles/8563934450327-Discord-Developer-Policy)

Use only a webhook you are authorized to control. Protect its URL as a secret,
honor Discord rate limits, avoid spam or deceptive content, and do not use this
project to automate a normal user account.

## Cloudflare

Deployment is subject to the operator's plan, product limits, and Cloudflare's
current agreements:

- [Self-Serve Subscription Agreement](https://www.cloudflare.com/terms/)
- [Service-Specific Terms](https://www.cloudflare.com/service-specific-terms-application-services/)

The operator is responsible for lawful content, secrets, account security,
resource usage, and any Discord or market data sent through the Worker.

## Hugging Face and historical data

The optional helper downloads only a dataset and file explicitly selected by
the user. Hugging Face access and each dataset are governed independently:

- [Hugging Face Terms of Service](https://huggingface.co/terms-of-service)
- [Dataset card and license documentation](https://huggingface.co/docs/hub/datasets-cards)

Before using any dataset, verify its card, license, provenance, redistribution
rights, market-data restrictions, and permitted commercial use. Do not commit
downloaded data to this repository. A public listing or downloadable URL does
not by itself grant unrestricted redistribution rights.

Obtain historical data through a documented, authorized download or licensed
vendor. Do not automate access-control or browser-verification challenges.

## Software dependencies

The project's MIT License covers original repository code and documentation,
not its dependencies. Review the exact licenses installed with the Node.js and
Python dependency trees before redistributing binaries or offering a commercial
service.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for direct dependencies.

## Financial regulation and public communications

The software is designed as standardized, impersonal research software with no
account control. CFTC materials describe a registration exemption that can be
relevant to certain standardized, non-customized publications and software,
but eligibility depends on facts and jurisdiction:

- [CFTC discussion of standardized advice and Rule 4.14(a)(9)](https://www.cftc.gov/sites/default/files/opa/press00/opa4374-00.htm)
- [CFTC Regulation 4.14](https://www.ecfr.gov/current/title-17/chapter-I/part-4/section-4.14)
- [CFTC Regulation 4.41](https://www.ecfr.gov/current/title-17/chapter-I/part-4/section-4.41)
- [NFA Rule 2-29 interpretive notice](https://www.nfa.futures.org/rulebooksql/rules.aspx?RuleID=9025&Section=9)

The NFA notice emphasizes that hypothetical results must be identified,
limitations and material assumptions must be prominent, and the overall
presentation must not mislead. The project follows those principles by keeping
directional results next to their sample, data, execution, and walk-forward
limitations.

Using the phrase “not financial advice” does not override the real substance of
an activity. Before adding fees, subscriptions, user-specific recommendations,
trade execution, account connections, custody, referrals, or performance
marketing, obtain qualified legal advice and repeat this review.

## Trademarks and non-affiliation

Third-party names are used descriptively to identify compatible services and
markets. Do not use third-party logos or wording that implies sponsorship,
certification, partnership, or endorsement without permission.

## Operator checklist

Before deployment or public distribution:

1. Re-read the current service terms linked above.
2. Confirm the deployment is permitted in every relevant jurisdiction.
3. Keep the Worker read-only unless a new legal and security review is complete.
4. Present hypothetical results with equally prominent limitations.
5. Do not describe the heuristic score as probability or “accuracy.”
6. Use only lawfully obtained data with documented provenance and rights.
7. Store webhook URLs and tokens as secrets and rotate any exposed credential.
8. Reassess compliance after any monetization, personalization, or execution feature.
