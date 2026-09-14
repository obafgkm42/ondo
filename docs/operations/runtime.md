# Operating Market Ondo

Back to the [documentation map](../README.md).

How to configure, deploy, and run the Worker. For what the Worker measures and
why, see the [README](../../README.md). For the offline Python studies, see
[Research commands](../research/commands.md).

## Primary interface: Discord

Market Ondo uses Discord HTTP Interactions. It does not maintain a Gateway
connection, read ordinary messages, request privileged intents, or place
orders. Responses to slash commands are ephemeral.

- `/scanner status` performs one live, read-only query and privately returns
  price, RVOL, fragility mechanisms, resilience, data coverage, and any retained
  reversal state.
- `/scanner repair` explains the six mechanisms and frozen level thresholds
  without requesting market data.
- `/scanner help` shows the private command guide.

Every interaction must have a valid Discord Ed25519 signature and match the
configured `DISCORD_GUILD_ID`. The Worker rejects request bodies larger than
64 KiB before signature verification and applies a loose Cloudflare-side limit
of 60 interaction requests per minute per Cloudflare location. This limit is a
coarse abuse guard; Discord signature verification and the guild allowlist
remain the authorization boundary.

### Discord setup

1. Create a Discord application and copy its Application ID and Public Key.
2. Store `DISCORD_APPLICATION_PUBLIC_KEY` and `DISCORD_GUILD_ID` as Cloudflare
   secrets.
3. Set the Developer Portal **Interactions Endpoint URL** to:

   ```text
   https://<your-custom-domain>/discord/interactions
   ```

4. Install the application with only the `applications.commands` scope.
5. Temporarily provide the Application ID, Guild ID, and Bot Token locally,
   then register the guild command:

   ```bash
   DISCORD_APPLICATION_ID=... \
   DISCORD_GUILD_ID=... \
   DISCORD_BOT_TOKEN=... \
   npm run discord:register
   ```

6. Unset the bot token. Use **Server Settings → Integrations** to grant the
   desired role or channel access; commands default to administrators.

Guild commands normally update immediately. Broad multi-server distribution is
out of scope for this personal deployment.

## Cloudflare deployment

The production interface uses a dashboard-managed Cloudflare Custom Domain.
`wrangler.toml` explicitly disables the two development surfaces so a Git-based
redeploy does not reopen them:

```toml
workers_dev = false
preview_urls = false
```

The custom hostname is intentionally not committed. It remains attached under
**Worker → Settings → Domains & Routes**, while the Discord endpoint uses that
hostname. The `name = "ondo"` entry in `wrangler.toml` matches the existing
Cloudflare Worker service identifier.

Public runtime defaults live in `wrangler.toml`. Secrets stay in Cloudflare:

```bash
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler secret put DISCORD_APPLICATION_PUBLIC_KEY
npx wrangler secret put DISCORD_GUILD_ID
```

`MANUAL_SCAN_TOKEN` is optional. Without it, the authenticated `/scan` endpoint
returns `404`; Discord `/scanner status` remains the normal on-demand interface.
To keep the emergency/manual endpoint, set it separately:

```bash
npx wrangler secret put MANUAL_SCAN_TOKEN
```

Only `GET /`, authenticated `GET /scan`, and `POST /discord/interactions` are
publicly routed. The root returns only `{ "status": "ok" }`; every other path
or method returns a minimal `404`, including dotfile and GraphQL probes.
Authenticated manual scans are limited to six requests per minute per
Cloudflare location before they can reach the scan coordinator or upstream
provider. Unauthenticated scans return `404` without consuming the limiter.

The two `[[ratelimits]]` bindings in `wrangler.toml` use account-local integer
namespace identifiers; they are configuration, not credentials. Binding
counters are local to a Cloudflare location and eventually consistent, so they
protect capacity but are not an exact accounting or authorization mechanism.
If broader probe traffic becomes material, add a zone-level WAF rate limiting
rule for the custom hostname so rejected traffic does not invoke the Worker.

An ID-free `SCANNER_STATE` KV binding is declared in `wrangler.toml`. It stores
bounded RVOL history, failed-scan recovery, signal deduplication, diagnostic
shadow state, rate-limit incident state, and version notices. Do not commit an
account-specific namespace ID if Wrangler writes one into a local file.

After this repository is linked to the existing Cloudflare Worker, Cloudflare
builds deploy the latest main branch automatically. A manual deployment remains
available:

```bash
npm run deploy
```

### Coordinated scan execution

The deployment uses `SCAN_EXECUTION_MODE = "durable-object"`. Cron ticks,
authenticated `GET /scan`, and Discord `/scanner status` all reach the same
named `ScanCoordinator` object through the `SCAN_COORDINATOR` binding. Discord
signature/guild checks and HTTP authentication still run before forwarding.
Help, repair, and endpoint-validation interactions do not request a scan.
The coordinator's `/scheduled` and `/status` handlers are reachable only
through its Worker binding. Do not add a public proxy to those handlers without
separate strong authentication.

The coordinator runs scheduled and manual work sequentially. Overlapping
manual queries share one in-flight result. Later manual queries reuse a
timestamped result until the 60-second refresh boundary; after that boundary a
local admission denial can still return the older, explicitly labelled cache.
Scheduled work retains Cloudflare's original scheduled timestamp, including
when it waits behind a manual query. A completed-tick watermark rejects repeat
or older Cron deliveries, including after an object restart. It is written
after completion, so it does not promise exactly-once external delivery if an
execution is interrupted between a notification and the receipt write.

`wrangler.toml` includes both the binding and the SQLite creation migration:

```toml
[[durable_objects.bindings]]
name = "SCAN_COORDINATOR"
class_name = "ScanCoordinator"

[[migrations]]
tag = "v1-scan-coordinator"
new_sqlite_classes = ["ScanCoordinator"]
```

Deploy with `wrangler deploy` (the existing `npm run deploy` command). This
creates the namespace and binding; do not manually create a second object or
add a namespace ID. No new secret is needed. The first release adds a Durable
Object class, so a build that only runs `wrangler versions upload` must instead
apply this migration with `wrangler deploy`. Existing `SCANNER_STATE` KV and
Discord secrets stay attached to the Worker. The object's storage holds its
completed-tick watermark, rolling provider reservations, provider cooldown,
the versioned category cache, and the bounded manual result cache. Existing
research and notification state keeps the same KV keys and retention.

After deployment, check **Worker → Bindings** for `SCAN_COORDINATOR`, linked to
`ScanCoordinator`, and **Settings → Variables and Secrets** for the text value
`SCAN_EXECUTION_MODE=durable-object`. These are supplied by the checked-in
Wrangler config; routine deployment requires no manual Dashboard additions.
Also verify `HYPERLIQUID_WEIGHT_LIMIT=240`. The parser deliberately rejects a
higher value; raising the local ceiling requires a reviewed code change.

For rollback, set `SCAN_EXECUTION_MODE=direct` and redeploy, or set that runtime
text variable in the Dashboard as an emergency override. Keep the class,
binding, and migration declaration so no namespace is deleted. Update the
repository variable too if the override must survive the next deployment.
Missing mode configuration also selects `direct`; an invalid value or a missing
binding in `durable-object` mode fails visibly instead of silently retrying a
possibly completed scan outside the object. Direct mode is an emergency
rollback and does not provide M3's persisted budget, cooldown, or category
cache; do not use it as an admission fallback inside coordinated mode.

The coordinated mode reserves at most 240 estimated Hyperliquid weight units
in a rolling 60-second window and permits one provider request in flight. It
does not change the Hyperliquid quota. A Durable Object has a stable execution
location, not a guaranteed dedicated or fixed egress IP. Reduced production
429s remain a hypothesis to measure.
See [Cloudflare data location][do-location] and
[Hyperliquid rate limits][hyperliquid-limits].

For verification, find `scan_coordinator_scheduled` and
`scan_coordinator_duplicate_tick` in Worker logs, and compare
`hyperliquid_request_failed` against actual attempted scans in comparable
sessions. Count a provider failure once: the later `scheduled scan skipped`
record describes the same incident. A green invocation outcome can include a
gracefully handled 429. Also verify a successful scheduled scan and a Discord
status query; a working health endpoint alone does not exercise this path.

The local suite includes native workerd/Miniflare tests with external network
access disabled. Miniflare is declared as a direct development dependency at
the version already used by Wrangler, so these checks run with `npm test` in
CI without introducing a Worker runtime dependency.

[do-location]: https://developers.cloudflare.com/durable-objects/reference/data-location/
[hyperliquid-limits]: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits

## Schedule and free-tier discipline

Cloudflare invokes the Worker every five minutes, then the Worker applies its
own gate:

- normal scans every 15 minutes;
- scans every five minutes from 15:00–16:00 New York time;
- opt-in price-only shadow acquisition every five minutes from the first
  completed RTH candle at 09:35 through 16:00 New York time;
- standard-session briefs every 30 minutes; and
- non-standard-session briefs no more frequently than hourly.

Coordination adds one internal Durable Object request per Cron tick (288 per
day), plus authorized manual queries. Provider admission adds a storage read
and a reservation write before every attempted Hyperliquid request. This does
not change the existing KV operation budget. Duplicate and obsolete tick
deliveries do not make provider requests.

Each live scheduled scan uses one Hyperliquid candle request and evaluates every
new five-minute candle since the previous allowed scan. Stage B adds 44 RTH
candle requests to the 104-call daily baseline because its other 34 boundaries
already run live. A due brief adds one
`metaAndAssetCtxs` request for fragility context. `perpCategories` is cached for
24 hours in coordinated storage. A failed refresh backs off for one hour and
may use a labelled stale value for at most 72 hours; after that, expanded
breadth is omitted. A history-deficient RVOL installation may make one bounded
15-minute bootstrap request after a deployment or during its post-close retry
window.

Provider failures use a status-specific request budget. HTTP 429 stops the
affected request after its first response, suppresses later provider calls in
that invocation, and persists a cross-request cooldown. A valid `Retry-After`
sets its bounded duration; absent or invalid guidance uses 60 seconds. Exactly
one request may probe after expiry, and a failed probe extends cooldown without
sleeping for another attempt. Transient 5xx responses retain at most three
total attempts, with one- and two-second exponential delays plus up to 250 ms
of jitter. Every attempt is admitted and reserved separately before I/O.

Candle requests reserve `20 + ceil(maximum response candles / 60)` estimated
units. Context and category requests reserve 20 units; the category endpoint's
weight remains explicitly uncertain. Successful candle responses log their
returned count and reconciled estimate without logging bodies. A lost response
keeps its reservation. Admission-state failure suppresses fresh provider I/O.

A primary candle 429 keeps the existing incomplete-scan notification and
catch-up behavior. A `perpCategories` 429 stops the later optional
`metaAndAssetCtxs` request and builds a price-only fragility brief, so optional
context remains fail-open without amplifying the same rate-limit window.

The prospective diagnostics reuse those responses:

- fragility shadow: at most about 13 KV reads and writes per full RTH day;
- five-minute resilience shadow: up to 78 KV reads and writes with stage B;
- five-minute price-only acquisition: up to 78 KV reads and writes; and
- after stage B acquires the candle, neither shadow collector adds another
  Hyperliquid request.

The stage B store is `rth-shadow-acquisition-5m:v1:<market>`. It is independent
of the 16-row half-hour fragility schema and live notification watermarks. Each
row records its actual acquisition timestamp and explicitly marks context as
`not_collected`; delayed price-only catch-up never receives newly fetched
cross-market context retroactively. State retains at most 78 rows per session,
60 sessions, and eight MiB. Oldest observations are removed before the byte
ceiling can be exceeded.

All durable collections are bounded. Provider, metadata, or KV failures fail
open and leave the core read-only monitor available. Current quota references
and the full resource contract live in the linked methodology documents rather
than being duplicated as assumptions here.

## Configuration modes

The repository deployment currently uses:

```toml
[vars]
LANGUAGE = "zh"
MARKET_ACTIVITY_MODE = "display"
FRAGILITY_PERSISTENCE_MODE = "shadow"
RESILIENCE_DECAY_SHADOW_MODE = "shadow"
FIVE_MINUTE_RTH_ACQUISITION_MODE = "shadow"
```

- `MARKET_ACTIVITY_MODE`: `off`, `shadow`, or `display`;
- `FRAGILITY_PERSISTENCE_MODE`: `off`, `shadow`, or `display`;
- `RESILIENCE_DECAY_SHADOW_MODE`: `off` or `shadow`.
- `FIVE_MINUTE_RTH_ACQUISITION_MODE`: `off` or `shadow`.

The acquisition parser defaults to `off`. Setting it to `shadow` changes only
the price-only collection grid. It does not change live reversal evaluation,
brief cadence, mentions, or context polling. Set it back to `off` to restore
the stage A request schedule while retaining M1 correctness and M3 provider
guards. Stage C context sampling remains unimplemented until the stage B pilot
passes its operational review.

Parser defaults remain conservative even where this repository explicitly opts
into bounded collection or display. Conflicting legacy
`FRAGILITY_V2_MODE`/`FRAGILITY_PERSISTENCE_MODE` values fail configuration
loading.

## Local development

Requirements:

- Node.js 22 or newer;
- Python 3.12; and
- `uv` for research tooling.

```bash
npm ci
npm test
npm run typecheck
uv sync --dev
uv run pytest
```

Run the Worker locally:

```bash
npm run dev
```

Trigger the local scheduled handler:

```text
http://localhost:8787/cdn-cgi/handler/scheduled
```

Copy `.env.example` to `.dev.vars` for local bindings. Never commit real
webhook URLs, account IDs, bot tokens, or manual-scan tokens.
