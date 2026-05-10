import type { InvestmentReport, ReportLanguage } from "./shared/report";

export type GenerateReportInput = {
  companyName: string;
  ticker?: string;
  market?: string;
  language: ReportLanguage;
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

  if (!response.ok) throw new Error((await readError(response)) || "Password check failed.");
}

export async function generateReport(input: GenerateReportInput): Promise<InvestmentReport> {
  const response = await fetch("/api/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });

  if (!response.ok) throw new Error((await readError(response)) || "Report generation failed.");

  const data = (await response.json()) as { report?: InvestmentReport; error?: string };
  if (data.error) throw new Error(data.error);
  if (!data.report) throw new Error("Report response did not include a report.");
  return data.report;
}

async function readError(response: Response) {
  try {
    const data = (await response.json()) as { error?: string };
    return data.error;
  } catch {
    return response.statusText;
  }
}
