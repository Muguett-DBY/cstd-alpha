import { computeTechnicalIndicators } from "./assistant-a-stock";

type ComputeInput = {
  operation: string;
  params: Record<string, unknown>;
};

type ComputeResult = {
  operation: string;
  label: string;
  summary: string;
  rows: Array<{ label: string; value: string }>;
};

export function executeFinancialCompute(input: ComputeInput): ComputeResult {
  switch (input.operation) {
    case "cagr":
      return computeCAGR(input.params);
    case "dcf":
      return computeDCF(input.params);
    case "stats":
      return computeStats(input.params);
    case "ratios":
      return computeRatios(input.params);
    case "technical":
      return computeTechnical(input.params);
    default:
      return {
        operation: input.operation,
        label: "未知计算",
        summary: `不支持的计算类型：${input.operation}`,
        rows: [],
      };
  }
}

function parseNumArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number).filter((n) => Number.isFinite(n));
  const str = String(value ?? "");
  return str
    .split(/[,;\s]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

function computeCAGR(params: Record<string, unknown>): ComputeResult {
  const values = parseNumArray(params.values);
  if (values.length < 2 || values[0] <= 0) {
    return {
      operation: "cagr",
      label: "CAGR 复合年增长率",
      summary: values.length < 2 ? "至少需要 2 个数值。" : "起始值必须大于 0，无法计算 CAGR。",
      rows: [],
    };
  }
  const years = values.length - 1;
  const cagr = Math.pow(values[values.length - 1] / values[0], 1 / years) - 1;
  const totalReturn = values[values.length - 1] / values[0] - 1;
  const periods = parseNumArray(params.periods);
  const labels = periods.length >= values.length ? periods.map(String) : values.map((_, i) => `第${i + 1}期`);
  return {
    operation: "cagr",
    label: "CAGR 复合年增长率",
    summary: `从 ${labels[0]} 到 ${labels[labels.length - 1]} 共 ${years} 期，CAGR 为 ${(cagr * 100).toFixed(2)}%，总回报 ${(totalReturn * 100).toFixed(2)}%`,
    rows: labels.map((label, i) => ({ label, value: values[i].toLocaleString() })),
  };
}

function computeDCF(params: Record<string, unknown>): ComputeResult {
  const cashFlows = parseNumArray(params.cashFlows);
  const terminalCashFlow = Number(params.terminalCashFlow) || 0;
  const terminalGrowthRate = rateRatio(params.terminalGrowthRate, 0);
  const discountRate = rateRatio(params.discountRate, 0.1);
  const sharesOutstanding = Number(params.sharesOutstanding) || 1;
  const netDebt = Number(params.netDebt) || 0;

  if (cashFlows.length < 3) {
    return {
      operation: "dcf",
      label: "DCF 估值",
      summary: "至少需要 3 期自由现金流。",
      rows: [],
    };
  }
  if (!Number.isFinite(discountRate) || !Number.isFinite(terminalGrowthRate) || discountRate <= terminalGrowthRate || discountRate <= -1 || terminalGrowthRate <= -1) {
    return {
      operation: "dcf",
      label: "DCF 估值",
      summary: "DCF 参数无效：贴现率必须高于永续增长率，且两者可使用 10 或 0.10 表示 10%。",
      rows: [],
    };
  }

  let pvTotal = 0;
  const rows: Array<{ label: string; value: string }> = [];
  cashFlows.forEach((cf, i) => {
    const pv = cf / Math.pow(1 + discountRate, i + 1);
    pvTotal += pv;
    rows.push({ label: `第${i + 1}年 FCF`, value: cf.toLocaleString() });
    rows.push({ label: `第${i + 1}年现值 PV`, value: pv.toFixed(0) });
  });

  const terminalValue = terminalCashFlow > 0
    ? (terminalCashFlow * (1 + terminalGrowthRate)) / (discountRate - terminalGrowthRate)
    : 0;
  const terminalPV = terminalValue > 0 ? terminalValue / Math.pow(1 + discountRate, cashFlows.length) : 0;
  if (terminalValue > 0) rows.push({ label: "终值 TV", value: terminalValue.toFixed(0) });
  if (terminalPV > 0) rows.push({ label: "终值现值", value: terminalPV.toFixed(0) });

  const enterpriseValue = pvTotal + terminalPV;
  const equityValue = enterpriseValue - netDebt;
  const fairPrice = sharesOutstanding > 0 ? equityValue / sharesOutstanding : 0;

  return {
    operation: "dcf",
    label: "DCF 估值",
    summary: `企业价值 ${enterpriseValue.toFixed(0)}，股权价值 ${equityValue.toFixed(0)}，每股公允价值 ${fairPrice.toFixed(2)}（股本 ${sharesOutstanding}，净债务 ${netDebt}）`,
    rows,
  };
}

function rateRatio(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.abs(parsed) > 1 ? parsed / 100 : parsed;
}

function computeStats(params: Record<string, unknown>): ComputeResult {
  const values = parseNumArray(params.values);
  if (values.length < 2) {
    return {
      operation: "stats",
      label: "描述性统计",
      summary: "至少需要 2 个数值。",
      rows: [],
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const min = sorted[0];
  const max = sorted[n - 1];

  return {
    operation: "stats",
    label: "描述性统计",
    summary: `${n} 个样本，均值 ${mean.toFixed(2)}，中位数 ${median.toFixed(2)}，标准差 ${std.toFixed(2)}，区间 [${min.toFixed(2)}, ${max.toFixed(2)}]`,
    rows: [
      { label: "样本数", value: String(n) },
      { label: "均值", value: mean.toFixed(2) },
      { label: "中位数", value: median.toFixed(2) },
      { label: "标准差", value: std.toFixed(2) },
      { label: "最小值", value: min.toFixed(2) },
      { label: "最大值", value: max.toFixed(2) },
    ],
  };
}

function computeRatios(params: Record<string, unknown>): ComputeResult {
  const price = Number(params.price) || 0;
  const eps = Number(params.eps) || 0;
  const bookValue = Number(params.bookValue) || 0;
  const revenue = Number(params.revenue) || 0;
  const netIncome = Number(params.netIncome) || 0;
  const totalAssets = Number(params.totalAssets) || 0;
  const totalEquity = Number(params.totalEquity) || 0;
  const totalLiab = Number(params.totalLiab) || 0;

  const rows: Array<{ label: string; value: string }> = [];
  const summary: string[] = [];

  if (price > 0 && eps > 0) {
    const pe = price / eps;
    rows.push({ label: "市盈率 PE", value: pe.toFixed(2) });
    summary.push(`PE ${pe.toFixed(2)}`);
  }
  if (price > 0 && bookValue > 0) {
    const pb = price / bookValue;
    rows.push({ label: "市净率 PB", value: pb.toFixed(2) });
    summary.push(`PB ${pb.toFixed(2)}`);
  }
  if (netIncome > 0 && totalEquity > 0) {
    const roe = (netIncome / totalEquity) * 100;
    rows.push({ label: "ROE", value: `${roe.toFixed(2)}%` });
    summary.push(`ROE ${roe.toFixed(2)}%`);
  }
  if (revenue > 0 && netIncome > 0) {
    const margin = (netIncome / revenue) * 100;
    rows.push({ label: "净利率", value: `${margin.toFixed(2)}%` });
    summary.push(`净利率 ${margin.toFixed(2)}%`);
  }
  if (totalLiab > 0 && totalAssets > 0) {
    const debtRatio = (totalLiab / totalAssets) * 100;
    rows.push({ label: "资产负债率", value: `${debtRatio.toFixed(2)}%` });
    summary.push(`负债率 ${debtRatio.toFixed(2)}%`);
  }

  return {
    operation: "ratios",
    label: "财务比率",
    summary: summary.length ? summary.join("，") : "缺少参数，至少需要 price + eps 或 netIncome + totalEquity。",
    rows,
  };
}

function computeTechnical(params: Record<string, unknown>): ComputeResult {
  const closes = parseNumArray(params.closes);
  if (closes.length < 20) return { operation: "technical", label: "技术指标", summary: "至少需要20期收盘价数据。", rows: [] };
  const highs = parseNumArray(params.highs);
  const lows = parseNumArray(params.lows);
  const volumes = parseNumArray(params.volumes);
  const rows = computeTechnicalIndicators(closes, highs.length >= closes.length ? highs : closes, lows.length >= closes.length ? lows : closes, volumes.length >= closes.length ? volumes : []);
  return { operation: "technical", label: "技术指标", summary: rows.map((r) => `${r.label}=${r.value}`).join("；"), rows };
}
