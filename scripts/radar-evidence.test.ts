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
    expect(snapshot.quality).toMatchObject({
      googleNewsShare: expect.any(Number),
      structuredShare: expect.any(Number),
      uniqueSources: expect.any(Number),
      largestSourceShare: expect.any(Number),
    });
    expect(snapshot.quality?.uniqueSources).toBeGreaterThanOrEqual(3);
    expect(snapshot.quality?.largestSourceShare).toBeLessThanOrEqual(0.5);
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
