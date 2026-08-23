import {
  buildDiscordHelpMessage,
  buildDiscordRepairGuideMessage,
  buildDiscordStatusErrorMessage,
  buildDiscordStatusMessage,
  buildDiscordUnauthorizedGuildMessage,
  buildDiscordUnsupportedCommandMessage,
  type DiscordMessageData,
  type DiscordScannerStatus,
} from "./discord-command-messages";
import type { Language } from "./types";

export type { DiscordScannerStatus } from "./discord-command-messages";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_INTERACTION_PING = 1;
const DISCORD_APPLICATION_COMMAND = 2;
const DISCORD_SUBCOMMAND = 1;
const DISCORD_RESPONSE_PONG = 1;
const DISCORD_RESPONSE_MESSAGE = 4;
const DISCORD_RESPONSE_DEFERRED_MESSAGE = 5;
const DISCORD_EPHEMERAL_FLAG = 1 << 6;
const MAXIMUM_SIGNATURE_AGE_MS = 5 * 60 * 1_000;

interface DiscordCommandOption {
  name?: string;
  type?: number;
}

interface DiscordInteraction {
  application_id?: string;
  token?: string;
  type?: number;
  guild_id?: string;
  data?: {
    name?: string;
    options?: DiscordCommandOption[];
  };
}

/** Runtime dependencies and security boundaries for the interaction endpoint. */
export interface DiscordInteractionOptions {
  publicKey: string | undefined;
  allowedGuildId: string | undefined;
  language: Language;
  getStatus: () => Promise<DiscordScannerStatus>;
  waitUntil: (promise: Promise<void>) => void;
  fetcher?: typeof fetch;
}

/**
 * Verify and dispatch one Discord HTTP interaction without using the Gateway.
 */
export async function handleDiscordInteraction(
  request: Request,
  options: DiscordInteractionOptions,
): Promise<Response> {
  const publicKey = options.publicKey?.trim();
  const allowedGuildId = options.allowedGuildId?.trim();
  if (
    publicKey === undefined ||
    !isHexOfLength(publicKey, 32) ||
    allowedGuildId === undefined ||
    !/^\d+$/.test(allowedGuildId)
  ) {
    return Response.json(
      { error: "discord interactions unavailable" },
      { status: 503 },
    );
  }

  const signature = request.headers.get("X-Signature-Ed25519") ?? "";
  const timestamp = request.headers.get("X-Signature-Timestamp") ?? "";
  const body = await request.text();
  if (
    !(await verifyDiscordRequest(
      publicKey,
      signature,
      timestamp,
      body,
    ))
  ) {
    return Response.json({ error: "invalid request signature" }, {
      status: 401,
    });
  }

  const interaction = parseInteraction(body);
  if (interaction === null) {
    return Response.json({ error: "invalid interaction" }, { status: 400 });
  }
  if (interaction.type === DISCORD_INTERACTION_PING) {
    return Response.json({ type: DISCORD_RESPONSE_PONG });
  }
  if (interaction.type !== DISCORD_APPLICATION_COMMAND) {
    return immediateMessage(
      buildDiscordUnsupportedCommandMessage(options.language),
    );
  }
  if (interaction.guild_id !== allowedGuildId) {
    return immediateMessage(
      buildDiscordUnauthorizedGuildMessage(options.language),
    );
  }
  if (interaction.data?.name !== "scanner") {
    return immediateMessage(
      buildDiscordUnsupportedCommandMessage(options.language),
    );
  }

  const subcommand = interaction.data.options?.find(
    (option) => option.type === DISCORD_SUBCOMMAND,
  )?.name;
  if (subcommand === "help") {
    return immediateMessage(buildDiscordHelpMessage(options.language));
  }
  if (subcommand === "repair") {
    return immediateMessage(buildDiscordRepairGuideMessage(options.language));
  }
  if (subcommand !== "status") {
    return immediateMessage(
      buildDiscordUnsupportedCommandMessage(options.language),
    );
  }
  if (
    typeof interaction.application_id !== "string" ||
    typeof interaction.token !== "string" ||
    interaction.token.length === 0
  ) {
    return Response.json({ error: "invalid interaction" }, { status: 400 });
  }

  options.waitUntil(
    completeStatusResponse(
      interaction.application_id,
      interaction.token,
      options,
    ),
  );
  return Response.json({
    type: DISCORD_RESPONSE_DEFERRED_MESSAGE,
    data: { flags: DISCORD_EPHEMERAL_FLAG },
  });
}

/**
 * Validate Discord's Ed25519 signature and reject stale replay attempts.
 */
export async function verifyDiscordRequest(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  body: string,
  currentTimeMs: number = Date.now(),
): Promise<boolean> {
  if (
    !isHexOfLength(publicKeyHex, 32) ||
    !isHexOfLength(signatureHex, 64) ||
    !/^\d+$/.test(timestamp)
  ) {
    return false;
  }
  const signedAt = Number(timestamp) * 1_000;
  if (
    !Number.isSafeInteger(signedAt) ||
    Math.abs(currentTimeMs - signedAt) > MAXIMUM_SIGNATURE_AGE_MS
  ) {
    return false;
  }

  try {
    const publicKey = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const message = new TextEncoder().encode(`${timestamp}${body}`);
    return crypto.subtle.verify(
      "Ed25519",
      publicKey,
      hexToBytes(signatureHex),
      message,
    );
  } catch {
    return false;
  }
}

async function completeStatusResponse(
  applicationId: string,
  interactionToken: string,
  options: DiscordInteractionOptions,
): Promise<void> {
  let message: DiscordMessageData;
  try {
    const status = await options.getStatus();
    message = buildDiscordStatusMessage(status, options.language, new Date());
  } catch (error) {
    console.error("Discord status command failed", safeErrorName(error));
    message = buildDiscordStatusErrorMessage(error, options.language);
  }

  const response = await (options.fetcher ?? fetch)(
    `${DISCORD_API_BASE_URL}/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interactionToken)}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    },
  );
  if (!response.ok) {
    throw new Error(`Discord interaction response failed: ${response.status}`);
  }
}

function immediateMessage(message: DiscordMessageData): Response {
  return Response.json({
    type: DISCORD_RESPONSE_MESSAGE,
    data: {
      ...message,
      flags: DISCORD_EPHEMERAL_FLAG,
    },
  });
}

function parseInteraction(body: string): DiscordInteraction | null {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null
      ? value as DiscordInteraction
      : null;
  } catch {
    return null;
  }
}

function isHexOfLength(value: string, byteLength: number): boolean {
  return value.length === byteLength * 2 && /^[0-9a-f]+$/i.test(value);
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
