import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import {
  confirmAssistantMemoryCandidate,
  fetchAssistantThread,
  listAssistantThreads,
  createAssistantThread,
  deleteAssistantThread,
  renameAssistantThread,
  rejectAssistantMemoryCandidate,
  sendAssistantMessage,
  sendCodeResult,
} from "./api";
import { composeClarifiedAssistantMessage, type AssistantClarificationOption, type AssistantClarificationRequest } from "./assistant-clarification";
import { assistantKeyIntent, canRestartSpeechAfterError, mergeSpeechTranscript, shouldBlockSpeechForPermissionState, speechErrorMessage } from "./assistant-input";
import { parseAssistantMarkdown } from "./assistant-markdown";
import { mergeAssistantDelta, stripInternalAssistantCompletion } from "./assistant-state";
import type { AssistantBlock, AssistantChartBlock, AssistantChatStreamEvent, AssistantMemoryCandidate, AssistantMessage, AssistantMode, AssistantThread } from "./shared/assistant";

type AssistantPhase = "loading" | "ready" | "streaming" | "error";
type SpeechPhase = "idle" | "starting" | "listening" | "unsupported" | "error";

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{ isFinal?: boolean; 0?: { transcript?: string } }>;
};

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives?: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export function AssistantView() {
  const [thread, setThread] = useState<AssistantThread | null>(null);
  const [phase, setPhase] = useState<AssistantPhase>("loading");
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState("");
  const [threadList, setThreadList] = useState<Array<{ id: string; title: string; updatedAt: string }>>([]);
  const [mode, setMode] = useState<AssistantMode>("chat");
  const [pendingClarification, setPendingClarification] = useState<{ original: string; request: AssistantClarificationRequest; selectedId: string; customAnswer: string; error?: string } | null>(null);
  const [pendingMemory, setPendingMemory] = useState<AssistantMemoryCandidate | null>(null);
  const [draftBlocks, setDraftBlocks] = useState<AssistantBlock[]>([]);
  const [agentStatus, setAgentStatus] = useState("");
  const [toolCalls, setToolCalls] = useState<Map<string, { label: string; status: "running" | "completed" | "failed" }>>(new Map());
  const [speechPhase, setSpeechPhase] = useState<SpeechPhase>("idle");
  const [speechNotice, setSpeechNotice] = useState("");
  const [pyodideReady, setPyodideReady] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const pyodideRef = useRef<{ runPythonAsync: (code: string) => Promise<unknown> } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const lastSentMessageRef = useRef("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(
    () => () => {
      recognitionRef.current?.abort?.();
      recognitionRef.current = null;
    },
    [],
  );

  useEffect(() => {
    void reloadThread();
    void loadThreadList();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [thread?.messages.length, draft, agentStatus]);

  async function reloadThread(threadId?: string) {
    setPhase("loading");
    setError("");
    try {
      const next = await fetchAssistantThread(threadId);
      setThread(next);
      setPhase("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "助手读取失败。");
      setPhase("error");
    }
  }

  async function loadThreadList() {
    try {
      const threads = await listAssistantThreads();
      setThreadList(threads);
    } catch { /* ignore */ }
  }

  async function switchThread(threadId: string) {
    setDraft("");
    await reloadThread(threadId);
  }

  async function newThread() {
    try {
      const created = await createAssistantThread();
      setThreadList((prev) => [{ id: created.id, title: created.title, updatedAt: new Date().toISOString() }, ...prev]);
      await switchThread(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建线程失败。");
    }
  }

  async function removeThread(threadId: string) {
    try {
      await deleteAssistantThread(threadId);
      const updated = threadList.filter((t) => t.id !== threadId);
      setThreadList(updated);
      if (thread?.id === threadId) {
        if (updated.length) {
          await switchThread(updated[0].id);
        } else {
          await newThread();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除线程失败。");
    }
  }

  async function submitMessage(event: React.FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || phase === "streaming") return;
    stopSpeechRecognition();
    await sendMessage(message);
  }

  function handleInputKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    const intent = assistantKeyIntent({
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      isComposing: event.nativeEvent.isComposing,
    });
    if (intent !== "submit") return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  async function toggleSpeechRecognition() {
    if (phase === "streaming") return;
    if (speechPhase === "listening" || speechPhase === "starting") {
      stopSpeechRecognition();
      return;
    }
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      setSpeechPhase("unsupported");
      setSpeechNotice("当前浏览器不支持语音输入。");
      return;
    }
    setSpeechPhase("starting");
    setSpeechNotice("正在启动语音识别…");
    const microphoneReady = await ensureMicrophoneReady();
    if (!microphoneReady.ok) {
      setSpeechPhase("error");
      setSpeechNotice(microphoneReady.message);
      return;
    }
    const recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      setSpeechPhase("listening");
      setSpeechNotice("正在识别，可以直接说出你的问题。");
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      setSpeechPhase((current) => (current === "listening" ? "idle" : current));
      setSpeechNotice((current) => (current === "正在识别，可以直接说出你的问题。" ? "" : current));
    };
    recognition.onerror = (event) => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      setSpeechPhase("error");
      setSpeechNotice(speechErrorMessage(event.error));
      if (canRestartSpeechAfterError(event.error)) {
        window.setTimeout(() => {
          if (recognitionRef.current) return;
          setSpeechPhase("idle");
        }, 900);
      }
    };
    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript ?? "";
        if (result?.isFinal) finalText += transcript;
        else interimText += transcript;
      }
      if (finalText.trim()) {
        setInput((current) => mergeSpeechTranscript(current, finalText));
        queueMicrotask(() => inputRef.current?.focus());
      }
      if (interimText.trim()) setSpeechNotice(`正在识别：${interimText.trim()}`);
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setSpeechPhase("error");
      setSpeechNotice("语音识别启动失败，请检查浏览器麦克风权限。");
    }
  }

  function stopSpeechRecognition() {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setSpeechPhase("idle");
    setSpeechNotice("");
  }

  async function sendMessage(message: string) {
    setInput("");
    setDraft("正在分析…");
    setDraftBlocks([]);
    setAgentStatus("");
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
      const final = await sendAssistantMessage(message, mode, handleStreamEvent, thread?.id);
      if (final) setThread((current) => (current ? { ...current, messages: [...current.messages.filter((item) => item.id !== final.id), final] } : current));
      setDraft("");
      setDraftBlocks([]);
      setAgentStatus("");
      setPhase("ready");
      if (final) {
        if (thread?.title === "新对话" && final.content) {
          const title = final.content.replace(/^[：:]\s*/, "").slice(0, 40).replace(/\n.*$/s, "") || message.slice(0, 40);
          try { await renameAssistantThread(thread.id, title); } catch { /* ignore */ }
        }
        void reloadThread(thread?.id);
        void loadThreadList();
      }
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
    if (event.type === "agent_step") { setDraft(""); setAgentStatus(event.title); }
    if (event.type === "tool_status") {
      setDraft("");
      setToolCalls((prev) => {
        const next = new Map(prev);
        next.set(event.id, { label: event.label, status: event.status });
        return next;
      });
      if (event.status === "completed") setAgentStatus("正在整合证据...");
      if (event.status === "failed") setAgentStatus("部分来源暂时不可用，继续分析...");
    }
    if (event.type === "tool_result") {
      setAgentStatus(event.status === "failed" ? "部分来源暂时不可用，继续分析..." : "正在整合证据...");
    }
    if (event.type === "delta") {
      setAgentStatus("");
      setToolCalls(new Map());
      setDraft((current) => mergeAssistantDelta(current, event.text));
    }
    if (event.type === "block") setDraftBlocks((current) => [...current.filter((item) => item.id !== event.block.id), event.block]);
    if (event.type === "choice_request") {
      setDraft("");
      setAgentStatus("");
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
    if (event.type === "code_exec") {
      setAgentStatus("正在用 Python 计算...");
      void executePyodideCode(event.id, event.code);
    }
  }

  async function executePyodideCode(execId: string, code: string) {
    try {
      if (!pyodideRef.current) {
        setPyodideReady("loading");
        const pyodideModule = await import("pyodide");
        const pyodide = await pyodideModule.loadPyodide({
          indexURL: "https://cdn.jsdelivr.net/pyodide/v0.27.0/full/",
        });
        pyodideRef.current = pyodide;
        setPyodideReady("ready");
      }
      const result = await pyodideRef.current.runPythonAsync(code);
      const output = String(result ?? "");
      await sendCodeResult(execId, output);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await sendCodeResult(execId, "", errorMsg);
      setPyodideReady("error");
    }
  }

  const visibleMessages = useMemo(() => thread?.messages ?? [], [thread]);

  return (
    <section className="assistant-workspace" aria-label="投研助手">
      <div className="assistant-thread-sidebar">
        <div className="assistant-thread-sidebar-header">
          <span>会话列表</span>
          <button type="button" className="assistant-thread-new" onClick={() => void newThread()}>＋ 新对话</button>
        </div>
        <div className="assistant-thread-list">
          {threadList.map((t) => (
            <div key={t.id} className={`assistant-thread-item ${t.id === thread?.id ? "active" : ""}`} onClick={() => void switchThread(t.id)}>
              <span className="assistant-thread-item-title">{t.title}</span>
              <button type="button" className="assistant-thread-delete" onClick={(e) => { e.stopPropagation(); void removeThread(t.id); }} aria-label="删除">✕</button>
            </div>
          ))}
        </div>
      </div>
      <section className="assistant-chat-panel" aria-label="助手聊天">
          <div className="assistant-messages">
            {phase === "loading" ? <p className="muted">正在读取长期线程...</p> : null}
            {visibleMessages.map((message) => {
              const cleanContent = stripInternalAssistantCompletion(message.content);
              if (message.role === "assistant" && !cleanContent.trim()) return null;
              return (
                <article key={message.id} className={`assistant-message ${message.role === "user" ? "user" : "assistant"}`}>
                  <span className="assistant-role-label">{message.role === "user" ? "你" : "助手"}</span>
                  <AssistantText text={message.metadata?.blocks?.length ? stripRenderedTables(cleanContent) : cleanContent} />
                  <AssistantBlocks blocks={message.metadata?.blocks ?? []} />
                </article>
              );
            })}
            {draft ? (
              <article className="assistant-message assistant streaming">
                <span className="assistant-role-label">助手</span>
                <AssistantText text={draftBlocks.length ? stripRenderedTables(stripInternalAssistantCompletion(draft)) : stripInternalAssistantCompletion(draft)} />
                <AssistantBlocks blocks={draftBlocks} />
              </article>
            ) : null}
            {!draft && (agentStatus || toolCalls.size || pyodideReady === "loading") ? (
              <div className="assistant-agent-status" role="status" aria-live="polite">
                {toolCalls.size ? (
                  <div className="assistant-tool-list">
                    {Array.from(toolCalls.values()).map((call, i) => (
                      <div key={i} className={`assistant-tool-item ${call.status}`}>
                        <span className="assistant-tool-icon">
                          {call.status === "running" ? "●" : call.status === "completed" ? "✓" : "✗"}
                        </span>
                        <span className="assistant-tool-label">{call.label}</span>
                      </div>
                    ))}
                    {agentStatus ? <div className="assistant-tool-summary">{agentStatus}</div> : null}
                  </div>
                ) : pyodideReady === "loading" ? (
                  "正在加载计算环境…"
                ) : (
                  <><span aria-hidden="true" />{agentStatus}</>
                )}
              </div>
            ) : null}
            <div ref={messagesEndRef} />
          </div>
          <form className="assistant-composer" onSubmit={(event) => void submitMessage(event)}>
            <div className="assistant-composer-tools">
              <span>{mode === "chat" ? "普通" : assistantModes.find((item) => item.id === mode)?.label}</span>
              <div className="assistant-mode-switch" aria-label="助手模式">
                {assistantModes.filter((item) => item.id !== "chat").map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={mode === item.id ? "active" : ""}
                    aria-pressed={mode === item.id}
                    onClick={() => setMode(mode === item.id ? "chat" : item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="assistant-input-row">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder={assistantModePlaceholder[mode]}
                rows={2}
                disabled={phase === "streaming"}
              />
              <button
                type="button"
                className={`assistant-voice-button ${speechPhase === "listening" ? "active" : ""}`}
                onClick={toggleSpeechRecognition}
                disabled={phase === "streaming"}
                aria-pressed={speechPhase === "listening"}
                aria-label={speechPhase === "listening" ? "停止语音输入" : "开始语音输入"}
                title={speechPhase === "listening" ? "停止语音输入" : "语音输入"}
              >
                <span aria-hidden="true">{speechPhase === "listening" ? "■" : "♪"}</span>
              </button>
              <button type="submit" disabled={!input.trim() || phase === "streaming"}>
                {phase === "streaming" ? "生成中..." : "发送"}
              </button>
            </div>
            {speechNotice ? <p className={`assistant-speech-status ${speechPhase === "error" || speechPhase === "unsupported" ? "is-error" : ""}`}>{speechNotice}</p> : null}
            {error ? <p className="error-text">{error}</p> : null}
          </form>
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

function AssistantText({ text }: { text: string }) {
  const blocks = parseAssistantMarkdown(text);
  return (
    <div className="assistant-rich-text">
      {blocks.length
        ? blocks.map((block, index) => {
            if (block.type === "heading") {
              const Heading = block.level <= 2 ? "h3" : "h4";
              return <Heading key={`h-${index}`}>{renderInlineMarkdown(block.text)}</Heading>;
            }
            if (block.type === "hr") return <hr key={`hr-${index}`} />;
            if (block.type === "list") {
              return (
                <ul key={`ul-${index}`}>
                  {block.items.map((item, itemIndex) => <li key={`${itemIndex}-${item}`}>{renderInlineMarkdown(item)}</li>)}
                </ul>
              );
            }
            if (block.type === "table") {
              return (
                <InlineAssistantTable key={`table-${index}`} headers={block.headers} rows={block.rows} />
              );
            }
            const isConclusion = /^结论[：:]/.test(block.text.trim());
            return <p key={`p-${index}`} className={isConclusion ? "assistant-conclusion-line" : undefined}>{renderInlineMarkdown(block.text)}</p>;
          })
        : <p>{text}</p>}
    </div>
  );
}

function InlineAssistantTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  const table = (
    <div className="assistant-inline-table-wrap">
      <table>
        <thead>
          <tr>{headers.map((cell, cellIndex) => <th key={`${cell}-${cellIndex}`}>{renderInlineMarkdown(cell)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${rowIndex}-${row.join("|")}`}>
              {row.map((cell, cellIndex) => <td key={`${cellIndex}-${cell}`}>{renderInlineMarkdown(cell)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  if (isCompactTable(headers.length, rows.length)) return table;
  return (
    <details className="assistant-collapsible-block">
      <summary>展开表格（{rows.length} 行）</summary>
      {table}
    </details>
  );
}

function renderInlineMarkdown(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={`${part}-${index}`}>{part.slice(2, -2)}</strong>;
    return <span key={`${part}-${index}`}>{part}</span>;
  });
}

function AssistantBlocks({ blocks }: { blocks: AssistantBlock[] }) {
  if (!blocks.length) return null;
  return (
    <div className="assistant-blocks">
      {blocks.map((block) => {
        if (block.type === "table") {
          const table = (
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
          if (isCompactTable(block.columns.length, block.rows.length)) return table;
          return (
            <details key={block.id} className="assistant-collapsible-block">
              <summary>{block.title || "展开表格"}（{block.rows.length} 行）</summary>
              {table}
            </details>
          );
        }
        if (block.type === "chart") {
          return <CollapsibleAssistantChart key={block.id} block={block} />;
        }
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

function isCompactTable(columnCount: number, rowCount: number) {
  return columnCount <= 4 && rowCount <= 4;
}

function CollapsibleAssistantChart({ block }: { block: AssistantChartBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="assistant-collapsible-block" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{block.title || "展开图表"}</summary>
      {open ? <AssistantChart block={block} /> : null}
    </details>
  );
}

function AssistantChart({ block }: { block: AssistantChartBlock }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ref.current) return undefined;
    const chart = echarts.init(ref.current);
    if (block.chartType === "pie") {
      chart.setOption({
        animation: false,
        tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
        legend: { orient: "vertical", left: "left", textStyle: { fontWeight: 700 } },
        series: [
          {
            type: "pie",
            radius: ["30%", "60%"],
            center: ["50%", "55%"],
            data: block.labels.map((label, i) => ({ name: label, value: block.series[0]?.data[i] ?? 0 })),
            emphasis: { itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: "rgba(0, 0, 0, 0.5)" } },
          },
        ],
      });
    } else {
      const isArea = block.chartType === "area";
      const isLine = block.chartType === "line" || isArea;
      chart.setOption({
        animation: false,
        tooltip: { trigger: "axis" },
        legend: { top: 0, textStyle: { fontWeight: 700 } },
        grid: { left: 44, right: 16, top: 42, bottom: 42 },
        xAxis: { type: "category", data: block.labels, axisLabel: { interval: 0, rotate: block.labels.length > 6 ? 24 : 0 } },
        yAxis: { type: "value" },
        series: block.series.map((series) => ({
          name: series.name,
          type: isLine ? "line" : block.chartType === "scatter" ? "scatter" : "bar",
          data: series.data,
          smooth: isLine,
          ...(isArea ? { areaStyle: {} } : {}),
        })),
      });
    }
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

async function ensureMicrophoneReady(): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const permission = await navigator.permissions?.query?.({ name: "microphone" as PermissionName });
    const blocked = shouldBlockSpeechForPermissionState(permission?.state);
    if (blocked.blocked) return { ok: false, message: blocked.message };
  } catch (error) {
    // Some browsers do not expose microphone permission through the Permissions API.
    // Let SpeechRecognition.start() request/check the device instead of pre-opening the mic.
    void error;
  }
  return { ok: true };
}

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const win = window as typeof window & { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

export default AssistantView;
