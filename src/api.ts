import type { ChartBundle, PriceMode } from "./shared/chart";
import type { CompanyCandidate, InvestmentReport } from "./shared/report";

export type GenerateReportInput = {
  company: CompanyCandidate;
};

export type FetchChartDataInput = {
  company: CompanyCandidate;
  priceMode: PriceMode;
};

export type ReportProgress = {
  type: "progress";
  stage: string;
  label: string;
  detail: string;
  percent: number;
  at: string;
};

export async function checkSession() {
  const response = await fetch("/api/session", { credentials: "include" });
  return response.ok;
}

export async function login(password: string) {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ password }),
  });

  if (!response.ok) throw new Error((await readError(response)) || "登录失败。");
}

export async function searchCompanies(query: string): Promise<CompanyCandidate[]> {
  const response = await fetch(`/api/company-search?q=${encodeURIComponent(query)}`, { credentials: "include" });
  if (!response.ok) throw new Error((await readError(response)) || "公司搜索失败。");
  const data = (await response.json()) as { candidates?: CompanyCandidate[] };
  return data.candidates ?? [];
}

export async function generateReport(input: GenerateReportInput, onProgress?: (progress: ReportProgress) => void): Promise<InvestmentReport> {
  const response = await fetch("/api/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });

  if (!response.ok) throw new Error((await readError(response)) || "报告生成失败。");

  let finalReport: InvestmentReport | undefined;
  for await (const event of readNdjson(response)) {
    if (event.type === "progress") onProgress?.(event as ReportProgress);
    if (event.type === "error") throw new Error(String(event.error || "报告生成失败。"));
    if (event.type === "final") finalReport = event.report as InvestmentReport;
  }

  if (!finalReport) throw new Error("报告响应没有包含最终报告。");
  return finalReport;
}

export async function fetchChartData(input: FetchChartDataInput): Promise<ChartBundle> {
  const response = await fetch("/api/chart-data", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });

  if (!response.ok) throw new Error((await readError(response)) || "图表数据生成失败。");
  return (await response.json()) as ChartBundle;
}

async function* readNdjson(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) {
    const data = JSON.parse(await response.text()) as Record<string, unknown>;
    yield data;
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      yield JSON.parse(trimmed) as Record<string, unknown>;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) yield JSON.parse(buffer.trim()) as Record<string, unknown>;
}

async function readError(response: Response) {
  try {
    const data = (await response.json()) as { error?: string };
    return data.error;
  } catch {
    return response.statusText;
  }
}
