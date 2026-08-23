#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const url = new URL(
    `https://huggingface.co/datasets/${options.dataset}/resolve/main/${options.file}`,
  );

  console.log(`Downloading ${options.dataset}/${options.file}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  await mkdir(dirname(options.output), { recursive: true });
  if (response.body === null) {
    throw new Error("Download response did not include a body");
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(options.output));
  console.log(`Saved to ${options.output}`);
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const [rawName, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawName}`);
    }
    if (inlineValue === undefined) {
      index += 1;
    }
    values.set(rawName, value);
  }

  const dataset = values.get("dataset");
  const file = values.get("file");
  const output = values.get("output");
  if (dataset === undefined || file === undefined || output === undefined) {
    throw new Error("--dataset, --file, and --output are required");
  }

  return { dataset, file, output };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
