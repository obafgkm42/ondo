#!/usr/bin/env node

const DEFAULT_QUERIES = [
  "SPY 1 minute",
  "SPY OHLCV",
  "S&P 500 intraday",
  "stock market 1 minute",
  "OHLCV intraday",
];

async function main() {
  const queries = process.argv.slice(2);
  const terms = queries.length > 0 ? queries : DEFAULT_QUERIES;
  for (const query of terms) {
    await searchDatasets(query);
  }
}

async function searchDatasets(query) {
  const url = new URL("https://huggingface.co/api/datasets");
  url.searchParams.set("search", query);
  url.searchParams.set("limit", "20");
  url.searchParams.set("full", "true");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Hugging Face dataset search failed: ${response.status}`);
  }

  const datasets = await response.json();
  console.log(`\nquery: ${query}`);
  for (const dataset of datasets.slice(0, 10)) {
    const siblings = dataset.siblings ?? [];
    const files = siblings
      .map((sibling) => sibling.rfilename)
      .filter(Boolean)
      .slice(0, 8)
      .join(", ");
    console.log(`${dataset.id} downloads=${dataset.downloads ?? 0} likes=${dataset.likes ?? 0}`);
    if (files.length > 0) {
      console.log(`  files: ${files}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
