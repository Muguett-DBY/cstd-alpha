import { useEffect, useMemo, useRef, useState } from "react";
import {
  confirmAssistantMemoryCandidate,
  fetchAssistantThread,
  sendAssistantMessage,
} from "./api";
import { analyzeAssistantClarification, composeClarifiedAssistantMessage, type AssistantClarificationOption, type AssistantClarificationRequest } from "./assistant-clarification";
import { mergeAssistantDelta } from "./assistant-state";
import type { AssistantChatStreamEvent, AssistantMessage, AssistantThread } from "./shared/assistant";

type AssistantPhase = "loading" | "ready" | "streaming" | "error";

export function AssistantView() {
  const [thread, setThread] = useState<AssistantThread | null>(null);
  const [phase, setPhase] = useState<AssistantPhase>("loading");
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState("");
  const [pendingClarification, setPendingClarification] = useState<{ original: string; request: AssistantClarificationRequest; selectedId: string; customAnswer: string; error?: string } | null>(null);
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
    const clarification = analyzeAssistantClarification(message);
    if (clarification) {
      setPendingClarification({ original: message, request: clarification, selectedId: clarification.options.find((option) => option.recommended)?.id ?? clarification.options[0].id, customAnswer: "" });
      return;
    }
    await sendMessage(message);
  }

  async function sendMessage(message: string) {
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
    </section>
  );
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

export default AssistantView;
