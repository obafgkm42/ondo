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
configured `DISCORD_GUILD_ID`.

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

## Schedule and free-tier discipline

Cloudflare invokes the Worker every five minutes, then the Worker applies its
own gate:

- normal scans every 15 minutes;
- scans every five minutes from 15:00–16:00 New York time;
- standard-session briefs every 30 minutes; and
- non-standard-session briefs no more frequently than hourly.

Each scheduled scan uses one Hyperliquid candle request and evaluates every new
five-minute candle since the previous allowed scan. A due brief adds one
`perpCategories` and one `metaAndAssetCtxs` request for fragility context. A
history-deficient RVOL installation may make one bounded 15-minute bootstrap
request after a deployment or during its post-close retry window.

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
