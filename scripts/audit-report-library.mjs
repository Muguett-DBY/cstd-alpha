import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultAccessPath = process.env.CSTD_ALPHA_ACCESS_FILE || process.env.CSTD_ALPHA_ACCESS_PATH || "";
const defaultOutputDir = path.join(".tmp", "report-library-audit");

const args = parseArgs(process.argv.slice(2));
const accessPath = args.access || defaultAccessPath;
const outputDir = args.output || defaultOutputDir;
const detailLimit = Number(args.detailLimit || 0);
const detailOffset = Math.max(0, Number(args.detailOffset || 0));
const detailConcurrency = Math.max(1, Math.min(20, Number(args.detailConcurrency || 8)));

const access = accessPath ? parseAccessFile(await readFile(accessPath, "utf8")) : {};
const baseUrl = args.baseUrl || process.env.CSTD_ALPHA_BASE_URL || access.URL;
const password = args.password || process.env.REPORT_PASSWORD || access.REPORT_PASSWORD;
const username = args.username || process.env.REPORT_USERNAME || access.REPORT_USERNAME || access.USERNAME || access.ADMIN_USERNAME;
if (!baseUrl) throw new Error("Missing URL. Pass --base-url or set CSTD_ALPHA_BASE_URL.");
if (!username) throw new Error("Missing REPORT_USERNAME. Pass --username, set REPORT_USERNAME, or set CSTD_ALPHA_ACCESS_FILE.");
if (!password) throw new Error("Missing REPORT_PASSWORD. Pass --password, set REPORT_PASSWORD, or set CSTD_ALPHA_ACCESS_FILE.");

await mkdir(outputDir, { recursive: true });

const cookie = await login(baseUrl, username, password);
const entries = await fetchAllEntries(baseUrl, cookie);
const detailTargets = detailLimit > 0 ? entries.slice(detailOffset, detailOffset + detailLimit) : entries.slice(detailOffset);
const detailAudits = await mapLimit(detailTargets, detailConcurrency, async (entry) => {
  try {
    const record = await fetchJson(`${baseUrl}/api/report-library?id=${encodeURIComponent(entry.id)}`, { cookie });
    return auditReport(record.entry ?? entry, record.report);
  } catch (error) {
    return {
      source: "detail",
      id: entry.id,
      ticker: entry.ticker,
      companyName: entry.companyName,
      severity: "error",
      issues: [`detail_fetch_failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
});

const entryAudits = entries.map(auditEntry);
const issues = [...entryAudits, ...detailAudits].filter((item) => item.issues.length);
const summary = summarize(entries, entryAudits, detailAudits);
const classified = classifyIssues(issues);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = {
  generatedAt: new Date().toISOString(),
  baseUrl: redactUrl(baseUrl),
  entryCount: entries.length,
  detailChecked: detailTargets.length,
  detailOffset,
  detailConcurrency,
  summary,
  rerunCandidates: classified.rerunCandidates,
  localFixCandidates: classified.localFixCandidates,
  manualReviewCandidates: classified.manualReviewCandidates,
  topIssues: issues.slice(0, 200),
  allIssues: issues,
};

const outputPath = path.join(outputDir, `report-library-audit-${stamp}.json`);
const rerunPath = path.join(outputDir, `report-library-rerun-candidates-${stamp}.json`);
const localFixPath = path.join(outputDir, `report-library-local-fix-candidates-${stamp}.json`);
const manualReviewPath = path.join(outputDir, `report-library-manual-review-${stamp}.json`);
await writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");
await Promise.all([
  writeFile(rerunPath, JSON.stringify(classified.rerunCandidates, null, 2), "utf8"),
  writeFile(localFixPath, JSON.stringify(classified.localFixCandidates, null, 2), "utf8"),
  writeFile(manualReviewPath, JSON.stringify(classified.manualReviewCandidates, null, 2), "utf8"),
]);

console.log(JSON.stringify({ outputPath, rerunPath, localFixPath, manualReviewPath, ...summary }, null, 2));

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

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
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

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
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
  if (Number(entry.scoreItemCount) < 20) issues.push(`partial_score_items:${Number(entry.scoreItemCount) || 0}`);
  return issueRecord(entry, issues, "entry");
}

function auditReport(entry, report) {
  const issues = [];
  if (!report || typeof report !== "object") return issueRecord(entry, ["missing_report_object"], "detail");
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
  return issueRecord(entry, issues, "detail");
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

function classifyIssues(issues) {
  const rerunIssueNames = new Set([
    "detail_fetch_failed",
    "missing_report_object",
    "missing_current_price",
    "too_few_score_items",
    "partial_score_items",
    "score_items_not_20",
    "placeholder_one_sentence",
    "too_few_evidence_items",
  ]);
  const localFixIssueNames = new Set([
    "avoid_with_nonzero_position",
    "position_mentions_quote_missing",
    "valuation_mentions_missing_quote",
    "missing_buy_range",
    "missing_sell_reduce_range",
    "report_avoid_position_not_zero",
    "report_avoid_account_max_not_zero",
  ]);
  const rerunCandidates = [];
  const localFixCandidates = [];
  const manualReviewCandidates = [];
  for (const issue of issues) {
    const names = issue.issues.map((item) => item.split(":")[0]);
    if (names.some((name) => rerunIssueNames.has(name))) rerunCandidates.push(issue);
    else if (names.some((name) => localFixIssueNames.has(name))) localFixCandidates.push(issue);
    else manualReviewCandidates.push(issue);
  }
  return {
    rerunCandidates: uniqueIssueRecords(rerunCandidates),
    localFixCandidates: uniqueIssueRecords(localFixCandidates),
    manualReviewCandidates: uniqueIssueRecords(manualReviewCandidates),
  };
}

function uniqueIssueRecords(records) {
  const seen = new Set();
  const result = [];
  for (const record of records) {
    const key = `${record.source}:${record.id}:${record.issues.join("|")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(record);
  }
  return result;
}

function issueRecord(entry, issues, source) {
  return {
    source,
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
