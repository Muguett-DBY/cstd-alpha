import { readFileSync } from "node:fs";
import { jsonrepair } from "jsonrepair";

const inputPath = process.argv[2];

if (!inputPath) {
  console.error("Usage: node scripts/repair-json.mjs <json-file>");
  process.exit(2);
}

process.stdout.write(jsonrepair(readFileSync(inputPath, "utf8")));
