import { useEffect, useState } from "react";
import type { ReportProgress } from "./api";

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds} 秒`;
  return `${minutes} 分 ${seconds} 秒`;
}

export function ProgressPanel({
  progress,
  phase,
  startedAt,
  completedElapsedMs,
  evidenceCount,
}: {
  progress: ReportProgress[];
  phase: "idle" | "searching" | "selecting" | "generating" | "ready" | "error";
  startedAt: number | null;
  completedElapsedMs?: number;
  evidenceCount: number;
}) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const latest = progress.at(-1);

  useEffect(() => {
    if (!startedAt) return;
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  const statusText =
    phase === "generating"
      ? formatDuration(elapsedMs)
      : phase === "ready"
        ? completedElapsedMs !== undefined
          ? `完成 / ${formatDuration(completedElapsedMs)}`
          : "完成"
        : phase === "error"
          ? "失败"
          : "待开始";
  return (
    <section className="progress-panel" aria-live="polite" aria-atomic="true">
      <div className="progress-head">
        <span>生成状态</span>
        <strong>{statusText}</strong>
      </div>
      <meter min="0" max="100" value={latest?.percent ?? (phase === "ready" ? 100 : 0)} />
      <p>{latest ? `${latest.label}：${latest.detail}` : "选择公司后开始读取公开数据并生成报告。"}</p>
      {completedElapsedMs !== undefined ? <small>生成耗时：{formatDuration(completedElapsedMs)}</small> : null}
      <small>当前证据数量：{evidenceCount}</small>
      <ol>
        {progress.map((item, index) => (
          <li key={`${item.stage}-${item.at}-${index}`}>
            <span>{item.percent}%</span>
            <div>
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
