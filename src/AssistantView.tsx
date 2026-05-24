import { useEffect, useMemo, useRef, useState } from "react";
import {
  confirmAssistantMemoryCandidate,
  fetchAssistantThread,
  sendAssistantMessage,
} from "./api";
import { mergeAssistantDelta } from "./assistant-state";
import type { AssistantChatStreamEvent, AssistantMessage, AssistantThread } from "./shared/assistant";

type AssistantPhase = "loading" | "ready" | "streaming" | "error";

export function AssistantView() {
  const [thread, setThread] = useState<AssistantThread | null>(null);
  const [phase, setPhase] = useState<AssistantPhase>("loading");
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState("");
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
    if (event.type === "memory_candidate") {
      void confirmAssistantMemoryCandidate(event.candidate.id).catch(() => undefined);
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
    </section>
  );
}

export default AssistantView;
