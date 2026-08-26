#!/usr/bin/env node
// Pre-commit hygiene scan: refuse to commit anything that would publish the
// local environment — secrets, LLM API keys, account-specific identifiers,
// machine names, or local filesystem paths.
//
//   node scripts/check-commit-hygiene.mjs           scan staged changes
//   node scripts/check-commit-hygiene.mjs --all     scan the whole tree
//
// Exits non-zero on any finding. See AGENTS.md "Pre-commit hygiene".

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const scanAll = process.argv.includes("--all");

// Placeholder values that are supposed to be committed, in .env.example and
// docs. A finding whose match contains one of these is not a leak.
const PLACEHOLDERS = [
  "replace/me",
  "replace-with",
  "your-custom-domain",
  "<your-custom-domain>",
  "example",
  "0123456789abcdef",
  "xxxxxxxx",
  "local-dev",
  "path/to/",
  "placeholder",
  "dummy",
  "sample",
  "fake",
  "-test",
  "test-",
];

const RULES = [
  {
    id: "discord-webhook",
    // A real webhook carries a numeric id and a long token.
    pattern: /discord(?:app)?\.com\/api\/webhooks\/\d{5,}\/[\w-]{20,}/gi,
    message: "Discord webhook URL with a real token",
  },
  {
    id: "discord-bot-token",
    pattern: /\b[MNO][\w-]{23,}\.[\w-]{6}\.[\w-]{27,}\b/g,
    message: "Discord bot token",
  },
  {
    id: "cloudflare-api-token",
    pattern: /\b(?:cloudflare|cf)[_-]?api[_-]?token\s*[=:]\s*["']?[\w-]{30,}/gi,
    message: "Cloudflare API token",
  },
  {
    id: "kv-namespace-id",
    // wrangler.toml must stay ID-free; a 32-hex id here is account-specific.
    pattern: /^\s*id\s*=\s*["'][0-9a-f]{32}["']/gim,
    message: "Cloudflare KV namespace or account id",
    files: /wrangler\.toml$|\.jsonc?$/,
  },
  {
    id: "account-id",
    pattern: /\baccount[_-]?id\s*[=:]\s*["']?[0-9a-f]{32}\b/gi,
    message: "Cloudflare account id",
  },
  {
    id: "secret-assignment",
    // A secret variable assigned a *quoted literal*. An unquoted identifier
    // (a test constant, an env lookup) is a reference, not a value, so it is
    // deliberately not matched. Literals that read as synthetic are dropped
    // by the PLACEHOLDERS filter below.
    pattern:
      /\b(DISCORD_BOT_TOKEN|DISCORD_WEBHOOK_URL|DISCORD_APPLICATION_PUBLIC_KEY|DISCORD_GUILD_ID|DISCORD_APPLICATION_ID|MANUAL_SCAN_TOKEN)\s*[=:]\s*["'`]([^"'`\n]{12,})["'`]/g,
    message: "assigned value for a secret variable",
    // .env.example is expected to carry placeholder assignments.
    skipFiles: /(^|\/)\.env\.example$/,
  },
  {
    id: "private-key",
    pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    message: "private key block",
  },
  {
    id: "local-path",
    pattern: /\/(?:Users|home)\/(?!user\b|runner\b)[A-Za-z0-9_.-]{2,}\//g,
    message: "local filesystem path containing a username",
  },
  {
    id: "windows-user-path",
    pattern: /[A-Za-z]:\\+Users\\+[^\\/\s"'`,;)\]]{2,}/g,
    message: "Windows path containing a username",
  },
  {
    id: "wsl-user-path",
    pattern: /\/mnt\/[a-z]\/Users\/[^/\s"'`,;)\]]{2,}/gi,
    message: "WSL path containing a username",
  },
  {
    id: "macos-volume-path",
    pattern: /\/Volumes\/[^/\s"'`,;)\]]{2,}/g,
    message: "macOS volume path (names a disk or machine)",
  },
  {
    id: "file-url",
    pattern:
      /file:\/\/\/(?:Users|home)\/(?!user\b|runner\b)[A-Za-z0-9_.-]{2,}/g,
    message: "file:// URL pointing into a home directory",
  },
  {
    id: "local-hostname",
    // macOS mDNS name, e.g. "Someones-MacBook-Pro.local". Requires a hyphen,
    // and the lookahead rejects filenames such as settings.local.json.
    pattern: /\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\.local\b(?!\.[A-Za-z])/g,
    message: "local machine hostname",
  },
  {
    id: "llm-api-key",
    // Provider key prefixes — the keys most likely to reach this repo by way
    // of a local coding agent or a research script.
    pattern:
      /\b(?:sk-ant-[\w-]{20,}|sk-proj-[\w-]{20,}|sk-svcacct-[\w-]{20,}|sk-[A-Za-z0-9]{32,}|AIza[\w-]{35}|gsk_[A-Za-z0-9]{40,}|hf_[A-Za-z0-9]{30,}|r8_[A-Za-z0-9]{30,}|xai-[A-Za-z0-9]{40,})\b/g,
    message: "LLM provider API key",
  },
  {
    id: "llm-key-assignment",
    pattern:
      /\b(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|GROQ_API_KEY|HF_TOKEN|HUGGINGFACE_TOKEN|REPLICATE_API_TOKEN|XAI_API_KEY)\s*[=:]\s*["'`]([^"'`\n]{12,})["'`]/g,
    message: "assigned value for an LLM API key",
  },
  {
    id: "workers-dev-hostname",
    pattern: /\b[\w-]+\.[\w-]+\.workers\.dev\b/g,
    message: "account-specific workers.dev hostname",
  },
];

// Data files that must never be committed regardless of content.
const FORBIDDEN_PATHS =
  /(^|\/)(\.env(?!\.example)|\.dev\.vars)|\.(parquet|feather|h5)$|^(backtest|reports\/generated|data|cache)\//;

function tracked() {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

function staged() {
  const out = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    { encoding: "utf8" },
  );
  return out.split("\0").filter(Boolean);
}

function isProbablyText(path) {
  try {
    if (statSync(path).size > 2_000_000) return false;
    const buf = readFileSync(path);
    return !buf.subarray(0, 8000).includes(0);
  } catch {
    return false;
  }
}

const files = scanAll ? tracked() : staged();
if (files.length === 0) {
  console.log(
    scanAll ? "No tracked files." : "No staged changes. Nothing to check.",
  );
  process.exit(0);
}

const findings = [];

for (const file of files) {
  if (FORBIDDEN_PATHS.test(file)) {
    findings.push({ file, line: 0, message: "file must not be committed" });
    continue;
  }
  // This checker quotes its own patterns; scanning it finds only itself.
  if (file === "scripts/check-commit-hygiene.mjs") continue;
  if (!isProbablyText(file)) continue;

  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  for (const rule of RULES) {
    if (rule.files && !rule.files.test(file)) continue;
    if (rule.skipFiles && rule.skipFiles.test(file)) continue;

    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(content)) !== null) {
      const text = match[0];
      const lower = text.toLowerCase();
      if (PLACEHOLDERS.some((p) => lower.includes(p.toLowerCase()))) continue;

      const line = content.slice(0, match.index).split("\n").length;
      // Redact the finding itself so CI logs do not republish the secret.
      const shown = text.length > 24 ? `${text.slice(0, 12)}…[redacted]` : text;
      findings.push({
        file,
        line,
        message: `${rule.message} (${rule.id}): ${shown}`,
      });
      if (!rule.pattern.global) break;
    }
  }
}

if (findings.length === 0) {
  console.log(`Commit hygiene: clean (${files.length} file(s) scanned).`);
  process.exit(0);
}

console.error(`Commit hygiene: ${findings.length} finding(s).\n`);
for (const f of findings) {
  console.error(`  ${f.file}${f.line ? `:${f.line}` : ""} — ${f.message}`);
}
console.error(
  [
    "",
    "Remove the value, rotate it if it ever reached a real service, and",
    "re-stage. If a finding is a false positive, narrow the pattern in",
    "scripts/check-commit-hygiene.mjs rather than deleting the rule.",
  ].join("\n"),
);
process.exit(1);
