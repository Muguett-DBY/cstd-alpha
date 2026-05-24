import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import {
  confirmAssistantMemoryCandidate,
  fetchAssistantThread,
  rejectAssistantMemoryCandidate,
  sendAssistantMessage,
} from "./api";
import { composeClarifiedAssistantMessage, type AssistantClarificationOption, type AssistantClarificationRequest } from "./assistant-clarification";
import { mergeAssistantDelta } from "./assistant-state";
import type { AssistantBlock, AssistantChartBlock, AssistantChatStreamEvent, AssistantMemoryCandidate, AssistantMessage, AssistantMode, AssistantThread } from "./shared/assistant";

type AssistantPhase = "loading" | "ready" | "streaming" | "error";

export function AssistantView() {
  const [thread, setThread] = useState<AssistantThread | null>(null);
  const [phase, setPhase] = useState<AssistantPhase>("loading");
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<AssistantMode>("chat");
  const [pendingClarification, setPendingClarification] = useState<{ original: string; request: AssistantClarificationRequest; selectedId: string; customAnswer: string; error?: string } | null>(null);
  const [pendingMemory, setPendingMemory] = useState<AssistantMemoryCandidate | null>(null);
  const [draftBlocks, setDraftBlocks] = useState<AssistantBlock[]>([]);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const lastSentMessageRef = useRef("");

  useEffect(() => {
    void reloadThread();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [thread?.messages.length, draft]);

  async function reloadThread() {
    setPhase("loading");
    setError("");
    try {
      const next = await fetchAssistantThread();
      setThread(next);
      setPhase("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "助手读取失败。");
      setPhase("error");
    }
  }

  async function submitMessage(event: React.FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || phase === "streaming") return;
    await sendMessage(message);
  }

  async function sendMessage(message: string) {
    setInput("");
    setDraft("");
    setDraftBlocks([]);
    setError("");
    setPhase("streaming");
    lastSentMessageRef.current = message;
    const optimisticUser: AssistantMessage = {
      id: `local:${Date.now()}`,
      threadId: thread?.id || "local",
      role: "user",
      content: message,
      createdAt: new Date().toISOString(),
    };
    setThread((current) =>
      current
        ? { ...current, messages: [...current.messages, optimisticUser] }
        : {
            id: "local",
            title: "长期投研助手",
            summary: "",
            updatedAt: new Date().toISOString(),
            messages: [optimisticUser],
            memories: [],
            memoryCandidates: [],
          },
    );
    try {
      const final = await sendAssistantMessage(message, mode, handleStreamEvent);
      if (final) setThread((current) => (current ? { ...current, messages: [...current.messages.filter((item) => item.id !== final.id), final] } : current));
      setDraft("");
      setDraftBlocks([]);
      setPhase("ready");
      if (final) void reloadThread();
    } catch (err) {
      setError(err instanceof Error ? err.message : "助手生成失败。");
      setPhase("error");
    }
  }

  async function submitClarification() {
    if (!pendingClarification || phase === "streaming") return;
    const option = pendingClarification.request.options.find((item) => item.id === pendingClarification.selectedId) ?? pendingClarification.request.options[0];
    if (option.requiresCustom && !pendingClarification.customAnswer.trim()) {
      setPendingClarification((current) => (current ? { ...current, error: "请先补充公司、行业或主题。" } : current));
      return;
    }
    const message = composeClarifiedAssistantMessage(pendingClarification.original, option, pendingClarification.customAnswer);
    setPendingClarification(null);
    await sendMessage(message);
  }

  function handleStreamEvent(event: AssistantChatStreamEvent) {
    if (event.type === "delta") setDraft((current) => mergeAssistantDelta(current, event.text));
    if (event.type === "block") setDraftBlocks((current) => [...current.filter((item) => item.id !== event.block.id), event.block]);
    if (event.type === "choice_request") {
      setDraft("");
      setPendingClarification({
        original: lastSentMessageRef.current,
        request: event.request,
        selectedId: event.request.options.find((option) => option.recommended)?.id ?? event.request.options[0]?.id ?? "",
        customAnswer: "",
      });
    }
    if (event.type === "memory_candidate") {
      setPendingMemory(event.candidate);
    }
  }

  const visibleMessages = useMemo(() => thread?.messages ?? [], [thread]);

  return (
    <section className="assistant-workspace" aria-labelledby="assistant-title">
      <section className="assistant-chat-panel" aria-label="助手聊天">
        <header className="assistant-chat-header">
          <div>
            <p className="eyebrow">Admin Only</p>
            <h2 id="assistant-title">投研助手</h2>
          </div>
          <span>DeepSeek Flash High</span>
        </header>
          <div className="assistant-mode-switch" aria-label="助手模式">
            {assistantModes.map((item) => (
              <button key={item.id} type="button" className={mode === item.id ? "active" : ""} onClick={() => setMode(item.id)}>
                <span>{item.label}</span>
                <small>{item.description}</small>
              </button>
            ))}
          </div>
          <div className="assistant-messages">
            {phase === "loading" ? <p className="muted">正在读取长期线程...</p> : null}
            {visibleMessages.map((message) => (
              <article key={message.id} className={`assistant-message ${message.role === "user" ? "user" : "assistant"}`}>
                <span>{message.role === "user" ? "你" : "助手"}</span>
                <p>{message.metadata?.blocks?.length ? stripRenderedTables(message.content) : message.content}</p>
                <AssistantBlocks blocks={message.metadata?.blocks ?? []} />
              </article>
            ))}
            {draft ? (
              <article className="assistant-message assistant streaming">
                <span>助手</span>
                <p>{draftBlocks.length ? stripRenderedTables(draft) : draft}</p>
                <AssistantBlocks blocks={draftBlocks} />
              </article>
            ) : null}
            <div ref={messagesEndRef} />
          </div>
          <form className="assistant-composer" onSubmit={(event) => void submitMessage(event)}>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={assistantModePlaceholder[mode]}
              rows={3}
              disabled={phase === "streaming"}
            />
            <button type="submit" disabled={!input.trim() || phase === "streaming"}>
              {phase === "streaming" ? "生成中..." : "发送"}
            </button>
          </form>
          {error ? <p className="error-text">{error}</p> : null}
      </section>
      {pendingClarification ? (
        <ClarificationDialog
          request={pendingClarification.request}
          selectedId={pendingClarification.selectedId}
          customAnswer={pendingClarification.customAnswer}
          error={pendingClarification.error}
          onSelect={(selectedId) => setPendingClarification((current) => (current ? { ...current, selectedId, error: undefined } : current))}
          onCustomAnswer={(customAnswer) => setPendingClarification((current) => (current ? { ...current, customAnswer, error: undefined } : current))}
          onCancel={() => setPendingClarification(null)}
          onSubmit={() => void submitClarification()}
        />
      ) : null}
      {pendingMemory ? (
        <MemoryCandidateDialog
          candidate={pendingMemory}
          onConfirm={() => {
            const id = pendingMemory.id;
            setPendingMemory(null);
            void confirmAssistantMemoryCandidate(id).then(() => reloadThread()).catch((err) => setError(err instanceof Error ? err.message : "记忆写入失败。"));
          }}
          onReject={() => {
            const id = pendingMemory.id;
            setPendingMemory(null);
            void rejectAssistantMemoryCandidate(id).catch(() => undefined);
          }}
        />
      ) : null}
    </section>
  );
}

function AssistantBlocks({ blocks }: { blocks: AssistantBlock[] }) {
  if (!blocks.length) return null;
  return (
    <div className="assistant-blocks">
      {blocks.map((block) => {
        if (block.type === "table") {
          return (
            <div key={block.id} className="assistant-table-block">
              {block.title ? <strong>{block.title}</strong> : null}
              <div>
                <table>
                  <thead>
                    <tr>{block.columns.map((column) => <th key={column}>{column}</th>)}</tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={`${block.id}-${rowIndex}`}>
                        {block.columns.map((column, columnIndex) => <td key={`${column}-${columnIndex}`}>{row[columnIndex] ?? ""}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        }
        if (block.type === "chart") return <AssistantChart key={block.id} block={block} />;
        return (
          <div key={block.id} className="assistant-text-block">
            {block.title ? <strong>{block.title}</strong> : null}
            <p>{block.text}</p>
          </div>
        );
      })}
    </div>
  );
}

function AssistantChart({ block }: { block: AssistantChartBlock }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ref.current) return undefined;
    const chart = echarts.init(ref.current);
    chart.setOption({
      animation: false,
      tooltip: { trigger: "axis" },
      legend: { top: 0, textStyle: { fontWeight: 700 } },
      grid: { left: 44, right: 16, top: 42, bottom: 42 },
      xAxis: { type: "category", data: block.labels, axisLabel: { interval: 0, rotate: block.labels.length > 6 ? 24 : 0 } },
      yAxis: { type: "value" },
      series: block.series.map((series) => ({
        name: series.name,
        type: block.chartType === "scatter" ? "scatter" : block.chartType,
        data: series.data,
        smooth: block.chartType === "line",
      })),
    });
    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.dispose();
    };
  }, [block]);

  return (
    <div className="assistant-chart-block">
      {block.title ? <strong>{block.title}</strong> : null}
      <div ref={ref} role="img" aria-label={block.title || "助手图表"} />
    </div>
  );
}

function stripRenderedTables(text: string) {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes("|") && isMarkdownSeparator(lines[index + 1] ?? "")) {
      index += 2;
      while (index < lines.length && lines[index].includes("|")) index += 1;
      index -= 1;
      continue;
    }
    kept.push(lines[index]);
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isMarkdownSeparator(line: string) {
  const cells = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

const assistantModes: Array<{ id: AssistantMode; label: string; description: string }> = [
  { id: "chat", label: "普通", description: "日常投研问答" },
  { id: "target", label: "标的研究", description: "公司/代码 + 问题" },
  { id: "industry", label: "行业研究", description: "行业/主题 + 问题" },
];

const assistantModePlaceholder: Record<AssistantMode, string> = {
  chat: "问一个投资问题，或说“记住：以后分析白酒先看批价和库存”。",
  target: "输入标的 + 问题，例如：宁德时代 长期还能不能持有？",
  industry: "输入行业/主题 + 问题，例如：光伏现在是不是接近出清？",
};

function ClarificationDialog({
  request,
  selectedId,
  customAnswer,
  error,
  onSelect,
  onCustomAnswer,
  onCancel,
  onSubmit,
}: {
  request: AssistantClarificationRequest;
  selectedId: string;
  customAnswer: string;
  error?: string;
  onSelect: (id: string) => void;
  onCustomAnswer: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="assistant-clarification-backdrop" role="presentation">
      <section className="assistant-clarification-dialog" role="dialog" aria-modal="true" aria-labelledby="assistant-clarification-title">
        <div>
          <p className="eyebrow">先确认一下</p>
          <h3 id="assistant-clarification-title">{request.title}</h3>
          <p>{request.question}</p>
          <small>{request.reason}</small>
        </div>
        <div className="assistant-clarification-options" role="radiogroup" aria-label="澄清选项">
          {request.options.map((option) => (
            <ClarificationOptionButton key={option.id} option={option} selected={selectedId === option.id} onSelect={() => onSelect(option.id)} />
          ))}
        </div>
        <textarea value={customAnswer} onChange={(event) => onCustomAnswer(event.target.value)} placeholder={request.customPlaceholder} rows={3} />
        {error ? <p className="error-text">{error}</p> : null}
        <footer>
          <button type="button" className="ghost-button" onClick={onCancel}>取消</button>
          <button type="button" onClick={onSubmit}>按这个继续</button>
        </footer>
      </section>
    </div>
  );
}

function ClarificationOptionButton({ option, selected, onSelect }: { option: AssistantClarificationOption; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`assistant-clarification-option ${selected ? "selected" : ""}`} onClick={onSelect} aria-pressed={selected}>
      <span>{option.label}</span>
      {option.recommended ? <em>推荐</em> : null}
      <small>{option.description}</small>
    </button>
  );
}

function MemoryCandidateDialog({ candidate, onConfirm, onReject }: { candidate: AssistantMemoryCandidate; onConfirm: () => void; onReject: () => void }) {
  return (
    <div className="assistant-clarification-backdrop" role="presentation">
      <section className="assistant-clarification-dialog assistant-memory-dialog" role="dialog" aria-modal="true" aria-labelledby="assistant-memory-title">
        <div>
          <p className="eyebrow">记忆候选</p>
          <h3 id="assistant-memory-title">是否写入长期记忆？</h3>
          <p>{candidate.content}</p>
          <small>{candidate.reason}</small>
        </div>
        <footer>
          <button type="button" className="ghost-button" onClick={onReject}>不写入</button>
          <button type="button" onClick={onConfirm}>确认写入</button>
        </footer>
      </section>
    </div>
  );
}

export default AssistantView;
