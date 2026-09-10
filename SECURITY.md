# Security Policy

## Supported version

Security fixes are applied to the latest commit on the default branch.

## Reporting a vulnerability

Use GitHub's private security advisory feature when a remote repository is
available. Do not open a public issue containing a webhook URL, token, account
identifier, private dataset, exploit detail, or other secret.

Include the affected version, impact, reproduction steps, and a suggested fix
when possible. Remove or replace all personal and production data.

## Secrets

- Store `DISCORD_WEBHOOK_URL`, `DISCORD_APPLICATION_PUBLIC_KEY`,
  `DISCORD_GUILD_ID`, and `MANUAL_SCAN_TOKEN` as Cloudflare secrets. The public
  key and guild ID are account-specific configuration even though they are not
  authentication secrets.
- Keep `DISCORD_BOT_TOKEN` local and temporary. It is used only by the command
  registration script and must never be stored in Worker bindings or committed.
- Use `.dev.vars` only for local development; it is ignored by Git.
- Never place secrets in `wrangler.toml`, screenshots, logs, fixtures, or issues.
- Rotate a Discord webhook or token immediately if it is exposed.

The Worker does not require a Hyperliquid wallet, private key, or trading API
credential. A contribution that adds any account or trading capability requires
a separate threat model and maintainer approval.

## Public endpoint boundary

The Worker uses a default-deny router. Only `GET /`, authenticated `GET /scan`,
and `POST /discord/interactions` are intentional public routes. Unknown paths,
unsupported methods, unauthenticated scans, and common dotfile probes receive a
minimal `404` response. The root health response must not expose versions,
bindings, upstream providers, route names, or deployment topology.

Discord signatures are verified before parsing or command execution, and the
configured guild is checked before a command can start a scan. Interaction
bodies are bounded at 64 KiB. Rate limiting protects both interactive routes,
but is not a substitute for the bearer token, Discord signature verification,
or the guild allowlist. Durable Object HTTP handlers remain internal to the
Worker binding and must not be publicly proxied without separate authentication.

Application logs record bounded operational fields and sanitized error names.
Do not log request headers, request bodies, Discord interaction tokens,
`Authorization`, or complete webhook URLs.
