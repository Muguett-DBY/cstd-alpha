import { importReportLibraryReports } from "./api";
import { upsertImportedRankingReports, type ImportedRankingReport } from "./ranking-storage";
import type { ReportLibraryEntry } from "./shared/report-library";
import type { InvestmentReport } from "./shared/report";

type RankingImportDependencies = {
  importGlobal: (reports: InvestmentReport[]) => Promise<ReportLibraryEntry[]>;
  upsertLocal: (reports: InvestmentReport[]) => ImportedRankingReport[];
};

const defaultDependencies: RankingImportDependencies = {
  importGlobal: importReportLibraryReports,
  upsertLocal: upsertImportedRankingReports,
};

export async function persistRankingReportImport(
  reports: InvestmentReport[],
  canManageGlobalLibrary: boolean,
  dependencies: RankingImportDependencies = defaultDependencies,
) {
  const saved = canManageGlobalLibrary ? await dependencies.importGlobal(reports) : [];
  const imported = dependencies.upsertLocal(reports);
  return { saved, imported, scope: canManageGlobalLibrary ? "global" as const : "local" as const };
}
