import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultBatchRoot = process.env.CSTD_ALPHA_BATCH_ROOT || path.join(".tmp", "cstd-alpha-opencode-batch");
const defaultUniversePath = path.join(defaultBatchRoot, "ashare-universe-test.json");
const defaultAuditDir = process.env.CSTD_ALPHA_AUDIT_DIR || path.join(".tmp", "report-library-audit");

const args = parseArgs(process.argv.slice(2));
const batchRoot = args.batchRoot || defaultBatchRoot;
const universePath = args.universe || defaultUniversePath;
const auditDir = args.auditDir || defaultAuditDir;
const outputDir = args.output || batchRoot;
const stamp = args.stamp || new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

await mkdir(outputDir, { recursive: true });

const universe = await readJson(universePath);
const companies = Array.isArray(universe) ? universe : Array.isArray(universe.companies) ? universe.companies : [];
if (!companies.length) throw new Error(`No companies found in universe: ${universePath}`);

const byCode = new Map(companies.flatMap((company) => (company?.code ? [[String(company.code), company]] : [])));
const successCodes = await readTerminalCodes(batchRoot, "status.json");
const failureCodes = await readTerminalCodes(batchRoot, "failure.json");

const latestRerunFile = args.rerun || (await latestFile(auditDir, /^report-library-rerun-candidates-.*\.json$/));
const rerunRecords = latestRerunFile ? await readJson(latestRerunFile) : [];
const qualityCodes = new Set((Array.isArray(rerunRecords) ? rerunRecords : []).map((record) => String(record?.ticker || "")).filter((code) => /^\d{6}$/.test(code)));

const notSuccess = companies.filter((company) => !successCodes.has(String(company.code)));
const nextByCode = new Map();
for (const company of notSuccess) {
  if (company?.code) nextByCode.set(String(company.code), company);
}
for (const code of qualityCodes) {
  const company = byCode.get(code);
  if (company) nextByCode.set(code, company);
}
const nextPass = Array.from(nextByCode.values()).sort((left, right) => String(left.code).localeCompare(String(right.code)));
const qualityCompanies = Array.from(qualityCodes)
  .sort()
  .map((code) => byCode.get(code))
  .filter(Boolean);

const notSuccessPath = path.join(outputDir, `ashare-universe-not-success-${stamp}.json`);
const qualityPath = path.join(outputDir, `ashare-universe-quality-rerun-${stamp}.json`);
const nextPath = path.join(outputDir, `ashare-universe-next-pass-quality-and-missing-${stamp}.json`);

const generatedAt = new Date().toISOString();
await Promise.all([
  writeUniverse(notSuccessPath, {
    generatedAt,
    sourceUniverse: universePath,
    totalUniverse: companies.length,
    successCount: successCodes.size,
    failureCount: failureCodes.size,
    count: notSuccess.length,
    companies: notSuccess,
  }),
  writeUniverse(qualityPath, {
    generatedAt,
    sourceAudit: latestRerunFile,
    totalUniverse: companies.length,
    qualityRerunCount: qualityCompanies.length,
    count: qualityCompanies.length,
    companies: qualityCompanies,
  }),
  writeUniverse(nextPath, {
    generatedAt,
    sourceUniverse: universePath,
    sourceAudit: latestRerunFile,
    totalUniverse: companies.length,
    successCount: successCodes.size,
    failureCount: failureCodes.size,
    notSuccessCount: notSuccess.length,
    qualityRerunCount: qualityCompanies.length,
    count: nextPass.length,
    companies: nextPass,
  }),
]);

console.log(
  JSON.stringify(
    {
      totalUniverse: companies.length,
      successCount: successCodes.size,
      failureCount: failureCodes.size,
      notSuccessCount: notSuccess.length,
      qualityRerunCount: qualityCompanies.length,
      nextPassCount: nextPass.length,
      sourceAudit: latestRerunFile,
      notSuccessPath,
      qualityPath,
      nextPath,
    },
    null,
    2,
  ),
);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    parsed[key] = values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : "true";
  }
  return parsed;
}

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

async function writeUniverse(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function latestFile(dir, pattern) {
  const files = await readdir(dir, { withFileTypes: true });
  const matches = await Promise.all(
    files
      .filter((file) => file.isFile() && pattern.test(file.name))
      .map(async (file) => {
        const filePath = path.join(dir, file.name);
        const fileStat = await stat(filePath);
        return { filePath, mtimeMs: fileStat.mtimeMs };
      }),
  );
  matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return matches[0]?.filePath;
}

async function readTerminalCodes(batchRoot, fileName) {
  const codes = new Set();
  for (const dirName of ["production", "production-api"]) {
    await collectCodes(path.join(batchRoot, dirName), fileName, codes);
  }
  return codes;
}

async function collectCodes(dir, fileName, codes) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectCodes(entryPath, fileName, codes);
      if (!entry.isFile() || entry.name !== fileName) return undefined;
      try {
        const json = await readJson(entryPath);
        if (json?.code) codes.add(String(json.code));
      } catch {
        // Ignore malformed terminal files and let the next pass regenerate them.
      }
      return undefined;
    }),
  );
}
