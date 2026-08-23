#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.outputDir, { recursive: true });
  const args = [
    "run",
    "reversal-scanner-backtest",
    "--input",
    options.input,
    "--market",
    options.market,
    "--placebo-runs",
    String(options.placeboRuns),
    "--output",
    join(options.outputDir, "reversal_backtest.json"),
    "--output-dir",
    options.outputDir,
  ];
  const result = await timedRun(options.pythonCommand, args);

  console.log("| runner | exit | duration ms |");
  console.log("| --- | ---: | ---: |");
  console.log(`| python | ${result.exitCode} | ${result.durationMs.toFixed(2)} |`);
}

function timedRun(command, args) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        durationMs: performance.now() - startedAt,
      });
    });
  });
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const [name, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    if (inlineValue === undefined) {
      index += 1;
    }
    values.set(name, value);
  }

  return {
    input: required(values, "input"),
    outputDir: values.get("output-dir") ?? "backtest/python-benchmark",
    market: values.get("market") ?? "SPX",
    placeboRuns: Number(values.get("placebo-runs") ?? 0),
    pythonCommand: values.get("python-command") ?? "uv",
  };
}

function required(values, name) {
  const value = values.get(name);
  if (value === undefined) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
