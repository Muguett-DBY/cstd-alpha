const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/117.0.0.0 Safari/537.36";

type AStockQuote = { code: string; name: string; price: number; changePct: number; peTtm: number; pb: number; mcapYi: number; turnoverPct: number; limitUp: number; limitDown: number };
type ThsHotStock = { code: string; name: string; changePct: number; reason: string; turnoverPct: number; volume: number };
type ThsEpsForecast = { year: string; institutionCount: number; minEps: number; avgEps: number; maxEps: number };
type ClsNewsItem = { id: string; title: string; ctime: string; content: string };
type EastmoneyRow = Record<string, unknown>;
type TechnicalResultRow = { label: string; value: string };

function normalizeCode(c: string): string {
  let s = c.trim().toUpperCase();
  if (s.endsWith(".HK")) s = s.slice(0, -3);
  if (s.endsWith(".SZ") || s.endsWith(".SH") || s.endsWith(".BJ")) s = s.slice(0, -3);
  if (s.startsWith("HK")) s = s.slice(2);
  if (s.startsWith("SH") || s.startsWith("SZ") || s.startsWith("BJ")) s = s.slice(2);
  return s;
}
function marketPrefix(code: string): string {
  const u = code.toUpperCase();
  if (u.startsWith("HK")) return "hk";
  const c = code.replace(/HK|hk/g, "");
  if (c.startsWith("6") || c.startsWith("9")) return "sh";
  if (c.startsWith("8")) return "bj";
  if (c.startsWith("5")) return "sh";
  return "sz";
}
function secid(code: string): string {
  const c = normalizeCode(code);
  return c.startsWith("6") ? `1.${c}` : `0.${c}`;
}

async function eastmoneyDatacenter(reportName: string, filter: string, pageSize = 50, sortCol = "", sortType = "-1", fetchImpl: typeof fetch = fetch): Promise<EastmoneyRow[]> {
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=${reportName}&columns=ALL&filter=${encodeURIComponent(filter)}&pageNumber=1&pageSize=${pageSize}&sortColumns=${sortCol}&sortTypes=${sortType}&source=WEB&client=WEB`;
  try {
    const r = await fetchImpl(url, { headers: { "User-Agent": UA } });
    const d = await r.json() as { result?: { data?: EastmoneyRow[] } };
    return d.result?.data ?? [];
  } catch { return []; }
}

async function eastmoneyPush2(path: string, params: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown> | null> {
  const qs = new URLSearchParams(params).toString();
  const url = `https://push2.eastmoney.com/api/${path}?${qs}`;
  try {
    const r = await fetchImpl(url, { headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" } });
    return await r.json() as Record<string, unknown>;
  } catch { return null; }
}

export async function fetchTencentQuote(codes: string[], fetchImpl = fetch): Promise<AStockQuote[]> {
  const prefixed = codes.map((c) => {
    const n = normalizeCode(c);
    const mk = marketPrefix(c);
    if (c.toUpperCase().includes("HK")) return `hk${n}`;
    return `${mk}${n}`;
  });
  try {
    const r = await fetchImpl(`https://qt.gtimg.cn/q=${prefixed.join(",")}`, { headers: { "User-Agent": UA } });
    const buf = await r.arrayBuffer();
    const data = new TextDecoder("gbk").decode(buf);
    const results: AStockQuote[] = [];
    for (const line of data.split(";")) {
      if (!line.includes('"')) continue;
      const key = line.split("=")[0].split("_").pop() ?? "";
      const vals = line.split('"')[1]?.split("~") ?? [];
      if (vals.length < 5) continue;
      const code = key.replace(/^(sh|sz|bj|hk)/i, "");
      const mcap = parseFloat(vals[44]) || 0;
      results.push({
        code,
        name: vals[1] ?? "",
        price: parseFloat(vals[3]) || 0,
        changePct: parseFloat(vals[32]) || 0,
        peTtm: parseFloat(vals[39]) || 0,
        pb: parseFloat(vals[46]) || 0,
        mcapYi: mcap,
        turnoverPct: parseFloat(vals[38]) || 0,
        limitUp: parseFloat(vals[47]) || 0,
        limitDown: parseFloat(vals[48]) || 0,
      });
    }
    return results;
  } catch { return []; }
}

export async function fetchThsHotStocks(date?: string, fetchImpl = fetch): Promise<ThsHotStock[]> {
  const d = date ?? new Date().toISOString().slice(0, 10);
  try {
    const r = await fetchImpl(`http://zx.10jqka.com.cn/event/api/getharden/date/${d}/orderby/date/orderway/desc/charset/GBK/`, { headers: { "User-Agent": UA } });
    const json = JSON.parse(new TextDecoder("gbk").decode(await r.arrayBuffer())) as { data?: Array<Record<string, unknown>>; errocode?: number };
    if (json.errocode) return [];
    return (json.data ?? []).map((item) => ({ code: String(item.code ?? ""), name: String(item.name ?? ""), changePct: parseFloat(String(item.zhangfu ?? "0")), reason: String(item.reason ?? ""), turnoverPct: parseFloat(String(item.huanshou ?? "0")), volume: parseFloat(String(item.chengjiaoliang ?? "0")) }));
  } catch { return []; }
}

export async function fetchThsConsensusEps(code: string, fetchImpl = fetch): Promise<ThsEpsForecast[]> {
  try {
    const r = await fetchImpl(`https://basic.10jqka.com.cn/new/${normalizeCode(code)}/worth.html`, { headers: { "User-Agent": UA } });
    const html = new TextDecoder("gbk").decode(await r.arrayBuffer());
    const rows: ThsEpsForecast[] = [];
    const tables = html.match(/<table[\s\S]*?<\/table>/gi);
    if (!tables) return rows;
    for (const table of tables) {
      if (!table.includes("预测年报每股收益")) continue;
      const trRe = /<tr[\s>][\s\S]*?<\/tr>/gi;
      let m: RegExpExecArray | null;
      while ((m = trRe.exec(table)) !== null) {
        const tr = m[0];
        if (!tr.includes("<td")) continue;
        const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => c[1].replace(/<[^>]+>/g, "").trim());
        const yr = cells[0]?.match(/(\d{4})/);
        if (!yr || cells.length < 5) continue;
        const inst = parseInt(cells[1] ?? "0") || 0;
        if (!inst) continue;
        rows.push({ year: yr[1], institutionCount: inst, minEps: parseFloat(cells[2] ?? "0") || 0, avgEps: parseFloat(cells[3] ?? "0") || 0, maxEps: parseFloat(cells[4] ?? "0") || 0 });
      }
      break;
    }
    return rows;
  } catch { return []; }
}

export async function fetchClsNews(fetchImpl = fetch): Promise<ClsNewsItem[]> {
  try {
    const r = await fetchImpl("https://www.cls.cn/v1/roll/get_roll_list?app=CailianpressWeb&os=web&sv=9.4.0&rn=20", { headers: { "User-Agent": UA, Referer: "https://www.cls.cn/" } });
    const json = await r.json() as { data?: { roll_data?: Array<{ id: string; title?: string; ctime?: string; content?: string }> }; errno?: string };
    if (json.errno) return [];
    return (json.data?.roll_data ?? []).map((item) => ({
      id: String(item.id ?? ""),
      title: String(item.title ?? "").replace(/<[^>]+>/g, ""),
      ctime: item.ctime ? new Date(Number(item.ctime) * 1000).toISOString().slice(0, 19).replace("T", " ") : "",
      content: String(item.content ?? "").replace(/<[^>]+>/g, "").slice(0, 300),
    }));
  } catch { return []; }
}

// === 龙虎榜 ===
export async function fetchDragonTigerBoard(code: string, fetchImpl = fetch): Promise<string> {
  const data = await eastmoneyDatacenter("RPT_DAILYBILLBOARD_DETAILSNEW", `(SECURITY_CODE="${normalizeCode(code)}")`, 10, "TRADE_DATE", "-1", fetchImpl);
  if (!data.length) return "该股近60日无龙虎榜记录。";
  return data.slice(0, 5).map((r) => `${String(r.TRADE_DATE ?? "").slice(0, 10)}: ${r.EXPLANATION ?? ""} 净买${(((r.BILLBOARD_NET_AMT as number) ?? 0) / 10000).toFixed(0)}万 换手${r.TURNOVERRATE ?? ""}%`).join("\n");
}

export async function fetchDailyDragonTiger(tradeDate: string, fetchImpl = fetch): Promise<string> {
  const data = await eastmoneyDatacenter("RPT_DAILYBILLBOARD_DETAILSNEW", `(TRADE_DATE>='${tradeDate}')(TRADE_DATE<='${tradeDate}')`, 100, "BILLBOARD_NET_AMT", "-1", fetchImpl);
  if (!data.length) return `无数据（${tradeDate}非交易日或盘后未更新）。`;
  return data.slice(0, 15).map((r) => `${r.SECURITY_CODE ?? ""} ${r.SECURITY_NAME_ABBR ?? ""}: ${r.EXPLANATION ?? ""} 净买${(((r.BILLBOARD_NET_AMT as number) ?? 0) / 10000).toFixed(0)}万 涨幅${r.CHANGE_RATE ?? ""}%`).join("\n");
}

// === 限售解禁 ===
export async function fetchLockupExpiry(code: string, fetchImpl = fetch): Promise<string> {
  const upcoming = await eastmoneyDatacenter("RPT_LIFT_STAGE", `(SECURITY_CODE="${normalizeCode(code)}")`, 15, "FREE_DATE", "1", fetchImpl);
  if (!upcoming.length) return "无限售解禁数据。";
  return upcoming.map((r) => `${String(r.FREE_DATE ?? "").slice(0, 10)}: ${r.LIMITED_STOCK_TYPE ?? ""} 数量${r.FREE_SHARES_NUM ?? ""}股 占比${r.FREE_RATIO ?? ""}`).join("\n");
}

// === 融资融券 ===
export async function fetchMarginTrading(code: string, fetchImpl = fetch): Promise<string> {
  const data = await eastmoneyDatacenter("RPTA_WEB_RZRQ_GGMX", `(SCODE="${normalizeCode(code)}")`, 30, "DATE", "-1", fetchImpl);
  if (!data.length) return "无融资融券数据。";
  return data.slice(0, 10).map((r) => `${String(r.DATE ?? "").slice(0, 10)}: 融资余额${(((r.RZYE as number) ?? 0) / 1e8).toFixed(2)}亿 融资买入${(((r.RZMRE as number) ?? 0) / 1e8).toFixed(2)}亿 融券余额${(((r.RQYE as number) ?? 0) / 1e8).toFixed(2)}亿`).join("\n");
}

// === 大宗交易 ===
export async function fetchBlockTrades(code: string, fetchImpl = fetch): Promise<string> {
  const data = await eastmoneyDatacenter("RPT_DATA_BLOCKTRADE", `(SECURITY_CODE="${normalizeCode(code)}")`, 15, "TRADE_DATE", "-1", fetchImpl);
  if (!data.length) return "无大宗交易记录。";
  return data.map((r) => {
    const close = (r.CLOSE_PRICE as number) ?? 0;
    const deal = (r.DEAL_PRICE as number) ?? 0;
    const premium = close ? (((deal / close - 1) * 100).toFixed(2)) : "N/A";
    return `${String(r.TRADE_DATE ?? "").slice(0, 10)}: 价格${deal} 溢价${premium}% 量${r.DEAL_VOLUME ?? ""} 买方${r.BUYER_NAME ?? ""}`;
  }).join("\n");
}

// === 股东户数 ===
export async function fetchHolderCount(code: string, fetchImpl = fetch): Promise<string> {
  const data = await eastmoneyDatacenter("RPT_HOLDERNUMLATEST", `(SECURITY_CODE="${normalizeCode(code)}")`, 10, "END_DATE", "-1", fetchImpl);
  if (!data.length) return "无股东户数数据。";
  return data.map((r) => `${String(r.END_DATE ?? "").slice(0, 10)}: 股东${r.HOLDER_NUM ?? ""}户 环比${r.HOLDER_NUM_RATIO ?? ""}% 户均${r.AVG_FREE_SHARES ?? ""}股`).join("\n");
}

// === 分红送转 ===
export async function fetchDividendHistory(code: string, fetchImpl = fetch): Promise<string> {
  const data = await eastmoneyDatacenter("RPT_SHAREBONUS_DET", `(SECURITY_CODE="${normalizeCode(code)}")`, 15, "EX_DIVIDEND_DATE", "-1", fetchImpl);
  if (!data.length) return "无分红送转数据。";
  return data.map((r) => `${String(r.EX_DIVIDEND_DATE ?? "").slice(0, 10)}: 每股派息${r.PRETAX_BONUS_RMB ?? "0"}元 每10股转${r.TRANSFER_RATIO ?? "0"}送${r.BONUS_RATIO ?? "0"}`).join("\n");
}

// === 个股资金流120日 ===
export async function fetchFundFlow120d(code: string, fetchImpl = fetch): Promise<string> {
  const sid = secid(code);
  const json = await eastmoneyPush2("qt/stock/fflow/daykline/get", { secid: sid, fields1: "f1,f2,f3,f7", fields2: "f51,f52,f53,f54,f55", lmt: "120" }, fetchImpl);
  const klines = (json as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
  const lines = (klines?.klines as string[]) ?? [];
  if (!lines.length) return "无资金流数据。";
  const parsed = lines.slice(-20).map((l) => { const p = l.split(","); return { date: p[0], main: parseFloat(p[1]) || 0 }; });
  const total = parsed.reduce((s, r) => s + r.main, 0);
  return parsed.map((r) => `${r.date}: 主力净流入${(r.main / 1e4).toFixed(0)}万`).join("\n") + `\n\n近20日主力累计净流入${(total / 1e8).toFixed(2)}亿`;
}

// === 北向资金 ===
export async function fetchNorthboundFlow(fetchImpl = fetch): Promise<string> {
  try {
    const r = await fetchImpl("https://data.hexin.cn/market/hsgtApi/method/dayChart/", { headers: { "User-Agent": UA, Referer: "https://data.hexin.cn/" } });
    const d = await r.json() as { time?: number[]; hgt?: number[]; sgt?: number[] };
    const times = d.time ?? []; const hgt = d.hgt ?? []; const sgt = d.sgt ?? [];
    const n = Math.min(times.length, hgt.length, sgt.length);
    if (n < 2) return "北向数据暂不可用（非交易时段）。";
    const lastHgt = hgt[n - 1] ?? 0; const lastSgt = sgt[n - 1] ?? 0;
    return `沪股通累计净流入${lastHgt.toFixed(2)}亿\n深股通累计净流入${lastSgt.toFixed(2)}亿\n合计${(lastHgt + lastSgt).toFixed(2)}亿（数据源：同花顺）`;
  } catch { return "北向资金数据暂不可用。"; }
}

// === 东财研报 ===
export async function fetchResearchReports(code: string, fetchImpl = fetch): Promise<string> {
  try {
    const r = await fetchImpl(`https://reportapi.eastmoney.com/report/list?industryCode=*&pageSize=10&industry=*&rating=*&ratingChange=*&pageNo=1&code=${normalizeCode(code)}&fields=&qType=0&orgCode=&rcode=`, { headers: { "User-Agent": UA, Referer: "https://data.eastmoney.com/" } });
    const d = await r.json() as { data?: Array<{ publishDate?: string; orgSName?: string; title?: string; emRatingName?: string }> };
    if (!d.data?.length) return "无东财研报数据。";
    return d.data.slice(0, 8).map((item) => `${(item.publishDate ?? "").slice(0, 10)} ${item.orgSName ?? ""}: ${item.title ?? ""}（${item.emRatingName ?? ""}）`).join("\n");
  } catch { return "研报数据暂不可用。"; }
}

// === 巨潮公告 ===
export async function fetchCninfoFilings(code: string, fetchImpl = fetch): Promise<string> {
  try {
    const c = normalizeCode(code);
    const pfx = c.startsWith("6") ? "gssh" : c.startsWith("0") || c.startsWith("3") ? "szse" : "bjse";
    const orgId = `${pfx}${c}`;
    const r = await fetchImpl(`https://www.cninfo.com.cn/new/hisAnnouncement/query`, {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Referer: "https://www.cninfo.com.cn/" },
      body: `stock=${c}&orgId=${orgId}&pageNum=1&pageSize=10&tabName=fulltext&plate=&seDate=&searchkey=&secid=&sortName=`,
    });
    const d = await r.json() as { totalAnnouncement?: number; announcements?: Array<{ announcementTitle?: string; announcementTime?: string; adjunctUrl?: string }> };
    const list = d.announcements ?? [];
    if (!list.length) return "无巨潮公告数据。";
    return list.slice(0, 8).map((a) => `${(a.announcementTime ?? "").slice(0, 10)}: ${a.announcementTitle ?? ""}`).join("\n");
  } catch { return "公告数据暂不可用。"; }
}

// === 新浪三表 ===
export async function fetchSinaFinancialStatements(code: string, fetchImpl = fetch): Promise<string> {
  const c = normalizeCode(code);
  const types = [
    { id: "vFD_BalanceSheet", label: "资产负债表" },
    { id: "vFD_ProfitStatement", label: "利润表" },
    { id: "vFD_CashFlow", label: "现金流量表" },
  ];
  try {
    const results: string[] = [];
    for (const t of types) {
      const r = await fetchImpl(`https://money.finance.sina.com.cn/corp/go.php/${t.id}/stockid/${c}/ctrl/2019/displaytype/4.phtml`, { headers: { "User-Agent": UA } });
      const buf = await r.arrayBuffer();
      const html = new TextDecoder("gbk").decode(buf);
      const tables = html.match(/<table[\s\S]*?<\/table>/gi);
      if (!tables?.length) continue;
      const dataTable = tables.find((tbl) => tbl.includes("报表日期"));
      if (!dataTable) continue;
      const rows = [...dataTable.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/gi)].slice(1, 20).map((tr) => {
        const cols = [...tr[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => c[1].replace(/<[^>]+>/g, "").trim());
        return cols.filter(Boolean).join(": ");
      }).filter(Boolean);
      if (rows.length) results.push(`${t.label}\n${rows.join("\n")}`);
    }
    return results.length ? results.join("\n\n") : "无新浪财报数据。";
  } catch { return "财务报表数据暂不可用。"; }
}

// === 东财个股信息 ===
export async function fetchEastmoneyStockInfo(code: string, fetchImpl = fetch): Promise<string> {
  const sid = secid(code);
  const json = await eastmoneyPush2("qt/stock/get", { secid: sid, fields: "f57,f58,f84,f85,f86,f100,f116,f117,f120,f121" }, fetchImpl);
  const d = (json as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
  if (!d) return "无个股信息数据。";
  return `名称: ${d.f58 ?? ""} 代码: ${d.f57 ?? ""} 行业: ${d.f84 ?? ""} 地区: ${d.f85 ?? ""} 总市值: ${d.f116 ?? ""}亿 流通市值: ${d.f117 ?? ""}亿 总股本: ${d.f100 ?? ""} 流通股: ${d.f86 ?? ""} 上市日期: ${d.f120 ?? ""}`;
}

// === 行业板块排名 ===
export async function fetchIndustryRanking(fetchImpl = fetch): Promise<string> {
  const url = "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fs=m:90+t:2&fields=f2,f3,f4,f12,f14,f104,f105,f140,f136";
  try {
    const r = await fetchImpl(url, { headers: { "User-Agent": UA } });
    const d = await r.json() as { data?: { diff?: Array<Record<string, unknown>> } };
    const items = d.data?.diff ?? [];
    if (!items.length) return "无行业板块数据。";
    const sorted = items.sort((a, b) => ((b.f3 as number) ?? 0) - ((a.f3 as number) ?? 0));
    return sorted.slice(0, 20).map((item, i) => `${i + 1}. ${item.f14 ?? ""}: ${item.f3 ?? ""}% 涨${item.f104 ?? ""}跌${item.f105 ?? ""} 领涨${item.f140 ?? ""}`).join("\n");
  } catch { return "行业板块数据暂不可用。"; }
}

// === 百度概念板块 ===
export async function fetchConceptBlocks(code: string, fetchImpl = fetch): Promise<string> {
  try {
    const r = await fetchImpl(`https://finance.pae.baidu.com/api/getrelatedblock?code=${normalizeCode(code)}&market=ab&typeCode=all&finClientType=pc`, { headers: { "User-Agent": UA, Accept: "application/vnd.finance-web.v1+json", Origin: "https://gushitong.baidu.com", Referer: "https://gushitong.baidu.com/" } });
    const d = await r.json() as { Result?: Array<{ type?: string; list?: Array<{ name?: string; increase?: string }> }>; ResultCode?: unknown };
    const code_ok = String(d.ResultCode ?? "-1") === "0" || String(d.ResultCode ?? "-1") === "10003";
    if (!code_ok || !d.Result) return "无概念板块数据。";
    return d.Result.map((block) => {
      const tag = block.type?.includes("行业") ? "行业" : block.type?.includes("概念") ? "概念" : "地域";
      return `${tag}: ${(block.list ?? []).map((b) => `${b.name ?? ""}`).join("、")}`;
    }).join("\n");
  } catch { return "概念板块数据暂不可用。"; }
}

// === 百度K线 ===
export async function fetchBaiduKline(code: string, fetchImpl = fetch): Promise<string> {
  try {
    const r = await fetchImpl(`https://finance.pae.baidu.com/selfselect/getstockquotation?all=1&isIndex=false&isBk=false&isBlock=false&isFutures=false&isStock=true&newFormat=1&group=quotation_kline_ab&finClientType=pc&code=${normalizeCode(code)}&ktype=1`, { headers: { "User-Agent": UA, Accept: "application/vnd.finance-web.v1+json", Origin: "https://gushitong.baidu.com", Referer: "https://gushitong.baidu.com/" } });
    const d = await r.json() as { Result?: { newMarketData?: { keys?: string[]; marketData?: string } } };
    const md = d.Result?.newMarketData;
    if (!md?.marketData) return "无K线数据。";
    const rows = md.marketData.split(";").filter(Boolean);
    return rows.slice(-30).map((row) => row.split(",").slice(0, 10).join(" ")).join("\n");
  } catch { return "K线数据暂不可用。"; }
}

// === 东财个股新闻 ===
export async function fetchStockNews(code: string, fetchImpl = fetch): Promise<string> {
  const param = JSON.stringify({ uid: "", keyword: code, type: ["cmsArticleWebOld"], client: "web", clientType: "web", clientVersion: "curr", param: { cmsArticleWebOld: { searchScope: "default", sort: "default", pageIndex: 1, pageSize: 10, preTag: "", postTag: "" } } });
  try {
    const r = await fetchImpl(`https://search-api-web.eastmoney.com/search/jsonp?cb=cstd&param=${encodeURIComponent(param)}`, { headers: { "User-Agent": UA, Referer: "https://so.eastmoney.com/" } });
    const text = await r.text();
    const json = JSON.parse(text.slice(text.indexOf("(") + 1, text.lastIndexOf(")"))) as { result?: { cmsArticleWebOld?: { list?: Array<{ title?: string; date?: string }> } } };
    const list = json.result?.cmsArticleWebOld?.list ?? [];
    if (!list.length) return "无个股新闻数据。";
    return list.map((a) => `${(a.date ?? "").slice(0, 10)} ${(a.title ?? "").replace(/<[^>]+>/g, "")}`).join("\n");
  } catch { return "新闻数据暂不可用。"; }
}

// === 东财全球资讯 ===
export async function fetchGlobalNews(fetchImpl = fetch): Promise<string> {
  try {
    const r = await fetchImpl("https://np-weblist.eastmoney.com/comm/web/list?cid=JGCK&pageindex=1&pagesize=10", { headers: { "User-Agent": UA, Referer: "https://finance.eastmoney.com/" } });
    const d = await r.json() as { Data?: Array<{ Art_Title?: string; Art_Ptime?: string }> };
    const list = d.Data ?? [];
    if (!list.length) return "无全球资讯数据。";
    return list.map((a) => `${(a.Art_Ptime ?? "").slice(0, 10)} ${a.Art_Title ?? ""}`).join("\n");
  } catch { return "全球资讯暂不可用。"; }
}

// === 技术指标 ===
export function computeTechnicalIndicators(closes: number[], highs: number[], lows: number[], volumes: number[]): TechnicalResultRow[] {
  const results: TechnicalResultRow[] = [];
  const n = closes.length;
  if (n < 20) return results;

  // RSI(14)
  const rsiPeriod = 14;
  if (n > rsiPeriod) {
    let gains = 0, losses = 0;
    for (let i = n - rsiPeriod; i < n; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const avgGain = gains / rsiPeriod, avgLoss = losses / rsiPeriod;
    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    results.push({ label: `RSI(14)`, value: rsi.toFixed(1) });
  }

  // MACD(12,26,9)
  if (n > 26) {
    const ema12 = calcEMA(closes, 12);
    const ema26 = calcEMA(closes, 26);
    const dif = ema12 - ema26;
    const dea = calcEMA(ema12, 9) - calcEMA(ema26, 9);

    const macd = 2 * (dif - dea);
    results.push({ label: "MACD", value: `${macd.toFixed(2)}（DIF=${dif.toFixed(2)} DEA=${dea.toFixed(2)}）` });
  }

  // Bollinger Bands(20,2)
  if (n >= 20) {
    const recent = closes.slice(-20);
    const ma = recent.reduce((a, b) => a + b, 0) / 20;
    const std = Math.sqrt(recent.reduce((s, v) => s + (v - ma) ** 2, 0) / 20);
    const upper = ma + 2 * std, lower = ma - 2 * std;
    results.push({ label: "布林带(20,2)", value: `上轨${upper.toFixed(2)} 中轨${ma.toFixed(2)} 下轨${lower.toFixed(2)}` });
  }

  // MA(5,10,20,60)
  [5, 10, 20, 60].forEach((p) => {
    if (n >= p) {
      const ma = closes.slice(-p).reduce((a, b) => a + b, 0) / p;
      results.push({ label: `MA${p}`, value: ma.toFixed(2) });
    }
  });

  // Volume trend (5-day vs 20-day avg)
  if (n >= 20 && volumes.length >= n) {
    const avg5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const avg20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    results.push({ label: "量比(5/20)", value: avg20 > 0 ? (avg5 / avg20).toFixed(2) : "N/A" });
  }

  return results;
}

function calcEMA(data: number[], period: number): number {
  if (data.length < period) return data[data.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
  return ema;
}

// === 横向对比格式化 ===
export function formatComparisonTable(quotes: AStockQuote[]): string {
  if (!quotes.length) return "无数据。";
  const headers = ["名称", "代码", "现价", "涨跌幅%", "PE(TTM)", "PB", "市值(亿)", "换手率%"];
  const rows = quotes.map((q) => [q.name, q.code, String(q.price), q.changePct.toFixed(2), q.peTtm ? q.peTtm.toFixed(1) : "-", q.pb ? q.pb.toFixed(2) : "-", q.mcapYi ? q.mcapYi.toFixed(0) : "-", q.turnoverPct ? q.turnoverPct.toFixed(2) : "-"]);
  const header = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return `${header}\n${sep}\n${body}`;
}
