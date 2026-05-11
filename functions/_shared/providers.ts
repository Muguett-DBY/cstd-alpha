import type { CompanyCandidate, CompanyIdentity, EvidenceItem, FinancialTenYear } from "../../src/shared/report";
import { buildDrawdownSeries, normalizeChartBundle, type ChartBundle, type PriceMode, type PricePoint } from "../../src/shared/chart";

export type EvidenceBundle = {
  company: CompanyIdentity;
  retrievedAt: string;
  evidence: EvidenceItem[];
  facts: Record<string, unknown>;
};

export type NormalizedFinancialTenYear = FinancialTenYear & {
  latestPeriod?: string;
  latestUpdate?: string;
};

type FetchLike = typeof fetch;

type FetchEvidenceInput = {
  companyName: string;
  ticker?: string;
  market?: string;
  company?: CompanyCandidate;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
};

type FetchChartInput = {
  company: CompanyCandidate;
  priceMode: PriceMode;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
};

type SecFactEntry = {
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  end?: string;
  val?: number;
  frame?: string;
};

type SecFilingSummary = {
  form?: string;
  fiscalYear?: number;
  fiscalPeriod?: string;
  end?: string;
  filed?: string;
};

type SecCompanyData = {
  cik: string;
  title: string;
  companyFactsUrl: string;
  companyFacts: unknown;
  latestAnnual?: SecFilingSummary;
  latestQuarter?: SecFilingSummary;
  normalizedFinancialTenYear: NormalizedFinancialTenYear;
  summaryFinancialData?: Record<string, unknown>;
};

const SEC_TICKER_OVERRIDES: Record<string, { cik_str: number; ticker: string; title: string }> = {
  AAPL: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
  MSFT: { cik_str: 789019, ticker: "MSFT", title: "Microsoft Corporation" },
};

export async function fetchPublicCompanyEvidence({
  companyName,
  ticker,
  market,
  company,
  fetchImpl = fetch,
  signal,
}: FetchEvidenceInput): Promise<EvidenceBundle> {
  fetchImpl = withAbortSignal(fetchImpl, signal);
  const retrievedAt = new Date().toISOString();
  const selectedCompany = company;
  const searchQuote = selectedCompany ? undefined : await searchYahooQuote(ticker || companyName, fetchImpl);
  const symbol = selectedCompany?.yahooSymbol || selectedCompany?.code || ticker || stringValue(searchQuote?.symbol);
  const isUsSelected = selectedCompany ? isUsListedCompany(selectedCompany) : false;
  const isHkSelected = selectedCompany ? isHongKongListedCompany(selectedCompany) : false;

  if (!symbol) {
    return unavailableBundle(companyName, market, retrievedAt, "Could not resolve a public market ticker.");
  }

  const quoteUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  const summaryUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
    symbol,
  )}?modules=assetProfile,summaryDetail,financialData,defaultKeyStatistics,price,calendarEvents,earnings`;
  const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const fundamentalsUrl = buildFundamentalsUrl(symbol);
  const stooqQuoteUrl = isUsSelected ? stooqQuoteUrlForSymbol(symbol) : "";
  const secucode = selectedCompany ? eastmoneySecucode(selectedCompany) : undefined;
  const incomeUrl = secucode ? eastmoneyFinanceUrl("RPT_F10_FINANCE_GINCOME", "APP_F10_GINCOME", secucode) : "";
  const cashflowUrl = secucode ? eastmoneyFinanceUrl("RPT_F10_FINANCE_GCASHFLOW", "APP_F10_GCASHFLOW", secucode) : "";
  const balanceUrl = secucode ? eastmoneyFinanceUrl("RPT_F10_FINANCE_GBALANCE", "F10_FINANCE_GBALANCE", secucode) : "";

  const eastmoneyQuoteResult = selectedCompany ? await fetchEastmoneyQuote(selectedCompany, fetchImpl) : { url: "", quote: undefined };
  const eastmoneyQuoteUrl = eastmoneyQuoteResult.url;
  const eastmoneyQuote = eastmoneyQuoteResult.quote;
  const incomeJson = incomeUrl ? await fetchJson(incomeUrl, fetchImpl) : null;
  const cashflowJson = cashflowUrl ? await fetchJson(cashflowUrl, fetchImpl) : null;
  const balanceJson = balanceUrl ? await fetchJson(balanceUrl, fetchImpl) : null;
  const incomeRows = arrayPath(incomeJson, ["result", "data"]);
  const cashflowRows = arrayPath(cashflowJson, ["result", "data"]);
  const balanceRows = arrayPath(balanceJson, ["result", "data"]);
  const eastmoneyFinancialTenYear = buildFinancialTenYearFromEastmoney(incomeRows, cashflowRows, balanceRows);
  const secData = isUsSelected ? await fetchSecCompanyData(symbol, fetchImpl) : undefined;

  const shouldFetchYahoo = !selectedCompany || selectedCompany.source !== "eastmoney" || isUsSelected || isHkSelected;
  const quoteJson = shouldFetchYahoo ? await fetchJson(quoteUrl, fetchImpl) : null;
  const quote = firstArrayItem(recordPath(quoteJson, ["quoteResponse", "result"]));
  const summaryJson = shouldFetchYahoo ? await fetchJson(summaryUrl, fetchImpl) : null;
  const summary = firstArrayItem(recordPath(summaryJson, ["quoteSummary", "result"]));
  const chartJson = shouldFetchYahoo ? await fetchJson(chartUrl, fetchImpl) : null;
  const chart = firstArrayItem(recordPath(chartJson, ["chart", "result"]));
  const chartMeta = isRecord(chart?.meta) ? chart.meta : undefined;
  const fundamentalsJson = shouldFetchYahoo ? await fetchJson(fundamentalsUrl, fetchImpl) : null;
  const fundamentals = Array.isArray(recordPath(fundamentalsJson, ["timeseries", "result"]))
    ? (recordPath(fundamentalsJson, ["timeseries", "result"]) as unknown[])
    : undefined;
  const stooqQuote = isUsSelected && !eastmoneyQuote && !quote && !chartMeta ? await fetchStooqQuote(stooqQuoteUrl, symbol, fetchImpl) : undefined;

  const hasEastmoneyFinancials = incomeRows.length > 0 || cashflowRows.length > 0 || balanceRows.length > 0;
  const providerFinancialData = normalizeFundamentals(fundamentals) ?? secData?.summaryFinancialData;
  const yahooFinancialTenYear = buildFinancialTenYearFromYahooFundamentals(providerFinancialData, isHkSelected ? "港元" : undefined);
  const financialTenYear = eastmoneyFinancialTenYear.rows.length
    ? eastmoneyFinancialTenYear
    : secData?.normalizedFinancialTenYear.rows.length
      ? secData.normalizedFinancialTenYear
      : yahooFinancialTenYear.rows.length
        ? yahooFinancialTenYear
        : eastmoneyFinancialTenYear;
  const hasPublicFinancials = hasEastmoneyFinancials || Boolean(secData?.normalizedFinancialTenYear.rows.length) || yahooFinancialTenYear.rows.length > 0;

  if (!quote && !summary && !chartMeta && !searchQuote && !fundamentals && !eastmoneyQuote && !hasPublicFinancials) {
    return unavailableBundle(companyName, market, retrievedAt, "Public financial endpoints returned no usable data.");
  }

  const profile = isRecord(summary?.assetProfile) ? summary.assetProfile : undefined;
  const price = isRecord(summary?.price) ? summary.price : undefined;
  const mergedQuote = {
    ...(eastmoneyQuote ? normalizeEastmoneyQuote(eastmoneyQuote, selectedCompany) : {}),
    ...(searchQuote ?? {}),
    ...(stooqQuote ?? {}),
    ...(chartMeta ?? {}),
    ...(quote ?? {}),
  };
  const inferredTrailingPe = inferTrailingPe(mergedQuote.regularMarketPrice, providerFinancialData?.trailingDilutedEPS);
  if (inferredTrailingPe !== undefined && mergedQuote.trailingPE === undefined) mergedQuote.trailingPE = inferredTrailingPe;
  const name =
    selectedCompany?.name ||
    stringValue(quote?.longName) ||
    stringValue(price?.longName) ||
    stringValue(chartMeta?.longName) ||
    stringValue(searchQuote?.longname) ||
    stringValue(searchQuote?.shortname) ||
    companyName;

  return {
    company: {
      name,
      ticker: selectedCompany?.code || stringValue(quote?.symbol) || stringValue(chartMeta?.symbol) || stringValue(searchQuote?.symbol) || symbol,
      market:
        selectedCompany?.listingPlace ||
        stringValue(quote?.market) ||
        stringValue(searchQuote?.exchDisp) ||
        stringValue(chartMeta?.exchangeName) ||
        market,
      industry: stringValue(profile?.industry) || stringValue(searchQuote?.industry) || stringValue(searchQuote?.industryDisp),
      sector: selectedCompany?.marketType || stringValue(profile?.sector) || stringValue(searchQuote?.sector) || stringValue(searchQuote?.sectorDisp),
    },
    retrievedAt,
    evidence: [
      {
        title: `${symbol} symbol search`,
        source: selectedCompany ? "Eastmoney public suggest endpoint" : "Yahoo Finance public search endpoint",
        url: selectedCompany
          ? `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(companyName)}&type=14&count=5`
          : `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker || companyName)}&quotesCount=1&newsCount=0`,
        retrievedAt,
        freshness: selectedCompany || searchQuote ? "latest-public" : "unavailable",
        notes: selectedCompany || searchQuote ? "Public company identity, exchange, sector and industry match." : "Search endpoint returned no data.",
      },
      {
        title: `${symbol} Eastmoney quote snapshot`,
        source: "Eastmoney public quote endpoint",
        url: eastmoneyQuoteUrl,
        retrievedAt,
        freshness: eastmoneyQuote ? "latest-public" : "unavailable",
        notes: eastmoneyQuote ? "Latest public market price, volume, market cap and valuation snapshot." : "Eastmoney quote unavailable.",
      },
      {
        title: `${symbol} Eastmoney financial statements`,
        source: "Eastmoney public financial statement endpoints",
        url: incomeUrl || cashflowUrl || balanceUrl,
        retrievedAt,
        freshness: hasEastmoneyFinancials ? "latest-public" : "unavailable",
        notes: hasEastmoneyFinancials
          ? `Normalized ${eastmoneyFinancialTenYear.rows.length} named financial metrics from Eastmoney statements. Latest period: ${eastmoneyFinancialTenYear.latestPeriod ?? "unknown"}.`
          : selectedCompany && isUsSelected
            ? "Eastmoney does not expose usable US financial statements here; SEC fallback was attempted."
            : "Income statement, cash flow statement and balance sheet rows where available.",
      },
      ...(isUsSelected
        ? [
            {
              title: `${symbol} SEC company facts`,
              source: "SEC EDGAR companyfacts endpoint",
              url: secData?.companyFactsUrl || "https://www.sec.gov/files/company_tickers.json",
              retrievedAt,
              freshness: secData?.normalizedFinancialTenYear.rows.length ? "latest-public" : "unavailable",
              notes: secData
                ? `SEC CIK ${secData.cik}; normalized ${secData.normalizedFinancialTenYear.rows.length} USD financial metrics. Latest annual filing: ${secData.latestAnnual?.form ?? "unknown"} ${secData.latestAnnual?.fiscalYear ?? ""}.`
                : "SEC ticker mapping or companyfacts endpoint returned no usable data.",
            } satisfies EvidenceItem,
          ]
        : []),
      ...(isAppleSymbol(symbol) && isUsSelected
        ? [
            {
              title: "Apple latest official financial statements",
              source: "Apple Investor Relations",
              url: "https://www.apple.com/newsroom/pdfs/fy2026q2/FY26_Q2_Consolidated_Financial_Statements.pdf",
              retrievedAt,
              freshness: "latest-public",
              notes: "Apple official consolidated financial statements are available as supplemental public evidence for AAPL.",
            } satisfies EvidenceItem,
          ]
        : []),
      {
        title: `${symbol} latest quote`,
        source: "Yahoo Finance public quote endpoint",
        url: quoteUrl,
        retrievedAt,
        freshness: quote ? "latest-public" : "unavailable",
        notes: quote ? "Latest public quote snapshot returned by Yahoo Finance." : "Quote endpoint returned no data.",
      },
      {
        title: `${symbol} company summary`,
        source: "Yahoo Finance public quoteSummary endpoint",
        url: summaryUrl,
        retrievedAt,
        freshness: summary ? "latest-public" : "unavailable",
        notes: summary ? "Public profile, financialData, summaryDetail and key statistics modules." : "Summary unavailable.",
      },
      {
        title: `${symbol} price chart snapshot`,
        source: "Yahoo Finance public chart endpoint",
        url: chartUrl,
        retrievedAt,
        freshness: chartMeta ? "latest-public" : "unavailable",
        notes: chartMeta ? "Latest market price, volume, exchange, and 52-week range metadata." : "Chart endpoint returned no data.",
      },
      {
        title: `${symbol} public fundamentals time series`,
        source: "Yahoo Finance public fundamentals-timeseries endpoint",
        url: fundamentalsUrl,
        retrievedAt,
        freshness: fundamentals ? "latest-public" : "unavailable",
        notes: fundamentals ? "Trailing and quarterly public financial statement metrics." : "Fundamentals time series unavailable.",
      },
      ...(isUsSelected
        ? [
            {
              title: `${symbol} Stooq quote fallback`,
              source: "Stooq public quote CSV endpoint",
              url: stooqQuoteUrl,
              retrievedAt,
              freshness: stooqQuote ? "latest-public" : "unavailable",
              notes: stooqQuote ? "No-key fallback quote snapshot for US-listed stocks." : "Stooq quote fallback returned no data.",
            } satisfies EvidenceItem,
          ]
        : []),
    ],
    facts: {
      quote: Object.keys(mergedQuote).length ? mergedQuote : undefined,
      summary:
        summary ??
        ({
          assetProfile: pickDefined({
            industry: stringValue(searchQuote?.industry) || stringValue(searchQuote?.industryDisp),
            sector: stringValue(searchQuote?.sector) || stringValue(searchQuote?.sectorDisp),
          }),
          price: chartMeta,
          financialData: providerFinancialData,
        } satisfies Record<string, unknown>),
      selectedCompany,
      eastmoney: {
        quote: eastmoneyQuote,
        incomeRows,
        cashflowRows,
        balanceRows,
      },
      sec: secData
        ? {
            cik: secData.cik,
            title: secData.title,
            companyFacts: summarizeSecCompanyFacts(secData.companyFacts, secData.companyFactsUrl),
            latestAnnual: secData.latestAnnual,
            latestQuarter: secData.latestQuarter,
            normalizedFinancialTenYear: secData.normalizedFinancialTenYear,
            summaryFinancialData: secData.summaryFinancialData,
          }
        : undefined,
      financialTenYear: financialTenYear.rows.length ? financialTenYear : undefined,
      search: searchQuote ?? undefined,
      chart: chart ?? undefined,
      fundamentals: providerFinancialData,
    },
  };
}

export function buildFinancialTenYearFromEastmoney(incomeRows: unknown[], cashflowRows: unknown[], balanceRows: unknown[]): NormalizedFinancialTenYear {
  const incomeAnnual = annualRows(incomeRows);
  const cashflowAnnual = annualRows(cashflowRows);
  const balanceAnnual = annualRows(balanceRows);
  const years = Array.from(new Set([...incomeAnnual.keys(), ...cashflowAnnual.keys(), ...balanceAnnual.keys()]))
    .sort()
    .slice(-10);
  const latest = latestStatementRow([...incomeRows, ...cashflowRows, ...balanceRows]);
  const metricSpecs: Array<{
    metric: string;
    kind: "amount" | "ratio";
    value: (year: string) => number | undefined;
    interpretation: string;
  }> = [
    {
      metric: "营业收入",
      kind: "amount",
      value: (year) => statementNumber(incomeAnnual.get(year), ["TOTAL_OPERATE_INCOME", "OPERATE_INCOME"]),
      interpretation: "观察收入规模和增长中枢，判断行业需求、份额和提价是否仍在兑现。",
    },
    {
      metric: "归母净利润",
      kind: "amount",
      value: (year) => statementNumber(incomeAnnual.get(year), ["PARENT_NETPROFIT", "NETPROFIT"]),
      interpretation: "观察归属普通股东的盈利能力，避免只看收入增长而忽略利润含金量。",
    },
    {
      metric: "扣非归母净利润",
      kind: "amount",
      value: (year) => statementNumber(incomeAnnual.get(year), ["DEDUCT_PARENT_NETPROFIT"]),
      interpretation: "剔除非经常性损益后检验主业盈利质量。",
    },
    {
      metric: "经营现金流",
      kind: "amount",
      value: (year) => statementNumber(cashflowAnnual.get(year), ["NETCASH_OPERATE"]),
      interpretation: "检验利润是否真正转化为经营现金流，是财务质量评分的核心证据。",
    },
    {
      metric: "货币资金",
      kind: "amount",
      value: (year) => statementNumber(balanceAnnual.get(year), ["MONETARYFUNDS", "CURRENCY_FUNDS"]) ?? statementNumber(cashflowAnnual.get(year), ["END_CCE"]),
      interpretation: "观察现金储备和流动性安全垫。",
    },
    {
      metric: "总资产",
      kind: "amount",
      value: (year) => statementNumber(balanceAnnual.get(year), ["TOTAL_ASSETS", "ASSET_BALANCE"]),
      interpretation: "观察资产规模扩张是否与收入和利润增长匹配。",
    },
    {
      metric: "总负债",
      kind: "amount",
      value: (year) => statementNumber(balanceAnnual.get(year), ["TOTAL_LIABILITIES", "LIAB_BALANCE"]),
      interpretation: "观察杠杆扩张和偿债压力。",
    },
    {
      metric: "资产负债率",
      kind: "ratio",
      value: (year) => ratio(statementNumber(balanceAnnual.get(year), ["TOTAL_LIABILITIES", "LIAB_BALANCE"]), statementNumber(balanceAnnual.get(year), ["TOTAL_ASSETS", "ASSET_BALANCE"])),
      interpretation: "负债率用于判断财务安全边际，持续上升需降低财务质量评分。",
    },
    {
      metric: "毛利率",
      kind: "ratio",
      value: (year) => {
        const row = incomeAnnual.get(year);
        const revenue = statementNumber(row, ["TOTAL_OPERATE_INCOME", "OPERATE_INCOME"]);
        const cost = statementNumber(row, ["OPERATE_COST", "TOTAL_OPERATE_COST"]);
        return revenue !== undefined && cost !== undefined ? ratio(revenue - cost, revenue) : undefined;
      },
      interpretation: "毛利率反映定价权和成本压力，是商业模式质量的重要证据。",
    },
    {
      metric: "净利率",
      kind: "ratio",
      value: (year) => ratio(statementNumber(incomeAnnual.get(year), ["PARENT_NETPROFIT", "NETPROFIT"]), statementNumber(incomeAnnual.get(year), ["TOTAL_OPERATE_INCOME", "OPERATE_INCOME"])),
      interpretation: "净利率反映最终盈利留存能力，持续下滑会拖累公司质量评分。",
    },
  ];

  const rows = metricSpecs
    .map((spec) => {
      const numericValues = years
        .map((year) => ({ year, value: spec.value(year) }))
        .filter((item): item is { year: string; value: number } => item.value !== undefined);
      if (!numericValues.length) return undefined;
      return {
        metric: spec.metric,
        values: Object.fromEntries(numericValues.map((item) => [item.year, spec.kind === "ratio" ? formatRatio(item.value) : formatAmount(item.value)])),
        trend: trendText(numericValues.map((item) => item.value), spec.kind),
        interpretation: spec.interpretation,
      };
    })
    .filter((row): row is FinancialTenYear["rows"][number] => Boolean(row));

  return {
    rows,
    interpretation: rows.length
      ? `已从东方财富公开财务报表整理 ${years.length} 个年度的具名财务指标；最新可见期间为 ${latest?.period ?? "待验证"}。`
      : "公开接口未返回可直接整理为十年表的年度财务数据。",
    latestPeriod: latest?.period,
    latestUpdate: latest?.update,
  };
}

export function buildFinancialTenYearFromSecFacts(companyFacts: unknown): NormalizedFinancialTenYear {
  const usGaap = secUsGaapFacts(companyFacts);
  if (!usGaap) {
    return {
      rows: [],
      interpretation: "SEC EDGAR 未返回可整理为十年表的 us-gaap 财务数据。",
    };
  }

  const revenue = secAnnualValueMap(usGaap, ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues"], ["USD"]);
  const netIncome = secAnnualValueMap(usGaap, ["NetIncomeLoss"], ["USD"]);
  const operatingCashFlow = secAnnualValueMap(usGaap, ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"], ["USD"]);
  const assets = secAnnualValueMap(usGaap, ["Assets"], ["USD"]);
  const liabilities = secAnnualValueMap(usGaap, ["Liabilities"], ["USD"]);
  const equity = secAnnualValueMap(usGaap, ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"], ["USD"]);
  const dilutedEps = secAnnualValueMap(usGaap, ["EarningsPerShareDiluted"], ["USD/shares", "USD/shares"]);
  const buybacks = secAnnualValueMap(usGaap, ["PaymentsForRepurchaseOfCommonStock", "PaymentsForRepurchaseOfCommonStocks", "RepurchasesOfCommonStock"], ["USD"]);
  const dividends = secAnnualValueMap(usGaap, ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"], ["USD"]);
  const metricMaps = [revenue, netIncome, operatingCashFlow, assets, liabilities, equity, dilutedEps, buybacks, dividends];
  const years = Array.from(new Set(metricMaps.flatMap((map) => Array.from(map.keys()))))
    .sort()
    .slice(-10);

  const rows = [
    secMetricRow("营业收入", years, revenue, "usd", "用 SEC 年报收入数据观察业务规模、增长中枢和需求韧性。"),
    secMetricRow("净利润", years, netIncome, "usd", "用 SEC 年报净利润数据观察最终盈利能力和利润趋势。"),
    secMetricRow("经营现金流", years, operatingCashFlow, "usd", "检验利润是否转换为真实经营现金流，是财务质量和回购能力的重要依据。"),
    secMetricRow("总资产", years, assets, "usd", "观察资产规模和资产结构变化，配合负债与权益判断财务安全垫。"),
    secMetricRow("总负债", years, liabilities, "usd", "观察杠杆和偿债压力，避免只看利润而忽略资产负债表风险。"),
    secMetricRow("股东权益", years, equity, "usd", "观察净资产基础和回购后权益变化，辅助判断资本配置强度。"),
    secDerivedMetricRow("资产负债率", years, liabilities, assets, "ratio", "用总负债除以总资产衡量财务杠杆；持续偏高需降低财务健康评分。"),
    secDerivedMetricRow("净利率", years, netIncome, revenue, "ratio", "用净利润除以收入衡量最终利润留存能力，反映品牌、成本与费用控制。"),
    secMetricRow("摊薄每股收益", years, dilutedEps, "perShare", "用于结合当前股价推导市盈率，避免把行情源 PE=0 误判为真实估值。"),
    secMetricRow("分红现金支出", years, dividends, "usd", "观察现金分红力度和股东回报的稳定性。"),
    secMetricRow("股票回购支出", years, buybacks, "usd", "观察回购规模和资本配置强度，是美股股东回报分析的核心证据。"),
  ].filter((row): row is FinancialTenYear["rows"][number] => Boolean(row));

  const latestAnnual = latestSecFilingSummary(companyFacts, "annual");
  return {
    rows,
    interpretation: rows.length
      ? `已从 SEC EDGAR Company Facts 整理 ${years.length} 个 fiscal year 的美元口径具名财务指标；最新年报为 ${latestAnnual?.fiscalYear ? `FY${latestAnnual.fiscalYear}` : "待验证"}。`
      : "SEC EDGAR 未返回可整理为十年表的年度财务数据。",
    latestPeriod: latestAnnual?.fiscalYear ? `FY${latestAnnual.fiscalYear} ${latestAnnual.form ?? "SEC"}` : undefined,
    latestUpdate: latestAnnual?.filed,
  };
}

export async function fetchChartBundle({ company, priceMode, fetchImpl = fetch, signal }: FetchChartInput): Promise<ChartBundle> {
  fetchImpl = withAbortSignal(fetchImpl, signal);
  const asOf = new Date().toISOString();
  const useEastmoney = Boolean(company.quoteId && (company.listingPlace.includes("A") || company.listingPlace.includes("港") || company.quoteId.startsWith("0.") || company.quoteId.startsWith("1.") || company.quoteId.startsWith("116.")));
  let url = useEastmoney ? eastmoneyKlineUrl(company.quoteId || company.secid || company.code, priceMode) : yahooTenYearChartUrl(company.yahooSymbol || company.code);
  let sourceName = useEastmoney ? "Eastmoney" : "Yahoo Finance";
  let json = await fetchJson(url, fetchImpl);
  let priceSeries = useEastmoney ? normalizeEastmoneyKlines(json, priceMode) : normalizeYahooChart(json, priceMode);

  if (useEastmoney && priceSeries.length === 0 && company.yahooSymbol) {
    url = yahooTenYearChartUrl(company.yahooSymbol);
    sourceName = "Yahoo Finance fallback";
    json = await fetchJson(url, fetchImpl);
    priceSeries = normalizeYahooChart(json, priceMode);
  }

  const drawdownSeries = buildDrawdownSeries(priceSeries);
  const latest = priceSeries.at(-1);
  const meta = isRecord(firstArrayItem(recordPath(json, ["chart", "result"]))?.meta)
    ? (firstArrayItem(recordPath(json, ["chart", "result"]))?.meta as Record<string, unknown>)
    : undefined;

  return normalizeChartBundle({
    company: {
      name: company.name,
      ticker: company.code,
      market: company.listingPlace,
      sector: company.marketType,
    },
    asOf,
    priceMode,
    priceSeries,
    drawdownSeries,
    marketSnapshot: {
      currentPrice: latest?.close,
      latestDate: latest?.date,
      currency: stringValue(meta?.currency),
      exchangeName: company.exchange || stringValue(meta?.exchangeName),
      source: sourceName,
    },
    evidence: [
      {
        title: `${company.code} 十年股价数据`,
        source: sourceName === "Eastmoney" ? "Eastmoney public kline endpoint" : `${sourceName} public chart endpoint`,
        url,
        retrievedAt: asOf,
        freshness: priceSeries.length ? "latest-public" : "unavailable",
        notes: priceSeries.length
          ? `${priceMode === "adjusted" ? "前复权/调整价" : "原始收盘价"}口径，返回 ${priceSeries.length} 个价格点。`
          : "公开历史价格接口未返回可用数据。",
      },
    ],
  });
}

export async function searchCompanyCandidates(query: string, fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<CompanyCandidate[]> {
  fetchImpl = withAbortSignal(fetchImpl, signal);
  const trimmed = query.trim();
  if (!trimmed) return [];

  const eastmoneyUrl = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(
    trimmed,
  )}&type=14&token=D43BF722C8E33BD61D078A2FA2B7E485&count=8`;
  const eastmoneyJson = await fetchJson(eastmoneyUrl, fetchImpl);
  const eastmoneyCandidates = arrayPath(eastmoneyJson, ["QuotationCodeTable", "Data"])
    .map(normalizeEastmoneyCandidate)
    .filter((item): item is CompanyCandidate => Boolean(item));

  if (eastmoneyCandidates.length > 0) return dedupeCandidates(eastmoneyCandidates);

  const yahooJson = await fetchJson(
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(trimmed)}&quotesCount=8&newsCount=0`,
    fetchImpl,
  );
  const yahooCandidates = arrayPath(yahooJson, ["quotes"])
    .map(normalizeYahooCandidate)
    .filter((item): item is CompanyCandidate => Boolean(item));

  return dedupeCandidates(yahooCandidates);
}

async function searchYahooQuote(companyName: string, fetchImpl: FetchLike) {
  const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
    companyName,
  )}&quotesCount=1&newsCount=0`;
  const json = await fetchJson(searchUrl, fetchImpl);
  return firstArrayItem(recordPath(json, ["quotes"]));
}

async function fetchSecCompanyData(symbol: string, fetchImpl: FetchLike): Promise<SecCompanyData | undefined> {
  const tickerMapUrl = "https://www.sec.gov/files/company_tickers.json";
  const tickerMap = await fetchJson(tickerMapUrl, fetchImpl);
  const entry = findSecTickerEntry(tickerMap, symbol);
  if (!entry) return undefined;

  const cik = String(entry.cik_str).padStart(10, "0");
  const companyFactsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  const companyFacts = await fetchJson(companyFactsUrl, fetchImpl);
  if (!companyFacts) return undefined;

  const normalizedFinancialTenYear = buildFinancialTenYearFromSecFacts(companyFacts);
  const summaryFinancialData = buildSecSummaryFinancialData(companyFacts);
  return {
    cik,
    title: entry.title,
    companyFactsUrl,
    companyFacts,
    latestAnnual: latestSecFilingSummary(companyFacts, "annual"),
    latestQuarter: latestSecFilingSummary(companyFacts, "quarter"),
    normalizedFinancialTenYear,
    summaryFinancialData,
  };
}

function findSecTickerEntry(value: unknown, symbol: string) {
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (!isRecord(value)) return SEC_TICKER_OVERRIDES[normalizedSymbol];
  for (const item of Object.values(value)) {
    if (!isRecord(item)) continue;
    const ticker = stringValue(item.ticker)?.toUpperCase();
    const cik = numberValue(item.cik_str);
    const title = stringValue(item.title);
    if (ticker === normalizedSymbol && cik !== undefined && title) return { cik_str: cik, ticker, title };
  }
  return SEC_TICKER_OVERRIDES[normalizedSymbol];
}

function buildFundamentalsUrl(symbol: string) {
  const now = Math.floor(Date.now() / 1000);
  const fiveYearsAgo = now - 60 * 60 * 24 * 365 * 5;
  const types = [
    "trailingTotalRevenue",
    "trailingNetIncome",
    "trailingOperatingIncome",
    "trailingGrossProfit",
    "trailingOperatingCashFlow",
    "trailingFreeCashFlow",
    "trailingDilutedEPS",
    "quarterlyTotalAssets",
    "quarterlyTotalDebt",
    "quarterlyStockholdersEquity",
  ];
  return `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(
    symbol,
  )}?type=${types.join(",")}&merge=false&period1=${fiveYearsAgo}&period2=${now}`;
}

function eastmoneyKlineUrl(secid: string, priceMode: PriceMode) {
  const now = new Date();
  const begin = `${now.getUTCFullYear() - 10}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
  const fqt = priceMode === "adjusted" ? "1" : "0";
  return `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(
    secid,
  )}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=${fqt}&beg=${begin}&end=20500101`;
}

function yahooTenYearChartUrl(symbol: string) {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1mo&events=history&includeAdjustedClose=true`;
}

function stooqQuoteUrlForSymbol(symbol: string) {
  const base = symbol.split(".")[0]?.replace("-", ".").toLowerCase() || symbol.toLowerCase();
  return `https://stooq.com/q/l/?s=${encodeURIComponent(`${base}.us`)}&f=sd2t2ohlcv&h&e=csv`;
}

function eastmoneyFinanceUrl(type: string, style: string, secucode: string) {
  return `https://datacenter.eastmoney.com/securities/api/data/get?type=${type}&sty=${style}&filter=(SECUCODE%3D%22${encodeURIComponent(
    secucode,
  )}%22)&p=1&ps=60&sr=-1&st=REPORT_DATE`;
}

function eastmoneySecucode(candidate: CompanyCandidate) {
  if (candidate.marketType === "AStock" || candidate.listingPlace.includes("A")) {
    const suffix = candidate.quoteId?.startsWith("1.") || candidate.listingPlace.includes("沪") ? "SH" : "SZ";
    return `${candidate.code}.${suffix}`;
  }
  if (candidate.marketType === "HK" || candidate.listingPlace.includes("港")) return `${candidate.code}.HK`;
  return undefined;
}

async function fetchEastmoneyQuote(candidate: CompanyCandidate, fetchImpl: FetchLike) {
  const urls = eastmoneyQuoteUrls(candidate);
  for (const url of urls) {
    const json = await fetchJson(url, fetchImpl);
    const quote = isRecord(recordPath(json, ["data"])) ? (recordPath(json, ["data"]) as Record<string, unknown>) : undefined;
    if (quote) return { url, quote };
  }
  return { url: urls[0] ?? "", quote: undefined };
}

function eastmoneyQuoteUrls(candidate: CompanyCandidate) {
  return uniqueStrings(eastmoneyQuoteIds(candidate).map(eastmoneyQuoteUrl));
}

function eastmoneyQuoteIds(candidate: CompanyCandidate) {
  return [candidate.quoteId, candidate.secid, derivedEastmoneyQuoteId(candidate)].filter((value): value is string => Boolean(value));
}

function derivedEastmoneyQuoteId(candidate: CompanyCandidate) {
  if (candidate.marketType === "AStock" || candidate.listingPlace.includes("A")) {
    const prefix = candidate.code.startsWith("6") || candidate.code.startsWith("9") || candidate.listingPlace.includes("沪") ? "1" : "0";
    return `${prefix}.${candidate.code}`;
  }
  if (candidate.marketType === "HK" || candidate.listingPlace.includes("港")) return `116.${candidate.code}`;
  if (candidate.listingPlace.includes("美")) return candidate.quoteId;
  return undefined;
}

function eastmoneyQuoteUrl(secid: string) {
  return `https://push2.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fields=f57,f58,f43,f44,f45,f46,f47,f48,f60,f116,f162,f167,f168,f169,f170`;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values));
}

function normalizeEastmoneyCandidate(value: unknown): CompanyCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const code = stringValue(value.Code);
  const name = stringValue(value.Name);
  if (!code || !name) return undefined;
  const listingPlace = stringValue(value.SecurityTypeName) || stringValue(value.JYS) || "未知市场";
  const quoteId = stringValue(value.QuoteID);
  return {
    id: `eastmoney:${quoteId || code}`,
    name,
    code,
    exchange: eastmoneyExchangeName(stringValue(value.JYS), quoteId, listingPlace),
    listingPlace,
    marketType: stringValue(value.Classify) || listingPlace,
    quoteId,
    secid: quoteId,
    yahooSymbol: eastmoneyYahooSymbol(code, listingPlace),
    source: "eastmoney",
  };
}

function eastmoneyExchangeName(rawExchange: string | undefined, quoteId: string | undefined, listingPlace: string) {
  if (listingPlace.includes("深") || quoteId?.startsWith("0.") || rawExchange === "0") return "深圳证券交易所";
  if (listingPlace.includes("沪") || quoteId?.startsWith("1.") || rawExchange === "1") return "上海证券交易所";
  if (listingPlace.includes("港") || quoteId?.startsWith("116.") || rawExchange === "116") return "香港交易所";
  if (listingPlace.includes("美")) return "美国市场";
  return rawExchange && !/^\d+$/.test(rawExchange) ? rawExchange : listingPlace;
}

function normalizeYahooCandidate(value: unknown): CompanyCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const code = stringValue(value.symbol);
  const name = stringValue(value.longname) || stringValue(value.shortname);
  if (!code || !name) return undefined;
  const exchange = stringValue(value.exchDisp) || stringValue(value.exchange) || "海外市场";
  return {
    id: `yahoo:${code}`,
    name,
    code,
    exchange,
    listingPlace: exchange,
    marketType: stringValue(value.quoteType) || stringValue(value.typeDisp) || "Equity",
    yahooSymbol: code,
    source: "yahoo",
  };
}

function eastmoneyYahooSymbol(code: string, listingPlace: string) {
  if (listingPlace.includes("深")) return `${code}.SZ`;
  if (listingPlace.includes("沪")) return `${code}.SS`;
  if (listingPlace.includes("港")) return `${code}.HK`;
  return code;
}

function isUsListedCompany(candidate: CompanyCandidate) {
  return Boolean(
    candidate.listingPlace.includes("美") ||
    candidate.marketType.toLowerCase().includes("us") ||
    candidate.exchange.toLowerCase().includes("nasdaq") ||
    candidate.exchange.toLowerCase().includes("nyse") ||
    candidate.quoteId?.startsWith("105.") ||
    candidate.quoteId?.startsWith("106.") ||
    candidate.quoteId?.startsWith("107.")
  );
}

function isHongKongListedCompany(candidate: CompanyCandidate) {
  return Boolean(candidate.listingPlace.includes("港") || candidate.marketType.toLowerCase() === "hk" || candidate.quoteId?.startsWith("116."));
}

function isAppleSymbol(symbol: string) {
  return symbol.trim().toUpperCase() === "AAPL";
}

function normalizeEastmoneyQuote(quote: Record<string, unknown>, company: CompanyCandidate | undefined) {
  const isUs = company ? isUsListedCompany(company) : false;
  const isHk = company ? isHongKongListedCompany(company) : false;
  const priceScale = isUs || isHk ? 1000 : 100;
  return pickDefined({
    symbol: stringValue(quote.f57),
    longName: stringValue(quote.f58),
    regularMarketPrice: eastmoneyPriceNumber(quote.f43, priceScale),
    regularMarketDayHigh: eastmoneyPriceNumber(quote.f44, priceScale),
    regularMarketDayLow: eastmoneyPriceNumber(quote.f45, priceScale),
    regularMarketOpen: eastmoneyPriceNumber(quote.f46, priceScale),
    regularMarketVolume: numberValue(quote.f47),
    regularMarketPreviousClose: eastmoneyPriceNumber(quote.f60, priceScale),
    marketCap: numberValue(quote.f116),
    trailingPE: eastmoneyRatioField(quote.f162, true),
    priceToBook: eastmoneyRatioField(quote.f167, true),
    regularMarketChange: eastmoneyPriceNumber(quote.f169, priceScale),
    regularMarketChangePercent: eastmoneyPercentNumber(quote.f170),
  });
}

function normalizeEastmoneyKlines(value: unknown, priceMode: PriceMode): PricePoint[] {
  const rows = arrayPath(value, ["data", "klines"]);
  return rows.reduce<PricePoint[]>((points, row) => {
      if (typeof row !== "string") return points;
      const [date, open, close, high, low, volume, amount, , changePercent] = row.split(",");
      const closeValue = numberFromString(close);
      if (!date || closeValue === undefined) return points;
      points.push({
        date,
        open: numberFromString(open),
        close: closeValue,
        adjustedClose: priceMode === "adjusted" ? closeValue : closeValue,
        rawClose: priceMode === "raw" ? closeValue : undefined,
        high: numberFromString(high),
        low: numberFromString(low),
        volume: numberFromString(volume) ?? 0,
        amount: numberFromString(amount),
        changePercent: numberFromString(changePercent),
      });
      return points;
    }, []);
}

function normalizeYahooChart(value: unknown, priceMode: PriceMode): PricePoint[] {
  const chart = firstArrayItem(recordPath(value, ["chart", "result"]));
  const timestamps = Array.isArray(chart?.timestamp) ? chart.timestamp : [];
  const quote = firstArrayItem(recordPath(chart, ["indicators", "quote"]));
  const adjusted = firstArrayItem(recordPath(chart, ["indicators", "adjclose"]));
  const closes = Array.isArray(quote?.close) ? quote.close : [];
  const adjustedCloses = Array.isArray(adjusted?.adjclose) ? adjusted.adjclose : [];
  const opens = Array.isArray(quote?.open) ? quote.open : [];
  const highs = Array.isArray(quote?.high) ? quote.high : [];
  const lows = Array.isArray(quote?.low) ? quote.low : [];
  const volumes = Array.isArray(quote?.volume) ? quote.volume : [];

  return timestamps.reduce<PricePoint[]>((points, timestamp, index) => {
      const rawClose = numberValue(closes[index]);
      const adjustedClose = numberValue(adjustedCloses[index]) ?? rawClose;
      const close = priceMode === "adjusted" ? adjustedClose : rawClose;
      if (typeof timestamp !== "number" || close === undefined) return points;
      points.push({
        date: new Date(timestamp * 1000).toISOString().slice(0, 10),
        open: numberValue(opens[index]),
        close,
        adjustedClose: adjustedClose ?? close,
        rawClose,
        high: numberValue(highs[index]),
        low: numberValue(lows[index]),
        volume: numberValue(volumes[index]) ?? 0,
      });
      return points;
    }, []);
}

function normalizeFundamentals(items: unknown[] | undefined) {
  if (!items) return undefined;
  const result: Record<string, unknown> = {};
  for (const item of items) {
    if (!isRecord(item) || !isRecord(item.meta) || !Array.isArray(item.meta.type)) continue;
    const type = item.meta.type.find(stringValue);
    if (!type) continue;
    result[type] = item[type];
  }
  return Object.keys(result).length ? result : undefined;
}

function buildFinancialTenYearFromYahooFundamentals(fundamentals: Record<string, unknown> | undefined, currencyUnit?: string): NormalizedFinancialTenYear {
  if (!fundamentals) return { rows: [], interpretation: "Yahoo fundamentals time series unavailable." };

  const revenue = yahooFundamentalValueMap(fundamentals.trailingTotalRevenue);
  const netIncome = yahooFundamentalValueMap(fundamentals.trailingNetIncome);
  const operatingIncome = yahooFundamentalValueMap(fundamentals.trailingOperatingIncome);
  const grossProfit = yahooFundamentalValueMap(fundamentals.trailingGrossProfit);
  const operatingCashFlow = yahooFundamentalValueMap(fundamentals.trailingOperatingCashFlow);
  const freeCashFlow = yahooFundamentalValueMap(fundamentals.trailingFreeCashFlow);
  const eps = yahooFundamentalValueMap(fundamentals.trailingDilutedEPS);
  const assets = yahooFundamentalValueMap(fundamentals.quarterlyTotalAssets);
  const debt = yahooFundamentalValueMap(fundamentals.quarterlyTotalDebt);
  const equity = yahooFundamentalValueMap(fundamentals.quarterlyStockholdersEquity);
  const years = Array.from(
    new Set([
      ...revenue.keys(),
      ...netIncome.keys(),
      ...operatingIncome.keys(),
      ...grossProfit.keys(),
      ...operatingCashFlow.keys(),
      ...freeCashFlow.keys(),
      ...eps.keys(),
      ...assets.keys(),
      ...debt.keys(),
      ...equity.keys(),
    ]),
  )
    .sort()
    .slice(-10);

  const rows = [
    yahooMetricRow("营业收入", years, revenue, "amount", currencyUnit, "Yahoo fundamentals trailing revenue time series."),
    yahooMetricRow("净利润", years, netIncome, "amount", currencyUnit, "Yahoo fundamentals trailing net income time series."),
    yahooMetricRow("经营利润", years, operatingIncome, "amount", currencyUnit, "Yahoo fundamentals trailing operating income time series."),
    yahooMetricRow("毛利润", years, grossProfit, "amount", currencyUnit, "Yahoo fundamentals trailing gross profit time series."),
    yahooMetricRow("经营现金流", years, operatingCashFlow, "amount", currencyUnit, "Yahoo fundamentals trailing operating cash flow time series."),
    yahooMetricRow("自由现金流", years, freeCashFlow, "amount", currencyUnit, "Yahoo fundamentals trailing free cash flow time series."),
    yahooMetricRow("摊薄每股收益", years, eps, "perShare", currencyUnit, "Yahoo fundamentals trailing diluted EPS time series."),
    yahooMetricRow("总资产", years, assets, "amount", currencyUnit, "Yahoo fundamentals quarterly total assets time series."),
    yahooMetricRow("总债务", years, debt, "amount", currencyUnit, "Yahoo fundamentals quarterly total debt time series."),
    yahooMetricRow("股东权益", years, equity, "amount", currencyUnit, "Yahoo fundamentals quarterly stockholders equity time series."),
    yahooDerivedMetricRow("净利率", years, netIncome, revenue, "用净利润除以收入衡量最终利润留存能力。"),
  ].filter((row): row is FinancialTenYear["rows"][number] => Boolean(row));

  return {
    rows,
    interpretation: rows.length ? "已基于 Yahoo fundamentals time series 归一化关键财务指标；港股需结合公司公告继续复核会计口径。" : "Yahoo fundamentals time series unavailable.",
    latestPeriod: years.at(-1),
  };
}

function yahooFundamentalValueMap(value: unknown) {
  const rows = Array.isArray(value) ? value.filter(isRecord) : [];
  const result = new Map<string, number>();
  for (const row of rows) {
    const year = stringValue(row.asOfDate)?.match(/^(\d{4})-/)?.[1];
    const raw = yahooRawNumber(row);
    if (!year || raw === undefined) continue;
    result.set(year, raw);
  }
  return result;
}

function yahooRawNumber(row: Record<string, unknown>) {
  const direct = numberValue(row.raw);
  if (direct !== undefined) return direct;
  const reportedValue = isRecord(row.reportedValue) ? row.reportedValue : undefined;
  return numberValue(reportedValue?.raw) ?? numberFromString(String(reportedValue?.fmt ?? row.fmt ?? ""));
}

function yahooMetricRow(
  metric: string,
  years: string[],
  values: Map<string, number>,
  kind: "amount" | "perShare" | "ratio",
  currencyUnit: string | undefined,
  interpretation: string,
) {
  const numericValues = years
    .map((year) => ({ year, value: values.get(year) }))
    .filter((item): item is { year: string; value: number } => item.value !== undefined);
  if (!numericValues.length) return undefined;
  return {
    metric,
    values: Object.fromEntries(
      numericValues.map((item) => [
        item.year,
        kind === "amount" ? formatAmountWithUnit(item.value, currencyUnit) : kind === "ratio" ? formatRatio(item.value) : formatPerShare(item.value, currencyUnit),
      ]),
    ),
    trend: trendText(numericValues.map((item) => item.value), kind === "ratio" ? "ratio" : "amount"),
    interpretation,
  };
}

function yahooDerivedMetricRow(metric: string, years: string[], numerator: Map<string, number>, denominator: Map<string, number>, interpretation: string) {
  const values = new Map<string, number>();
  for (const year of years) {
    const value = ratio(numerator.get(year), denominator.get(year));
    if (value !== undefined) values.set(year, value);
  }
  return yahooMetricRow(metric, years, values, "ratio", undefined, interpretation);
}

function normalizeStooqQuote(text: string | undefined, symbol: string) {
  if (!text) return undefined;
  const [headerLine, valueLine] = text.trim().split(/\r?\n/);
  if (!headerLine || !valueLine) return undefined;
  const headers = headerLine.split(",").map((item) => item.trim());
  const values = valueLine.split(",").map((item) => item.trim());
  const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  const close = numberFromString(row.Close);
  if (close === undefined) return undefined;
  return pickDefined({
    symbol,
    currency: "USD",
    regularMarketPrice: close,
    regularMarketOpen: numberFromString(row.Open),
    regularMarketDayHigh: numberFromString(row.High),
    regularMarketDayLow: numberFromString(row.Low),
    regularMarketVolume: numberFromString(row.Volume),
    regularMarketTime: row.Date && row.Time ? `${row.Date} ${row.Time}` : row.Date,
    quoteSourceName: "Stooq",
  });
}

function annualRows(rows: unknown[]) {
  const annual = new Map<string, Record<string, unknown>>();
  for (const item of rows) {
    if (!isRecord(item)) continue;
    const year = statementYear(item);
    if (!year || !isAnnualStatement(item)) continue;
    annual.set(year, item);
  }
  return annual;
}

function statementYear(row: Record<string, unknown>) {
  const rawDate = stringValue(row.REPORT_DATE);
  const match = rawDate?.match(/^(\d{4})-/) ?? stringValue(row.REPORT_DATE_NAME)?.match(/^(\d{4})/);
  return match?.[1];
}

function isAnnualStatement(row: Record<string, unknown>) {
  const name = stringValue(row.REPORT_DATE_NAME) ?? "";
  const date = stringValue(row.REPORT_DATE) ?? "";
  return name.includes("年报") || date.includes("-12-31");
}

function latestStatementRow(rows: unknown[]) {
  const sorted = rows
    .filter(isRecord)
    .map((row) => {
      const period = stringValue(row.REPORT_DATE_NAME) ?? stringValue(row.REPORT_DATE);
      const date = stringValue(row.REPORT_DATE);
      const update = stringValue(row.UPDATE_DATE) ?? stringValue(row.NOTICE_DATE);
      return period && date ? { period, date, update } : undefined;
    })
    .filter((item): item is { period: string; date: string; update: string | undefined } => Boolean(item))
    .sort((a, b) => a.date.localeCompare(b.date));
  return sorted.at(-1);
}

function secUsGaapFacts(companyFacts: unknown): Record<string, unknown> | undefined {
  const facts = isRecord(companyFacts) ? companyFacts.facts : undefined;
  const usGaap = isRecord(facts) ? facts["us-gaap"] : undefined;
  return isRecord(usGaap) ? usGaap : undefined;
}

function secAnnualValueMap(usGaap: Record<string, unknown>, tags: string[], units: string[]) {
  for (const tag of tags) {
    const entries = secFactEntries(usGaap[tag], units).filter((entry) => isSecAnnualEntry(entry));
    if (!entries.length) continue;
    const annual = new Map<string, { value: number; entry: SecFactEntry }>();
    for (const entry of entries) {
      const year = secEntryYear(entry);
      if (!year || entry.val === undefined) continue;
      const existing = annual.get(year);
      if (!existing || compareSecEntries(existing.entry, entry) <= 0) annual.set(year, { value: entry.val, entry });
    }
    if (annual.size) return annual;
  }
  return new Map<string, { value: number; entry: SecFactEntry }>();
}

function secFactEntries(metric: unknown, acceptedUnits: string[]) {
  if (!isRecord(metric) || !isRecord(metric.units)) return [];
  for (const unit of acceptedUnits) {
    const entries = metric.units[unit];
    if (Array.isArray(entries)) return entries.filter(isSecFactEntry);
  }
  return [];
}

function isSecFactEntry(value: unknown): value is SecFactEntry {
  if (!isRecord(value)) return false;
  return typeof value.val === "number" && Number.isFinite(value.val);
}

function isSecAnnualEntry(entry: SecFactEntry) {
  const form = entry.form ?? "";
  const fp = entry.fp ?? "";
  const frame = entry.frame ?? "";
  return form.includes("10-K") || fp === "FY" || /^CY\d{4}$/.test(frame);
}

function isSecQuarterEntry(entry: SecFactEntry) {
  const form = entry.form ?? "";
  const fp = entry.fp ?? "";
  return form.includes("10-Q") || /^Q[1-3]$/.test(fp);
}

function secEntryYear(entry: SecFactEntry) {
  if (entry.fy !== undefined && Number.isFinite(entry.fy)) return String(entry.fy);
  return entry.end?.match(/^(\d{4})-/)?.[1];
}

function secMetricRow(
  metric: string,
  years: string[],
  values: Map<string, { value: number; entry: SecFactEntry }>,
  kind: "usd" | "ratio" | "perShare",
  interpretation: string,
) {
  const numericValues = years
    .map((year) => ({ year, value: values.get(year)?.value }))
    .filter((item): item is { year: string; value: number } => item.value !== undefined);
  if (!numericValues.length) return undefined;
  return {
    metric,
    values: Object.fromEntries(
      numericValues.map((item) => [
        item.year,
        kind === "usd" ? formatUsdAmount(item.value) : kind === "perShare" ? formatUsdPerShare(item.value) : formatRatio(item.value),
      ]),
    ),
    trend: trendText(numericValues.map((item) => item.value), kind === "ratio" ? "ratio" : "amount"),
    interpretation,
  };
}

function secDerivedMetricRow(
  metric: string,
  years: string[],
  numerator: Map<string, { value: number; entry: SecFactEntry }>,
  denominator: Map<string, { value: number; entry: SecFactEntry }>,
  kind: "ratio",
  interpretation: string,
) {
  const derived = new Map<string, { value: number; entry: SecFactEntry }>();
  for (const year of years) {
    const numeratorValue = numerator.get(year);
    const denominatorValue = denominator.get(year);
    const value = ratio(numeratorValue?.value, denominatorValue?.value);
    if (value !== undefined && numeratorValue) derived.set(year, { value, entry: numeratorValue.entry });
  }
  return secMetricRow(metric, years, derived, kind, interpretation);
}

function latestSecFilingSummary(companyFacts: unknown, mode: "annual" | "quarter"): SecFilingSummary | undefined {
  const usGaap = secUsGaapFacts(companyFacts);
  if (!usGaap) return undefined;
  const entries = [
    ...secFactEntries(usGaap.RevenueFromContractWithCustomerExcludingAssessedTax, ["USD"]),
    ...secFactEntries(usGaap.Revenues, ["USD"]),
    ...secFactEntries(usGaap.NetIncomeLoss, ["USD"]),
    ...secFactEntries(usGaap.Assets, ["USD"]),
  ].filter((entry) => (mode === "annual" ? isSecAnnualEntry(entry) : isSecQuarterEntry(entry)));
  const latest = entries.sort(compareSecEntries).at(-1);
  if (!latest) return undefined;
  return {
    form: latest.form,
    fiscalYear: latest.fy,
    fiscalPeriod: latest.fp,
    end: latest.end,
    filed: latest.filed,
  };
}

function buildSecSummaryFinancialData(companyFacts: unknown) {
  const usGaap = secUsGaapFacts(companyFacts);
  if (!usGaap) return undefined;
  const revenue = secAnnualValueMap(usGaap, ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues"], ["USD"]);
  const netIncome = secAnnualValueMap(usGaap, ["NetIncomeLoss"], ["USD"]);
  const operatingCashFlow = secAnnualValueMap(usGaap, ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"], ["USD"]);
  const assets = secAnnualValueMap(usGaap, ["Assets"], ["USD"]);
  const liabilities = secAnnualValueMap(usGaap, ["Liabilities"], ["USD"]);
  const equity = secAnnualValueMap(usGaap, ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"], ["USD"]);
  const eps = secAnnualValueMap(usGaap, ["EarningsPerShareDiluted"], ["USD/shares"]);
  const latestYear = Array.from(new Set([...revenue.keys(), ...netIncome.keys(), ...operatingCashFlow.keys(), ...assets.keys(), ...liabilities.keys(), ...equity.keys(), ...eps.keys()]))
    .sort()
    .at(-1);
  if (!latestYear) return undefined;
  const netMargin = ratio(netIncome.get(latestYear)?.value, revenue.get(latestYear)?.value);
  const result = pickDefined({
    totalRevenue: rawMetric(revenue.get(latestYear)?.value),
    trailingTotalRevenue: rawMetric(revenue.get(latestYear)?.value),
    trailingNetIncome: rawMetric(netIncome.get(latestYear)?.value),
    trailingOperatingCashFlow: rawMetric(operatingCashFlow.get(latestYear)?.value),
    trailingDilutedEPS: rawMetric(eps.get(latestYear)?.value),
    quarterlyTotalAssets: rawMetric(assets.get(latestYear)?.value),
    quarterlyTotalDebt: rawMetric(liabilities.get(latestYear)?.value),
    quarterlyStockholdersEquity: rawMetric(equity.get(latestYear)?.value),
    profitMargins: rawMetric(netMargin === undefined ? undefined : netMargin / 100),
    source: "SEC EDGAR Company Facts",
    fiscalYear: latestYear,
  });
  return Object.keys(result).length ? result : undefined;
}

function summarizeSecCompanyFacts(companyFacts: unknown, sourceUrl: string) {
  const record = isRecord(companyFacts) ? companyFacts : {};
  return pickDefined({
    cik: record.cik,
    entityName: record.entityName,
    sourceUrl,
    available: true,
  });
}

function rawMetric(value: number | undefined) {
  return value === undefined ? undefined : { raw: value };
}

function compareSecEntries(a: SecFactEntry, b: SecFactEntry) {
  return `${a.filed ?? ""}:${a.end ?? ""}`.localeCompare(`${b.filed ?? ""}:${b.end ?? ""}`);
}

function statementNumber(row: Record<string, unknown> | undefined, keys: string[]) {
  if (!row) return undefined;
  for (const key of keys) {
    const value = numberValue(row[key]) ?? numberFromString(String(row[key] ?? ""));
    if (value !== undefined) return value;
  }
  return undefined;
}

function ratio(numerator: number | undefined, denominator: number | undefined) {
  if (numerator === undefined || denominator === undefined || denominator === 0) return undefined;
  return (numerator / denominator) * 100;
}

function formatAmount(value: number) {
  return `${(value / 100_000_000).toLocaleString("zh-CN", { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 })}亿`;
}

function formatAmountWithUnit(value: number, unit: string | undefined) {
  return `${(value / 100_000_000).toLocaleString("zh-CN", { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 })}亿${unit ?? ""}`;
}

function formatUsdAmount(value: number) {
  return `${(value / 100_000_000).toLocaleString("zh-CN", { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 })}亿美元`;
}

function formatPerShare(value: number, unit: string | undefined) {
  return `${value.toLocaleString("zh-CN", { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 })}${unit ? ` ${unit}/股` : ""}`;
}

function formatUsdPerShare(value: number) {
  return `$${value.toLocaleString("zh-CN", { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatRatio(value: number) {
  return `${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function trendText(values: number[], kind: "amount" | "ratio") {
  if (values.length < 2) return "待继续观察";
  const first = values[0];
  const last = values.at(-1) ?? first;
  if (first === 0) return last > 0 ? "由低位改善" : "待继续观察";
  const change = (last - first) / Math.abs(first);
  const threshold = kind === "ratio" ? 0.02 : 0.03;
  if (change > threshold) return "上升";
  if (change < -threshold) return "下降";
  return "基本稳定";
}

function pickDefined(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function dedupeCandidates(candidates: CompanyCandidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.source}:${candidate.code}:${candidate.listingPlace}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withAbortSignal(fetchImpl: FetchLike, signal?: AbortSignal): FetchLike {
  if (!signal) return fetchImpl;
  return ((resource: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => fetchImpl(resource, { ...init, signal })) as FetchLike;
}

async function fetchJson(url: string, fetchImpl: FetchLike): Promise<unknown> {
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        "user-agent": "CSTD Alpha/1.0",
      },
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function fetchText(url: string, fetchImpl: FetchLike): Promise<string | undefined> {
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "text/csv,text/plain,*/*",
        "user-agent": "CSTD Alpha/1.0",
      },
    });
    if (!response.ok) return undefined;
    return response.text();
  } catch {
    return undefined;
  }
}

async function fetchStooqQuote(url: string, symbol: string, fetchImpl: FetchLike) {
  if (!url) return undefined;
  const text = await fetchText(url, fetchImpl);
  return normalizeStooqQuote(text, symbol);
}

function unavailableBundle(companyName: string, market: string | undefined, retrievedAt: string, notes: string): EvidenceBundle {
  return {
    company: { name: companyName, market },
    retrievedAt,
    evidence: [
      {
        title: "Public financial data unavailable",
        source: "CSTD Alpha data provider",
        url: "",
        retrievedAt,
        freshness: "unavailable",
        notes,
      },
    ],
    facts: {},
  };
}

function recordPath(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);
}

function arrayPath(value: unknown, path: string[]): unknown[] {
  const result = recordPath(value, path);
  return Array.isArray(result) ? result : [];
}

function firstArrayItem(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) && isRecord(value[0]) ? value[0] : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberFromString(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function inferTrailingPe(price: unknown, dilutedEps: unknown) {
  const priceValue = numberValue(price);
  const epsValue = metricRawNumber(dilutedEps);
  if (priceValue === undefined || epsValue === undefined || epsValue <= 0) return undefined;
  return Math.round((priceValue / epsValue) * 100) / 100;
}

function metricRawNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (isRecord(value)) return numberValue(value.raw);
  return undefined;
}

function eastmoneyPriceNumber(value: unknown, scale: number) {
  return eastmoneyScaledNumber(value, scale);
}

function eastmoneyRatioField(value: unknown, zeroAsUnavailable: boolean) {
  return eastmoneyScaledNumber(value, 100, zeroAsUnavailable);
}

function eastmoneyPercentNumber(value: unknown) {
  return eastmoneyScaledNumber(value, 100);
}

function eastmoneyScaledNumber(value: unknown, divisor = 100, zeroAsUnavailable = false) {
  const number = numberValue(value);
  if (number === undefined || number === -100) return undefined;
  if (number === 0 && zeroAsUnavailable) return undefined;
  if (number === 0) return 0;
  return Math.round((number / divisor) * 1000) / 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
