import { verifySessionCookie } from "../_shared/auth";
import { callDeepSeekReport } from "../_shared/deepseek";
import { fetchPublicCompanyEvidence } from "../_shared/providers";
import type { CompanyCandidate } from "../../src/shared/report";

type Env = {
  AUTH_SECRET: string;
  DEEPSEEK_API_KEY: string;
};

type ReportRequest = {
  company?: CompanyCandidate;
  companyName?: string;
  ticker?: string;
  market?: string;
  language?: "zh-CN" | "en";
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const authenticated = await verifySessionCookie(request.headers.get("cookie"), env.AUTH_SECRET);
  if (!authenticated) return json({ error: "Unauthorized." }, 401);

  const body = (await request.json().catch(() => null)) as ReportRequest | null;
  const company = body?.company;
  const companyName = company?.name?.trim() || body?.companyName?.trim();
  if (!companyName) return json({ error: "请先搜索并选择一个候选公司。" }, 400);
  if (!env.DEEPSEEK_API_KEY) return json({ error: "DEEPSEEK_API_KEY is not configured." }, 500);

  return streamNdjson(async (emit) => {
    emit({ type: "progress", stage: "confirmed", label: "已确认公司", detail: company ? `${company.name} / ${company.code} / ${company.listingPlace}` : companyName, percent: 5 });
    emit({ type: "progress", stage: "market_data", label: "读取行情数据", detail: "正在读取公开行情、交易所与估值快照。", percent: 18 });
    emit({ type: "progress", stage: "financial_data", label: "读取财务数据", detail: "正在读取利润表、现金流量表、资产负债表与公开财务时间序列。", percent: 32 });

    const evidence = await fetchPublicCompanyEvidence({
      companyName,
      ticker: company?.code || body?.ticker?.trim() || undefined,
      market: company?.listingPlace || body?.market?.trim() || undefined,
      company,
    });

    emit({
      type: "progress",
      stage: "evidence_ready",
      label: "证据包完成",
      detail: `已整理 ${evidence.evidence.length} 条公开证据，开始深度评分。`,
      percent: 48,
      evidenceCount: evidence.evidence.length,
    });
    emit({ type: "progress", stage: "deepseek_scoring", label: "DeepSeek 评分生成", detail: "V4 Pro max thinking 正在生成 20 项评分、红线封顶和估值结构。", percent: 62 });

    const report = await callDeepSeekReport({
      apiKey: env.DEEPSEEK_API_KEY,
      evidence,
      language: "zh-CN",
      onProgress: (progress) => emit({ type: "progress", ...progress }),
    });

    emit({ type: "progress", stage: "validation", label: "结构校验", detail: "正在校验 20 项评分、红线封顶、模板章节和导出结构。", percent: 90 });
    emit({ type: "progress", stage: "done", label: "报告完成", detail: "深度报告已生成，可在网页查看或导出 DOCX。", percent: 100 });
    emit({ type: "final", report, evidence });
  });
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

type ProgressEvent = {
  type: "progress";
  stage: string;
  label: string;
  detail: string;
  percent: number;
  at?: string;
  evidenceCount?: number;
};

type HeartbeatEvent = {
  type: "heartbeat";
  stage: string;
  label: string;
  detail: string;
  percent: number;
  at?: string;
};

type ErrorEvent = {
  type: "error";
  error: string;
  code?: string;
  retryable?: boolean;
};

type StreamEmit = (event: ProgressEvent | HeartbeatEvent | { type: "final"; report: unknown; evidence: unknown } | ErrorEvent) => void;

function streamNdjson(task: (emit: StreamEmit) => Promise<void>) {
  const encoder = new TextEncoder();
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit: StreamEmit = (event) => {
        const payload = event.type === "progress" || event.type === "heartbeat" ? { ...event, at: event.at ?? new Date().toISOString() } : event;
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };

      keepalive = setInterval(() => {
        emit({ type: "heartbeat", stage: "working", label: "仍在生成", detail: "模型仍在分析，连接保持中。", percent: 75 });
      }, 10_000);

      task(emit)
        .catch((error) => {
          emit(errorEvent(error));
        })
        .finally(() => {
          if (keepalive) clearInterval(keepalive);
          controller.close();
        });
    },
    cancel() {
      if (keepalive) clearInterval(keepalive);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function errorEvent(error: unknown): ErrorEvent {
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  return {
    type: "error",
    error: error instanceof Error ? error.message : "报告生成失败。",
    code: typeof record.code === "string" ? record.code : undefined,
    retryable: typeof record.retryable === "boolean" ? record.retryable : undefined,
  };
}
