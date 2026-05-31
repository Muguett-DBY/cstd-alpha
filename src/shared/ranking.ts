import type { CompanyCandidate, InvestmentReport } from "./report";
import { normalizeEntryConclusion, normalizeEntryPositionAdvice, type ReportLibraryEntry } from "./report-library";
import { formatLocalizedIndustry, localizedCompanyName, localizedIndustry } from "./market-display";
import { crossMarketAnchorForListing } from "./cross-market";
export { reportIdentityKey } from "./report-identity";
import { normalizeIdentity, reportIdentityKey, stockCodeIdentity } from "./report-identity";

export type RankingSource = "deep-report" | "seed";

export type RankingSeed = {
  code: string;
  name: string;
  exchange: string;
  listingPlace: string;
  sector: string;
  baseline: number;
};

export type RankingEntry = {
  id: string;
  rank: number;
  code: string;
  name: string;
  exchange: string;
  listingPlace: string;
  sector: string;
  industryGroup: string;
  cqs: number;
  ias: number;
  conclusion: InvestmentReport["conclusion"] | "待导入";
  positionAdvice: string;
  valuationView: string;
  asOf: string;
  source: RankingSource;
  hasReport: boolean;
  seedOrder: number;
  libraryId?: string;
  report?: InvestmentReport;
  candidate: CompanyCandidate;
};

export const A_SHARE_RANKING_SEEDS: RankingSeed[] = [
  { code: "600519", name: "贵州茅台", exchange: "上海证券交易所", listingPlace: "沪A", sector: "食品饮料", baseline: 89 },
  { code: "000858", name: "五粮液", exchange: "深圳证券交易所", listingPlace: "深A", sector: "食品饮料", baseline: 84 },
  { code: "000568", name: "泸州老窖", exchange: "深圳证券交易所", listingPlace: "深A", sector: "食品饮料", baseline: 81 },
  { code: "600809", name: "山西汾酒", exchange: "上海证券交易所", listingPlace: "沪A", sector: "食品饮料", baseline: 80 },
  { code: "600887", name: "伊利股份", exchange: "上海证券交易所", listingPlace: "沪A", sector: "食品饮料", baseline: 76 },
  { code: "000333", name: "美的集团", exchange: "深圳证券交易所", listingPlace: "深A", sector: "家用电器", baseline: 82 },
  { code: "000651", name: "格力电器", exchange: "深圳证券交易所", listingPlace: "深A", sector: "家用电器", baseline: 73 },
  { code: "600690", name: "海尔智家", exchange: "上海证券交易所", listingPlace: "沪A", sector: "家用电器", baseline: 77 },
  { code: "000895", name: "双汇发展", exchange: "深圳证券交易所", listingPlace: "深A", sector: "食品饮料", baseline: 72 },
  { code: "603288", name: "海天味业", exchange: "上海证券交易所", listingPlace: "沪A", sector: "食品饮料", baseline: 78 },
  { code: "601318", name: "中国平安", exchange: "上海证券交易所", listingPlace: "沪A", sector: "非银金融", baseline: 70 },
  { code: "600036", name: "招商银行", exchange: "上海证券交易所", listingPlace: "沪A", sector: "银行", baseline: 79 },
  { code: "601166", name: "兴业银行", exchange: "上海证券交易所", listingPlace: "沪A", sector: "银行", baseline: 69 },
  { code: "600000", name: "浦发银行", exchange: "上海证券交易所", listingPlace: "沪A", sector: "银行", baseline: 58 },
  { code: "601398", name: "工商银行", exchange: "上海证券交易所", listingPlace: "沪A", sector: "银行", baseline: 72 },
  { code: "601288", name: "农业银行", exchange: "上海证券交易所", listingPlace: "沪A", sector: "银行", baseline: 71 },
  { code: "601988", name: "中国银行", exchange: "上海证券交易所", listingPlace: "沪A", sector: "银行", baseline: 70 },
  { code: "601939", name: "建设银行", exchange: "上海证券交易所", listingPlace: "沪A", sector: "银行", baseline: 73 },
  { code: "600030", name: "中信证券", exchange: "上海证券交易所", listingPlace: "沪A", sector: "非银金融", baseline: 67 },
  { code: "300059", name: "东方财富", exchange: "深圳证券交易所", listingPlace: "创业板", sector: "非银金融", baseline: 68 },
  { code: "600276", name: "恒瑞医药", exchange: "上海证券交易所", listingPlace: "沪A", sector: "医药生物", baseline: 78 },
  { code: "300760", name: "迈瑞医疗", exchange: "深圳证券交易所", listingPlace: "创业板", sector: "医药生物", baseline: 84 },
  { code: "000538", name: "云南白药", exchange: "深圳证券交易所", listingPlace: "深A", sector: "医药生物", baseline: 70 },
  { code: "600436", name: "片仔癀", exchange: "上海证券交易所", listingPlace: "沪A", sector: "医药生物", baseline: 80 },
  { code: "603259", name: "药明康德", exchange: "上海证券交易所", listingPlace: "沪A", sector: "医药生物", baseline: 69 },
  { code: "300122", name: "智飞生物", exchange: "深圳证券交易所", listingPlace: "创业板", sector: "医药生物", baseline: 62 },
  { code: "600196", name: "复星医药", exchange: "上海证券交易所", listingPlace: "沪A", sector: "医药生物", baseline: 63 },
  { code: "000661", name: "长春高新", exchange: "深圳证券交易所", listingPlace: "深A", sector: "医药生物", baseline: 66 },
  { code: "300015", name: "爱尔眼科", exchange: "深圳证券交易所", listingPlace: "创业板", sector: "医药生物", baseline: 72 },
  { code: "600763", name: "通策医疗", exchange: "上海证券交易所", listingPlace: "沪A", sector: "医药生物", baseline: 61 },
  { code: "300750", name: "宁德时代", exchange: "深圳证券交易所", listingPlace: "创业板", sector: "电力设备", baseline: 83 },
  { code: "002594", name: "比亚迪", exchange: "深圳证券交易所", listingPlace: "深A", sector: "汽车", baseline: 82 },
  { code: "300014", name: "亿纬锂能", exchange: "深圳证券交易所", listingPlace: "创业板", sector: "电力设备", baseline: 70 },
  { code: "002812", name: "恩捷股份", exchange: "深圳证券交易所", listingPlace: "深A", sector: "电力设备", baseline: 58 },
  { code: "002709", name: "天赐材料", exchange: "深圳证券交易所", listingPlace: "深A", sector: "电力设备", baseline: 59 },
  { code: "300124", name: "汇川技术", exchange: "深圳证券交易所", listingPlace: "创业板", sector: "机械设备", baseline: 81 },
  { code: "600438", name: "通威股份", exchange: "上海证券交易所", listingPlace: "沪A", sector: "电力设备", baseline: 60 },
  { code: "601012", name: "隆基绿能", exchange: "上海证券交易所", listingPlace: "沪A", sector: "电力设备", baseline: 61 },
  { code: "300274", name: "阳光电源", exchange: "深圳证券交易所", listingPlace: "创业板", sector: "电力设备", baseline: 76 },
  { code: "002129", name: "TCL中环", exchange: "深圳证券交易所", listingPlace: "深A", sector: "电力设备", baseline: 56 },
  { code: "600031", name: "三一重工", exchange: "上海证券交易所", listingPlace: "沪A", sector: "机械设备", baseline: 69 },
  { code: "000425", name: "徐工机械", exchange: "深圳证券交易所", listingPlace: "深A", sector: "机械设备", baseline: 68 },
  { code: "600309", name: "万华化学", exchange: "上海证券交易所", listingPlace: "沪A", sector: "基础化工", baseline: 80 },
  { code: "600019", name: "宝钢股份", exchange: "上海证券交易所", listingPlace: "沪A", sector: "钢铁", baseline: 64 },
  { code: "601899", name: "紫金矿业", exchange: "上海证券交易所", listingPlace: "沪A", sector: "有色金属", baseline: 77 },
  { code: "601600", name: "中国铝业", exchange: "上海证券交易所", listingPlace: "沪A", sector: "有色金属", baseline: 63 },
  { code: "600028", name: "中国石化", exchange: "上海证券交易所", listingPlace: "沪A", sector: "石油石化", baseline: 65 },
  { code: "601857", name: "中国石油", exchange: "上海证券交易所", listingPlace: "沪A", sector: "石油石化", baseline: 66 },
  { code: "601088", name: "中国神华", exchange: "上海证券交易所", listingPlace: "沪A", sector: "煤炭", baseline: 78 },
  { code: "600900", name: "长江电力", exchange: "上海证券交易所", listingPlace: "沪A", sector: "公用事业", baseline: 83 },
  { code: "600050", name: "中国联通", exchange: "上海证券交易所", listingPlace: "沪A", sector: "通信", baseline: 64 },
  { code: "600941", name: "中国移动", exchange: "上海证券交易所", listingPlace: "沪A", sector: "通信", baseline: 79 },
  { code: "601728", name: "中国电信", exchange: "上海证券交易所", listingPlace: "沪A", sector: "通信", baseline: 70 },
  { code: "000063", name: "中兴通讯", exchange: "深圳证券交易所", listingPlace: "深A", sector: "通信", baseline: 70 },
  { code: "002415", name: "海康威视", exchange: "深圳证券交易所", listingPlace: "深A", sector: "计算机", baseline: 76 },
  { code: "002230", name: "科大讯飞", exchange: "深圳证券交易所", listingPlace: "深A", sector: "计算机", baseline: 62 },
  { code: "688981", name: "中芯国际", exchange: "上海证券交易所", listingPlace: "科创板", sector: "电子", baseline: 67 },
  { code: "603501", name: "韦尔股份", exchange: "上海证券交易所", listingPlace: "沪A", sector: "电子", baseline: 69 },
  { code: "002371", name: "北方华创", exchange: "深圳证券交易所", listingPlace: "深A", sector: "电子", baseline: 78 },
  { code: "300661", name: "圣邦股份", exchange: "深圳证券交易所", listingPlace: "创业板", sector: "电子", baseline: 68 },
  { code: "600585", name: "海螺水泥", exchange: "上海证券交易所", listingPlace: "沪A", sector: "建筑材料", baseline: 62 },
  { code: "000002", name: "万科A", exchange: "深圳证券交易所", listingPlace: "深A", sector: "房地产", baseline: 45 },
  { code: "001979", name: "招商蛇口", exchange: "深圳证券交易所", listingPlace: "深A", sector: "房地产", baseline: 55 },
  { code: "600048", name: "保利发展", exchange: "上海证券交易所", listingPlace: "沪A", sector: "房地产", baseline: 57 },
  { code: "601668", name: "中国建筑", exchange: "上海证券交易所", listingPlace: "沪A", sector: "建筑装饰", baseline: 66 },
  { code: "601390", name: "中国中铁", exchange: "上海证券交易所", listingPlace: "沪A", sector: "建筑装饰", baseline: 60 },
  { code: "601186", name: "中国铁建", exchange: "上海证券交易所", listingPlace: "沪A", sector: "建筑装饰", baseline: 59 },
  { code: "600170", name: "上海建工", exchange: "上海证券交易所", listingPlace: "沪A", sector: "建筑装饰", baseline: 50 },
  { code: "605287", name: "德才股份", exchange: "上海证券交易所", listingPlace: "沪A", sector: "建筑装饰", baseline: 32 },
  { code: "002241", name: "歌尔股份", exchange: "深圳证券交易所", listingPlace: "深A", sector: "电子", baseline: 60 },
  { code: "600703", name: "三安光电", exchange: "上海证券交易所", listingPlace: "沪A", sector: "电子", baseline: 55 },
  { code: "000725", name: "京东方A", exchange: "深圳证券交易所", listingPlace: "深A", sector: "电子", baseline: 57 },
  { code: "000100", name: "TCL科技", exchange: "深圳证券交易所", listingPlace: "深A", sector: "电子", baseline: 58 },
  { code: "002475", name: "立讯精密", exchange: "深圳证券交易所", listingPlace: "深A", sector: "电子", baseline: 77 },
  { code: "002236", name: "大华股份", exchange: "深圳证券交易所", listingPlace: "深A", sector: "计算机", baseline: 63 },
  { code: "300433", name: "蓝思科技", exchange: "深圳证券交易所", listingPlace: "创业板", sector: "电子", baseline: 66 },
  { code: "600745", name: "闻泰科技", exchange: "上海证券交易所", listingPlace: "沪A", sector: "电子", baseline: 54 },
  { code: "688008", name: "澜起科技", exchange: "上海证券交易所", listingPlace: "科创板", sector: "电子", baseline: 74 },
  { code: "688111", name: "金山办公", exchange: "上海证券交易所", listingPlace: "科创板", sector: "计算机", baseline: 82 },
  { code: "300454", name: "深信服", exchange: "深圳证券交易所", listingPlace: "创业板", sector: "计算机", baseline: 64 },
  { code: "600104", name: "上汽集团", exchange: "上海证券交易所", listingPlace: "沪A", sector: "汽车", baseline: 57 },
  { code: "601633", name: "长城汽车", exchange: "上海证券交易所", listingPlace: "沪A", sector: "汽车", baseline: 65 },
  { code: "000625", name: "长安汽车", exchange: "深圳证券交易所", listingPlace: "深A", sector: "汽车", baseline: 66 },
  { code: "601238", name: "广汽集团", exchange: "上海证券交易所", listingPlace: "沪A", sector: "汽车", baseline: 56 },
  { code: "600660", name: "福耀玻璃", exchange: "上海证券交易所", listingPlace: "沪A", sector: "汽车", baseline: 79 },
  { code: "603799", name: "华友钴业", exchange: "上海证券交易所", listingPlace: "沪A", sector: "有色金属", baseline: 58 },
  { code: "002460", name: "赣锋锂业", exchange: "深圳证券交易所", listingPlace: "深A", sector: "有色金属", baseline: 57 },
  { code: "002466", name: "天齐锂业", exchange: "深圳证券交易所", listingPlace: "深A", sector: "有色金属", baseline: 56 },
  { code: "603986", name: "兆易创新", exchange: "上海证券交易所", listingPlace: "沪A", sector: "电子", baseline: 68 },
  { code: "300782", name: "卓胜微", exchange: "深圳证券交易所", listingPlace: "创业板", sector: "电子", baseline: 66 },
  { code: "600958", name: "东方证券", exchange: "上海证券交易所", listingPlace: "沪A", sector: "非银金融", baseline: 58 },
  { code: "601688", name: "华泰证券", exchange: "上海证券交易所", listingPlace: "沪A", sector: "非银金融", baseline: 66 },
  { code: "600999", name: "招商证券", exchange: "上海证券交易所", listingPlace: "沪A", sector: "非银金融", baseline: 62 },
  { code: "601601", name: "中国太保", exchange: "上海证券交易所", listingPlace: "沪A", sector: "非银金融", baseline: 67 },
  { code: "601628", name: "中国人寿", exchange: "上海证券交易所", listingPlace: "沪A", sector: "非银金融", baseline: 60 },
  { code: "600795", name: "国电电力", exchange: "上海证券交易所", listingPlace: "沪A", sector: "公用事业", baseline: 63 },
  { code: "600886", name: "国投电力", exchange: "上海证券交易所", listingPlace: "沪A", sector: "公用事业", baseline: 70 },
  { code: "600406", name: "国电南瑞", exchange: "上海证券交易所", listingPlace: "沪A", sector: "电力设备", baseline: 79 },
  { code: "002352", name: "顺丰控股", exchange: "深圳证券交易所", listingPlace: "深A", sector: "交通运输", baseline: 70 },
  { code: "601919", name: "中远海控", exchange: "上海证券交易所", listingPlace: "沪A", sector: "交通运输", baseline: 60 },
];

export function buildRankingEntries(
  reports: InvestmentReport[] = [],
  libraryEntries: ReportLibraryEntry[] = [],
  seeds: readonly RankingSeed[] = A_SHARE_RANKING_SEEDS,
  anchorLibraryEntries: ReportLibraryEntry[] = [],
): RankingEntry[] {
  const reportByKey = new Map(reports.map((report) => [reportRankingMatchKey(report), report]));
  const libraryEntryByKey = new Map(libraryEntries.map((entry) => [libraryEntryRankingMatchKey(entry), entry]));
  const anchorEntryByTicker = new Map(anchorLibraryEntries.map((entry) => [normalizeIdentity(entry.ticker), entry]));
  const seedKeys = new Set<string>();
  const rows = seeds.map((seed, index) => {
    const seedKey = seedRankingMatchKey(seed);
    seedKeys.add(seedKey);
    const report = reportByKey.get(seedKey);
    const libraryEntry = libraryEntryByKey.get(seedKey);
    return report
      ? reportToRankingEntry(report, seed, index, anchorEntryForListing(report.company.ticker, report.company.market, anchorEntryByTicker))
      : libraryEntry
        ? libraryEntryToRankingEntry(libraryEntry, seed, index, anchorEntryForListing(libraryEntry.ticker, libraryEntry.market, anchorEntryByTicker))
        : seedToRankingEntry(seed, index);
  });

  for (const report of reports) {
    if (!seedKeys.has(reportRankingMatchKey(report))) rows.push(reportToRankingEntry(report, undefined, Number.MAX_SAFE_INTEGER, anchorEntryForListing(report.company.ticker, report.company.market, anchorEntryByTicker)));
  }
  for (const entry of libraryEntries) {
    const key = libraryEntryRankingMatchKey(entry);
    if (!seedKeys.has(key) && !reportByKey.has(key)) rows.push(libraryEntryToRankingEntry(entry, undefined, Number.MAX_SAFE_INTEGER, anchorEntryForListing(entry.ticker, entry.market, anchorEntryByTicker)));
  }

  const sortedRows = rows.sort((left, right) => {
    const sourceScore = sourcePriority(right.source) - sourcePriority(left.source);
    if (sourceScore !== 0) return sourceScore;
    if (left.source === "seed" && right.source === "seed") return left.seedOrder - right.seedOrder;
    if (right.ias !== left.ias) return right.ias - left.ias;
    if (right.cqs !== left.cqs) return right.cqs - left.cqs;
    return left.code.localeCompare(right.code);
  });

  return dedupeShareClassRows(sortedRows).map((entry, index) => ({ ...entry, rank: index + 1 }));
}

export function companyCandidateFromRanking(entry: RankingEntry): CompanyCandidate {
  return entry.candidate;
}

function seedIdentityKey(seed: RankingSeed) {
  return `${normalizeIdentity(seed.listingPlace)}:${normalizeIdentity(seed.code)}`;
}

function seedRankingMatchKey(seed: RankingSeed) {
  return stockCodeIdentity(seed.code) || seedIdentityKey(seed);
}

function reportRankingMatchKey(report: InvestmentReport) {
  return stockCodeIdentity(report.company.ticker) || reportIdentityKey(report);
}

function libraryEntryIdentityKey(entry: ReportLibraryEntry) {
  const ticker = normalizeIdentity(entry.ticker);
  const market = normalizeIdentity(entry.market);
  const name = normalizeIdentity(entry.companyName);
  return ticker ? `${market}:${ticker}` : `${market}:${name}`;
}

function libraryEntryRankingMatchKey(entry: ReportLibraryEntry) {
  return stockCodeIdentity(entry.ticker) || libraryEntryIdentityKey(entry);
}

function seedToRankingEntry(seed: RankingSeed, seedOrder: number): RankingEntry {
  return {
    id: seedIdentityKey(seed),
    rank: 0,
    code: seed.code,
    name: seed.name,
    exchange: seed.exchange,
    listingPlace: seed.listingPlace,
    sector: seed.sector,
    industryGroup: seed.sector,
    cqs: 0,
    ias: 0,
    conclusion: "待导入",
    positionAdvice: "待导入深度报告",
    valuationView: "待验证",
    asOf: "种子列表",
    source: "seed",
    hasReport: false,
    seedOrder,
    candidate: seedToCandidate(seed),
  };
}

function reportToRankingEntry(report: InvestmentReport, seed?: RankingSeed, seedOrder = Number.MAX_SAFE_INTEGER, anchor?: ReportLibraryEntry): RankingEntry {
  const code = report.company.ticker || seed?.code || report.company.name;
  const listingPlace = report.company.market || seed?.listingPlace || "A股";
  const industry = localizedIndustry(code, listingPlace, anchor?.industry ?? report.company.industry, anchor?.sector ?? report.company.sector, seed?.sector);
  return {
    id: reportIdentityKey(report),
    rank: 0,
    code,
    name: localizedCompanyName(report.company.name || seed?.name || code, code, listingPlace),
    exchange: seed?.exchange || listingPlace,
    listingPlace,
    sector: formatLocalizedIndustry(industry),
    industryGroup: industry.group,
    cqs: anchor?.cqs ?? report.cqs,
    ias: report.ias,
    conclusion: report.conclusion,
    positionAdvice: report.summaryDashboard.positionAdvice || report.accountRules.maxPosition,
    valuationView: report.summaryDashboard.valuationView,
    asOf: report.asOf,
    source: "deep-report",
    hasReport: true,
    seedOrder,
    report,
    candidate: seed ? seedToCandidate(seed) : reportToCandidate(report),
  };
}

function libraryEntryToRankingEntry(entry: ReportLibraryEntry, seed?: RankingSeed, seedOrder = Number.MAX_SAFE_INTEGER, anchor?: ReportLibraryEntry): RankingEntry {
  const code = entry.ticker || seed?.code || entry.companyName;
  const listingPlace = seed?.listingPlace || entry.market || "A股";
  const industry = localizedIndustry(code, listingPlace, anchor?.industry ?? entry.industry, anchor?.sector ?? entry.sector, seed?.sector);
  const cqs = anchor?.cqs ?? entry.cqs;
  const conclusion = normalizeEntryConclusion(entry.conclusion, cqs, entry.ias);
  return {
    id: libraryEntryIdentityKey(entry),
    rank: 0,
    code,
    name: localizedCompanyName(entry.companyName || seed?.name || code, code, listingPlace),
    exchange: seed?.exchange || listingPlace,
    listingPlace,
    sector: formatLocalizedIndustry(industry),
    industryGroup: industry.group,
    cqs,
    ias: entry.ias,
    conclusion,
    positionAdvice: normalizeEntryPositionAdvice(conclusion, entry.positionAdvice, cqs, entry.ias),
    valuationView: entry.valuationView,
    asOf: entry.asOf,
    source: "deep-report",
    hasReport: true,
    seedOrder,
    libraryId: entry.id,
    candidate: seed ? seedToCandidate(seed) : libraryEntryToCandidate(entry),
  };
}

function anchorEntryForListing(ticker: unknown, market: unknown, anchorEntryByTicker: Map<string, ReportLibraryEntry>) {
  const anchor = crossMarketAnchorForListing(ticker, market);
  return anchor ? anchorEntryByTicker.get(normalizeIdentity(anchor.anchorTicker)) : undefined;
}

function seedToCandidate(seed: RankingSeed): CompanyCandidate {
  return {
    id: `ranking:${seed.listingPlace}:${seed.code}`,
    name: seed.name,
    code: seed.code,
    exchange: seed.exchange,
    listingPlace: seed.listingPlace,
    marketType: "AStock",
    source: "eastmoney",
  };
}

function reportToCandidate(report: InvestmentReport): CompanyCandidate {
  return {
    id: `imported:${report.company.market || "UNKNOWN"}:${report.company.ticker || report.company.name}`,
    name: report.company.name,
    code: report.company.ticker || report.company.name,
    exchange: report.company.market || "导入报告",
    listingPlace: report.company.market || "导入",
    marketType: "Imported",
    source: "eastmoney",
  };
}

function libraryEntryToCandidate(entry: ReportLibraryEntry): CompanyCandidate {
  return {
    id: `library:${entry.market || "UNKNOWN"}:${entry.ticker || entry.companyName}`,
    name: entry.companyName,
    code: entry.ticker || entry.companyName,
    exchange: entry.market || "报告库",
    listingPlace: entry.market || "报告库",
    marketType: "Library",
    source: "eastmoney",
  };
}

function sourcePriority(source: RankingSource) {
  return source === "deep-report" ? 1 : 0;
}

function dedupeShareClassRows(rows: RankingEntry[]) {
  const byCompany = new Map<string, RankingEntry>();
  for (const row of rows) {
    const key = shareClassCompanyKey(row);
    if (!byCompany.has(key)) byCompany.set(key, row);
  }
  return Array.from(byCompany.values());
}

const US_SHARE_CLASS_COMPANY_KEYS: Record<string, string> = {
  BRK_A: "US:BERKSHIRE_HATHAWAY",
  BRK_B: "US:BERKSHIRE_HATHAWAY",
  FOX: "US:FOX_CORPORATION",
  FOXA: "US:FOX_CORPORATION",
  GOOG: "US:ALPHABET",
  GOOGL: "US:ALPHABET",
  NWS: "US:NEWS_CORP",
  NWSA: "US:NEWS_CORP",
};

function shareClassCompanyKey(row: RankingEntry) {
  if (!isUsListing(row.listingPlace)) return row.id;
  const ticker = normalizeIdentity(row.code).replace(/[.-]/g, "_");
  return US_SHARE_CLASS_COMPANY_KEYS[ticker] || row.id;
}

function isUsListing(value: unknown) {
  const text = normalizeIdentity(value);
  return /美|US|USA|NASDAQ|NYSE|AMEX/.test(text);
}
