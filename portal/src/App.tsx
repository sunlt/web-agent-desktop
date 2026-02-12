import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type ProviderKind = "claude-code" | "opencode" | "codex-cli";
type Role = "user" | "assistant" | "system";
type TodoStatus = "todo" | "doing" | "done" | "canceled";
type UiRunStatus = "idle" | "running" | "succeeded" | "failed" | "blocked" | "canceled";

type ChatMessage = {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
};

type TodoItem = {
  runId: string;
  todoId: string;
  content: string;
  status: TodoStatus;
  order: number;
  updatedAt: string;
};

type TodoEvent = {
  eventId: string;
  runId: string;
  todoId: string;
  content: string;
  status: TodoStatus;
  order: number;
  eventTs: string;
};

type HumanLoopRequest = {
  questionId: string;
  runId: string;
  sessionId: string;
  prompt: string;
  metadata: Record<string, unknown>;
  status: "pending" | "resolved";
  requestedAt: string;
  resolvedAt: string | null;
};

type RunStatusEvent = {
  type: "run.status";
  runId: string;
  provider: ProviderKind;
  status: "started" | "finished" | "failed" | "blocked";
  ts: string;
  detail?: string;
};

type MessageDeltaEvent = {
  type: "message.delta";
  runId: string;
  provider: ProviderKind;
  text: string;
  ts: string;
};

type RunWarningEvent = {
  type: "run.warning";
  runId: string;
  provider: ProviderKind;
  warning: string;
  ts: string;
};

type TodoUpdateEvent = {
  type: "todo.update";
  runId: string;
  provider: ProviderKind;
  todo: {
    todoId: string;
    content: string;
    status: TodoStatus;
    order: number;
  };
  ts: string;
};

type ParsedSseEvent = {
  event: string;
  data: unknown;
};

type TimelineEntry = {
  id: string;
  ts: string;
  label: string;
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/$/, "");
const POLL_MS = 3500;
const MAX_TIMELINE = 200;

const DEFAULT_MODEL: Record<ProviderKind, string> = {
  "codex-cli": "gpt-5.1-codex",
  opencode: "openai/gpt-5.1-codex",
  "claude-code": "claude-sonnet-4-20250514",
};

export default function App() {
  const [provider, setProvider] = useState<ProviderKind>("codex-cli");
  const [model, setModel] = useState<string>(DEFAULT_MODEL["codex-cli"]);
  const [requireHumanLoop, setRequireHumanLoop] = useState<boolean>(true);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState<string>("");
  const [runStatus, setRunStatus] = useState<UiRunStatus>("idle");
  const [runDetail, setRunDetail] = useState<string>("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const [todoItems, setTodoItems] = useState<TodoItem[]>([]);
  const [todoEvents, setTodoEvents] = useState<TodoEvent[]>([]);
  const [pendingRequests, setPendingRequests] = useState<HumanLoopRequest[]>([]);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [replying, setReplying] = useState<Record<string, boolean>>({});

  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [errorText, setErrorText] = useState<string>("");

  const nextMessageIdRef = useRef<number>(1);
  const assistantMessageIdRef = useRef<string | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setModel(DEFAULT_MODEL[provider]);
  }, [provider]);

  useEffect(() => {
    activeRunIdRef.current = activeRunId;
  }, [activeRunId]);

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
    };
  }, []);

  const groupedTodos = useMemo(() => {
    const base: Record<TodoStatus, TodoItem[]> = {
      todo: [],
      doing: [],
      done: [],
      canceled: [],
    };

    const sorted = [...todoItems].sort((a, b) => {
      if (a.order !== b.order) {
        return a.order - b.order;
      }
      return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
    });

    for (const item of sorted) {
      base[item.status].push(item);
    }

    return base;
  }, [todoItems]);

  const createMessage = useCallback((role: Role, content: string): ChatMessage => {
    const id = `m-${nextMessageIdRef.current}`;
    nextMessageIdRef.current += 1;
    return {
      id,
      role,
      content,
      createdAt: new Date().toISOString(),
    };
  }, []);

  const appendTimeline = useCallback((label: string, ts?: string) => {
    const entry: TimelineEntry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      ts: ts ?? new Date().toISOString(),
      label,
    };

    setTimeline((prev) => {
      const next = [...prev, entry];
      if (next.length <= MAX_TIMELINE) {
        return next;
      }
      return next.slice(next.length - MAX_TIMELINE);
    });
  }, []);

  const upsertTodo = useCallback((todo: TodoItem) => {
    setTodoItems((prev) => {
      const idx = prev.findIndex((item) => item.todoId === todo.todoId && item.runId === todo.runId);
      if (idx === -1) {
        return [...prev, todo];
      }
      const next = [...prev];
      next[idx] = todo;
      return next;
    });
  }, []);

  const appendAssistantDelta = useCallback((text: string) => {
    const assistantId = assistantMessageIdRef.current;
    if (!assistantId) {
      return;
    }

    setMessages((prev) => {
      const idx = prev.findIndex((message) => message.id === assistantId);
      if (idx === -1) {
        return prev;
      }
      const next = [...prev];
      const target = next[idx];
      if (!target) {
        return prev;
      }
      next[idx] = {
        ...target,
        content: target.content + text,
      };
      return next;
    });
  }, []);

  const fetchJson = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${API_BASE}${path}`, init);
    if (!response.ok) {
      const text = await response.text();
      let message = `请求失败(${response.status})`;
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: string; reason?: string };
          message = parsed.error ?? parsed.reason ?? text;
        } catch {
          message = text;
        }
      }
      throw new Error(message);
    }
    return (await response.json()) as T;
  }, []);

  const refreshRunPanels = useCallback(async (runId: string) => {
    const [todos, todoHistory, pending] = await Promise.all([
      fetchJson<{ items: TodoItem[] }>(
        `/runs/${encodeURIComponent(runId)}/todos?limit=500`,
      ),
      fetchJson<{ events: TodoEvent[] }>(
        `/runs/${encodeURIComponent(runId)}/todos/events?limit=500`,
      ),
      fetchJson<{ requests: HumanLoopRequest[] }>(`/human-loop/pending?runId=${encodeURIComponent(runId)}&limit=200`),
    ]);

    setTodoItems(todos.items ?? []);
    setTodoEvents(todoHistory.events ?? []);
    setPendingRequests(pending.requests ?? []);
  }, [fetchJson]);

  useEffect(() => {
    if (!activeRunId) {
      return;
    }

    void refreshRunPanels(activeRunId);

    if (runStatus !== "running") {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshRunPanels(activeRunId);
    }, POLL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [activeRunId, runStatus, refreshRunPanels]);

  const consumeSse = useCallback(
    async (response: Response) => {
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("SSE 响应体为空");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseBuffer(buffer);
        buffer = parsed.rest;

        for (const event of parsed.events) {
          if (event.event === "run.closed") {
            appendTimeline("run.closed");
            continue;
          }

          if (!event.data || typeof event.data !== "object") {
            continue;
          }

          const payload = event.data as { type?: string };
          switch (payload.type) {
            case "run.status": {
              const statusEvent = payload as RunStatusEvent;
              activeRunIdRef.current = statusEvent.runId;
              setActiveRunId((prev) => prev ?? statusEvent.runId);
              appendTimeline(`run.status: ${statusEvent.status}${statusEvent.detail ? ` (${statusEvent.detail})` : ""}`, statusEvent.ts);

              if (statusEvent.status === "started") {
                setRunStatus("running");
                continue;
              }

              if (statusEvent.status === "blocked") {
                setRunStatus("blocked");
                setRunDetail(statusEvent.detail ?? "provider 不支持 human-loop");
                setErrorText(statusEvent.detail ?? "运行被阻塞");
                continue;
              }

              if (statusEvent.status === "failed") {
                setRunStatus("failed");
                setRunDetail(statusEvent.detail ?? "运行失败");
                setErrorText(statusEvent.detail ?? "运行失败");
                continue;
              }

              const detail = (statusEvent.detail ?? "").toLowerCase();
              if (detail === "canceled") {
                setRunStatus("canceled");
              } else if (detail === "succeeded") {
                setRunStatus("succeeded");
              } else {
                setRunStatus("failed");
                if (statusEvent.detail) {
                  setRunDetail(statusEvent.detail);
                }
              }
              continue;
            }

            case "message.delta": {
              const deltaEvent = payload as MessageDeltaEvent;
              appendAssistantDelta(deltaEvent.text);
              continue;
            }

            case "run.warning": {
              const warningEvent = payload as RunWarningEvent;
              appendTimeline(`warning: ${warningEvent.warning}`, warningEvent.ts);
              continue;
            }

            case "todo.update": {
              const todoEvent = payload as TodoUpdateEvent;
              const item: TodoItem = {
                runId: todoEvent.runId,
                todoId: todoEvent.todo.todoId,
                content: todoEvent.todo.content,
                status: todoEvent.todo.status,
                order: todoEvent.todo.order,
                updatedAt: todoEvent.ts,
              };
              upsertTodo(item);
              setTodoEvents((prev) => [
                ...prev,
                {
                  eventId: `stream-${todoEvent.runId}-${todoEvent.todo.todoId}-${todoEvent.ts}`,
                  runId: todoEvent.runId,
                  todoId: todoEvent.todo.todoId,
                  content: todoEvent.todo.content,
                  status: todoEvent.todo.status,
                  order: todoEvent.todo.order,
                  eventTs: todoEvent.ts,
                },
              ]);
              appendTimeline(`todo.update: ${todoEvent.todo.status} #${todoEvent.todo.order} ${todoEvent.todo.content}`, todoEvent.ts);
              continue;
            }

            default:
              continue;
          }
        }
      }
    },
    [appendAssistantDelta, appendTimeline, upsertTodo],
  );

  const handleSend = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      if (submitting || runStatus === "running") {
        return;
      }

      const text = input.trim();
      if (!text) {
        return;
      }

      const userMessage = createMessage("user", text);
      const assistantMessage = createMessage("assistant", "");
      const historyMessages = [...messages, userMessage];
      const nextMessages = [...historyMessages, assistantMessage];

      assistantMessageIdRef.current = assistantMessage.id;
      activeRunIdRef.current = null;
      streamAbortRef.current?.abort();
      streamAbortRef.current = new AbortController();

      setMessages(nextMessages);
      setInput("");
      setSubmitting(true);
      setRunStatus("running");
      setRunDetail("");
      setErrorText("");
      setActiveRunId(null);
      setTodoItems([]);
      setTodoEvents([]);
      setPendingRequests([]);
      setTimeline([]);
      appendTimeline(`run.start (${provider})`);

      try {
        const response = await fetch(`${API_BASE}/runs/start`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify({
            provider,
            model,
            requireHumanLoop,
            messages: historyMessages
              .filter((item) => item.role === "user" || item.role === "assistant" || item.role === "system")
              .map((item) => ({
                role: item.role,
                content: item.content,
              })),
          }),
          signal: streamAbortRef.current.signal,
        });

        if (!response.ok) {
          const bodyText = await response.text();
          let failure = `启动失败(${response.status})`;
          if (bodyText) {
            try {
              const payload = JSON.parse(bodyText) as { error?: string; reason?: string };
              failure = payload.error ?? payload.reason ?? bodyText;
            } catch {
              failure = bodyText;
            }
          }
          throw new Error(failure);
        }

        await consumeSse(response);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          appendTimeline("stream.aborted");
          setRunStatus("canceled");
        } else {
          const message = error instanceof Error ? error.message : String(error);
          setErrorText(message);
          setRunDetail(message);
          setRunStatus("failed");
          appendTimeline(`run.error: ${message}`);
        }
      } finally {
        const runId = activeRunIdRef.current;
        if (runId) {
          void refreshRunPanels(runId);
        }
        assistantMessageIdRef.current = null;
        setSubmitting(false);
      }
    },
    [
      input,
      submitting,
      runStatus,
      createMessage,
      messages,
      appendTimeline,
      provider,
      model,
      requireHumanLoop,
      consumeSse,
      activeRunId,
      refreshRunPanels,
    ],
  );

  const handleStop = useCallback(async () => {
    if (!activeRunId || runStatus !== "running") {
      streamAbortRef.current?.abort();
      return;
    }

    try {
      await fetchJson(`/runs/${activeRunId}/stop`, {
        method: "POST",
      });
      setRunStatus("canceled");
      appendTimeline("run.stop requested");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorText(message);
      appendTimeline(`run.stop failed: ${message}`);
    } finally {
      streamAbortRef.current?.abort();
    }
  }, [activeRunId, runStatus, fetchJson, appendTimeline]);

  const handleReply = useCallback(
    async (request: HumanLoopRequest) => {
      const answer = (answerDrafts[request.questionId] ?? "").trim();
      if (!answer) {
        return;
      }

      setReplying((prev) => ({ ...prev, [request.questionId]: true }));
      setErrorText("");

      try {
        await fetchJson<{ ok: boolean; status?: string; duplicate?: boolean }>("/human-loop/reply", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            runId: request.runId,
            questionId: request.questionId,
            answer,
          }),
        });

        setAnswerDrafts((prev) => {
          const next = { ...prev };
          delete next[request.questionId];
          return next;
        });

        appendTimeline(`human-loop resolved: ${request.questionId}`);
        await refreshRunPanels(request.runId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setErrorText(message);
        appendTimeline(`human-loop reply failed: ${message}`);
      } finally {
        setReplying((prev) => ({ ...prev, [request.questionId]: false }));
      }
    },
    [answerDrafts, fetchJson, appendTimeline, refreshRunPanels],
  );

  const onInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="app-root">
      <header className="app-header">
        <div>
          <p className="eyebrow">Agent Workbench</p>
          <h1>ChatUI · Todo · Human Loop</h1>
        </div>
        <div className="run-chip" data-status={runStatus}>
          <span className="run-dot" />
          <span>{runStatus}</span>
        </div>
      </header>

      <section className="control-bar">
        <label>
          Provider
          <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderKind)} disabled={runStatus === "running"}>
            <option value="codex-cli">codex-cli</option>
            <option value="opencode">opencode</option>
            <option value="claude-code">claude-code</option>
          </select>
        </label>

        <label>
          Model
          <input value={model} onChange={(e) => setModel(e.target.value)} disabled={runStatus === "running"} placeholder="输入模型 ID" />
        </label>

        <label className="checkbox-row">
          <input type="checkbox" checked={requireHumanLoop} onChange={(e) => setRequireHumanLoop(e.target.checked)} disabled={runStatus === "running"} />
          <span>require human-loop</span>
        </label>
      </section>

      <main className="layout">
        <section className="chat-pane">
          <div className="messages" role="log" aria-live="polite">
            {messages.length === 0 ? (
              <div className="empty-state">
                <h2>输入你的任务指令</h2>
                <p>消息会通过 <code>POST /api/runs/start</code> 进入真实执行链路，右侧同步展示 Todo 与 Human-loop。</p>
              </div>
            ) : (
              messages.map((message) => (
                <article key={message.id} className={`bubble bubble-${message.role}`}>
                  <header>
                    <strong>{message.role}</strong>
                    <time>{formatTime(message.createdAt)}</time>
                  </header>
                  <pre>{message.content || (message.role === "assistant" && runStatus === "running" ? "..." : "")}</pre>
                </article>
              ))
            )}
          </div>

          <form className="composer" onSubmit={(e) => void handleSend(e)}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              rows={3}
              disabled={submitting}
            />
            <div className="composer-actions">
              <button type="submit" disabled={submitting || runStatus === "running" || !input.trim()}>
                发送
              </button>
              <button type="button" className="secondary" disabled={runStatus !== "running"} onClick={() => void handleStop()}>
                停止
              </button>
            </div>
          </form>

          {errorText ? <p className="error-text">{errorText}</p> : null}
        </section>

        <aside className="side-pane">
          <section className="panel">
            <h3>Run 状态</h3>
            <dl>
              <dt>runId</dt>
              <dd>{activeRunId ?? "-"}</dd>
              <dt>status</dt>
              <dd>{runStatus}</dd>
              <dt>detail</dt>
              <dd>{runDetail || "-"}</dd>
            </dl>
          </section>

          <section className="panel">
            <h3>Todo</h3>
            <div className="todo-grid">
              {(Object.keys(groupedTodos) as TodoStatus[]).map((status) => (
                <div key={status} className="todo-column">
                  <h4>
                    {status} <span>{groupedTodos[status].length}</span>
                  </h4>
                  {groupedTodos[status].length === 0 ? (
                    <p className="muted">空</p>
                  ) : (
                    groupedTodos[status].map((item) => (
                      <div key={`${item.runId}-${item.todoId}`} className="todo-card">
                        <div className="todo-order">#{item.order}</div>
                        <div className="todo-content">{item.content}</div>
                      </div>
                    ))
                  )}
                </div>
              ))}
            </div>
            <div className="todo-events">
              <h4>Todo Timeline</h4>
              {todoEvents.length === 0 ? (
                <p className="muted">暂无事件</p>
              ) : (
                <ul>
                  {todoEvents.slice(-20).map((event) => (
                    <li key={event.eventId}>
                      <time>{formatTime(event.eventTs)}</time>
                      <span>[{event.status}] #{event.order} {event.content}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="panel">
            <h3>Human-loop</h3>
            {pendingRequests.length === 0 ? (
              <p className="muted">当前无待回复问题</p>
            ) : (
              <div className="pending-list">
                {pendingRequests.map((request) => (
                  <article key={request.questionId} className="pending-card">
                    <header>
                      <strong>{request.questionId}</strong>
                      <time>{formatTime(request.requestedAt)}</time>
                    </header>
                    <p>{request.prompt}</p>
                    <textarea
                      placeholder="输入回复"
                      value={answerDrafts[request.questionId] ?? ""}
                      onChange={(e) =>
                        setAnswerDrafts((prev) => ({
                          ...prev,
                          [request.questionId]: e.target.value,
                        }))
                      }
                      rows={2}
                    />
                    <button
                      type="button"
                      disabled={replying[request.questionId] === true || !(answerDrafts[request.questionId] ?? "").trim()}
                      onClick={() => void handleReply(request)}
                    >
                      {replying[request.questionId] ? "提交中..." : "提交回复"}
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <h3>Run Timeline</h3>
            {timeline.length === 0 ? (
              <p className="muted">暂无事件</p>
            ) : (
              <ul className="timeline-list">
                {timeline.slice(-30).map((entry) => (
                  <li key={entry.id}>
                    <time>{formatTime(entry.ts)}</time>
                    <span>{entry.label}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </main>
    </div>
  );
}

function parseSseBuffer(raw: string): { events: ParsedSseEvent[]; rest: string } {
  const chunks = raw.replace(/\r\n/g, "\n").split("\n\n");
  const rest = chunks.pop() ?? "";
  const events: ParsedSseEvent[] = [];

  for (const chunk of chunks) {
    const block = chunk.trim();
    if (!block || block.startsWith(":")) {
      continue;
    }

    let eventName = "message";
    const dataLines: string[] = [];

    for (const line of block.split("\n")) {
      if (line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }

    const dataText = dataLines.join("\n");
    let data: unknown = dataText;

    if (dataText.length > 0) {
      try {
        data = JSON.parse(dataText);
      } catch {
        data = dataText;
      }
    }

    events.push({
      event: eventName,
      data,
    });
  }

  return {
    events,
    rest,
  };
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
