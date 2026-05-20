import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("rolling radar evidence collector", () => {
  test("generates a valid offline evidence snapshot without any DeepSeek dependency", () => {
    const script = "scripts/collect_radar_evidence.py";
    const source = readFileSync(script, "utf8");
    expect(source).not.toMatch(/DEEPSEEK|deepseek/i);

    const outputPath = join(mkdtempSync(join(tmpdir(), "radar-evidence-")), "radar-evidence.json");
    execFileSync("python", [script, "--offline-fixture", "--output", outputPath], { stdio: "pipe" });
    const snapshot = JSON.parse(readFileSync(outputPath, "utf8")) as {
      version?: string;
      source?: string;
      evidenceHash?: string;
      quality?: { googleNewsShare?: number; structuredShare?: number; uniqueSources?: number; largestSourceShare?: number };
      sources?: Array<{ source?: string; query?: string; title?: string; url?: string; sourceType?: string; weight?: number }>;
      financialFacts?: unknown[];
      industryFacts?: unknown[];
      companyCandidates?: unknown[];
      industryPackets?: Array<{ group?: string; industry?: string; status?: string; evidenceHash?: string; sourceCount?: number; evidenceTypes?: string[]; evidenceGaps?: string[]; themes?: string[] }>;
    };
    const sources = snapshot.sources ?? [];
    const googleSources = sources.filter((source) => source.source === "Google News");
    const structuredSources = sources.filter((source) => source.source !== "Google News" && source.sourceType !== "news");

    expect(snapshot).toMatchObject({
      version: "v1",
      source: "github-actions-python",
    });
    expect(snapshot.evidenceHash).toMatch(/^[a-z0-9]+$/);
    expect(sources.length).toBeGreaterThanOrEqual(36);
    expect(sources.every((source) => source.source && source.query && source.title && typeof source.weight === "number")).toBe(true);
    expect(sources.some((source) => source.sourceType === "hard_data")).toBe(true);
    expect(sources.some((source) => source.sourceType === "market")).toBe(true);
    expect(googleSources.length / sources.length).toBeLessThanOrEqual(0.5);
    expect(googleSources.every((source) => source.sourceType === "news")).toBe(true);
    expect(structuredSources.length).toBeGreaterThanOrEqual(50);
    expect(snapshot.financialFacts?.length).toBeGreaterThan(0);
    expect(snapshot.industryFacts?.length).toBeGreaterThan(0);
    expect(snapshot.companyCandidates?.length).toBeGreaterThan(0);
    expect(snapshot.industryPackets?.length).toBeGreaterThanOrEqual(80);
    expect(snapshot.industryPackets?.every((packet) => packet.status === "scanned" && packet.industry && packet.evidenceHash)).toBe(true);
    expect(snapshot.industryPackets?.map((packet) => packet.industry)).toEqual(expect.arrayContaining(["半导体/AI算力", "存储芯片", "港股互联网平台", "基础化工", "银行", "航空机场"]));
    expect(snapshot.industryPackets?.some((packet) => packet.themes?.includes("HBM存储"))).toBe(true);
    expect(snapshot.quality).toMatchObject({
      googleNewsShare: expect.any(Number),
      structuredShare: expect.any(Number),
      uniqueSources: expect.any(Number),
      largestSourceShare: expect.any(Number),
    });
    expect(snapshot.quality?.uniqueSources).toBeGreaterThanOrEqual(3);
    expect(snapshot.quality?.largestSourceShare).toBeLessThanOrEqual(0.5);
  });

  test("emits full fine-industry packets even when some industries have weak evidence", () => {
    const script = "scripts/collect_radar_evidence.py";
    const outputPath = join(mkdtempSync(join(tmpdir(), "radar-evidence-")), "radar-evidence.json");
    execFileSync("python", [script, "--offline-fixture", "--output", outputPath], { stdio: "pipe" });
    const snapshot = JSON.parse(readFileSync(outputPath, "utf8")) as {
      industryPackets?: Array<{ industry?: string; evidenceHash?: string; sourceCount?: number; evidenceGaps?: string[] }>;
    };
    const packets = snapshot.industryPackets ?? [];
    const emptyOrWeak = packets.filter((packet) => (packet.sourceCount ?? 0) <= 1);

    expect(packets.length).toBeGreaterThanOrEqual(80);
    expect(emptyOrWeak.length).toBeGreaterThan(0);
    expect(emptyOrWeak.every((packet) => packet.evidenceHash && Array.isArray(packet.evidenceGaps))).toBe(true);
  });

  test("does not use local placeholder signals as financial evidence", () => {
    const script = "scripts/collect_radar_evidence.py";
    const outputPath = join(mkdtempSync(join(tmpdir(), "radar-evidence-")), "radar-evidence.json");
    execFileSync("python", [script, "--offline-fixture", "--output", outputPath], { stdio: "pipe" });
    const snapshot = JSON.parse(readFileSync(outputPath, "utf8")) as {
      sources?: Array<{ source?: string; query?: string; title?: string; summary?: string; sourceType?: string; signalType?: string }>;
      financialFacts?: Array<{ source?: string; company?: string; metric?: string; yoy?: number }>;
    };
    const sources = snapshot.sources ?? [];
    const explicitSignals = sources.filter((source) => source.signalType);
    const financialSources = sources.filter((source) => source.signalType === "financial_metric");

    expect(sources.some((source) => source.source === "本地硬数据指标聚合")).toBe(false);
    expect(Array.from(new Set(explicitSignals.map((source) => source.signalType)))).toEqual(expect.arrayContaining(["commodity_price", "financial_metric", "industry_stat", "freight_rate"]));
    expect(financialSources.length).toBeGreaterThan(0);
    expect(financialSources.every((source) => ["东方财富业绩报表", "东方财富业绩快报", "东方财富业绩预告"].includes(source.source ?? ""))).toBe(true);
    expect(snapshot.financialFacts?.some((fact) => fact.source === "东方财富业绩报表" && fact.company && fact.metric === "净利润" && typeof fact.yoy === "number")).toBe(true);
  });

  test("offline fixture exercises the same real hard-data source families as live collection", () => {
    const script = "scripts/collect_radar_evidence.py";
    const outputPath = join(mkdtempSync(join(tmpdir(), "radar-evidence-")), "radar-evidence.json");
    execFileSync("python", [script, "--offline-fixture", "--output", outputPath], { stdio: "pipe" });
    const snapshot = JSON.parse(readFileSync(outputPath, "utf8")) as {
      sources?: Array<{ source?: string; query?: string; title?: string; summary?: string; sourceType?: string; signalType?: string }>;
      quality?: { bySignalType?: Record<string, number> };
    };
    const sources = snapshot.sources ?? [];
    const sourceFamilies = new Set(sources.map((source) => source.source));

    expect(Array.from(sourceFamilies)).toEqual(
      expect.arrayContaining(["东方财富业绩报表", "东方财富业绩预告", "AKShare/Sina期货日线", "AKShare/100ppi期现基差", "AKShare/乘联会汽车统计", "AKShare/生猪价格统计", "东方财富行业指数"]),
    );
    expect(sources.some((source) => source.sourceType === "hard_data" && source.signalType === "commodity_price" && /收盘|结算|现货|基差/.test(`${source.title} ${source.summary}`))).toBe(true);
    expect(sources.some((source) => source.sourceType === "official" && source.signalType === "industry_stat" && /批发|出口|同比|销量/.test(`${source.title} ${source.summary}`))).toBe(true);
    expect(sources.some((source) => source.signalType === "freight_rate" && /BDI|SCFI|CCFI|集运|航运/.test(`${source.query} ${source.title}`))).toBe(true);
    expect(snapshot.quality?.bySignalType).toMatchObject({
      commodity_price: expect.any(Number),
      financial_metric: expect.any(Number),
      industry_stat: expect.any(Number),
      freight_rate: expect.any(Number),
    });
  });

  test("includes AnySearch as a supplemental source family without treating it as hard data", () => {
    const script = "scripts/collect_radar_evidence.py";
    const workflow = ".github/workflows/radar-evidence.yml";
    const source = readFileSync(script, "utf8");
    const outputPath = join(mkdtempSync(join(tmpdir(), "radar-evidence-")), "radar-evidence.json");

    expect(source).toContain("ANYSEARCH_API_KEY");
    expect(readFileSync(workflow, "utf8")).toContain("ANYSEARCH_API_KEY");

    execFileSync("python", [script, "--offline-fixture", "--output", outputPath], { stdio: "pipe" });
    const snapshot = JSON.parse(readFileSync(outputPath, "utf8")) as {
      sources?: Array<{
        source?: string;
        sourceType?: string;
        signalType?: string;
        qualityScore?: number;
        anysearchRequestId?: string;
        cached?: boolean;
        evidenceProfile?: string;
        anysearchTags?: string[];
        anysearchContentTypes?: string[];
        anysearchFreshness?: string;
        anysearchSource?: string;
        score?: number;
      }>;
      industryPackets?: Array<{ sources?: Array<{ source?: string }> }>;
    };
    const anysearchSources = (snapshot.sources ?? []).filter((source) => source.source === "AnySearch");
    const profiles = new Set(anysearchSources.map((source) => source.evidenceProfile));

    expect(anysearchSources.length).toBeGreaterThanOrEqual(4);
    expect(Array.from(profiles)).toEqual(expect.arrayContaining(["announcement", "industry_data", "policy", "risk"]));
    expect(anysearchSources.every((source) => source.sourceType === "news")).toBe(true);
    expect(anysearchSources.every((source) => source.signalType !== "financial_metric" && source.signalType !== "commodity_price")).toBe(true);
    expect(anysearchSources.every((source) => source.signalType === "external_search")).toBe(true);
    expect(anysearchSources.some((source) => typeof source.qualityScore === "number" && source.qualityScore >= 0.85 && source.anysearchRequestId && typeof source.cached === "boolean")).toBe(true);
    expect(anysearchSources.some((source) => source.anysearchTags?.length && source.anysearchFreshness === "week")).toBe(true);
    expect(anysearchSources.some((source) => source.anysearchContentTypes?.includes("data") || source.anysearchContentTypes?.includes("doc"))).toBe(true);
    expect(anysearchSources.filter((source) => source.anysearchSource === "doc" || source.anysearchSource === "data").every((source) => (source.score ?? 0) >= 50)).toBe(true);
    expect(snapshot.industryPackets?.some((packet) => packet.sources?.some((source) => source.source === "AnySearch"))).toBe(true);
  });

  test("scores AnySearch quality consistently across 0-1 and 0-100 scales", () => {
    const output = execFileSync(
      "python",
      [
        "-c",
        [
          "import importlib.util, json",
          "spec=importlib.util.spec_from_file_location('collector','scripts/collect_radar_evidence.py')",
          "m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
          "base={'source':'AnySearch','query':'存储芯片 价格 库存','title':'存储芯片 价格 库存 订单','summary':'价格 库存 同比','sourceType':'official','signalType':'external_search','weight':4,'anysearchContentTypes':['data','news','web'],'publishedAt':'2026-05-19T00:00:00Z'}",
          "a={**base,'qualityScore':0.86}; b={**base,'qualityScore':86}",
          "print(json.dumps([m.score_source(a), m.score_source(b)]))",
        ].join("; "),
      ],
      { encoding: "utf8" },
    );
    const [fractionScore, percentageScore] = JSON.parse(output) as [number, number];

    expect(percentageScore).toBe(fractionScore);
  });

  test("keeps all AnySearch evidence profiles in selected sources", () => {
    const output = execFileSync(
      "python",
      [
        "-c",
        [
          "import importlib.util, json",
          "spec=importlib.util.spec_from_file_location('collector','scripts/collect_radar_evidence.py')",
          "m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
          "items=[]",
          "profiles=['industry_data','announcement','policy','risk']",
          "for profile in profiles:",
          "    for index in range(24):",
          "        source_type='news'",
          "        items.append(m.classify_source({'source':'AnySearch','query':profile,'title':f'{profile} 证据 {index} 价格 财报 风险','url':f'https://any.example/{profile}/{index}','sourceType':source_type,'signalType':'external_search','weight':m.SOURCE_WEIGHTS[source_type],'evidenceProfile':profile,'anysearchTags':['tag'], 'anysearchContentTypes':['doc' if profile in ('announcement','policy') else 'news'], 'qualityScore':90 if profile in ('industry_data','announcement') else 72,'publishedAt':'2026-05-19T00:00:00Z'}))",
          "selected=m.select_sources(items, limit=80)",
          "counts={profile: sum(1 for item in selected if item.get('evidenceProfile') == profile) for profile in profiles}",
          "print(json.dumps(counts, ensure_ascii=False))",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    const counts = JSON.parse(output) as Record<string, number>;

    expect(counts.industry_data).toBeGreaterThan(0);
    expect(counts.announcement).toBeGreaterThan(0);
    expect(counts.policy).toBeGreaterThan(0);
    expect(counts.risk).toBeGreaterThan(0);
  });

  test("evidence gaps are routed by industry need instead of requiring price and sales for every sector", () => {
    const output = execFileSync(
      "python",
      [
        "-c",
        [
          "import importlib.util, json",
          "spec=importlib.util.spec_from_file_location('collector','scripts/collect_radar_evidence.py')",
          "m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
          "drug={'group':'医药医疗','industry':'创新药/医疗服务','keywords':('创新药','CXO')}",
          "storage={'group':'科技成长','industry':'存储芯片','keywords':('存储','DRAM','NAND','HBM')}",
          "same_type_multi_source={'group':'周期品','industry':'航运物流','keywords':('航运','运价')}",
          "drug_sources=[{'sourceType':'announcement','signalType':'financial_metric','title':'药企营收净利润增长'}]",
          "storage_sources=[{'sourceType':'official','signalType':'external_search','title':'存储芯片订单线索'}]",
          "multi_sources=[{'source':'AKShare/Sina期货日线','sourceType':'hard_data','signalType':'freight_rate','title':'BDI运价上涨'}, {'source':'东方财富行业板块','sourceType':'hard_data','signalType':'freight_rate','title':'航运指数上涨'}]",
          "print(json.dumps({'drug': m.industry_evidence_gaps(drug, drug_sources, [{'company':'A'}], []), 'storage': m.industry_evidence_gaps(storage, storage_sources, [], []), 'sameTypeMulti': m.industry_evidence_gaps(same_type_multi_source, multi_sources, [], [{'name':'BDI'}])}, ensure_ascii=True))",
        ].join("; "),
      ],
      { encoding: "utf8" },
    );
    const result = JSON.parse(output) as { drug: string[]; storage: string[]; sameTypeMulti: string[] };

    expect(result.drug).not.toContain("缺价格");
    expect(result.drug).not.toContain("缺销量");
    expect(result.storage).toEqual(expect.arrayContaining(["缺财报", "缺价格", "缺库存"]));
    expect(result.sameTypeMulti).not.toContain("缺多源验证");
  });

  test("refuses to emit a live-quality snapshot when evidence is only Google News", () => {
    const script = "scripts/collect_radar_evidence.py";
    const outputPath = join(mkdtempSync(join(tmpdir(), "radar-evidence-")), "radar-evidence.json");

    expect(() => execFileSync("python", [script, "--offline-google-only", "--output", outputPath], { stdio: "pipe" })).toThrow();
  });

  test("refuses to emit a live-quality snapshot when structured evidence is too narrow", () => {
    const script = "scripts/collect_radar_evidence.py";
    const outputPath = join(mkdtempSync(join(tmpdir(), "radar-evidence-")), "radar-evidence.json");

    expect(() => execFileSync("python", [script, "--offline-single-structured", "--output", outputPath], { stdio: "pipe" })).toThrow();
  });

  test("has a scheduled GitHub Action that uploads evidence but does not call DeepSeek", () => {
    const workflow = ".github/workflows/radar-evidence.yml";

    expect(existsSync(workflow)).toBe(true);
    const text = readFileSync(workflow, "utf8");
    expect(text).toContain("collect_radar_evidence.py");
    expect(text).toContain("RADAR_EVIDENCE_KV_NAMESPACE_ID");
    expect(text).not.toMatch(/DEEPSEEK|deepseek/i);
  });
});
