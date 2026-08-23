#!/usr/bin/env node

async function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    throw new Error("Usage: node scripts/inspect-huggingface-dataset.mjs <dataset-id>...");
  }

  for (const id of ids) {
    await inspectDataset(id);
  }
}

async function inspectDataset(id) {
  const url = new URL(`https://huggingface.co/api/datasets/${id}`);
  url.searchParams.set("full", "true");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Hugging Face inspect failed for ${id}: ${response.status}`);
  }

  const dataset = await response.json();
  console.log(`\n${id}`);
  console.log(`downloads=${dataset.downloads ?? 0} likes=${dataset.likes ?? 0}`);
  console.log(`private=${dataset.private ?? false} gated=${dataset.gated ?? false}`);
  for (const sibling of (dataset.siblings ?? []).slice(0, 80)) {
    console.log(`file ${sibling.rfilename} size=${sibling.size ?? "unknown"}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
