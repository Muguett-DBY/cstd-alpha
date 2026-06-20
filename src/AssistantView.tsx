import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  confirmAssistantMemoryCandidate,
  fetchAssistantThread,
  listAssistantThreads,
  createAssistantThread,
  deleteAssistantThread,
  fetchAssistantDeepResearchJob,
  renameAssistantThread,
  rejectAssistantMemoryCandidate,
  sendAssistantMessage,
  sendCodeResult,
  stopAssistantDeepResearchJob,
} from "./api";
import { composeClarifiedAssistantMessage, type AssistantClarificationOption, type AssistantClarificationRequest } from "./assistant-clarification";
import { assistantKeyIntent, canRestartSpeechAfterError, mergeSpeechTranscript, resolveSpeechPermissionState, shouldBlockSpeechForPermissionState, speechErrorMessage } from "./assistant-input";
import { parseAssistantMarkdown } from "./assistant-markdown";
import { assistantSupplementaryBlocks, mergeAssistantDeepResearchJobs, mergeAssistantDelta, stripInternalAssistantCompletion } from "./assistant-state";
import type { AssistantBlock, AssistantChartBlock, AssistantChatStreamEvent, AssistantDeepResearchJob, AssistantMemoryCandidate, AssistantMessage, AssistantThread } from "./shared/assistant";

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
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [threadList, setThreadList] = useState<Array<{ id: string; title: string; updatedAt: string }>>([]);
  const [threadDrawerOpen, setThreadDrawerOpen] = useState(false);
  const [pendingClarification, setPendingClarification] = useState<{ original: string; request: AssistantClarificationRequest; selectedId: string; customAnswer: string; error?: string } | null>(null);
  const [pendingMemory, setPendingMemory] = useState<AssistantMemoryCandidate | null>(null);
  const [draftBlocks, setDraftBlocks] = useState<AssistantBlock[]>([]);
  const [agentStatus, setAgentStatus] = useState("");
  const [toolCalls, setToolCalls] = useState<Map<string, { label: string; status: "running" | "completed" | "failed" }>>(new Map());
  const [deepResearchJobs, setDeepResearchJobs] = useState<Record<string, AssistantDeepResearchJob>>({});
  const [speechPhase, setSpeechPhase] = useState<SpeechPhase>("idle");
  const [speechNotice, setSpeechNotice] = useState("");
  const [pyodideReady, setPyodideReady] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [retryCount, setRetryCount] = useState(0);
  const pyodideRef = useRef<{ runPythonAsync: (code: string) => Promise<unknown> } | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const lastSentMessageRef = useRef("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const assistantAbortRef = useRef<AbortController | null>(null);
  const activeThreadIdRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      recognitionRef.current?.abort?.();
      recognitionRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => {
      if (phase === "error" && lastSentMessageRef.current) {
        setRetryCount((current) => current + 1);
      } else if (phase === "ready" || phase === "streaming") {
        setRetryCount((previous) => (previous === 0 ? previous : 0));
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [phase]);

  useEffect(() => {
    activeThreadIdRef.current = thread?.id ?? null;
    shouldStickToBottomRef.current = true;
  }, [thread?.id]);

  useEffect(() => {
    if (!shouldStickToBottomRef.current) return;
    const scrollEl = messagesScrollRef.current;
    if (scrollEl) {
      scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: "smooth" });
      return;
    }
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [thread?.messages.length, draft, agentStatus, deepResearchJobs]);

  function updateMessageScrollStickiness() {
    const scrollEl = messagesScrollRef.current;
    if (!scrollEl) {
      shouldStickToBottomRef.current = true;
      return;
    }
    const distanceToBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    shouldStickToBottomRef.current = distanceToBottom < 96;
  }

  const activeDeepResearchIds = useMemo(
    () => Object.values(deepResearchJobs).filter((job) => job.status === "queued" || job.status === "running" || job.status === "stopping").map((job) => job.id).sort().join(","),
    [deepResearchJobs],
  );

  useEffect(() => {
    if (!activeDeepResearchIds) return;
    let cancelled = false;
    const poll = async () => {
      const ids = activeDeepResearchIds.split(",").filter(Boolean);
      const results = await Promise.all(ids.map((id) => fetchAssistantDeepResearchJob(id).catch(() => null)));
      if (cancelled) return;
      const completed = results.some((job) => job?.status === "completed" || job?.status === "failed");
      setDeepResearchJobs((current) => mergeAssistantDeepResearchJobs(current, results));
      if (completed) {
        await reloadThread(activeThreadIdRef.current ?? undefined);
        void loadThreadList();
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeDeepResearchIds]);

  async function reloadThread(threadId?: string) {
    setPhase("loading");
    setError("");
    try {
      const next = await fetchAssistantThread(threadId);
      setThread(next);
      setDeepResearchJobs((current) => mergeAssistantDeepResearchJobs(current, collectDeepResearchJobs(next.messages)));
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
    assistantAbortRef.current?.abort();
    setDraft("");
    setDraftBlocks([]);
    setAgentStatus("");
    setToolCalls(new Map());
    setThreadDrawerOpen(false);
    await reloadThread(threadId);
  }

  async function newThread() {
    try {
      const created = await createAssistantThread();
      setThreadList((prev) => [{ id: created.id, title: created.title, updatedAt: new Date().toISOString() }, ...prev]);
      setThreadDrawerOpen(false);
      await switchThread(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建线程失败。");
    }
  }

  async function renameThreadInline(threadId: string, currentTitle: string) {
    const next = window.prompt("重命名会话", currentTitle);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === currentTitle) return;
    try {
      await renameAssistantThread(threadId, trimmed);
      setThreadList((current) => current.map((t) => (t.id === threadId ? { ...t, title: trimmed } : t)));
      if (thread?.id === threadId) {
        setThread((current) => (current ? { ...current, title: trimmed } : current));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "重命名失败。");
    }
  }

  function exportThreadAsJson() {
    if (!thread) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      thread: {
        id: thread.id,
        title: thread.title,
        updatedAt: thread.updatedAt,
        messages: thread.messages,
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `assistant-thread-${thread.id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
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
    let startTimeoutId: number | undefined;
    const clearStartTimeout = () => {
      if (startTimeoutId === undefined) return;
      window.clearTimeout(startTimeoutId);
      startTimeoutId = undefined;
    };
    recognition.onstart = () => {
      clearStartTimeout();
      setSpeechPhase("listening");
      setSpeechNotice("正在识别，可以直接说出你的问题。");
    };
    recognition.onend = () => {
      clearStartTimeout();
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      setSpeechPhase((current) => (current === "listening" ? "idle" : current));
      setSpeechNotice((current) => (current === "正在识别，可以直接说出你的问题。" ? "" : current));
    };
    recognition.onerror = (event) => {
      clearStartTimeout();
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
      startTimeoutId = window.setTimeout(() => {
        if (recognitionRef.current !== recognition) return;
        recognition.abort?.();
        recognitionRef.current = null;
        setSpeechPhase("error");
        setSpeechNotice("语音识别启动超时，请检查浏览器麦克风权限或使用系统听写。");
      }, 5_000);
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
    assistantAbortRef.current?.abort();
    const controller = new AbortController();
    assistantAbortRef.current = controller;
    const requestThreadId = thread?.id ?? null;
    shouldStickToBottomRef.current = true;
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
      const final = await sendAssistantMessage(message, handleStreamEvent, undefined, requestThreadId ?? undefined, controller.signal);
      if (final) {
        setThread((current) => {
          if (!current || !isSameAssistantResponseThread(current.id, requestThreadId, final.threadId)) return current;
          return { ...current, id: final.threadId || current.id, messages: [...current.messages.filter((item) => item.id !== final.id), final] };
        });
      }
      setDraft("");
      setDraftBlocks([]);
      setAgentStatus("");
      setPhase("ready");
      if (final) {
        if (isSameAssistantResponseThread(activeThreadIdRef.current, requestThreadId, final.threadId) && thread?.title === "新对话" && final.content) {
          const title = final.content.replace(/^[：:]\s*/, "").slice(0, 40).replace(/\n.*$/s, "") || message.slice(0, 40);
          try { await renameAssistantThread(final.threadId || requestThreadId || thread.id, title); } catch { /* ignore */ }
        }
        if (isSameAssistantResponseThread(activeThreadIdRef.current, requestThreadId, final.threadId)) void reloadThread(final.threadId || requestThreadId || undefined);
        void loadThreadList();
      }
    } catch (err) {
      if (controller.signal.aborted) {
        setDraft("");
        setDraftBlocks([]);
        setAgentStatus("");
        setToolCalls(new Map());
        setError("已停止生成。");
        setPhase("ready");
        return;
      }
      setError(err instanceof Error ? err.message : "助手生成失败。");
      setPhase("error");
    }
    finally {
      if (assistantAbortRef.current === controller) assistantAbortRef.current = null;
    }
  }

  function stopAssistantGeneration() {
    assistantAbortRef.current?.abort();
  }

  function resendLastMessage() {
    if (phase === "streaming") return;
    if (!lastSentMessageRef.current.trim()) {
      setError("没有可重发的上一条消息。");
      return;
    }
    void sendMessage(lastSentMessageRef.current);
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
    if (event.type === "replace") {
      setAgentStatus("");
      setToolCalls(new Map());
      setDraft(event.text);
    }
    if (event.type === "block") setDraftBlocks((current) => [...current.filter((item) => item.id !== event.block.id), event.block]);
    if (event.type === "choice_request") {
      setDraft("");
      setAgentStatus("");
      setToolCalls(new Map());
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
    if (event.type === "deep_research_job") {
      setDeepResearchJobs((current) => mergeAssistantDeepResearchJobs(current, [event.job]));
      setAgentStatus("");
      setToolCalls(new Map());
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

  const visibleMessages = useMemo(() => {
    const base = thread?.messages ?? [];
    if (!searchQuery.trim()) return base;
    const query = searchQuery.trim().toLowerCase();
    return base.filter((message) => message.content.toLowerCase().includes(query));
  }, [thread, searchQuery]);
  const searchMatchCount = useMemo(() => {
    if (!searchQuery.trim()) return 0;
    const all = thread?.messages ?? [];
    return all.filter((message) => message.content.toLowerCase().includes(searchQuery.trim().toLowerCase())).length;
  }, [thread, searchQuery]);

  return (
    <section className="assistant-workspace" aria-label="投研助手">
      {threadDrawerOpen ? <button type="button" className="assistant-thread-scrim" aria-label="关闭会话列表" onClick={() => setThreadDrawerOpen(false)} /> : null}
      <div className={`assistant-thread-sidebar ${threadDrawerOpen ? "open" : ""}`}>
        <div className="assistant-thread-sidebar-header">
          <span>会话列表</span>
          <div>
            <button type="button" className="assistant-thread-new" onClick={() => void newThread()}>＋ 新对话</button>
            <button type="button" className="assistant-thread-close" onClick={() => setThreadDrawerOpen(false)} aria-label="收起会话列表">收起</button>
          </div>
        </div>
        <div className="assistant-thread-list">
          {threadList.map((t) => (
            <div key={t.id} className={`assistant-thread-item ${t.id === thread?.id ? "active" : ""}`} onClick={() => void switchThread(t.id)}>
              <span className="assistant-thread-item-title">{t.title}</span>
              <div className="assistant-thread-item-actions">
                <button type="button" className="assistant-thread-rename" onClick={(e) => { e.stopPropagation(); void renameThreadInline(t.id, t.title); }} aria-label="重命名会话">✎</button>
                <button type="button" className="assistant-thread-delete" onClick={(e) => { e.stopPropagation(); void removeThread(t.id); }} aria-label="删除">✕</button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <section className="assistant-chat-panel" aria-label="助手聊天">
          <header className="assistant-mobile-bar">
            <button type="button" className="assistant-thread-toggle" onClick={() => setThreadDrawerOpen(true)} aria-label="展开会话列表">☰</button>
            <div>
              <strong>CSTD 助手</strong>
              <span>{thread?.title || "长期投研线程"}</span>
            </div>
            <button type="button" className="assistant-mobile-new" onClick={() => void newThread()} aria-label="新对话">＋</button>
            {thread && thread.messages.length > 0 ? (
              <button type="button" className="assistant-thread-export" onClick={exportThreadAsJson} aria-label="导出当前会话为 JSON">⤓</button>
            ) : null}
          </header>
          <div className="assistant-search-bar" role="search">
            <button
              type="button"
              className={`assistant-search-toggle ${searchOpen ? "open" : ""}`}
              onClick={() => setSearchOpen((current) => !current)}
              aria-label={searchOpen ? "关闭消息搜索" : "打开消息搜索"}
              aria-expanded={searchOpen}
            >
              🔍
            </button>
            {searchOpen ? (
              <>
                <input
                  type="search"
                  className="assistant-search-input"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="搜索历史消息"
                  aria-label="搜索消息内容"
                />
                {searchQuery ? (
                  <span className="assistant-search-count" aria-live="polite">
                    {searchMatchCount} 条匹配
                  </span>
                ) : null}
                <button
                  type="button"
                  className="assistant-search-clear"
                  onClick={() => { setSearchQuery(""); setSearchOpen(false); }}
                  aria-label="清除搜索"
                >
                  ×
                </button>
              </>
            ) : null}
          </div>
          <div ref={messagesScrollRef} className="assistant-messages" onScroll={updateMessageScrollStickiness}>
            {phase === "loading" ? <p className="muted">正在读取长期线程...</p> : null}
            {visibleMessages.map((message) => {
              const cleanContent = stripInternalAssistantCompletion(message.content);
              if (message.role === "assistant" && !cleanContent.trim()) return null;
              return (
                <article key={message.id} className={`assistant-message ${message.role === "user" ? "user" : "assistant"}`}>
                  <span className="assistant-role-label">{message.role === "user" ? "你" : "助手"}</span>
                  <AssistantText text={cleanContent} highlight={searchQuery} />
                  <AssistantBlocks blocks={assistantSupplementaryBlocks(message.metadata?.blocks)} />
                  {message.metadata?.deepResearchJob ? (
                    <AssistantDeepResearchCard
                      job={deepResearchJobs[message.metadata.deepResearchJob.id] ?? message.metadata.deepResearchJob}
                      onStop={stopDeepResearch}
                    />
                  ) : null}
                </article>
              );
            })}
            {draft ? (
              <article className="assistant-message assistant streaming">
                <span className="assistant-role-label">助手</span>
                <AssistantText text={stripInternalAssistantCompletion(draft)} />
                <AssistantBlocks blocks={assistantSupplementaryBlocks(draftBlocks)} />
              </article>
            ) : null}
            {!draft && (agentStatus || toolCalls.size || pyodideReady === "loading") ? (
              <div className="assistant-agent-status" role="status" aria-live="polite">
                {toolCalls.size ? (
                  <>
                    <span aria-hidden="true" />
                    <span className="assistant-agent-text">
                    {agentStatus || (() => {
                      const running = Array.from(toolCalls.values()).filter((c) => c.status === "running");
                      const completed = Array.from(toolCalls.values()).filter((c) => c.status === "completed");
                      const parts: string[] = [];
                      if (running.length) parts.push(`正在${running.map((c) => c.label).join("、")}`);
                      if (completed.length) parts.push(`已完成${completed.length}项`);
                      return parts.join("，");
                    })()}
                    </span>
                  </>
                ) : pyodideReady === "loading" ? (
                  "正在加载计算环境…"
                ) : (
                  <><span aria-hidden="true" />{agentStatus}</>
                )}
              </div>
            ) : null}
            <div ref={messagesEndRef} />
          </div>
          <div className={`assistant-status-bar ${isOnline ? "online" : "offline"} ${phase === "error" ? "has-error" : ""}`} role="status" aria-live="polite">
            <span className="assistant-status-dot" aria-hidden="true" />
            <span className="assistant-status-text">
              {!isOnline ? "离线" : phase === "error" ? (retryCount > 1 ? `连接异常 (重试 ${retryCount})` : "连接异常") : "在线"}
            </span>
            {retryCount > 0 && phase === "error" ? (
              <span className="assistant-status-hint">点击上方"重试上一条"可重新发送</span>
            ) : null}
          </div>
          <form className="assistant-composer" onSubmit={(event) => void submitMessage(event)}>
            <div className="assistant-input-row">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder={'问一个投资问题，或说\u201C记住：以后分析白酒先看批价和库存\u201D。'}
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
              <button
                type={phase === "streaming" ? "button" : "submit"}
                className={phase === "streaming" ? "assistant-stop-button" : undefined}
                disabled={!input.trim() && phase !== "streaming"}
                onClick={phase === "streaming" ? stopAssistantGeneration : undefined}
              >
                {phase === "streaming" ? "停止" : "发送"}
              </button>
              <button
                type="button"
                className="assistant-resend-button"
                onClick={resendLastMessage}
                disabled={phase === "streaming" || !lastSentMessageRef.current.trim()}
                aria-label="重发上一条消息"
                title="重发上一条消息"
              >
                ↻
              </button>
            </div>
            {speechNotice ? <p className={`assistant-speech-status ${speechPhase === "error" || speechPhase === "unsupported" ? "is-error" : ""}`}>{speechNotice}</p> : null}
            {error ? (
              <div className="assistant-error-block" role="alert">
                <p className="error-text">{error}</p>
                <button
                  type="button"
                  className="assistant-error-retry"
                  onClick={resendLastMessage}
                  disabled={phase === "streaming" || !lastSentMessageRef.current.trim()}
                >
                  重试上一条
                </button>
              </div>
            ) : null}
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

  async function stopDeepResearch(job: AssistantDeepResearchJob) {
    if (job.status !== "queued" && job.status !== "running") return;
    setDeepResearchJobs((current) => mergeAssistantDeepResearchJobs(current, [{ ...job, status: "stopping", progressTitle: "正在整理阶段性总结..." }]));
    try {
      const next = await stopAssistantDeepResearchJob(job.id);
      setDeepResearchJobs((current) => mergeAssistantDeepResearchJobs(current, [next]));
    } catch (err) {
      setError(err instanceof Error ? err.message : "深度研究停止失败。");
    }
  }
}

function collectDeepResearchJobs(messages: AssistantMessage[]) {
  return messages.flatMap((message) => message.metadata?.deepResearchJob ? [message.metadata.deepResearchJob] : []);
}

function AssistantDeepResearchCard({ job, onStop }: { job: AssistantDeepResearchJob; onStop: (job: AssistantDeepResearchJob) => void }) {
  const canStop = job.status === "queued" || job.status === "running";
  const progress = Math.max(0, Math.min(100, Math.round((job.progressCurrent / Math.max(job.progressTotal, 1)) * 100)));
  return (
    <section className={`assistant-deep-research-card ${job.status}`} aria-label="深度研究进度">
      <div className="assistant-deep-research-head">
        <div>
          <strong>{deepResearchStatusLabel(job.status)}</strong>
          <span>{job.progressTitle}</span>
        </div>
        {canStop ? <button type="button" onClick={() => onStop(job)}>停止并总结</button> : null}
      </div>
      <div className="assistant-deep-research-progress" aria-label={`深度研究进度 ${progress}%`}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <small>{job.status === "completed" ? "最终答案已追加到当前会话。" : job.status === "failed" ? "本次后台研究未完成，可稍后重试。" : "可以离开页面，后台会继续研究。"}</small>
    </section>
  );
}

function deepResearchStatusLabel(status: AssistantDeepResearchJob["status"]) {
  if (status === "queued") return "深度研究排队中";
  if (status === "running") return "深度研究进行中";
  if (status === "stopping") return "正在停止并总结";
  if (status === "completed") return "深度研究完成";
  return "深度研究失败";
}

function isSameAssistantResponseThread(currentThreadId: string | null, requestThreadId: string | null, responseThreadId?: string) {
  if (!currentThreadId) return false;
  if (responseThreadId && currentThreadId === responseThreadId) return true;
  if (requestThreadId && currentThreadId === requestThreadId) return true;
  return !requestThreadId && currentThreadId === "local";
}

function AssistantText({ text, highlight }: { text: string; highlight?: string }) {
  const blocks = parseAssistantMarkdown(text);
  const highlightText = (value: string) => {
    if (!highlight || !highlight.trim()) return value;
    const query = highlight.trim();
    const parts: ReactNode[] = [];
    let lastIndex = 0;
    const lowerValue = value.toLowerCase();
    const lowerQuery = query.toLowerCase();
    let cursor = 0;
    while (cursor < value.length) {
      const found = lowerValue.indexOf(lowerQuery, cursor);
      if (found < 0) {
        parts.push(value.slice(cursor));
        break;
      }
      if (found > cursor) parts.push(value.slice(cursor, found));
      parts.push(<mark key={`hl-${lastIndex++}`} className="assistant-search-highlight">{value.slice(found, found + query.length)}</mark>);
      cursor = found + query.length;
    }
    return <>{parts}</>;
  };
  return (
    <div className="assistant-rich-text">
      {blocks.length
        ? blocks.map((block, index) => {
            if (block.type === "heading") {
              const Heading = block.level <= 2 ? "h3" : "h4";
              return <Heading key={`h-${index}`}>{highlightText(block.text)}</Heading>;
            }
            if (block.type === "hr") return <hr key={`hr-${index}`} />;
            if (block.type === "list") {
              return (
                <ul key={`ul-${index}`}>
                  {block.items.map((item, itemIndex) => <li key={`${itemIndex}-${item}`}>{highlightText(item)}</li>)}
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
  return rowCount <= 2 || (columnCount <= 4 && rowCount <= 4);
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

async function loadAssistantECharts() {
  const [core, charts, components, renderers] = await Promise.all([
    import("echarts/core"),
    import("echarts/charts"),
    import("echarts/components"),
    import("echarts/renderers"),
  ]);
  core.use([
    charts.PieChart,
    charts.LineChart,
    charts.BarChart,
    charts.ScatterChart,
    components.GridComponent,
    components.TooltipComponent,
    components.LegendComponent,
    renderers.CanvasRenderer,
  ]);
  return core;
}

function AssistantChart({ block }: { block: AssistantChartBlock }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ref.current) return undefined;
    let disposed = false;
    let chart: import("echarts/core").EChartsType | undefined;
    const resize = () => chart?.resize();
    void loadAssistantECharts()
      .then((echarts) => {
        if (!ref.current || disposed) return;
        chart = echarts.init(ref.current);
        applyAssistantChartOptions(chart, block);
        window.addEventListener("resize", resize);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      window.removeEventListener("resize", resize);
      chart?.dispose();
    };
  }, [block]);

  return (
    <div className="assistant-chart-block">
      {block.title ? <strong>{block.title}</strong> : null}
      <div ref={ref} role="img" aria-label={block.title || "助手图表"} />
    </div>
  );
}

function applyAssistantChartOptions(chart: import("echarts/core").EChartsType, block: AssistantChartBlock) {
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
    return;
  }
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
  const state = await resolveSpeechPermissionState(
    navigator.permissions?.query ? () => navigator.permissions.query({ name: "microphone" as PermissionName }) : undefined,
  );
  const blocked = shouldBlockSpeechForPermissionState(state);
  if (blocked.blocked) return { ok: false, message: blocked.message };
  return { ok: true };
}

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const win = window as typeof window & { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

export default AssistantView;
