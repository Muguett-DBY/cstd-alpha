import { readFileSync, writeFileSync } from "node:fs";
import { jsonrepair } from "jsonrepair";

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath) {
  console.error("Usage: node scripts/repair-json.mjs <json-file> [output-file]");
  process.exit(2);
}

const repaired = jsonrepair(readFileSync(inputPath, "utf8"));
if (outputPath) {
  writeFileSync(outputPath, repaired, "utf8");
} else {
  process.stdout.write(repaired);
}
