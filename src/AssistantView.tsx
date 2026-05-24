import { useEffect, useMemo, useRef, useState } from "react";
import {
  confirmAssistantMemoryCandidate,
  deleteAssistantMemory,
  disableAssistantMemory,
  fetchAssistantThread,
  rejectAssistantMemoryCandidate,
  sendAssistantMessage,
} from "./api";
import { assistantCacheHitRate, mergeAssistantDelta } from "./assistant-state";
import type { AssistantChatStreamEvent, AssistantMemory, AssistantMemoryCandidate, AssistantMessage, AssistantThread, AssistantUsage } from "./shared/assistant";

type AssistantPhase = "loading" | "ready" | "streaming" | "error";

export function AssistantView() {
  const [thread, setThread] = useState<AssistantThread | null>(null);
  const [phase, setPhase] = useState<AssistantPhase>("loading");
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState("");
  const [usage, setUsage] = useState<AssistantUsage | undefined>();
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

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
      setUsage(next.latestUsage);
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
    setInput("");
    setDraft("");
    setError("");
    setPhase("streaming");
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
      const final = await sendAssistantMessage(message, handleStreamEvent);
      setThread((current) => (current ? { ...current, messages: [...current.messages.filter((item) => item.id !== final.id), final] } : current));
      setDraft("");
      setPhase("ready");
      void reloadThread();
    } catch (err) {
      setError(err instanceof Error ? err.message : "助手生成失败。");
      setPhase("error");
    }
  }

  function handleStreamEvent(event: AssistantChatStreamEvent) {
    if (event.type === "delta") setDraft((current) => mergeAssistantDelta(current, event.text));
    if (event.type === "usage") setUsage(event.usage);
    if (event.type === "memory_candidate") {
      setThread((current) => (current ? { ...current, memoryCandidates: uniqueCandidates([event.candidate, ...current.memoryCandidates]) } : current));
    }
  }

  async function confirmCandidate(candidate: AssistantMemoryCandidate) {
    await confirmAssistantMemoryCandidate(candidate.id);
    await reloadThread();
  }

  async function rejectCandidate(candidate: AssistantMemoryCandidate) {
    await rejectAssistantMemoryCandidate(candidate.id);
    await reloadThread();
  }

  async function disableMemory(memory: AssistantMemory) {
    await disableAssistantMemory(memory.id);
    await reloadThread();
  }

  async function removeMemory(memory: AssistantMemory) {
    await deleteAssistantMemory(memory.id);
    await reloadThread();
  }

  const cacheRate = assistantCacheHitRate(usage);
  const visibleMessages = useMemo(() => thread?.messages ?? [], [thread]);

  return (
    <section className="assistant-workspace" aria-labelledby="assistant-title">
      <header className="assistant-hero">
        <div>
          <p className="eyebrow">Admin Only</p>
          <h2 id="assistant-title">投研助手</h2>
          <p>用站内证据、长期记忆和可审计引用来回答投资问题。默认 DeepSeek Flash High，不写入雷达或模板正式报告。</p>
        </div>
        <div className="assistant-kpis" aria-label="助手状态">
          <span><strong>{visibleMessages.length}</strong>消息</span>
          <span><strong>{thread?.memories.filter((item) => item.status === "active").length ?? 0}</strong>记忆</span>
          <span><strong>{cacheRate === null ? "--" : `${cacheRate}%`}</strong>缓存命中</span>
        </div>
      </header>

      <div className="assistant-grid">
        <section className="assistant-chat-panel" aria-label="助手聊天">
          <div className="assistant-messages">
            {phase === "loading" ? <p className="muted">正在读取长期线程...</p> : null}
            {visibleMessages.map((message) => (
              <article key={message.id} className={`assistant-message ${message.role === "user" ? "user" : "assistant"}`}>
                <span>{message.role === "user" ? "你" : "助手"}</span>
                <p>{message.content}</p>
              </article>
            ))}
            {draft ? (
              <article className="assistant-message assistant streaming">
                <span>助手</span>
                <p>{draft}</p>
              </article>
            ) : null}
            <div ref={messagesEndRef} />
          </div>
          <form className="assistant-composer" onSubmit={(event) => void submitMessage(event)}>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="问一个投资问题，或说“记住：以后分析白酒先看批价和库存”。"
              rows={3}
              disabled={phase === "streaming"}
            />
            <button type="submit" disabled={!input.trim() || phase === "streaming"}>
              {phase === "streaming" ? "生成中..." : "发送"}
            </button>
          </form>
          {error ? <p className="error-text">{error}</p> : null}
        </section>

        <aside className="assistant-side-panel" aria-label="助手证据和记忆">
          <section>
            <h3>记忆候选</h3>
            {thread?.memoryCandidates.length ? (
              thread.memoryCandidates.map((candidate) => (
                <div key={candidate.id} className="assistant-memory-card pending">
                  <strong>{candidate.category}</strong>
                  <p>{candidate.content}</p>
                  <small>{candidate.reason}</small>
                  <div>
                    <button type="button" onClick={() => void confirmCandidate(candidate)}>确认</button>
                    <button type="button" className="ghost-button" onClick={() => void rejectCandidate(candidate)}>忽略</button>
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">暂无待确认记忆。</p>
            )}
          </section>

          <section>
            <h3>已确认记忆</h3>
            {thread?.memories.length ? (
              thread.memories.map((memory) => (
                <div key={memory.id} className={`assistant-memory-card ${memory.status}`}>
                  <strong>{memory.category}</strong>
                  <p>{memory.content}</p>
                  <div>
                    {memory.status === "active" ? <button type="button" className="ghost-button" onClick={() => void disableMemory(memory)}>停用</button> : null}
                    <button type="button" className="ghost-button" onClick={() => void removeMemory(memory)}>删除</button>
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">确认候选后，助手会在后续聊天中使用。</p>
            )}
          </section>

          <section>
            <button type="button" className="assistant-diagnostics-toggle" onClick={() => setShowDiagnostics((value) => !value)}>
              {showDiagnostics ? "收起调用指标" : "展开调用指标"}
            </button>
            {showDiagnostics ? (
              <dl className="assistant-diagnostics">
                <dt>模型</dt>
                <dd>{usage?.model ?? "deepseek-v4-flash"}</dd>
                <dt>思考强度</dt>
                <dd>{usage?.reasoningEffort ?? "high"}</dd>
                <dt>命中缓存</dt>
                <dd>{usage?.promptCacheHitTokens ?? "--"}</dd>
                <dt>未命中</dt>
                <dd>{usage?.promptCacheMissTokens ?? "--"}</dd>
                <dt>总 token</dt>
                <dd>{usage?.totalTokens ?? "--"}</dd>
                <dt>耗时</dt>
                <dd>{usage?.elapsedMs ? `${Math.round(usage.elapsedMs / 1000)} 秒` : "--"}</dd>
              </dl>
            ) : null}
          </section>
        </aside>
      </div>
    </section>
  );
}

function uniqueCandidates(candidates: AssistantMemoryCandidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

export default AssistantView;
