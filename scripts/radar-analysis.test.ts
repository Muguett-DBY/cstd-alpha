import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("background radar analyzer", () => {
  test("reads full evidence facts, previous radar, and writes a normalized radar cache payload", () => {
    const workdir = mkdtempSync(join(tmpdir(), "radar-analysis-"));
    const evidencePath = join(workdir, "evidence.json");
    const previousPath = join(workdir, "previous.json");
    const modelPath = join(workdir, "model.json");
    const outputRadarPath = join(workdir, "radar-cache.json");
    const outputJobPath = join(workdir, "job.json");

    writeFileSync(evidencePath, JSON.stringify(evidenceSnapshot()), "utf8");
    writeFileSync(previousPath, JSON.stringify(previousRadarCache()), "utf8");
    writeFileSync(modelPath, JSON.stringify(modelOutput()), "utf8");

    execFileSync(
      "node",
      [
        "scripts/run_radar_analysis.mjs",
        "--evidence",
        evidencePath,
        "--previous",
        previousPath,
        "--job-id",
        "job-test",
        "--mock-model-output",
        modelPath,
        "--output-radar",
        outputRadarPath,
        "--output-job",
        outputJobPath,
      ],
      { stdio: "pipe" },
    );

    const radarCache = JSON.parse(readFileSync(outputRadarPath, "utf8")) as {
      version?: string;
      radar?: {
        generatedAt?: string;
        model?: string;
        sourceCount?: number;
        solidGrowth?: Array<{ companies?: string[]; sourceIds?: string[]; evidenceGaps?: string[] }>;
        sustainability?: Array<{ title?: string; changeReason?: string }>;
        evidenceSources?: Array<{ id?: string; source?: string; signalType?: string }>;
        industryPackets?: Array<{ industry?: string; changeStatus?: string; evidenceHash?: string; stage?: string; scores?: { growth?: number; evidence?: number; bubbleRisk?: number } }>;
        analysisScope?: { totalIndustryCount?: number; changedIndustryCount?: number; unchangedIndustryCount?: number };
        changeLog?: string[];
      };
    };
    const job = JSON.parse(readFileSync(outputJobPath, "utf8")) as { id?: string; status?: string; radarGeneratedAt?: string };

    expect(radarCache.version).toBe("v2");
    expect(radarCache.radar?.model).toBe("deepseek-v4-flash");
    expect(radarCache.radar?.sourceCount).toBeGreaterThanOrEqual(5);
    expect(radarCache.radar?.solidGrowth?.[0].companies).toEqual(["百济神州"]);
    expect(radarCache.radar?.solidGrowth?.[0].sourceIds).toContain("S1");
    expect(radarCache.radar?.solidGrowth?.[0].evidenceGaps).toEqual([]);
    expect(radarCache.radar?.industryPackets?.length).toBeGreaterThanOrEqual(4);
    expect(radarCache.radar?.analysisScope).toMatchObject({ totalIndustryCount: 4, changedIndustryCount: 3, unchangedIndustryCount: 1 });
    expect(radarCache.radar?.industryPackets?.find((packet) => packet.industry === "创新药/医疗服务")).toMatchObject({ stage: "扎实增长", scores: { evidence: expect.any(Number), growth: expect.any(Number), bubbleRisk: expect.any(Number) } });
    expect(radarCache.radar?.sustainability?.some((item) => item.title === "航运运价高位观察" && item.changeReason?.includes("复用上次稳定结论"))).toBe(true);
    expect(radarCache.radar?.evidenceSources?.some((source) => source.source === "东方财富业绩报表" && source.signalType === "financial_metric")).toBe(true);
    expect(radarCache.radar?.changeLog?.join(" ")).toContain("新增");
    expect(job).toMatchObject({ id: "job-test", status: "completed" });
    expect(job.radarGeneratedAt).toBe(radarCache.radar?.generatedAt);
  });

  test("model input fixture includes financial, industry, and company candidate facts", () => {
    const workdir = mkdtempSync(join(tmpdir(), "radar-analysis-input-"));
    const evidencePath = join(workdir, "evidence.json");
    const previousPath = join(workdir, "previous.json");
    const modelPath = join(workdir, "model.json");
    const requestPath = join(workdir, "request.json");

    writeFileSync(evidencePath, JSON.stringify(evidenceSnapshot()), "utf8");
    writeFileSync(previousPath, JSON.stringify(previousRadarCache()), "utf8");
    writeFileSync(modelPath, JSON.stringify(modelOutput()), "utf8");

    execFileSync(
      "node",
      [
        "scripts/run_radar_analysis.mjs",
        "--evidence",
        evidencePath,
        "--previous",
        previousPath,
        "--job-id",
        "job-test",
        "--mock-model-output",
        modelPath,
        "--debug-request-output",
        requestPath,
      ],
      { stdio: "pipe" },
    );

    const requestBody = JSON.parse(readFileSync(requestPath, "utf8")) as { messages?: Array<{ content?: string }> };
    const dynamicPayload = JSON.parse(String(requestBody.messages?.[2].content)) as {
      evidenceDigest?: { citations?: unknown[]; packets?: unknown[] };
      analysisScope?: { changedIndustryPackets?: Array<{ scores?: unknown }>; unchangedIndustrySummaries?: Array<{ scores?: unknown }>; totalIndustryCount?: number };
      structuredFacts?: { financialFacts?: unknown[]; industryFacts?: unknown[]; companyCandidates?: unknown[] };
      previousScan?: { id?: string };
    };

    expect(dynamicPayload.previousScan).toMatchObject({ id: "radar-previous" });
    expect(dynamicPayload.analysisScope?.totalIndustryCount).toBe(4);
    expect(dynamicPayload.analysisScope?.changedIndustryPackets?.length).toBe(3);
    expect(dynamicPayload.analysisScope?.unchangedIndustrySummaries?.length).toBe(1);
    expect(dynamicPayload.analysisScope?.changedIndustryPackets?.every((packet) => packet.scores)).toBe(true);
    expect(dynamicPayload.evidenceDigest?.citations?.length).toBeGreaterThan(4);
    expect(dynamicPayload.structuredFacts?.financialFacts?.length).toBeGreaterThan(0);
    expect(dynamicPayload.structuredFacts?.industryFacts?.length).toBeGreaterThan(0);
    expect(dynamicPayload.structuredFacts?.companyCandidates?.length).toBeGreaterThan(0);
    expect(JSON.stringify(dynamicPayload.structuredFacts)).not.toContain("industryPackets");
  });
});

function evidenceSnapshot() {
  const sources = [
    {
      source: "东方财富业绩报表",
      query: "A股 财报 营收 净利润 毛利率 经营现金流",
      title: "百济神州 2026Q1 营收同比 31.02%，净利润同比 1801.30%",
      url: "https://data.eastmoney.com/bbsj/202603/yjbb.html#688235",
      publishedAt: "2026-05-07T00:00:00Z",
      summary: "公司级财报硬证据：营收 10544044000，净利润 1607782000，毛利率待验证。",
      sourceType: "announcement",
      signalType: "financial_metric",
      weight: 4,
      company: "百济神州",
      code: "688235.SH",
      market: "A股",
      industry: "化学制药",
    },
    {
      source: "东方财富业绩预告",
      query: "A股 业绩预告 净利润 预增",
      title: "新天力 2026H1 净利润预告同比 1.00% 至 8.05%",
      url: "https://data.eastmoney.com/bbsj/202606/yjyg.html#920218",
      publishedAt: "2026-05-18T00:00:00Z",
      summary: "业绩预告原因待披露。",
      sourceType: "announcement",
      signalType: "financial_metric",
      weight: 4,
      company: "新天力",
      code: "920218.BJ",
      market: "A股",
      industry: "包装材料",
    },
    {
      source: "AKShare/乘联会汽车统计",
      query: "汽车/智能驾驶 汽车出口 销量 同比",
      title: "狭义乘用车出口 2026年4月 77.02 万辆，同比 82.16%",
      url: "http://data.cpcadata.com/TotalMarket",
      publishedAt: "2026-04-01T00:00:00Z",
      summary: "乘联会月度行业统计。",
      sourceType: "official",
      signalType: "industry_stat",
      weight: 4,
      industry: "汽车/智能驾驶",
    },
    {
      source: "AKShare/Sina期货日线",
      query: "战略有色金属 铜 期货 价格 库存",
      title: "沪铜主连 2026-05-18 收盘上涨",
      url: "https://finance.sina.com.cn/futures/quotes/CU0.shtml",
      sourceType: "hard_data",
      signalType: "commodity_price",
      weight: 5,
      industry: "战略有色金属",
    },
    {
      source: "东方财富行业指数",
      query: "航运物流 航运 BDI 运价 指数",
      title: "BDI 2026-05-18 最新值 3092，1年变化 122.77%",
      url: "https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_INDUSTRY_INDEX",
      sourceType: "hard_data",
      signalType: "freight_rate",
      weight: 5,
      industry: "航运物流",
    },
  ];
  return {
    version: "v1",
    source: "github-actions-python",
    generatedAt: "2026-05-19T10:10:00Z",
    asOfDate: "2026-05-19",
    evidenceHash: "testhash",
    sourceCount: sources.length,
    quality: {},
    sources,
    financialFacts: [
      { source: "东方财富业绩报表", company: "百济神州", code: "688235.SH", market: "A股", industry: "化学制药", metric: "净利润", value: 1607782000, yoy: 1801.3, publishedAt: "2026-05-07T00:00:00Z" },
    ],
    industryFacts: [
      { source: "AKShare/乘联会汽车统计", industry: "汽车/智能驾驶", metric: "出口销量", value: 77.02, yoy: 82.16, unit: "万辆", publishedAt: "2026-04-01T00:00:00Z" },
    ],
    companyCandidates: [
      { company: "百济神州", code: "688235.SH", market: "A股", industry: "化学制药", triggerEvidence: "净利润同比 1801.30%", evidenceStrength: 4 },
    ],
    industryPackets: [
      { group: "医药健康", industry: "创新药/医疗服务", status: "scanned", evidenceHash: "hash-new-drug", sourceCount: 1, evidenceTypes: ["announcement"], signalTypes: ["financial_metric"], evidenceGaps: [], sources: [sources[0]], financialFacts: [{ company: "百济神州", industry: "化学制药" }], industryFacts: [], companyCandidates: [{ company: "百济神州", industry: "化学制药" }] },
      { group: "高景气成长", industry: "汽车/智能驾驶", status: "scanned", evidenceHash: "hash-auto", sourceCount: 1, evidenceTypes: ["official"], signalTypes: ["industry_stat"], evidenceGaps: ["缺财报"], sources: [sources[2]], financialFacts: [], industryFacts: [{ industry: "汽车/智能驾驶" }], companyCandidates: [] },
      { group: "周期品", industry: "战略有色金属", status: "scanned", evidenceHash: "hash-metal", sourceCount: 1, evidenceTypes: ["hard_data"], signalTypes: ["commodity_price"], evidenceGaps: ["缺财报"], sources: [sources[3]], financialFacts: [], industryFacts: [], companyCandidates: [] },
      { group: "周期品", industry: "航运物流", status: "scanned", evidenceHash: "hash-ship-stable", sourceCount: 1, evidenceTypes: ["hard_data"], signalTypes: ["freight_rate"], evidenceGaps: ["缺财报"], sources: [sources[4]], financialFacts: [], industryFacts: [], companyCandidates: [] },
    ],
  };
}

function previousRadarCache() {
  const now = "2026-05-18T00:00:00Z";
  return {
    version: "v2",
    cachedAt: now,
    radar: {
      id: "radar-previous",
      title: "行业雷达扫描",
      generatedAt: now,
      asOfDate: "2026-05-18",
      validUntil: "2026-05-19T00:00:00Z",
      model: "deepseek-v4-flash",
      sourceCount: 5,
      sourceQueries: [],
      executiveSummary: ["旧报告。"],
      solidGrowth: [],
      sustainability: [
        {
          title: "航运运价高位观察",
          industries: ["航运物流"],
          companies: ["中远海控"],
          thesis: "运价高位但公司级业绩仍需验证。",
          drivers: ["运价"],
          evidence: ["旧证据"],
          conclusionStrength: "观察",
          evidenceGaps: ["缺财报"],
          driverTags: ["价格"],
          sustainabilityTier: "短期催化",
          durability: "短期",
          riskLevel: "中",
          confidence: "中",
          sourceIds: [],
          counterEvidenceConditions: ["运价回落"],
          turningPoints: ["BDI回落"],
        },
      ],
      bubbleRisks: [],
      upcomingGrowth: [],
      decliningIndustries: [],
      representativeCompanies: [],
      stageCompanies: [],
      limitations: [],
      industryPackets: [
        { group: "周期品", industry: "航运物流", status: "scanned", evidenceHash: "hash-ship-stable", sourceCount: 1, evidenceTypes: ["hard_data"], signalTypes: ["freight_rate"], evidenceGaps: ["缺财报"] },
      ],
    },
  };
}

function modelOutput() {
  return {
    title: "行业雷达扫描",
    asOfDate: "2026-05-19",
    confidenceSummary: "测试输出。",
    changeLog: ["新增创新药公司级财报拐点。"],
    executiveSummary: ["百济神州财报显示收入和利润拐点。"],
    solidGrowth: [
      {
        title: "创新药商业化利润拐点",
        industries: ["创新药/医疗服务"],
        companies: ["百济神州", "Micron"],
        thesis: "营收增长和净利润拐点由公司财报直接验证。",
        drivers: ["商业化收入扩张", "费用率改善"],
        evidence: ["S1 财报数据"],
        sourceIds: ["S1"],
        evidenceTypes: ["announcement"],
        supportingSourceCount: 1,
        conclusionStrength: "正式结论",
        evidenceGaps: [],
        driverTags: ["需求", "市占率"],
        sustainabilityTier: "中期景气",
        confidence: "高",
        durability: "中期",
        riskLevel: "中",
        counterEvidenceConditions: ["后续季度利润再次转亏"],
        turningPoints: ["核心产品销售放缓"],
      },
    ],
    sustainability: [],
    bubbleRisks: [],
    upcomingGrowth: [],
    decliningIndustries: [],
    representativeCompanies: [{ label: "扎实增长产业中的代表公司", companies: ["百济神州", "美光"], note: "测试过滤海外公司。" }],
    stageCompanies: [],
    limitations: [],
  };
}
