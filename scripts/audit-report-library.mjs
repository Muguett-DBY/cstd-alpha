import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const defaultAccessPath = "E:\\DEV\\codex-tools\\cstd-alpha-access.txt";
const defaultOutputDir = "E:\\DEV\\测试\\cstd-alpha-report-audit";

const args = parseArgs(process.argv.slice(2));
const accessPath = args.access || defaultAccessPath;
const outputDir = args.output || defaultOutputDir;
const detailLimit = Number(args.detailLimit || 0);

const access = parseAccessFile(await readFile(accessPath, "utf8"));
const baseUrl = args.baseUrl || access.URL;
const password = args.password || access.REPORT_PASSWORD;
if (!baseUrl) throw new Error("Missing URL in access file or --base-url.");
if (!password) throw new Error("Missing REPORT_PASSWORD in access file or --password.");

await mkdir(outputDir, { recursive: true });

const cookie = await login(baseUrl, password);
const entries = await fetchAllEntries(baseUrl, cookie);
const detailTargets = detailLimit > 0 ? entries.slice(0, detailLimit) : entries;
const detailAudits = [];
for (const entry of detailTargets) {
  try {
    const record = await fetchJson(`${baseUrl}/api/report-library?id=${encodeURIComponent(entry.id)}`, { cookie });
    detailAudits.push(auditReport(record.entry ?? entry, record.report));
  } catch (error) {
    detailAudits.push({
      id: entry.id,
      ticker: entry.ticker,
      companyName: entry.companyName,
      severity: "error",
      issues: [`detail_fetch_failed: ${error instanceof Error ? error.message : String(error)}`],
    });
  }
}

const entryAudits = entries.map(auditEntry);
const issues = [...entryAudits, ...detailAudits].filter((item) => item.issues.length);
const summary = summarize(entries, entryAudits, detailAudits);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = {
  generatedAt: new Date().toISOString(),
  baseUrl: redactUrl(baseUrl),
  entryCount: entries.length,
  detailChecked: detailTargets.length,
  summary,
  topIssues: issues.slice(0, 200),
};

const outputPath = path.join(outputDir, `report-library-audit-${stamp}.json`);
await writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");

console.log(JSON.stringify({ outputPath, ...summary }, null, 2));

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

function parseAccessFile(raw) {
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([^:=]+)[:=]\s*(.*)$/);
    if (match) result[match[1].trim()] = match[2].trim();
  }
  return result;
}

async function login(baseUrl, password) {
  const response = await fetch(`${baseUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) throw new Error(`login failed: HTTP ${response.status} ${await response.text()}`);
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("login did not return a session cookie.");
  return setCookie.split(";")[0];
}

async function fetchAllEntries(baseUrl, cookie) {
  const limit = 100;
  const entries = [];
  for (let offset = 0; ; offset += limit) {
    const data = await fetchJson(`${baseUrl}/api/report-library?limit=${limit}&offset=${offset}`, { cookie });
    entries.push(...(Array.isArray(data.entries) ? data.entries : []));
    if (entries.length >= Number(data.total || 0) || !data.entries?.length) break;
  }
  return entries;
}

async function fetchJson(url, { cookie }) {
  const response = await fetch(url, { headers: { cookie } });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function auditEntry(entry) {
  const issues = [];
  const industry = stringValue(entry.industry);
  const position = stringValue(entry.positionAdvice);
  const valuation = stringValue(entry.valuationView);
  if (!entry.companyName || !entry.ticker) issues.push("missing_identity");
  if (!Number.isFinite(Number(entry.cqs)) || !Number.isFinite(Number(entry.ias))) issues.push("missing_scores");
  if (!industry || isPlaceholder(industry)) issues.push("missing_or_placeholder_industry");
  if (entry.conclusion === "回避" && !/^0%?$/.test(position)) issues.push("avoid_with_nonzero_position");
  if (/报价缺失|无公开报价|缺乏实时|不可用|无法/.test(position)) issues.push("position_mentions_quote_missing");
  if (/无公开报价|缺乏实时|不可用|无法|unavailable/i.test(valuation)) issues.push("valuation_mentions_missing_quote");
  if (Number(entry.evidenceCount) < 2) issues.push("too_few_evidence_items");
  if (Number(entry.scoreItemCount) < 15) issues.push("too_few_score_items");
  return issueRecord(entry, issues);
}

function auditReport(entry, report) {
  const issues = [];
  if (!report || typeof report !== "object") return issueRecord(entry, ["missing_report_object"]);
  const valuation = report.valuationAnalysis ?? {};
  const dashboard = report.summaryDashboard ?? {};
  const accountRules = report.accountRules ?? {};
  const scoreItems = Array.isArray(report.scoreItems20) ? report.scoreItems20 : [];
  const riskMatrix = Array.isArray(report.riskMatrix) ? report.riskMatrix : [];
  if (isPlaceholder(report.oneSentence) || /数据不足：.*核心一句话/.test(String(report.oneSentence || ""))) issues.push("placeholder_one_sentence");
  if (scoreItems.length !== 20) issues.push(`score_items_not_20:${scoreItems.length}`);
  if (riskMatrix.length < 3) issues.push(`risk_matrix_too_short:${riskMatrix.length}`);
  if (report.conclusion === "回避" && dashboard.positionAdvice !== "0%") issues.push("report_avoid_position_not_zero");
  if (report.conclusion === "回避" && accountRules.maxPosition !== "0%") issues.push("report_avoid_account_max_not_zero");
  if (isMissingValuation(valuation.currentPrice)) issues.push("missing_current_price");
  if (isMissingValuation(valuation.buyRange)) issues.push("missing_buy_range");
  if (isMissingValuation(valuation.sellReduceRange)) issues.push("missing_sell_reduce_range");
  const unavailableEvidence = Array.isArray(report.evidence) ? report.evidence.filter((item) => item?.freshness === "unavailable").length : 0;
  if (unavailableEvidence > 3) issues.push(`many_unavailable_evidence:${unavailableEvidence}`);
  return issueRecord(entry, issues);
}

function summarize(entries, entryAudits, detailAudits) {
  const issueCounts = {};
  for (const audit of [...entryAudits, ...detailAudits]) {
    for (const issue of audit.issues) issueCounts[issue.split(":")[0]] = (issueCounts[issue.split(":")[0]] || 0) + 1;
  }
  return {
    totalEntries: entries.length,
    detailChecked: detailAudits.length,
    entriesWithIssues: entryAudits.filter((item) => item.issues.length).length,
    detailsWithIssues: detailAudits.filter((item) => item.issues.length).length,
    issueCounts,
  };
}

function issueRecord(entry, issues) {
  return {
    id: entry?.id,
    ticker: entry?.ticker,
    companyName: entry?.companyName,
    cqs: entry?.cqs,
    ias: entry?.ias,
    conclusion: entry?.conclusion,
    positionAdvice: entry?.positionAdvice,
    issues,
  };
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isPlaceholder(value) {
  const text = stringValue(value);
  return !text || /^[-—–]+$/.test(text) || /^(AStock|UsStock|HK|Imported|Library)$/i.test(text);
}

function isMissingValuation(value) {
  const text = stringValue(value);
  return !text || /^(待验证|数据不足|unavailable|N\/A)$/i.test(text) || /不可用|缺失|无法|无公开报价|缺乏实时/.test(text);
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "configured-url";
  }
}
