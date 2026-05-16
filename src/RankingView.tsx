import { useEffect, useMemo, useState } from "react";
import { fetchReportLibrary, importReportLibraryReports } from "./api";
import { deleteImportedRankingReport, loadImportedRankingReports, parseRankingReportJson, upsertImportedRankingReports } from "./ranking-storage";
import { A_SHARE_INDUSTRY_GROUPS } from "./shared/industry";
import type { ReportLibraryEntry } from "./shared/report-library";
import { buildRankingEntries, type RankingEntry, type RankingSeed } from "./shared/ranking";
import { crossMarketAnchorTickersForListings } from "./shared/cross-market";

export type RankingMarket = "a-share" | "us" | "hk";

type RankingViewProps = {
  market: RankingMarket;
  onOpenEntry: (entry: RankingEntry) => void | Promise<void>;
};

type SortMode = "rank" | "ias" | "cqs" | "name" | "code" | "sector";
type SortDirection = "desc" | "asc";
const LIBRARY_PAGE_SIZE = 20;
const CLIENT_FILTERED_LIBRARY_LIMIT = 100;

const RANKING_CONFIG: Record<
  RankingMarket,
  {
    marketParam: string;
    eyebrow: string;
    title: string;
    description: string;
    tableLabel: string;
    industryGroups: readonly string[];
    seeds: readonly RankingSeed[];
  }
> = {
  "a-share": {
    marketParam: "cn",
    eyebrow: "A 股评分池",
    title: "A 股公司排行",
    description: "按已入库完整深度报告评分排序；A 股报告库按唯一股票代码单独成榜。",
    tableLabel: "A 股公司评分排行",
    industryGroups: A_SHARE_INDUSTRY_GROUPS,
    seeds: [],
  },
  us: {
    marketParam: "us",
    eyebrow: "美股评分池",
    title: "美股公司排行",
    description: "按已入库深度报告评分排序；美股报告单独成榜，不与 A 股混排。",
    tableLabel: "美股公司评分排行",
    industryGroups: [],
    seeds: [],
  },
  hk: {
    marketParam: "hk",
    eyebrow: "港股评分池",
    title: "港股公司排行",
    description: "按已入库深度报告评分排序；港股报告单独成榜，不与 A 股混排。",
    tableLabel: "港股公司评分排行",
    industryGroups: [],
    seeds: [],
  },
};

export function RankingView({ market, onOpenEntry }: RankingViewProps) {
  const config = RANKING_CONFIG[market];
  const usesClientSideLibrary = market !== "a-share";
  const [imported, setImported] = useState(() => loadImportedRankingReports());
  const [libraryEntries, setLibraryEntries] = useState<ReportLibraryEntry[]>([]);
  const [anchorLibraryEntries, setAnchorLibraryEntries] = useState<ReportLibraryEntry[]>([]);
  const [libraryTotal, setLibraryTotal] = useState(0);
  const [matchedSeedCodes, setMatchedSeedCodes] = useState<Set<string>>(() => new Set());
  const [libraryPhase, setLibraryPhase] = useState<"loading" | "ready" | "error">("loading");
  const [libraryPage, setLibraryPage] = useState(1);
  const [query, setQuery] = useState("");
  const [sector, setSector] = useState("全部行业");
  const [source, setSource] = useState<"all" | "deep-report" | "seed">("deep-report");
  const [sortMode, setSortMode] = useState<SortMode>("rank");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [importText, setImportText] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    queueMicrotask(() => {
      setLibraryPage(1);
      setQuery("");
      setSector("全部行业");
      setSource("deep-report");
      setLibraryEntries([]);
      setAnchorLibraryEntries([]);
      setLibraryTotal(0);
      setMatchedSeedCodes(new Set());
    });
  }, [market]);

  const remoteLibraryPage = usesClientSideLibrary ? 1 : libraryPage;
  const remoteIndustry = usesClientSideLibrary ? "全部行业" : sector;
  const remoteSortMode = usesClientSideLibrary ? "rank" : sortMode;
  const remoteSortDirection = usesClientSideLibrary ? "desc" : sortDirection;

  useEffect(() => {
    let cancelled = false;
    const offset = (remoteLibraryPage - 1) * LIBRARY_PAGE_SIZE;
    queueMicrotask(() => {
      if (!cancelled) {
        setLibraryPhase("loading");
        setLibraryEntries([]);
        setAnchorLibraryEntries([]);
        setMatchedSeedCodes(new Set());
      }
    });
    const seedCodes = config.seeds.map((seed) => seed.code);
    const request = usesClientSideLibrary
      ? fetchAllMarketLibraryEntries(config.marketParam, seedCodes)
      : fetchReportLibrary({
          limit: LIBRARY_PAGE_SIZE,
          offset,
          sort: remoteSortMode,
          direction: remoteSortDirection,
          industry: remoteIndustry,
          market: config.marketParam,
          seedCodes,
        });

    void request
      .then((library) => {
        if (cancelled) return;
        setLibraryEntries(library.entries);
        setAnchorLibraryEntries(library.anchorEntries ?? []);
        setLibraryTotal(library.total);
        setMatchedSeedCodes(new Set(library.matchedTickers ?? []));
        setLibraryPhase("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setLibraryPhase("error");
        setError(err instanceof Error ? err.message : "报告库读取失败。");
      });
    return () => {
      cancelled = true;
    };
  }, [config.marketParam, config.seeds, remoteIndustry, remoteLibraryPage, remoteSortDirection, remoteSortMode, usesClientSideLibrary]);

  const entries = useMemo(
    () =>
      buildRankingEntries(
        imported.map((entry) => entry.report),
        libraryEntries,
        config.seeds,
        anchorLibraryEntries,
      ).filter((entry) => entry.source !== "seed" || !matchedSeedCodes.has(entry.code)),
    [anchorLibraryEntries, config.seeds, imported, libraryEntries, matchedSeedCodes],
  );
  const sectors = useMemo(() => {
    const seen = new Set(["全部行业", ...config.industryGroups, ...entries.map((entry) => entry.industryGroup)]);
    return Array.from(seen);
  }, [config.industryGroups, entries]);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return entries
      .filter((entry) => {
        const keywordMatched = !keyword || `${entry.name} ${entry.code} ${entry.sector} ${entry.industryGroup}`.toLowerCase().includes(keyword);
        const sectorMatched = sector === "全部行业" || entry.industryGroup === sector;
        const sourceMatched = source === "all" || entry.source === source;
        return keywordMatched && sectorMatched && sourceMatched;
      })
      .sort((left, right) => compareRankingRows(left, right, sortMode, sortDirection));
  }, [entries, query, sector, sortDirection, sortMode, source]);
  const visibleRows = useMemo(() => {
    if (!usesClientSideLibrary) return filtered;
    const pageOffset = (libraryPage - 1) * LIBRARY_PAGE_SIZE;
    return filtered.slice(pageOffset, pageOffset + LIBRARY_PAGE_SIZE);
  }, [filtered, libraryPage, usesClientSideLibrary]);

  const deepReportCount = entries.filter((entry) => entry.source === "deep-report").length;
  const seedCount = entries.filter((entry) => entry.source === "seed").length;
  const pageTopEntry = entries.find((entry) => entry.source === "deep-report");
  const visibleTotal = usesClientSideLibrary ? filtered.length : libraryTotal;
  const libraryPageCount = Math.max(1, Math.ceil(visibleTotal / LIBRARY_PAGE_SIZE));
  const libraryOffset = (libraryPage - 1) * LIBRARY_PAGE_SIZE;
  const pageStart = visibleTotal ? libraryOffset + 1 : 0;
  const pageEnd = Math.min(libraryOffset + visibleRows.length, visibleTotal);

  async function submitImport(event: React.FormEvent) {
    event.preventDefault();
    setNotice("");
    setError("");
    try {
      const reports = parseRankingReportJson(importText);
      const saved = await importReportLibraryReports(reports);
      const nextImported = upsertImportedRankingReports(reports);
      setImported(nextImported);
      setLibraryEntries((current) => mergeLibraryEntries(current, saved));
      setLibraryTotal((current) => Math.max(current, mergeLibraryEntries(libraryEntries, saved).length));
      setImportText("");
      setNotice(`已导入 ${reports.length} 份报告到服务端报告库，排行榜已按深度报告评分更新。`);
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
          <p className="eyebrow">{config.eyebrow}</p>
          <h2 id="ranking-title">{config.title}</h2>
          <p className="muted">{config.description}</p>
        </div>
        <div className="ranking-summary">
          <MetricTile label="公司池" value={`${libraryTotal + seedCount}`} />
          <MetricTile label="报告库" value={libraryPhase === "loading" ? "读取中" : `${libraryTotal || deepReportCount}`} />
          <MetricTile label="待导入" value={`${seedCount}`} />
          <MetricTile label="本页第一" value={pageTopEntry ? pageTopEntry.name : "待生成"} />
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
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLibraryPage(1);
          }}
          placeholder="搜索公司、代码或行业"
          aria-label="搜索排行"
        />
        <select
          value={sector}
          onChange={(event) => {
            setSector(event.target.value);
            setLibraryPage(1);
          }}
          aria-label="行业筛选"
        >
          {sectors.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <select
          value={sortMode}
          onChange={(event) => {
            setSortMode(event.target.value as SortMode);
            setLibraryPage(1);
          }}
          aria-label="排序字段"
        >
          <option value="rank">综合排名</option>
          <option value="ias">投资吸引力 IAS</option>
          <option value="cqs">公司质量 CQS</option>
          <option value="name">公司名称</option>
          <option value="code">股票代码</option>
          <option value="sector">行业</option>
        </select>
        <select
          value={sortDirection}
          onChange={(event) => {
            setSortDirection(event.target.value as SortDirection);
            setLibraryPage(1);
          }}
          aria-label="排序方向"
        >
          <option value="desc">降序</option>
          <option value="asc">升序</option>
        </select>
        <div className="segmented-control" role="group" aria-label="数据来源">
          <button
            type="button"
            className={source === "all" ? "active" : ""}
            aria-pressed={source === "all"}
            onClick={() => {
              setSource("all");
              setLibraryPage(1);
            }}
          >
            全部
          </button>
          <button
            type="button"
            className={source === "deep-report" ? "active" : ""}
            aria-pressed={source === "deep-report"}
            onClick={() => {
              setSource("deep-report");
              setLibraryPage(1);
            }}
          >
            深度报告
          </button>
          <button
            type="button"
            className={source === "seed" ? "active" : ""}
            aria-pressed={source === "seed"}
            onClick={() => {
              setSource("seed");
              setLibraryPage(1);
            }}
          >
            待导入
          </button>
        </div>
      </div>

      <div className="ranking-table" role="table" aria-label={config.tableLabel}>
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
        {libraryPhase === "loading" ? (
          <div className="ranking-row ranking-row-loading" role="row">
            <span>读取中</span>
            <span>正在刷新报告库数据...</span>
            <span>--</span>
            <span>--</span>
            <span>--</span>
            <span>--</span>
            <span>--</span>
            <span>--</span>
            <span>--</span>
          </div>
        ) : null}
        {visibleRows.map((entry, index) => (
          <div key={`${entry.id}-${entry.source}`} className={`ranking-row ${entry.source === "deep-report" ? "is-report" : "is-seed"}`} role="row">
            <span>#{entry.source === "deep-report" ? libraryOffset + index + 1 : entry.rank}</span>
            <button type="button" className="ranking-company" onClick={() => void onOpenEntry(entry)}>
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
              <button type="button" className="secondary-button" onClick={() => void onOpenEntry(entry)}>
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

      {source !== "seed" ? (
        <div className="ranking-pagination" aria-label="报告库分页">
          <span>
            第 {libraryPage} / {libraryPageCount} 页，显示 {pageStart}-{pageEnd} / {visibleTotal}
          </span>
          <div>
            <button type="button" onClick={() => setLibraryPage(1)} disabled={libraryPage <= 1 || libraryPhase === "loading"}>
              首页
            </button>
            <button type="button" onClick={() => setLibraryPage((page) => Math.max(1, page - 1))} disabled={libraryPage <= 1 || libraryPhase === "loading"}>
              上一页
            </button>
            <button
              type="button"
              onClick={() => setLibraryPage((page) => Math.min(libraryPageCount, page + 1))}
              disabled={libraryPage >= libraryPageCount || libraryPhase === "loading"}
            >
              下一页
            </button>
            <button type="button" onClick={() => setLibraryPage(libraryPageCount)} disabled={libraryPage >= libraryPageCount || libraryPhase === "loading"}>
              末页
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function compareRankingRows(left: RankingEntry, right: RankingEntry, sortMode: SortMode, direction: SortDirection) {
  const multiplier = direction === "desc" ? -1 : 1;
  if (sortMode === "rank") return direction === "desc" ? left.rank - right.rank : right.rank - left.rank;
  const value = compareRankingValue(left, right, sortMode);
  if (value !== 0) return value * multiplier;
  return left.rank - right.rank;
}

async function fetchAllMarketLibraryEntries(market: string, seedCodes: string[]) {
  const entries: ReportLibraryEntry[] = [];
  const anchorEntries: ReportLibraryEntry[] = [];
  const matchedTickers = new Set<string>();
  let total: number;
  for (let offset = 0; ; offset += CLIENT_FILTERED_LIBRARY_LIMIT) {
    const page = await fetchReportLibrary({
      limit: CLIENT_FILTERED_LIBRARY_LIMIT,
      offset,
      sort: "rank",
      direction: "desc",
      market,
      seedCodes,
    });
    entries.push(...page.entries);
    for (const ticker of page.matchedTickers ?? []) matchedTickers.add(ticker);
    total = page.total ?? entries.length;
    if (!page.entries.length || entries.length >= total) break;
  }
  const anchorTickers = crossMarketAnchorTickersForListings(entries);
  for (let offset = 0; offset < anchorTickers.length; offset += CLIENT_FILTERED_LIBRARY_LIMIT) {
    const pageTickers = anchorTickers.slice(offset, offset + CLIENT_FILTERED_LIBRARY_LIMIT);
    const page = await fetchReportLibrary({
      limit: CLIENT_FILTERED_LIBRARY_LIMIT,
      offset: 0,
      sort: "rank",
      direction: "desc",
      market: "cn",
      tickers: pageTickers,
    });
    anchorEntries.push(...page.entries);
  }
  return { entries, total, matchedTickers: Array.from(matchedTickers), anchorEntries };
}

function compareRankingValue(left: RankingEntry, right: RankingEntry, sortMode: Exclude<SortMode, "rank">) {
  if (sortMode === "ias" || sortMode === "cqs") return scoreValue(left, sortMode) - scoreValue(right, sortMode);
  if (sortMode === "name") return left.name.localeCompare(right.name, "zh-CN");
  if (sortMode === "code") return left.code.localeCompare(right.code);
  return `${left.industryGroup} ${left.sector}`.localeCompare(`${right.industryGroup} ${right.sector}`, "zh-CN");
}

function scoreValue(entry: RankingEntry, key: "ias" | "cqs") {
  return entry.source === "deep-report" && Number.isFinite(entry[key]) ? entry[key] : -1;
}

function mergeLibraryEntries(current: ReportLibraryEntry[], incoming: ReportLibraryEntry[]) {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) byId.set(entry.id, entry);
  return Array.from(byId.values());
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
