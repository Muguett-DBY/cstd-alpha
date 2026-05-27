type AStockQuote = {
  code: string;
  name: string;
  price: number;
  changePct: number;
  peTtm: number;
  pb: number;
  mcapYi: number;
  turnoverPct: number;
  limitUp: number;
  limitDown: number;
};

type ThsHotStock = {
  code: string;
  name: string;
  changePct: number;
  reason: string;
  turnoverPct: number;
  volume: number;
};

type ThsEpsForecast = {
  year: string;
  institutionCount: number;
  minEps: number;
  avgEps: number;
  maxEps: number;
};

type ClsNewsItem = {
  id: string;
  title: string;
  ctime: string;
  content: string;
};

function normalizeCode(code: string): string {
  const c = code.replace(/[.SHshSZszBJBJ]/g, "").trim();
  return c;
}

function marketPrefix(code: string): string {
  if (code.startsWith("6") || code.startsWith("9")) return "sh";
  if (code.startsWith("8")) return "bj";
  return "sz";
}

export async function fetchTencentQuote(codes: string[], fetchImpl: typeof fetch = fetch): Promise<AStockQuote[]> {
  const prefixed = codes.map((c) => `${marketPrefix(normalizeCode(c))}${normalizeCode(c)}`);
  const url = `https://qt.gtimg.cn/q=${prefixed.join(",")}`;
  try {
    const response = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder("gbk");
    const data = decoder.decode(buffer);
    const results: AStockQuote[] = [];
    for (const line of data.split(";")) {
      if (!line.includes('"')) continue;
      const key = line.split("=")[0].split("_").pop() ?? "";
      const vals = line.split('"')[1]?.split("~") ?? [];
      if (vals.length < 53) continue;
      const code = key.slice(2);
      results.push({
        code,
        name: vals[1] ?? "",
        price: parseFloat(vals[3]) || 0,
        changePct: parseFloat(vals[32]) || 0,
        peTtm: parseFloat(vals[39]) || 0,
        pb: parseFloat(vals[46]) || 0,
        mcapYi: parseFloat(vals[44]) || 0,
        turnoverPct: parseFloat(vals[38]) || 0,
        limitUp: parseFloat(vals[47]) || 0,
        limitDown: parseFloat(vals[48]) || 0,
      });
    }
    return results;
  } catch {
    return [];
  }
}

export async function fetchThsHotStocks(date?: string, fetchImpl: typeof fetch = fetch): Promise<ThsHotStock[]> {
  const d = date ?? new Date().toISOString().slice(0, 10);
  const url = `http://zx.10jqka.com.cn/event/api/getharden/date/${d}/orderby/date/orderway/desc/charset/GBK/`;
  try {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/117.0.0.0 Safari/537.36" },
    });
    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder("gbk");
    const text = decoder.decode(buffer);
    const json = JSON.parse(text) as { data?: Array<Record<string, unknown>>; errocode?: number };
    if (json.errocode) return [];
    return (json.data ?? []).map((item) => ({
      code: String(item.code ?? ""),
      name: String(item.name ?? ""),
      changePct: parseFloat(String(item.zhangfu ?? "0")),
      reason: String(item.reason ?? ""),
      turnoverPct: parseFloat(String(item.huanshou ?? "0")),
      volume: parseFloat(String(item.chengjiaoliang ?? "0")),
    }));
  } catch {
    return [];
  }
}

export async function fetchThsConsensusEps(code: string, fetchImpl: typeof fetch = fetch): Promise<ThsEpsForecast[]> {
  const normalized = normalizeCode(code);
  const url = `https://basic.10jqka.com.cn/new/${normalized}/worth.html`;
  try {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    });
    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder("gbk");
    const html = decoder.decode(buffer);
    const rows: ThsEpsForecast[] = [];
    const tableRegex = /<tr>.*?<\/tr>/gs;
    let tableMatch: RegExpExecArray | null;
    while ((tableMatch = tableRegex.exec(html)) !== null) {
      const tr = tableMatch[0];
      if (!tr.includes("每股收益")) continue;
      const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
      if (cells.length < 6) continue;
      const yearMatch = cells[0]?.match(/(\d{4})/);
      if (!yearMatch) continue;
      rows.push({
        year: yearMatch[1],
        institutionCount: parseInt(cells[1] ?? "0", 10) || 0,
        minEps: parseFloat(cells[3] ?? "0") || 0,
        avgEps: parseFloat(cells[4] ?? "0") || 0,
        maxEps: parseFloat(cells[5] ?? "0") || 0,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

export async function fetchClsNews(fetchImpl: typeof fetch = fetch): Promise<ClsNewsItem[]> {
  const url = "https://www.cls.cn/api/telegraph";
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0",
      },
      body: "category=all&last_time=",
    });
    const json = (await response.json()) as { data?: { list?: Array<{ id: string; title: string; ctime: string; content: string }> } };
    const list = json.data?.list ?? [];
    return list.map((item) => ({
      id: String(item.id ?? ""),
      title: String(item.title ?? "").replace(/<[^>]+>/g, ""),
      ctime: item.ctime
        ? new Date(Number(item.ctime) * 1000).toISOString().slice(0, 19).replace("T", " ")
        : "",
      content: String(item.content ?? "").replace(/<[^>]+>/g, "").slice(0, 300),
    }));
  } catch {
    return [];
  }
}
