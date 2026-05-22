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
    const outputSqlPath = join(workdir, "radar-history.sql");

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
        "--output-d1-sql",
        outputSqlPath,
      ],
      { stdio: "pipe" },
    );

    const radarCache = JSON.parse(readFileSync(outputRadarPath, "utf8")) as {
      version?: string;
      radar?: {
        generatedAt?: string;
        model?: string;
        sourceCount?: number;
        solidGrowth?: Array<{ title?: string; companies?: string[]; sourceIds?: string[]; evidence?: string[]; evidenceGaps?: string[]; confidence?: string; conclusionStrength?: string; supportingSourceCount?: number }>;
        upcomingGrowth?: Array<{ title?: string; companies?: string[]; sourceIds?: string[]; evidence?: string[]; evidenceGaps?: string[]; confidence?: string; conclusionStrength?: string; supportingSourceCount?: number }>;
        sustainability?: Array<{ title?: string; changeReason?: string }>;
        bubbleRisks?: Array<{ companies?: string[] }>;
        representativeCompanies?: Array<{ label?: string; companies?: string[] }>;
        stageCompanies?: Array<{ label?: string; companies?: string[] }>;
        evidenceSources?: Array<{ id?: string; source?: string; signalType?: string }>;
        industryPackets?: Array<{ industry?: string; changeStatus?: string; evidenceHash?: string; stage?: string; scores?: { growth?: number; evidence?: number; bubbleRisk?: number } }>;
        coverageReview?: Array<{ label?: string; sourceCount?: number; sourceIds?: string[] }>;
        analysisScope?: { totalIndustryCount?: number; changedIndustryCount?: number; unchangedIndustryCount?: number };
        changeLog?: string[];
        executiveSummary?: string[];
        confidenceSummary?: string;
      };
    };
    const job = JSON.parse(readFileSync(outputJobPath, "utf8")) as { id?: string; status?: string; radarGeneratedAt?: string };
    const sql = readFileSync(outputSqlPath, "utf8");

    expect(radarCache.version).toBe("v2");
    expect(radarCache.radar?.model).toBe("deepseek-v4-flash");
    expect(radarCache.radar?.sourceCount).toBeGreaterThanOrEqual(5);
    const demotedGrowth = radarCache.radar?.sustainability?.find((item) => item.title === "创新药商业化利润拐点");
    expect(radarCache.radar?.solidGrowth).toHaveLength(0);
    expect(demotedGrowth?.companies).toEqual(["百济神州", "药明康德"]);
    expect(demotedGrowth?.sourceIds).toContain("S1");
    expect(demotedGrowth?.evidence?.join(" ")).toContain("低基数/一次性因素需核验");
    expect(demotedGrowth?.evidenceGaps).toContain("缺现金流");
    expect(demotedGrowth).toMatchObject({
      confidence: "中",
      conclusionStrength: "观察",
      supportingSourceCount: expect.any(Number),
    });
    expect(demotedGrowth?.supportingSourceCount).toBe(demotedGrowth?.sourceIds?.length);
    expect(radarCache.radar?.representativeCompanies?.find((item) => item.label === "扎实增长产业中的代表公司")?.companies).toEqual([]);
    expect(radarCache.radar?.stageCompanies?.find((item) => item.label === "上升产业中的领军人物")?.companies).toEqual([]);
    expect(radarCache.radar?.bubbleRisks?.[0].companies).toEqual(["万丰奥威(002085.SZ)"]);
    const formalItems = [
      ...(radarCache.radar?.solidGrowth ?? []),
      ...(radarCache.radar?.sustainability ?? []),
      ...(radarCache.radar?.bubbleRisks ?? []),
      ...(radarCache.radar?.upcomingGrowth ?? []),
      ...(radarCache.radar?.decliningIndustries ?? []),
    ];
    expect(formalItems.every((item) => item.sourceIds?.length)).toBe(true);
    expect(new Set(formalItems.map((item) => item.title)).size).toBe(formalItems.length);
    expect(canonicalTitles(formalItems)).toHaveLength(new Set(canonicalTitles(formalItems)).size);
    expect(radarCache.radar?.industryPackets?.length).toBeGreaterThanOrEqual(4);
    expect(radarCache.radar?.analysisScope).toMatchObject({ totalIndustryCount: 14, changedIndustryCount: 13, unchangedIndustryCount: 1 });
    const newDrugPacket = radarCache.radar?.industryPackets?.find((packet) => packet.industry === "创新药/医疗服务");
    expect(newDrugPacket).toMatchObject({ stage: "继续观察", scores: { evidence: expect.any(Number), growth: expect.any(Number), bubbleRisk: expect.any(Number) } });
    expect(newDrugPacket?.scores?.growth).toBeLessThan(68);
    expect(newDrugPacket?.scores?.declineRisk).toBeLessThanOrEqual(60);
    expect(radarCache.radar?.industryPackets?.find((packet) => packet.industry === "光伏产业链")).toMatchObject({ stage: "衰退" });
    const propertyPacket = radarCache.radar?.industryPackets?.find((packet) => packet.industry === "地产链");
    expect(propertyPacket).toMatchObject({ stage: "衰退" });
    expect(propertyPacket?.scores?.growth).toBeLessThanOrEqual(49);
    expect(propertyPacket?.scores?.declineRisk).toBeGreaterThanOrEqual(72);
    expect(radarCache.radar?.industryPackets?.find((packet) => packet.industry === "铜/铝")?.stage).toBe("继续观察");
    expect(radarCache.radar?.industryPackets?.find((packet) => packet.industry === "钢铁长材/板材")?.stage).not.toBe("衰退");
    expect(radarCache.radar?.industryPackets?.find((packet) => packet.industry === "汽车/智能驾驶")?.stage).not.toBe("衰退");
    expect(radarCache.radar?.industryPackets?.find((packet) => packet.industry === "新能源汽车/智能驾驶")?.stage).not.toBe("衰退");
    expect(radarCache.radar?.industryPackets?.find((packet) => packet.industry === "CXO")?.stage).not.toBe("衰退");
    expect(radarCache.radar?.industryPackets?.find((packet) => packet.industry === "港股银行/保险")).toMatchObject({ stage: "证据不足" });
    expect(radarCache.radar?.industryPackets?.find((packet) => packet.industry === "白酒")?.stage).not.toBe("衰退");
    expect(radarCache.radar?.industryPackets?.find((packet) => packet.industry === "港股物业")).toMatchObject({ stage: "证据不足" });
    expect(radarCache.radar?.industryPackets?.find((packet) => packet.industry === "存储芯片")).toMatchObject({ stage: expect.not.stringMatching("扎实增长"), scores: { evidence: expect.any(Number) } });
    expect(radarCache.radar?.industryPackets?.find((packet) => packet.industry === "存储芯片")?.scores?.evidence).toBeLessThanOrEqual(45);
    expect(radarCache.radar?.industryPackets?.find((packet) => packet.industry === "存储芯片")?.scores?.growth).toBeLessThan(68);
    expect(radarCache.radar?.coverageReview?.find((item) => item.label === "存储芯片")).toMatchObject({
      sourceCount: expect.any(Number),
      sourceIds: expect.any(Array),
    });
    expect(radarCache.radar?.coverageReview?.find((item) => item.label === "存储芯片")?.sourceCount).toBeGreaterThan(0);
    expect(radarCache.radar?.coverageReview?.find((item) => item.label === "存储芯片")?.sourceIds?.length).toBeGreaterThan(0);
    expect(radarCache.radar?.sustainability?.some((item) => item.sourceIds?.length === 0)).toBe(false);
    expect(radarCache.radar?.sustainability?.filter((item) => /平稳现金流|高股息/.test(item.title ?? ""))).toHaveLength(1);
    expect(radarCache.radar?.decliningIndustries?.filter((item) => /光伏/.test(item.title ?? "") || item.industries?.some((industry) => /光伏/.test(industry ?? "")))).toHaveLength(1);
    expect(radarCache.radar?.evidenceSources?.some((source) => source.source === "东方财富业绩报表" && source.signalType === "financial_metric")).toBe(true);
    expect(radarCache.radar?.changeLog?.join(" ")).toContain("新增");
    expect(job).toMatchObject({ id: "job-test", status: "completed" });
    expect(job.radarGeneratedAt).toBe(radarCache.radar?.generatedAt);
    expect(sql).toContain("INSERT OR REPLACE INTO radar_runs");
    expect(sql).toContain("INSERT OR REPLACE INTO radar_items");
    expect(sql).toContain("INSERT OR REPLACE INTO indicator_values");
    expect(sql).toContain("INSERT OR REPLACE INTO evidence_items");
  });

  test("removes stale formal wording and model-provided companies when no formal sections survive", () => {
    const workdir = mkdtempSync(join(tmpdir(), "radar-analysis-empty-formal-"));
    const evidencePath = join(workdir, "evidence.json");
    const previousPath = join(workdir, "previous.json");
    const modelPath = join(workdir, "model.json");
    const outputRadarPath = join(workdir, "radar.json");
    const outputJobPath = join(workdir, "job.json");

    const output = modelOutput();
    output.solidGrowth = [];
    output.sustainability = [];
    output.bubbleRisks = [];
    output.upcomingGrowth = [];
    output.decliningIndustries = [];
    output.executiveSummary = ["存储芯片涨价周期得到业绩确认，维持正式结论。"];
    output.changeLog = ["维持存储芯片为solid growth，维持光伏为declining industries。"];
    output.confidenceSummary = "总体置信度高，增长类证据充分。";
    output.representativeCompanies = [{ label: "扎实增长产业中的代表公司", companies: ["德明利", "美光"], note: "来自本轮扎实增长正式结论。" }];
    output.stageCompanies = [{ label: "上升产业中的领军人物", companies: ["迪哲医药"], note: "来自扎实增长或即将增长方向。" }];

    writeFileSync(evidencePath, JSON.stringify(evidenceSnapshot()), "utf8");
    writeFileSync(previousPath, JSON.stringify(previousRadarCache()), "utf8");
    writeFileSync(modelPath, JSON.stringify(output), "utf8");

    execFileSync(
      "node",
      [
        "scripts/run_radar_analysis.mjs",
        "--evidence",
        evidencePath,
        "--previous",
        previousPath,
        "--job-id",
        "job-empty-formal",
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
      radar?: {
        executiveSummary?: string[];
        changeLog?: string[];
        confidenceSummary?: string;
        representativeCompanies?: Array<{ companies?: string[]; note?: string }>;
        stageCompanies?: Array<{ companies?: string[]; note?: string }>;
      };
    };

    expect(radarCache.radar?.executiveSummary?.[0]).toContain("没有行业达到正式结论门槛");
    expect(radarCache.radar?.executiveSummary?.join(" ")).not.toContain("维持正式结论");
    expect(radarCache.radar?.executiveSummary?.join(" ")).not.toContain("扎实增长");
    expect(radarCache.radar?.changeLog?.join(" ")).not.toMatch(/solidGrowth|solid growth|decliningIndustries|declining industries|维持存储芯片/);
    expect(radarCache.radar?.confidenceSummary).toContain("总体置信度中等");
    expect(radarCache.radar?.confidenceSummary).not.toContain("总体置信度高");
    expect((radarCache.radar?.representativeCompanies ?? []).flatMap((item) => item.companies ?? [])).toHaveLength(0);
    expect((radarCache.radar?.stageCompanies ?? []).flatMap((item) => item.companies ?? [])).toHaveLength(0);
    expect(radarCache.radar?.representativeCompanies?.map((item) => item.note).join(" ")).not.toContain("来自本轮扎实增长正式结论");
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

    const requestBody = JSON.parse(readFileSync(requestPath, "utf8")) as { reasoning_effort?: string; messages?: Array<{ content?: string }> };
    const stablePayload = JSON.parse(String(requestBody.messages?.[2].content)) as {
      evidenceDigest?: { citations?: Array<{ source?: string; qualityScore?: number; evidenceProfile?: string; anysearchTags?: string[]; anysearchContentTypes?: string[]; anysearchFreshness?: string }>; packets?: unknown[] };
      structuredFacts?: { financialFacts?: unknown[]; industryFacts?: unknown[]; companyCandidates?: unknown[]; industryPackets?: Array<{ scores?: { evidence?: number }; industry?: string }> };
    };
    const volatilePayload = JSON.parse(String(requestBody.messages?.[3].content)) as {
      analysisScope?: { changedIndustryPackets?: Array<{ scores?: { evidence?: number }; industry?: string }>; unchangedIndustrySummaries?: Array<{ scores?: unknown }>; totalIndustryCount?: number };
      previousScan?: { id?: string };
    };

    expect(requestBody.reasoning_effort).toBe("max");
    expect(volatilePayload.previousScan).toMatchObject({ id: "radar-previous" });
    expect(JSON.stringify(stablePayload)).not.toContain("radar-previous");
    expect(JSON.stringify(stablePayload)).not.toContain("changedIndustryPackets");
    expect(volatilePayload.analysisScope?.totalIndustryCount).toBe(14);
    expect(volatilePayload.analysisScope?.changedIndustryPackets?.length).toBe(13);
    expect(volatilePayload.analysisScope?.unchangedIndustrySummaries?.length).toBe(1);
    expect(volatilePayload.analysisScope?.changedIndustryPackets?.every((packet) => packet.scores)).toBe(true);
    expect(volatilePayload.analysisScope?.changedIndustryPackets?.find((packet) => packet.industry === "存储芯片")?.scores?.evidence).toBeLessThanOrEqual(45);
    expect(stablePayload.evidenceDigest?.citations?.length).toBeGreaterThan(4);
    expect(stablePayload.evidenceDigest?.citations?.find((source) => source.source === "AnySearch")).toMatchObject({
      qualityScore: 86,
      evidenceProfile: "industry_data",
      anysearchFreshness: "week",
      anysearchTags: ["finance.market", "business.industry"],
      anysearchContentTypes: ["data", "news", "web"],
    });
    expect(stablePayload.structuredFacts?.financialFacts?.length).toBeGreaterThan(0);
    expect(stablePayload.structuredFacts?.industryFacts?.length).toBeGreaterThan(0);
    expect(stablePayload.structuredFacts?.companyCandidates?.length).toBeGreaterThan(0);
    expect(stablePayload.structuredFacts?.industryPackets?.length).toBe(14);
    expect(stablePayload.structuredFacts?.industryPackets?.find((packet) => packet.industry === "存储芯片")?.scores?.evidence).toBeLessThanOrEqual(45);
  });

  test("keeps stable evidence before volatile scan context for prefix cache reuse", () => {
    const workdir = mkdtempSync(join(tmpdir(), "radar-analysis-prefix-"));
    const evidencePath = join(workdir, "evidence.json");
    const previousAPath = join(workdir, "previous-a.json");
    const previousBPath = join(workdir, "previous-b.json");
    const modelPath = join(workdir, "model.json");
    const requestAPath = join(workdir, "request-a.json");
    const requestBPath = join(workdir, "request-b.json");

    const previousA = previousRadarCache();
    const previousB = previousRadarCache();
    previousB.radar.id = "radar-later";
    previousB.radar.generatedAt = "2026-05-22T02:30:00.000Z";
    previousB.radar.executiveSummary = ["本轮摘要发生变化，但稳定证据包应仍在前缀中复用。"];

    writeFileSync(evidencePath, JSON.stringify(evidenceSnapshot()), "utf8");
    writeFileSync(previousAPath, JSON.stringify(previousA), "utf8");
    writeFileSync(previousBPath, JSON.stringify(previousB), "utf8");
    writeFileSync(modelPath, JSON.stringify(modelOutput()), "utf8");

    for (const [previousPath, requestPath] of [
      [previousAPath, requestAPath],
      [previousBPath, requestBPath],
    ]) {
      execFileSync(
        "node",
        [
          "scripts/run_radar_analysis.mjs",
          "--evidence",
          evidencePath,
          "--previous",
          previousPath,
          "--job-id",
          "job-prefix",
          "--mock-model-output",
          modelPath,
          "--debug-request-output",
          requestPath,
        ],
        { stdio: "pipe" },
      );
    }

    const requestA = readFileSync(requestAPath, "utf8");
    const requestB = readFileSync(requestBPath, "utf8");
    expect(commonPrefixRatio(requestA, requestB)).toBeGreaterThan(0.7);
    expect(requestA.indexOf("evidenceDigest")).toBeLessThan(requestA.indexOf("previousScan"));
  });

  test("writes DeepSeek cache usage to the completed radar job", () => {
    const workdir = mkdtempSync(join(tmpdir(), "radar-analysis-usage-"));
    const evidencePath = join(workdir, "evidence.json");
    const previousPath = join(workdir, "previous.json");
    const responsePath = join(workdir, "deepseek-response.json");
    const outputRadarPath = join(workdir, "radar-cache.json");
    const outputJobPath = join(workdir, "job.json");

    writeFileSync(evidencePath, JSON.stringify(evidenceSnapshot()), "utf8");
    writeFileSync(previousPath, JSON.stringify(previousRadarCache()), "utf8");
    writeFileSync(
      responsePath,
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(modelOutput()) } }],
        usage: {
          prompt_tokens: 1000,
          prompt_cache_hit_tokens: 750,
          prompt_cache_miss_tokens: 250,
          completion_tokens: 120,
          total_tokens: 1120,
        },
      }),
      "utf8",
    );

    execFileSync(
      "node",
      [
        "scripts/run_radar_analysis.mjs",
        "--evidence",
        evidencePath,
        "--previous",
        previousPath,
        "--job-id",
        "job-usage",
        "--mock-deepseek-response",
        responsePath,
        "--output-radar",
        outputRadarPath,
        "--output-job",
        outputJobPath,
      ],
      { stdio: "pipe" },
    );

    const job = JSON.parse(readFileSync(outputJobPath, "utf8")) as {
      tokenUsage?: { promptCacheHitTokens?: number; promptCacheMissTokens?: number; completionTokens?: number; totalTokens?: number; cacheHitRate?: number };
    };
    expect(job.tokenUsage).toMatchObject({
      promptCacheHitTokens: 750,
      promptCacheMissTokens: 250,
      completionTokens: 120,
      totalTokens: 1120,
      cacheHitRate: 0.75,
    });
  });

  test("does not let a low-base property item promote the property chain into solid growth", () => {
    const workdir = mkdtempSync(join(tmpdir(), "radar-analysis-property-"));
    const evidencePath = join(workdir, "evidence.json");
    const previousPath = join(workdir, "previous.json");
    const modelPath = join(workdir, "model.json");
    const outputRadarPath = join(workdir, "radar-cache.json");

    const output = modelOutput();
    output.decliningIndustries = output.decliningIndustries.filter((item) => !item.title.includes("地产"));
    output.solidGrowth.push({
      title: "地产链低基数利润修复",
      industries: ["地产链"],
      companies: ["万科A"],
      thesis: "净利润同比+1200%，但销售面积仍弱，低基数因素明显。",
      drivers: ["低基数修复"],
      evidence: ["S10 财报低基数改善", "S11 销售面积承压"],
      sourceIds: ["S10", "S11"],
      evidenceTypes: ["announcement", "official"],
      supportingSourceCount: 2,
      conclusionStrength: "正式结论",
      evidenceGaps: [],
      driverTags: ["需求"],
      sustainabilityTier: "短期催化",
      confidence: "高",
      durability: "短期",
      riskLevel: "高",
      counterEvidenceConditions: ["销售面积继续下降"],
      turningPoints: ["销售回升"],
    });
    writeFileSync(evidencePath, JSON.stringify(evidenceSnapshot()), "utf8");
    writeFileSync(previousPath, JSON.stringify(previousRadarCache()), "utf8");
    writeFileSync(modelPath, JSON.stringify(output), "utf8");

    execFileSync(
      "node",
      [
        "scripts/run_radar_analysis.mjs",
        "--evidence",
        evidencePath,
        "--previous",
        previousPath,
        "--job-id",
        "job-property",
        "--mock-model-output",
        modelPath,
        "--output-radar",
        outputRadarPath,
      ],
      { stdio: "pipe" },
    );

    const radarCache = JSON.parse(readFileSync(outputRadarPath, "utf8")) as { radar?: { industryPackets?: Array<{ industry?: string; stage?: string; scores?: { growth?: number; declineRisk?: number } }> } };
    const propertyPacket = radarCache.radar?.industryPackets?.find((packet) => packet.industry === "地产链");

    expect(propertyPacket?.stage).toBe("衰退");
    expect(propertyPacket?.scores?.growth).toBeLessThanOrEqual(49);
    expect(propertyPacket?.scores?.declineRisk).toBeGreaterThanOrEqual(72);
  });

  test("adds a rule-backed solid growth item when model misses a hard-data and financial cross-validated industry", () => {
    const workdir = mkdtempSync(join(tmpdir(), "radar-analysis-rule-growth-"));
    const evidencePath = join(workdir, "evidence.json");
    const previousPath = join(workdir, "previous.json");
    const modelPath = join(workdir, "model.json");
    const outputRadarPath = join(workdir, "radar-cache.json");

    const evidence = evidenceSnapshot();
    const shippingFinancial = {
      source: "东方财富业绩报表",
      query: "航运物流 财报 营收 净利润 现金流",
      title: "招商南油 2026Q1 营收同比 14.19%，净利润同比 51.73%",
      url: "https://data.eastmoney.com/bbsj/202603/yjbb.html#601975",
      sourceType: "announcement",
      signalType: "financial_metric",
      weight: 4,
      company: "招商南油",
      code: "601975.SH",
      market: "A股",
      industry: "航运物流",
      summary: "航运公司财报显示收入与净利润同步改善，经营现金流为正。",
    };
    evidence.sources.push(shippingFinancial);
    const shippingPacket = evidence.industryPackets.find((packet) => packet.industry === "航运物流");
    Object.assign(shippingPacket ?? {}, {
      sourceCount: 8,
      evidenceTypes: ["hard_data", "announcement", "market"],
      signalTypes: ["freight_rate", "financial_metric"],
      evidenceGaps: [],
      sources: [evidence.sources[4], shippingFinancial],
      financialFacts: [
        {
          company: "招商南油",
          code: "601975.SH",
          market: "A股",
          industry: "航运物流",
          yoy: 51.73,
          metrics: { revenueYoy: 14.19, netProfitYoy: 51.73, operatingCashflowPerShare: 0.06 },
        },
      ],
      companyCandidates: [{ company: "招商南油", code: "601975.SH", market: "A股", industry: "航运物流", evidenceStrength: 12, sourceTypes: ["announcement", "market"] }],
    });
    const output = modelOutput();
    output.solidGrowth = [];
    writeFileSync(evidencePath, JSON.stringify(evidence), "utf8");
    writeFileSync(previousPath, JSON.stringify(previousRadarCache()), "utf8");
    writeFileSync(modelPath, JSON.stringify(output), "utf8");

    execFileSync(
      "node",
      [
        "scripts/run_radar_analysis.mjs",
        "--evidence",
        evidencePath,
        "--previous",
        previousPath,
        "--job-id",
        "job-rule-growth",
        "--mock-model-output",
        modelPath,
        "--output-radar",
        outputRadarPath,
      ],
      { stdio: "pipe" },
    );

    const radarCache = JSON.parse(readFileSync(outputRadarPath, "utf8")) as {
      radar?: {
        solidGrowth?: Array<{ title?: string; confidence?: string; conclusionStrength?: string; companies?: string[]; evidenceTypes?: string[] }>;
        industryPackets?: Array<{ industry?: string; stage?: string }>;
      };
    };

    expect(radarCache.radar?.solidGrowth?.[0]).toMatchObject({
      title: "航运物流景气与业绩共振",
      confidence: "中",
      conclusionStrength: "正式结论",
    });
    expect(radarCache.radar?.solidGrowth?.[0].companies).toContain("招商南油");
    expect(radarCache.radar?.solidGrowth?.[0].evidenceTypes).toEqual(expect.arrayContaining(["hard_data", "announcement"]));
    expect(radarCache.radar?.industryPackets?.find((packet) => packet.industry === "航运物流")?.stage).toBe("扎实增长");
  });

  test("promotes the strongest multi-company growth observation when no hard-data solid growth survives", () => {
    const workdir = mkdtempSync(join(tmpdir(), "radar-analysis-observation-growth-"));
    const evidencePath = join(workdir, "evidence.json");
    const previousPath = join(workdir, "previous.json");
    const modelPath = join(workdir, "model.json");
    const outputRadarPath = join(workdir, "radar-cache.json");

    const evidence = evidenceSnapshot();
    const storageA = {
      source: "东方财富业绩快报",
      query: "存储芯片 财报 营收 净利润",
      title: "佰维存储 2025年营收同比 68.72%，净利润同比 437.56%",
      url: "https://data.eastmoney.com/bbsj/202512/yjbb.html#688525",
      sourceType: "announcement",
      signalType: "financial_metric",
      weight: 4,
      company: "佰维存储",
      code: "688525.SH",
      market: "A股",
      industry: "存储芯片",
    };
    const storageB = {
      source: "东方财富业绩预告",
      query: "存储芯片 业绩预告 预增",
      title: "德明利 2025年净利润预增 115.82% 至 136.77%",
      url: "https://data.eastmoney.com/bbsj/202512/yjyg.html#001309",
      sourceType: "announcement",
      signalType: "financial_metric",
      weight: 4,
      company: "德明利",
      code: "001309.SZ",
      market: "A股",
      industry: "存储芯片",
    };
    const storageNews = {
      source: "AnySearch",
      query: "存储芯片 涨价 HBM AI服务器",
      title: "存储芯片涨价周期受 AI 服务器需求推动",
      url: "https://anysearch.example.com/storage-cycle",
      sourceType: "news",
      signalType: "external_search",
      weight: 2,
      industry: "存储芯片",
    };
    evidence.sources.push(storageA, storageB, storageNews);
    const output = modelOutput();
    output.solidGrowth = [];
    output.upcomingGrowth = [
      {
        title: "存储芯片涨价周期",
        industries: ["存储芯片"],
        companies: ["佰维存储", "德明利"],
        thesis: "存储芯片涨价周期持续，AI需求推动，多家公司公告显示营收和利润增长，可持续性需观察。",
        drivers: ["AI需求", "价格上涨"],
        evidence: ["S12 佰维存储财报", "S13 德明利业绩预告", "S14 存储涨价线索"],
        sourceIds: ["S12", "S13", "S14", "S6"],
        evidenceTypes: ["announcement", "news"],
        supportingSourceCount: 4,
        conclusionStrength: "观察",
        evidenceGaps: ["缺现金流", "缺多源验证"],
        driverTags: ["需求", "价格"],
        sustainabilityTier: "中期景气",
        confidence: "中",
        durability: "中期",
        riskLevel: "中",
        counterEvidenceConditions: ["存储价格回落"],
        turningPoints: ["HBM需求下修"],
      },
    ];
    writeFileSync(evidencePath, JSON.stringify(evidence), "utf8");
    writeFileSync(previousPath, JSON.stringify(previousRadarCache()), "utf8");
    writeFileSync(modelPath, JSON.stringify(output), "utf8");

    execFileSync(
      "node",
      [
        "scripts/run_radar_analysis.mjs",
        "--evidence",
        evidencePath,
        "--previous",
        previousPath,
        "--job-id",
        "job-observation-growth",
        "--mock-model-output",
        modelPath,
        "--output-radar",
        outputRadarPath,
      ],
      { stdio: "pipe" },
    );

    const radarCache = JSON.parse(readFileSync(outputRadarPath, "utf8")) as {
      radar?: {
        solidGrowth?: Array<{ title?: string; confidence?: string; conclusionStrength?: string; companies?: string[]; evidenceGaps?: string[] }>;
        upcomingGrowth?: Array<{ title?: string }>;
      };
    };

    expect(radarCache.radar?.solidGrowth?.[0]).toMatchObject({
      title: "存储芯片涨价周期",
      confidence: "中",
      conclusionStrength: "正式结论",
    });
    expect(radarCache.radar?.solidGrowth?.[0].companies).toEqual(["佰维存储", "德明利"]);
    expect(radarCache.radar?.solidGrowth?.[0].evidenceGaps).toEqual(expect.arrayContaining(["缺现金流"]));
    expect(radarCache.radar?.upcomingGrowth?.some((item) => item.title === "存储芯片涨价周期")).toBe(false);
  });

  test("promotes rich company-level semiconductor evidence without requiring price data", () => {
    const workdir = mkdtempSync(join(tmpdir(), "radar-analysis-rich-semi-growth-"));
    const evidencePath = join(workdir, "evidence.json");
    const previousPath = join(workdir, "previous.json");
    const modelPath = join(workdir, "model.json");
    const outputRadarPath = join(workdir, "radar-cache.json");

    const evidence = evidenceSnapshot();
    const semiSources = [
      {
        source: "东方财富业绩报表",
        query: "半导体 财报 营收 净利润",
        title: "德明利 2026Q1 营收同比 502.08%，净利润同比 4943.39%",
        url: "https://data.eastmoney.com/bbsj/202603/yjbb.html#001309",
        sourceType: "announcement",
        signalType: "financial_metric",
        weight: 4,
        company: "德明利",
        code: "001309.SZ",
        market: "A股",
        industry: "半导体",
      },
      {
        source: "东方财富业绩报表",
        query: "半导体 财报 营收 净利润",
        title: "源杰科技 2025年营收同比 138.50%，净利润同比 3212.62%",
        url: "https://data.eastmoney.com/bbsj/202512/yjbb.html#688498",
        sourceType: "announcement",
        signalType: "financial_metric",
        weight: 4,
        company: "源杰科技",
        code: "688498.SH",
        market: "A股",
        industry: "半导体",
      },
      {
        source: "东方财富业绩报表",
        query: "半导体 财报 营收 净利润",
        title: "华虹公司 2026Q1 营收同比 18.22%，净利润同比 513.10%",
        url: "https://data.eastmoney.com/bbsj/202603/yjbb.html#688347",
        sourceType: "announcement",
        signalType: "financial_metric",
        weight: 4,
        company: "华虹公司",
        code: "688347.SH",
        market: "A股",
        industry: "半导体",
      },
      {
        source: "AnySearch",
        query: "半导体 AI算力 财报 景气",
        title: "AI算力需求推动半导体链条景气改善",
        url: "https://anysearch.example.com/semi-ai",
        sourceType: "news",
        signalType: "external_search",
        weight: 2,
        industry: "半导体/AI算力",
      },
    ];
    evidence.sources.push(...semiSources);
    evidence.industryPackets.push({
      group: "科技成长",
      industry: "半导体/AI算力",
      status: "scanned",
      evidenceHash: "hash-rich-semi",
      sourceCount: 12,
      evidenceTypes: ["news", "announcement", "market"],
      signalTypes: ["external_search", "financial_metric"],
      evidenceGaps: ["缺价格"],
      sources: semiSources,
      financialFacts: [
        { company: "德明利", code: "001309.SZ", market: "A股", industry: "半导体", metrics: { revenueYoy: 502.08, netProfitYoy: 4943.39, netProfit: 3346185437.62, operatingCashflowPerShare: -1.06 } },
        { company: "源杰科技", code: "688498.SH", market: "A股", industry: "半导体", metrics: { revenueYoy: 138.5, netProfitYoy: 3212.62, netProfit: 190924031.75, operatingCashflowPerShare: 1.74 } },
        { company: "华虹公司", code: "688347.SH", market: "A股", industry: "半导体", metrics: { revenueYoy: 18.22, netProfitYoy: 513.1, netProfit: 139562597, operatingCashflowPerShare: 0.52 } },
        { company: "盛合晶微", code: "688820.SH", market: "A股", industry: "半导体", metrics: { revenueYoy: 13.13, netProfitYoy: 51.55, netProfit: 191328450.33, operatingCashflowPerShare: 0.36 } },
      ],
      industryFacts: [],
      companyCandidates: [
        { company: "德明利", code: "001309.SZ", market: "A股", industry: "半导体", evidenceStrength: 16, sourceTypes: ["announcement"] },
        { company: "源杰科技", code: "688498.SH", market: "A股", industry: "半导体", evidenceStrength: 12, sourceTypes: ["announcement"] },
        { company: "华虹公司", code: "688347.SH", market: "A股", industry: "半导体", evidenceStrength: 8, sourceTypes: ["announcement"] },
      ],
    });
    const output = modelOutput();
    output.solidGrowth = [];
    output.sustainability = [];
    output.upcomingGrowth = [];
    writeFileSync(evidencePath, JSON.stringify(evidence), "utf8");
    writeFileSync(previousPath, JSON.stringify(previousRadarCache()), "utf8");
    writeFileSync(modelPath, JSON.stringify(output), "utf8");

    execFileSync(
      "node",
      [
        "scripts/run_radar_analysis.mjs",
        "--evidence",
        evidencePath,
        "--previous",
        previousPath,
        "--job-id",
        "job-rich-semi-growth",
        "--mock-model-output",
        modelPath,
        "--output-radar",
        outputRadarPath,
      ],
      { stdio: "pipe" },
    );

    const radarCache = JSON.parse(readFileSync(outputRadarPath, "utf8")) as {
      radar?: {
        solidGrowth?: Array<{ title?: string; confidence?: string; conclusionStrength?: string; companies?: string[]; evidenceGaps?: string[] }>;
        sustainability?: Array<{ title?: string; industries?: string[]; confidence?: string; conclusionStrength?: string; companies?: string[]; evidenceGaps?: string[] }>;
        industryPackets?: Array<{ industry?: string; stage?: string; evidenceGaps?: string[] }>;
      };
    };

    expect(radarCache.radar?.solidGrowth?.some((item) => item.title === "半导体/AI算力景气与业绩共振")).toBe(true);
    const solid = radarCache.radar?.solidGrowth?.find((item) => item.title === "半导体/AI算力景气与业绩共振");
    expect(solid).toMatchObject({ confidence: "中", conclusionStrength: "正式结论" });
    expect(solid?.companies).toEqual(expect.arrayContaining(["源杰科技", "华虹公司"]));
    expect(solid?.companies).not.toContain("德明利");
    expect(solid?.evidenceGaps).toEqual(expect.arrayContaining(["缺价格"]));
    expect(radarCache.radar?.sustainability?.some((item) => item.title === "半导体/AI算力增长可持续性")).toBe(false);
    expect(radarCache.radar?.sustainability?.some((item) => item.industries?.includes("半导体/AI算力"))).toBe(false);
    expect(radarCache.radar?.industryPackets?.find((packet) => packet.industry === "半导体/AI算力")?.stage).toBe("扎实增长");
  });

  test("does not show a missing-financials packet as solid growth in the all-industry table", () => {
    const workdir = mkdtempSync(join(tmpdir(), "radar-analysis-missing-financials-stage-"));
    const evidencePath = join(workdir, "evidence.json");
    const previousPath = join(workdir, "previous.json");
    const modelPath = join(workdir, "model.json");
    const outputRadarPath = join(workdir, "radar-cache.json");

    const evidence = evidenceSnapshot();
    const output = modelOutput();
    output.solidGrowth = [];
    output.sustainability = [];
    output.upcomingGrowth = [];
    writeFileSync(evidencePath, JSON.stringify(evidence), "utf8");
    writeFileSync(previousPath, JSON.stringify(previousRadarCache()), "utf8");
    writeFileSync(modelPath, JSON.stringify(output), "utf8");

    execFileSync(
      "node",
      [
        "scripts/run_radar_analysis.mjs",
        "--evidence",
        evidencePath,
        "--previous",
        previousPath,
        "--job-id",
        "job-missing-financials-stage",
        "--mock-model-output",
        modelPath,
        "--output-radar",
        outputRadarPath,
      ],
      { stdio: "pipe" },
    );

    const radarCache = JSON.parse(readFileSync(outputRadarPath, "utf8")) as {
      radar?: {
        sustainability?: Array<{ title?: string }>;
        industryPackets?: Array<{ industry?: string; stage?: string; evidenceGaps?: string[] }>;
      };
    };
    expect(radarCache.radar?.industryPackets?.find((packet) => packet.industry === "钢铁长材/板材")?.stage).not.toBe("扎实增长");
    expect(radarCache.radar?.sustainability?.some((item) => item.title?.includes("钢铁长材"))).toBe(false);
  });

  test("rejects unsuitable or context-mismatched representative companies", () => {
    const workdir = mkdtempSync(join(tmpdir(), "radar-analysis-company-filter-"));
    const evidencePath = join(workdir, "evidence.json");
    const previousPath = join(workdir, "previous.json");
    const modelPath = join(workdir, "model.json");
    const outputRadarPath = join(workdir, "radar-cache.json");

    const evidence = evidenceSnapshot();
    evidence.sources.push(
      {
        source: "东方财富业绩报表",
        query: "A股 财报 营收 净利润 毛利率 经营现金流 养殖业",
        title: "*ST天山(300313.SZ) 2026Q1 营收同比 381.05%，净利润同比 183.91%",
        summary: "公司级财报：行业 养殖业，具体主业仍需核验。",
        sourceType: "announcement",
        signalType: "financial_metric",
        company: "*ST天山",
        code: "300313.SZ",
        market: "A股",
        industry: "养殖业",
        weight: 4,
      },
      {
        source: "东方财富业绩报表",
        query: "A股 财报 营收 净利润 毛利率 经营现金流 养殖业",
        title: "晓鸣股份(300967.SZ) 2025年净利润同比 2243.97%",
        summary: "公司级财报：行业 养殖业，具体主业仍需核验。",
        sourceType: "announcement",
        signalType: "financial_metric",
        company: "晓鸣股份",
        code: "300967.SZ",
        market: "A股",
        industry: "养殖业",
        weight: 4,
      },
    );
    const output = modelOutput();
    output.solidGrowth = [
      {
        title: "生猪养殖周期反转确认",
        industries: ["生猪养殖"],
        companies: ["*ST天山(300313.SZ)", "晓鸣股份(300967.SZ)"],
        thesis: "猪价上行，但公司级样本来自宽泛养殖业。",
        drivers: ["猪价上行"],
        evidence: ["外三元猪价上行", "*ST天山和晓鸣股份财报样本"],
        evidenceTypes: ["hard_data", "announcement"],
        supportingSourceCount: 3,
        conclusionStrength: "正式结论",
        evidenceGaps: [],
        driverTags: ["价格"],
        sustainabilityTier: "中期景气",
        confidence: "高",
        durability: "中期",
        riskLevel: "低",
        counterEvidenceConditions: ["猪价回落"],
        turningPoints: ["供给释放"],
      },
    ];
    output.sustainability = [];
    output.bubbleRisks = [];
    output.upcomingGrowth = [];
    output.decliningIndustries = [];

    writeFileSync(evidencePath, JSON.stringify(evidence), "utf8");
    writeFileSync(previousPath, JSON.stringify({ version: "v2", radar: null }), "utf8");
    writeFileSync(modelPath, JSON.stringify(output), "utf8");

    execFileSync(
      "node",
      [
        "scripts/run_radar_analysis.mjs",
        "--evidence",
        evidencePath,
        "--previous",
        previousPath,
        "--job-id",
        "job-company-filter",
        "--mock-model-output",
        modelPath,
        "--output-radar",
        outputRadarPath,
      ],
      { stdio: "pipe" },
    );

    const radarCache = JSON.parse(readFileSync(outputRadarPath, "utf8")) as {
      radar?: { solidGrowth?: Array<{ title?: string; companies?: string[] }>; representativeCompanies?: Array<{ companies?: string[] }> };
    };
    const allCompanies = [
      ...(radarCache.radar?.solidGrowth ?? []).flatMap((item) => item.companies ?? []),
      ...(radarCache.radar?.representativeCompanies ?? []).flatMap((item) => item.companies ?? []),
    ];

    expect(radarCache.radar?.solidGrowth?.some((item) => item.title === "生猪养殖周期反转确认")).toBe(false);
    expect(allCompanies.join(" ")).not.toContain("*ST天山");
    expect(allCompanies.join(" ")).not.toContain("晓鸣股份");
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
    {
      source: "AnySearch",
      query: "存储芯片 HBM 价格 库存 A股 港股",
      title: "存储芯片价格和 A/H 产业链订单搜索线索",
      url: "https://anysearch.example.com/storage",
      publishedAt: "2026-05-19T00:00:00Z",
      summary: "外部搜索发现价格和订单线索，仍需硬数据交叉验证。",
      sourceType: "news",
      signalType: "external_search",
      weight: 4,
      industry: "存储芯片",
      evidenceProfile: "industry_data",
      anysearchFreshness: "week",
      anysearchTags: ["finance.market", "business.industry"],
      anysearchContentTypes: ["data", "news", "web"],
      anysearchSource: "data",
      qualityScore: 86,
      anysearchScore: 0.82,
      anysearchSignalScores: { freshness: 12, authority: 31 },
      anysearchRequestId: "req_test",
      cached: false,
    },
    {
      source: "东方财富行业板块",
      query: "光伏产业链 亏损 过剩 硅料 价格",
      title: "光伏产业链持续亏损，产能过剩压力未消",
      url: "https://quote.eastmoney.com/center/boardlist.html#boards-BK0478",
      sourceType: "market",
      signalType: "financial_metric",
      weight: 3,
      industry: "光伏产业链",
    },
    {
      source: "东方财富概念板块",
      query: "低空经济 概念 涨幅 成交额 估值",
      title: "低空经济概念成交额放大，万丰奥威短期涨幅居前",
      url: "https://quote.eastmoney.com/center/boardlist.html#concept-low-altitude",
      sourceType: "market",
      signalType: "market_heat",
      weight: 3,
      company: "万丰奥威",
      code: "002085.SZ",
      market: "A股",
      industry: "低空经济",
    },
    {
      source: "AnySearch",
      query: "低空经济 订单 政策 风险",
      title: "低空经济政策催化但订单兑现不足",
      url: "https://anysearch.example.com/low-altitude",
      sourceType: "news",
      signalType: "external_search",
      weight: 2,
      company: "万丰奥威",
      code: "002085.SZ",
      market: "A股",
      industry: "低空经济",
    },
    {
      source: "AKShare/Sina期货日线",
      query: "光伏产业链 多晶硅 工业硅 价格",
      title: "工业硅价格低位，光伏硅料库存压力仍在",
      url: "https://finance.sina.com.cn/futures/quotes/SI0.shtml",
      sourceType: "hard_data",
      signalType: "commodity_price",
      weight: 5,
      industry: "光伏产业链",
    },
    {
      source: "国家统计局",
      query: "房地产开发 投资 销售面积 新开工",
      title: "房地产开发投资和销售面积继续承压",
      url: "https://www.stats.gov.cn/",
      sourceType: "official",
      signalType: "industry_stat",
      weight: 4,
      industry: "房地产开发",
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
      { group: "周期资源", industry: "铜/铝", status: "scanned", evidenceHash: "hash-copper-aluminum", sourceCount: 14, evidenceTypes: ["news", "hard_data", "official", "market"], signalTypes: ["external_search", "commodity_price"], evidenceGaps: [], themes: ["铜价上涨", "库存低位"], sources: [sources[3]], financialFacts: [], industryFacts: [], companyCandidates: [] },
      { group: "周期资源", industry: "钢铁长材/板材", status: "scanned", evidenceHash: "hash-steel-long-flat", sourceCount: 15, evidenceTypes: ["news", "hard_data", "market"], signalTypes: ["external_search", "commodity_price"], evidenceGaps: ["缺财报"], themes: ["钢铁复苏", "地产需求"], sources: [sources[3]], financialFacts: [], industryFacts: [], companyCandidates: [] },
      { group: "周期品", industry: "航运物流", status: "scanned", evidenceHash: "hash-ship-stable", sourceCount: 1, evidenceTypes: ["hard_data"], signalTypes: ["freight_rate"], evidenceGaps: ["缺财报"], sources: [sources[4]], financialFacts: [], industryFacts: [], companyCandidates: [] },
      { group: "科技成长", industry: "存储芯片", status: "scanned", evidenceHash: "hash-storage-anysearch", sourceCount: 12, evidenceTypes: ["news"], signalTypes: ["external_search"], evidenceGaps: ["缺财报", "缺价格", "缺销量"], sources: [sources[5]], financialFacts: [], industryFacts: [], companyCandidates: [] },
      { group: "过剩/衰退", industry: "光伏产业链", status: "scanned", evidenceHash: "hash-pv", sourceCount: 2, evidenceTypes: ["market", "hard_data"], signalTypes: ["financial_metric", "commodity_price"], evidenceGaps: [], sources: [sources[6], sources[9]], financialFacts: [], industryFacts: [], companyCandidates: [] },
      {
        group: "过剩/衰退",
        industry: "地产链",
        status: "scanned",
        evidenceHash: "hash-property",
        sourceCount: 8,
        evidenceTypes: ["hard_data", "announcement", "market"],
        signalTypes: ["financial_metric", "commodity_price"],
        evidenceGaps: [],
        sources: [
          {
            source: "东方财富业绩报表",
            query: "地产链 财报 营收 净利润",
            title: "地产链公司低基数利润同比改善",
            summary: "房地产销售仍弱，低基数下净利润同比改善，债务和需求压力未解。",
            sourceType: "announcement",
            signalType: "financial_metric",
            weight: 4,
            industry: "房地产开发",
          },
        ],
        financialFacts: [{ company: "万科A", industry: "房地产开发", yoy: 1200 }],
        industryFacts: [{ industry: "房地产开发", metric: "销售面积", value: -12 }],
        companyCandidates: [{ company: "万科A", industry: "房地产开发" }],
      },
      {
        group: "高景气成长",
        industry: "新能源汽车/智能驾驶",
        status: "scanned",
        evidenceHash: "hash-new-energy-auto",
        sourceCount: 4,
        evidenceTypes: ["official", "market"],
        signalTypes: ["industry_stat"],
        evidenceGaps: ["缺财报"],
        sources: [sources[2]],
        financialFacts: [],
        industryFacts: [{ industry: "汽车/智能驾驶" }],
        companyCandidates: [],
      },
      {
        group: "医药医疗",
        industry: "CXO",
        status: "scanned",
        evidenceHash: "hash-cxo",
        sourceCount: 6,
        evidenceTypes: ["announcement", "market"],
        signalTypes: ["financial_metric"],
        evidenceGaps: [],
        themes: ["医药投融资", "订单恢复"],
        sources: [
          {
            source: "东方财富业绩报表",
            query: "CXO 财报 订单 恢复",
            title: "CXO 订单恢复但投融资仍弱",
            summary: "订单恢复线索出现，医药投融资仍低迷，不能直接判定衰退。",
            sourceType: "announcement",
            signalType: "financial_metric",
            weight: 4,
            industry: "CXO",
          },
        ],
        financialFacts: [{ company: "药明康德", industry: "CXO" }],
        industryFacts: [],
        companyCandidates: [{ company: "药明康德", industry: "CXO" }],
      },
      {
        group: "金融地产",
        industry: "港股银行/保险",
        status: "scanned",
        evidenceHash: "hash-hk-bank-insurance",
        sourceCount: 3,
        evidenceTypes: ["news", "market"],
        signalTypes: ["external_search"],
        evidenceGaps: ["缺财报"],
        themes: ["高股息", "保险复苏"],
        sources: [{ source: "AnySearch", title: "港股高股息和保险复苏线索", sourceType: "news", signalType: "external_search", weight: 2, industry: "港股银行/保险" }],
        financialFacts: [],
        industryFacts: [],
        companyCandidates: [],
      },
      {
        group: "消费",
        industry: "白酒",
        status: "scanned",
        evidenceHash: "hash-baijiu",
        sourceCount: 8,
        evidenceTypes: ["news", "hard_data", "market"],
        signalTypes: ["external_search", "commodity_price"],
        evidenceGaps: [],
        themes: ["白酒批价", "消费复苏"],
        sources: [{ source: "AnySearch", title: "白酒批价和消费复苏仍需跟踪", sourceType: "news", signalType: "external_search", weight: 2, industry: "白酒" }],
        financialFacts: [],
        industryFacts: [],
        companyCandidates: [],
      },
      {
        group: "金融地产",
        industry: "港股物业",
        status: "scanned",
        evidenceHash: "hash-hk-property",
        sourceCount: 1,
        evidenceTypes: ["news"],
        signalTypes: ["external_search"],
        evidenceGaps: ["缺财报", "缺多源验证"],
        themes: ["物业现金流", "地产链压力"],
        sources: [{ source: "AnySearch", title: "港股物业现金流线索不足", sourceType: "news", signalType: "external_search", weight: 2, industry: "港股物业" }],
        financialFacts: [],
        industryFacts: [],
        companyCandidates: [],
      },
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
        companies: ["百济神州", "药明康德", "Micron"],
        thesis: "营收增长和净利润拐点由公司财报直接验证。",
        drivers: ["商业化收入扩张", "费用率改善"],
        evidence: ["S1 财报数据", "净利润同比+42653%"],
        sourceIds: ["S1", "S6"],
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
    sustainability: [
      {
        title: "平稳现金流/高股息板块",
        industries: ["平稳现金流/高股息"],
        companies: ["工商银行(601398.SH)"],
        thesis: "现金流稳定且股息率有吸引力。",
        drivers: ["分红稳定"],
        evidence: ["S1 现金流稳定", "S2 分红稳定"],
        sourceIds: ["S1", "S2"],
        evidenceTypes: ["announcement", "official"],
        supportingSourceCount: 2,
        conclusionStrength: "观察",
        evidenceGaps: [],
        driverTags: ["现金流"],
        sustainabilityTier: "长期护城河",
        confidence: "中",
        durability: "长期",
        riskLevel: "低",
        counterEvidenceConditions: ["分红下降"],
        turningPoints: ["现金流恶化"],
      },
      {
        title: "高股息/平稳现金流资产",
        industries: ["高股息资产"],
        companies: ["长江电力(600900.SH)"],
        thesis: "同义主题不应重复占两个正式结论。",
        drivers: ["分红稳定"],
        evidence: ["S3 现金流稳定", "S4 分红稳定"],
        sourceIds: ["S3", "S4"],
        evidenceTypes: ["official", "hard_data"],
        supportingSourceCount: 2,
        conclusionStrength: "观察",
        evidenceGaps: [],
        driverTags: ["现金流"],
        sustainabilityTier: "长期护城河",
        confidence: "中",
        durability: "长期",
        riskLevel: "低",
        counterEvidenceConditions: ["利率大幅上行"],
        turningPoints: ["股息率下降"],
      },
    ],
    bubbleRisks: [
      {
        title: "低空经济概念超前",
        industries: ["低空经济"],
        companies: ["万丰奥威(002085.SZ)", "亿航智能(EH.O)"],
        thesis: "海外公司只能作为产业证据，不能进入代表公司。",
        drivers: ["主题催化"],
        evidence: ["S8 低空经济概念成交额放大", "S9 政策催化但订单兑现不足"],
        sourceIds: ["S8", "S9"],
        evidenceTypes: ["market", "news"],
        supportingSourceCount: 1,
        conclusionStrength: "观察",
        evidenceGaps: [],
        driverTags: ["政策"],
        sustainabilityTier: "短期催化",
        confidence: "中",
        durability: "短期",
        riskLevel: "高",
        counterEvidenceConditions: ["订单兑现"],
        turningPoints: ["监管变化"],
      },
    ],
    upcomingGrowth: [],
    decliningIndustries: [
      {
        title: "光伏产业链",
        industries: ["光伏", "光伏组件"],
        companies: ["隆基绿能"],
        thesis: "模型用正式标题给出衰退结论时，行业包应继承该阶段。",
        drivers: ["产能过剩"],
        evidence: ["S7 行业板块压力", "S10 工业硅价格低位"],
        sourceIds: ["S7", "S10"],
        evidenceTypes: ["market", "hard_data"],
        supportingSourceCount: 2,
        conclusionStrength: "正式结论",
        evidenceGaps: [],
        driverTags: ["供给"],
        sustainabilityTier: "中期景气",
        confidence: "中",
        durability: "中期",
        riskLevel: "高",
        counterEvidenceConditions: ["硅料价格持续反弹"],
        turningPoints: ["产能出清"],
      },
      {
        title: "光伏硅料价格低位",
        industries: ["光伏硅料"],
        companies: ["通威股份"],
        thesis: "同一光伏 canonical 主题不应重复生成第二条正式衰退结论。",
        drivers: ["产能过剩"],
        evidence: ["S10 工业硅价格低位"],
        sourceIds: ["S10", "S7"],
        evidenceTypes: ["hard_data", "market"],
        supportingSourceCount: 2,
        conclusionStrength: "正式结论",
        evidenceGaps: [],
        driverTags: ["价格", "供给"],
        sustainabilityTier: "中期景气",
        confidence: "中",
        durability: "中期",
        riskLevel: "高",
        counterEvidenceConditions: ["硅料价格持续反弹"],
        turningPoints: ["产能出清"],
      },
      {
        title: "地产链整体承压",
        industries: ["房地产开发", "房地产服务"],
        companies: ["万科A(000002.SZ)", "保利发展(600048.SH)"],
        thesis: "成交和开工仍弱，低基数利润修复不能证明扎实增长。",
        drivers: ["需求萎缩", "债务压力"],
        evidence: ["S1 地产链低基数改善但销售仍弱", "S11 房地产开发投资和销售面积继续承压"],
        sourceIds: ["S1", "S11"],
        evidenceTypes: ["announcement", "official"],
        supportingSourceCount: 2,
        conclusionStrength: "正式结论",
        evidenceGaps: [],
        driverTags: ["需求", "价格"],
        sustainabilityTier: "中期景气",
        confidence: "中",
        durability: "中期",
        riskLevel: "高",
        counterEvidenceConditions: ["销售面积和现金流连续改善"],
        turningPoints: ["开工率回升"],
      },
      {
        title: "传统燃油车市场萎缩",
        industries: ["传统燃油车", "汽车零部件（燃油）"],
        companies: ["上汽集团(600104.SH)"],
        thesis: "燃油车份额被新能源挤压。",
        drivers: ["技术替代"],
        evidence: ["S3 销量结构变化"],
        sourceIds: ["S3"],
        evidenceTypes: ["official"],
        supportingSourceCount: 1,
        conclusionStrength: "正式结论",
        evidenceGaps: [],
        driverTags: ["需求"],
        sustainabilityTier: "中期景气",
        confidence: "中",
        durability: "中期",
        riskLevel: "高",
        counterEvidenceConditions: ["燃油车份额回升"],
        turningPoints: ["新能源渗透率放缓"],
      },
    ],
    representativeCompanies: [{ label: "扎实增长产业中的代表公司", companies: ["百济神州", "美光"], note: "测试过滤海外公司。" }],
    stageCompanies: [],
    coverageReview: [{ label: "存储芯片", status: "insufficient", sourceCount: 0, evidenceTypes: [], sourceIds: [], note: "模型认为仍需硬数据。" }],
    limitations: [],
  };
}

function commonPrefixRatio(left: string, right: string) {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) index += 1;
  return index / Math.max(left.length, right.length);
}

function canonicalTitles(items: Array<{ title?: string; industries?: string[] }>) {
  return items.map((item) => {
    const text = [item.industries?.[0], item.title].filter(Boolean).join(" ");
    if (/光伏|硅料|组件|逆变器/.test(text)) return "光伏产业链";
    if (/地产|房地产|物业/.test(text)) return "地产链";
    if (/存储|DRAM|NAND|HBM/.test(text)) return "存储芯片";
    if (/平稳现金流|高股息|分红/.test(text)) return "平稳现金流高股息";
    return text.replace(/\s+/g, "");
  });
}
