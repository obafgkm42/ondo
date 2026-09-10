# Operating Market Ondo

How to configure, deploy, and run the Worker. For what the Worker measures and
why, see the [README](../README.md). For the offline Python studies, see
[Research commands](research-commands.md).

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
manual queries share one in-flight result; a later query fetches fresh data.
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
Discord secrets stay attached to the Worker. The new object's storage holds
only its completed-tick watermark; existing research and notification state
keeps the same KV keys and retention.

After deployment, check **Worker → Bindings** for `SCAN_COORDINATOR`, linked to
`ScanCoordinator`, and **Settings → Variables and Secrets** for the text value
`SCAN_EXECUTION_MODE=durable-object`. These are supplied by the checked-in
Wrangler config; routine deployment requires no manual Dashboard additions.

For rollback, set `SCAN_EXECUTION_MODE=direct` and redeploy, or set that runtime
text variable in the Dashboard as an emergency override. Keep the class,
binding, and migration declaration so no namespace is deleted. Update the
repository variable too if the override must survive the next deployment.
Missing mode configuration also selects `direct`; an invalid value or a missing
binding in `durable-object` mode fails visibly instead of silently retrying a
possibly completed scan outside the object.

This release preserves the cadence and the one-attempt 429 policy. It does not
add a cross-request provider cooldown or change the Hyperliquid quota. A
Durable Object has a stable execution location, not a guaranteed dedicated or
fixed egress IP. Reduced production 429s remain a hypothesis to measure.
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
- standard-session briefs every 30 minutes; and
- non-standard-session briefs no more frequently than hourly.

Coordination adds one internal Durable Object request per Cron tick (288 per
day), plus authorized manual queries. Each unique completed tick uses at most
one coordinator storage read and one write. This does not add Hyperliquid
requests or change the existing KV operation budget. Duplicate tick deliveries
need only the coordinator storage read.

Each scheduled scan uses one Hyperliquid candle request and evaluates every new
five-minute candle since the previous allowed scan. A due brief adds one
`perpCategories` and one `metaAndAssetCtxs` request for fragility context. A
history-deficient RVOL installation may make one bounded 15-minute bootstrap
request after a deployment or during its post-close retry window.

Provider failures use a status-specific request budget. HTTP 429 stops the
affected request after its first response; the Worker records any valid
`Retry-After` guidance but waits for the next configured scan boundary instead
of retrying inside the same invocation. Transient 5xx responses retain at most
three total attempts, with one- and two-second exponential delays plus up to
250 ms of jitter. Every failed response logs the operation, status, attempt,
retry decision, planned local delay, and parsed `Retry-After` delay without
logging response bodies or raw header values.

A primary candle 429 keeps the existing incomplete-scan notification and
catch-up behavior. A `perpCategories` 429 stops the later optional
`metaAndAssetCtxs` request and builds a price-only fragility brief, so optional
context remains fail-open without amplifying the same rate-limit window.

The prospective diagnostics reuse those responses:

- fragility shadow: at most about 13 KV reads and writes per full RTH day;
- five-minute resilience shadow: about 35 KV reads and writes under the mixed
  production cadence, with a conservative 78-operation ceiling; and
- no extra Hyperliquid request for either shadow collector.

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
```

- `MARKET_ACTIVITY_MODE`: `off`, `shadow`, or `display`;
- `FRAGILITY_PERSISTENCE_MODE`: `off`, `shadow`, or `display`;
- `RESILIENCE_DECAY_SHADOW_MODE`: `off` or `shadow`.

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
