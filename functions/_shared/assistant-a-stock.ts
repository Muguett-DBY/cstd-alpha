const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/117.0.0.0 Safari/537.36";

type AStockQuote = { code: string; name: string; price: number; changePct: number; peTtm: number; pb: number; mcapYi: number; turnoverPct: number; limitUp: number; limitDown: number };
type ThsHotStock = { code: string; name: string; changePct: number; reason: string; turnoverPct: number; volume: number };
type ThsEpsForecast = { year: string; institutionCount: number; minEps: number; avgEps: number; maxEps: number };
type ClsNewsItem = { id: string; title: string; ctime: string; content: string };
type EastmoneyRow = Record<string, unknown>;

function normalizeCode(c: string): string { return c.replace(/[.SHshSZszBJBJ]/g, "").trim(); }
function marketPrefix(code: string): string {
  if (code.startsWith("6") || code.startsWith("9")) return "sh";
  if (code.startsWith("8")) return "bj";
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
  const prefixed = codes.map((c) => `${marketPrefix(normalizeCode(c))}${normalizeCode(c)}`);
  try {
    const r = await fetchImpl(`https://qt.gtimg.cn/q=${prefixed.join(",")}`, { headers: { "User-Agent": UA } });
    const buf = await r.arrayBuffer();
    const data = new TextDecoder("gbk").decode(buf);
    const results: AStockQuote[] = [];
    for (const line of data.split(";")) {
      if (!line.includes('"')) continue;
      const key = line.split("=")[0].split("_").pop() ?? "";
      const vals = line.split('"')[1]?.split("~") ?? [];
      if (vals.length < 53) continue;
      results.push({ code: key.slice(2), name: vals[1] ?? "", price: parseFloat(vals[3]) || 0, changePct: parseFloat(vals[32]) || 0, peTtm: parseFloat(vals[39]) || 0, pb: parseFloat(vals[46]) || 0, mcapYi: parseFloat(vals[44]) || 0, turnoverPct: parseFloat(vals[38]) || 0, limitUp: parseFloat(vals[47]) || 0, limitDown: parseFloat(vals[48]) || 0 });
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
    const trRe = /<tr>[\s\S]*?<\/tr>/g;
    let m: RegExpExecArray | null;
    while ((m = trRe.exec(html)) !== null) {
      if (!m[0].includes("每股收益")) continue;
      const cells = [...m[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, "").trim());
      if (cells.length < 6) continue;
      const yr = cells[0]?.match(/(\d{4})/);
      if (!yr) continue;
      rows.push({ year: yr[1], institutionCount: parseInt(cells[1] ?? "0") || 0, minEps: parseFloat(cells[3] ?? "0") || 0, avgEps: parseFloat(cells[4] ?? "0") || 0, maxEps: parseFloat(cells[5] ?? "0") || 0 });
    }
    return rows;
  } catch { return []; }
}

export async function fetchClsNews(fetchImpl = fetch): Promise<ClsNewsItem[]> {
  try {
    const r = await fetchImpl("https://www.cls.cn/api/telegraph", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA }, body: "category=all&last_time=" });
    const json = await r.json() as { data?: { list?: Array<{ id: string; title: string; ctime: string; content: string }> } };
    return (json.data?.list ?? []).map((item) => ({ id: String(item.id ?? ""), title: String(item.title ?? "").replace(/<[^>]+>/g, ""), ctime: item.ctime ? new Date(Number(item.ctime) * 1000).toISOString().slice(0, 19).replace("T", " ") : "", content: String(item.content ?? "").replace(/<[^>]+>/g, "").slice(0, 300) }));
  } catch { return []; }
}

// === Batch 2: 龙虎榜 ===
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
  if (!data.length) return "无限售解禁数据。";
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
  if (!data.length) return "无限售解禁数据。";
  return data.map((r) => `${String(r.END_DATE ?? "").slice(0, 10)}: 股东${r.HOLDER_NUM ?? ""}户 环比${r.HOLDER_NUM_RATIO ?? ""}% 户均${r.AVG_FREE_SHARES ?? ""}股`).join("\n");
}

// === 分红送转 ===
export async function fetchDividendHistory(code: string, fetchImpl = fetch): Promise<string> {
  const data = await eastmoneyDatacenter("RPT_SHAREBONUS_DET", `(SECURITY_CODE="${normalizeCode(code)}")`, 15, "EX_DIVIDEND_DATE", "-1", fetchImpl);
  if (!data.length) return "无限售解禁数据。";
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
    return `沪股通累计净流入${lastHgt.toFixed(2)}亿\n深股通累计净流入${lastSgt.toFixed(2)}亿\n合计${(lastHgt + lastSgt).toFixed(2)}亿\n（数据源：同花顺，分钟级实时）`;
  } catch { return "北向资金数据暂不可用。"; }
}

// === 东财研报 ===
export async function fetchResearchReports(code: string, fetchImpl = fetch): Promise<string> {
  try {
    const r = await fetchImpl(`https://reportapi.eastmoney.com/report/list?industryCode=*&pageSize=10&industry=*&rating=*&ratingChange=*&pageNo=1&code=${normalizeCode(code)}&fields=&qType=0&orgCode=&rcode=`, { headers: { "User-Agent": UA, Referer: "https://data.eastmoney.com/" } });
    const d = await r.json() as { data?: Array<{ publishDate?: string; orgSName?: string; title?: string; emRatingName?: string }> };
    if (!d.data?.length) return "无限售解禁数据。";
    return d.data.slice(0, 8).map((item) => `${(item.publishDate ?? "").slice(0, 10)} ${item.orgSName ?? ""}: ${item.title ?? ""}（${item.emRatingName ?? ""}）`).join("\n");
  } catch { return "研报数据暂不可用。"; }
}

// === 巨潮公告 ===
export async function fetchCninfoFilings(code: string, fetchImpl = fetch): Promise<string> {
  try {
    const c = normalizeCode(code);
    const prefix = c.startsWith("6") ? "gssh" : c.startsWith("3") || c.startsWith("0") ? "sz" : "bj";
    const orgId = `${prefix}${code.startsWith("6") || code.startsWith("0") || code.startsWith("3") ? code : c}`;
    const r = await fetchImpl(`https://www.cninfo.com.cn/data/orgId/${orgId}/${c}/bulletin_bulletin/0/10.json`, { headers: { "User-Agent": UA, Referer: "https://www.cninfo.com.cn/" } });
    const d = await r.json() as { totalAnnouncement?: number; announcements?: Array<{ announcementTitle?: string; announcementTime?: number; adjunctUrl?: string }> };
    const list = d.announcements ?? [];
    if (!list.length) return "无限售解禁数据。";
    return list.slice(0, 8).map((a) => `${new Date((a.announcementTime ?? 0) * 1000).toISOString().slice(0, 10)}: ${a.announcementTitle ?? ""}`).join("\n");
  } catch { return "公告数据暂不可用。"; }
}

// === 新浪三表 ===
export async function fetchSinaFinancialStatements(code: string, fetchImpl = fetch): Promise<string> {
  const c = normalizeCode(code);
  const prefix = marketPrefix(c);
  try {
    const r = await fetchImpl(`https://quotes.sina.cn/api/financial_statement?code=${prefix}${c}&type=0&page=1&num=4`, { headers: { "User-Agent": UA } });
    const d = await r.json() as { result?: { data?: { reports?: Array<{ title?: string; data?: Array<{ name?: string; value?: string }> }> } } };
    const reports = d.result?.data?.reports ?? [];
    if (!reports.length) return "无限售解禁数据。";
    return reports.slice(0, 3).map((report) => `${report.title ?? ""}:\n${(report.data ?? []).slice(0, 15).map((item) => `  ${item.name ?? ""}: ${item.value ?? ""}`).join("\n")}`).join("\n\n");
  } catch { return "财务报表数据暂不可用。"; }
}

// === 东财个股信息 ===
export async function fetchEastmoneyStockInfo(code: string, fetchImpl = fetch): Promise<string> {
  const sid = secid(code);
  const json = await eastmoneyPush2("qt/stock/get", { secid: sid, fields: "f57,f58,f84,f85,f86,f100,f116,f117,f120,f121" }, fetchImpl);
  const d = (json as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
  if (!d) return "无限售解禁数据。";
  return `名称: ${d.f58 ?? ""} 代码: ${d.f57 ?? ""} 行业: ${d.f84 ?? ""} 地区: ${d.f85 ?? ""} 总市值: ${d.f116 ?? ""}亿 流通市值: ${d.f117 ?? ""}亿 总股本: ${d.f100 ?? ""} 流通股: ${d.f86 ?? ""} 上市日期: ${d.f120 ?? ""}`;
}

// === 行业板块排名 ===
export async function fetchIndustryRanking(fetchImpl = fetch): Promise<string> {
  const url = "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fs=m:90+t:2&fields=f2,f3,f4,f12,f14,f104,f105,f140,f136";
  try {
    const r = await fetchImpl(url, { headers: { "User-Agent": UA } });
    const d = await r.json() as { data?: { diff?: Array<Record<string, unknown>> } };
    const items = d.data?.diff ?? [];
    if (!items.length) return "无限售解禁数据。";
    const sorted = items.sort((a, b) => ((b.f3 as number) ?? 0) - ((a.f3 as number) ?? 0));
    return sorted.slice(0, 20).map((item, i) => `${i + 1}. ${item.f14 ?? ""}: ${item.f3 ?? ""}% 涨${item.f104 ?? ""}跌${item.f105 ?? ""} 领涨${item.f140 ?? ""}`).join("\n");
  } catch { return "行业板块数据暂不可用。"; }
}

// === 百度概念板块 ===
export async function fetchConceptBlocks(code: string, fetchImpl = fetch): Promise<string> {
  try {
    const r = await fetchImpl(`https://finance.pae.baidu.com/api/getrelatedblock?code=${normalizeCode(code)}&market=ab&typeCode=all&finClientType=pc`, { headers: { "User-Agent": UA, Accept: "application/vnd.finance-web.v1+json", Origin: "https://gushitong.baidu.com", Referer: "https://gushitong.baidu.com/" } });
    const d = await r.json() as { Result?: Array<{ type?: string; list?: Array<{ name?: string; increase?: string }> }>; ResultCode?: unknown };
    if (String(d.ResultCode ?? "-1") !== "0" || !d.Result) return "无限售解禁数据。";
    return d.Result.map((block) => {
      const tag = block.type?.includes("行业") ? "行业" : block.type?.includes("概念") ? "概念" : "地域";
      return `${tag}: ${(block.list ?? []).map((b) => `${b.name ?? ""}(${b.increase ?? ""})`).join("、")}`;
    }).join("\n");
  } catch { return "概念板块数据暂不可用。"; }
}

// === 百度K线 ===
export async function fetchBaiduKline(code: string, fetchImpl = fetch): Promise<string> {
  try {
    const r = await fetchImpl(`https://finance.pae.baidu.com/selfselect/getstockquotation?all=1&isIndex=false&isBk=false&isBlock=false&isFutures=false&isStock=true&newFormat=1&group=quotation_kline_ab&finClientType=pc&code=${normalizeCode(code)}&ktype=1`, { headers: { "User-Agent": UA, Accept: "application/vnd.finance-web.v1+json", Origin: "https://gushitong.baidu.com", Referer: "https://gushitong.baidu.com/" } });
    const d = await r.json() as { Result?: { newMarketData?: { keys?: string[]; marketData?: string } } };
    const md = d.Result?.newMarketData;
    if (!md?.marketData) return "无限售解禁数据。";
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
    const json = JSON.parse(text.slice(text.indexOf("(") + 1, text.lastIndexOf(")"))) as { result?: { cmsArticleWebOld?: { list?: Array<{ title?: string; date?: string; content?: string }> } } };
    const list = json.result?.cmsArticleWebOld?.list ?? [];
    if (!list.length) return "无限售解禁数据。";
    return list.map((a) => `${(a.date ?? "").slice(0, 10)} ${(a.title ?? "").replace(/<[^>]+>/g, "")}`).join("\n");
  } catch { return "新闻数据暂不可用。"; }
}

// === 东财全球资讯 ===
export async function fetchGlobalNews(fetchImpl = fetch): Promise<string> {
  try {
    const r = await fetchImpl(`https://np-weblist.eastmoney.com/comm/web/list?req_trace=${crypto.randomUUID()}&cid=JGCK&callback=&pageindex=1&pagesize=15`, { headers: { "User-Agent": UA, Referer: "https://finance.eastmoney.com/" } });
    const d = await r.json() as { Data?: Array<{ Art_Ctnt?: string; Art_Title?: string; Art_Ptime?: string; Art_Url?: string }> };
    const list = d.Data ?? [];
    return list.map((a) => `${(a.Art_Ptime ?? "").slice(0, 10)} ${a.Art_Title ?? ""}`).join("\n");
  } catch { return "全球资讯暂不可用。"; }
}
