import { useMemo, useState } from "react";
import { deleteImportedRankingReport, loadImportedRankingReports, parseRankingReportJson, upsertImportedRankingReports } from "./ranking-storage";
import { buildRankingEntries, type RankingEntry } from "./shared/ranking";

type RankingViewProps = {
  onOpenEntry: (entry: RankingEntry) => void;
};

export function RankingView({ onOpenEntry }: RankingViewProps) {
  const [imported, setImported] = useState(() => loadImportedRankingReports());
  const [query, setQuery] = useState("");
  const [sector, setSector] = useState("全部行业");
  const [source, setSource] = useState<"all" | "deep-report" | "seed">("all");
  const [importText, setImportText] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const entries = useMemo(() => buildRankingEntries(imported.map((entry) => entry.report)), [imported]);
  const sectors = useMemo(() => ["全部行业", ...Array.from(new Set(entries.map((entry) => entry.sector))).sort()], [entries]);
  const filtered = entries.filter((entry) => {
    const keyword = query.trim().toLowerCase();
    const keywordMatched = !keyword || `${entry.name} ${entry.code} ${entry.sector}`.toLowerCase().includes(keyword);
    const sectorMatched = sector === "全部行业" || entry.sector === sector;
    const sourceMatched = source === "all" || entry.source === source;
    return keywordMatched && sectorMatched && sourceMatched;
  });

  const deepReportCount = entries.filter((entry) => entry.source === "deep-report").length;
  const seedCount = entries.filter((entry) => entry.source === "seed").length;
  const topEntry = entries.find((entry) => entry.source === "deep-report");

  function submitImport(event: React.FormEvent) {
    event.preventDefault();
    setNotice("");
    setError("");
    try {
      const reports = parseRankingReportJson(importText);
      const nextImported = upsertImportedRankingReports(reports);
      setImported(nextImported);
      setImportText("");
      setNotice(`已导入 ${reports.length} 份报告，排行榜已按深度报告评分更新。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败，请检查 JSON。");
    }
  }

  function deleteReport(entry: RankingEntry) {
    if (!entry.report) return;
    const nextImported = deleteImportedRankingReport(entry.report);
    setImported(nextImported);
    setNotice(`已移除 ${entry.name} 的导入报告。`);
  }

  return (
    <section className="ranking-workspace" aria-labelledby="ranking-title">
      <header className="ranking-header">
        <div>
          <p className="eyebrow">A 股评分池</p>
          <h2 id="ranking-title">100 家公司排行</h2>
          <p className="muted">按 IAS 与 CQS 排序；已导入的深度报告会覆盖本地种子分数。</p>
        </div>
        <div className="ranking-summary">
          <MetricTile label="公司池" value={`${entries.length}`} />
          <MetricTile label="深度报告" value={`${deepReportCount}`} />
          <MetricTile label="待导入" value={`${seedCount}`} />
          <MetricTile label="当前第一" value={topEntry ? topEntry.name : "待生成"} />
        </div>
      </header>

      <form className="ranking-import" onSubmit={submitImport}>
        <label htmlFor="rankingImport">导入报告 JSON</label>
        <textarea
          id="rankingImport"
          value={importText}
          onChange={(event) => setImportText(event.target.value)}
          placeholder='粘贴单份报告 JSON，或 {"reports":[...]}'
          rows={5}
        />
        <button type="submit" disabled={!importText.trim()}>
          导入并更新排行
        </button>
        {notice ? <p className="cache-notice">{notice}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
      </form>

      <div className="ranking-tools">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索公司、代码或行业" aria-label="搜索排行" />
        <select value={sector} onChange={(event) => setSector(event.target.value)} aria-label="行业筛选">
          {sectors.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <div className="segmented-control" role="group" aria-label="数据来源">
          <button type="button" className={source === "all" ? "active" : ""} onClick={() => setSource("all")}>
            全部
          </button>
          <button type="button" className={source === "deep-report" ? "active" : ""} onClick={() => setSource("deep-report")}>
            深度报告
          </button>
          <button type="button" className={source === "seed" ? "active" : ""} onClick={() => setSource("seed")}>
            待导入
          </button>
        </div>
      </div>

      <div className="ranking-table" role="table" aria-label="A 股公司评分排行">
        <div className="ranking-row ranking-row-head" role="row">
          <span>排名</span>
          <span>公司</span>
          <span>行业</span>
          <span>CQS</span>
          <span>IAS</span>
          <span>动作</span>
          <span>仓位</span>
          <span>来源</span>
          <span>操作</span>
        </div>
        {filtered.map((entry) => (
          <div key={`${entry.id}-${entry.source}`} className={`ranking-row ${entry.source === "deep-report" ? "is-report" : "is-seed"}`} role="row">
            <span>#{entry.rank}</span>
            <button type="button" className="ranking-company" onClick={() => onOpenEntry(entry)}>
              <strong>{entry.name}</strong>
              <small>
                {entry.code} / {entry.listingPlace}
              </small>
            </button>
            <span>{entry.sector}</span>
            <span>{formatScore(entry, "cqs")}</span>
            <span>{formatScore(entry, "ias")}</span>
            <span>{entry.conclusion}</span>
            <span>{entry.positionAdvice}</span>
            <span>{entry.source === "deep-report" ? "深度报告" : "待导入"}</span>
            <span className="ranking-actions">
              <button type="button" className="secondary-button" onClick={() => onOpenEntry(entry)}>
                查看
              </button>
              {entry.report ? (
                <button type="button" className="ghost-button" onClick={() => deleteReport(entry)}>
                  移除
                </button>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="ranking-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatScore(entry: RankingEntry, key: "cqs" | "ias") {
  if (entry.source !== "deep-report") return "待评分";
  const value = entry[key];
  return Number.isFinite(value) ? value.toFixed(value % 1 === 0 ? 0 : 1) : "-";
}
