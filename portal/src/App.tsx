import { useChat } from "@ai-sdk/react";
import type {
  ChatTransport,
  FinishReason,
  UIMessage,
  UIMessageChunk,
} from "ai";
import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type ProviderKind = "claude-code" | "opencode" | "codex-cli";
type TodoStatus = "todo" | "doing" | "done" | "canceled";
type UiRunStatus =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "canceled";

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

type PortalMessageMetadata = {
  createdAt?: string;
  runId?: string;
};

type PortalUiMessage = UIMessage<PortalMessageMetadata>;

type RunStartMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type RunStartConfig = {
  provider: ProviderKind;
  model: string;
  requireHumanLoop: boolean;
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(
  /\/$/,
  "",
);
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

  const [input, setInput] = useState<string>("");
  const [runStatus, setRunStatus] = useState<UiRunStatus>("idle");
  const [runDetail, setRunDetail] = useState<string>("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const [todoItems, setTodoItems] = useState<TodoItem[]>([]);
  const [todoEvents, setTodoEvents] = useState<TodoEvent[]>([]);
  const [pendingRequests, setPendingRequests] = useState<HumanLoopRequest[]>([]);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [replying, setReplying] = useState<Record<string, boolean>>({});

  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [errorText, setErrorText] = useState<string>("");

  const activeRunIdRef = useRef<string | null>(null);
  const runConfigRef = useRef<RunStartConfig>({
    provider: "codex-cli",
    model: DEFAULT_MODEL["codex-cli"],
    requireHumanLoop: true,
  });

  useEffect(() => {
    setModel(DEFAULT_MODEL[provider]);
  }, [provider]);

  useEffect(() => {
    activeRunIdRef.current = activeRunId;
  }, [activeRunId]);

  useEffect(() => {
    runConfigRef.current = {
      provider,
      model,
      requireHumanLoop,
    };
  }, [provider, model, requireHumanLoop]);

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
      const idx = prev.findIndex(
        (item) => item.todoId === todo.todoId && item.runId === todo.runId,
      );
      if (idx === -1) {
        return [...prev, todo];
      }
      const next = [...prev];
      next[idx] = todo;
      return next;
    });
  }, []);

  const fetchJson = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const response = await fetch(`${API_BASE}${path}`, init);
      if (!response.ok) {
        throw new Error(await resolveResponseError(response));
      }
      return (await response.json()) as T;
    },
    [],
  );

  const refreshRunPanels = useCallback(
    async (runId: string) => {
      const [todos, todoHistory, pending] = await Promise.all([
        fetchJson<{ items: TodoItem[] }>(
          `/runs/${encodeURIComponent(runId)}/todos?limit=500`,
        ),
        fetchJson<{ events: TodoEvent[] }>(
          `/runs/${encodeURIComponent(runId)}/todos/events?limit=500`,
        ),
        fetchJson<{ requests: HumanLoopRequest[] }>(
          `/human-loop/pending?runId=${encodeURIComponent(runId)}&limit=200`,
        ),
      ]);

      setTodoItems(todos.items ?? []);
      setTodoEvents(todoHistory.events ?? []);
      setPendingRequests(pending.requests ?? []);
    },
    [fetchJson],
  );

  const handleRunStatusEvent = useCallback(
    (statusEvent: RunStatusEvent) => {
      activeRunIdRef.current = statusEvent.runId;
      setActiveRunId((prev) => prev ?? statusEvent.runId);
      appendTimeline(
        `run.status: ${statusEvent.status}${statusEvent.detail ? ` (${statusEvent.detail})` : ""}`,
        statusEvent.ts,
      );

      if (statusEvent.status === "started") {
        setRunStatus("running");
        return;
      }

      if (statusEvent.status === "blocked") {
        setRunStatus("blocked");
        setRunDetail(statusEvent.detail ?? "provider 不支持 human-loop");
        setErrorText(statusEvent.detail ?? "运行被阻塞");
        return;
      }

      if (statusEvent.status === "failed") {
        setRunStatus("failed");
        setRunDetail(statusEvent.detail ?? "运行失败");
        setErrorText(statusEvent.detail ?? "运行失败");
        return;
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
    },
    [appendTimeline],
  );

  const handleTodoUpdateEvent = useCallback(
    (todoEvent: TodoUpdateEvent) => {
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
      appendTimeline(
        `todo.update: ${todoEvent.todo.status} #${todoEvent.todo.order} ${todoEvent.todo.content}`,
        todoEvent.ts,
      );
    },
    [appendTimeline, upsertTodo],
  );

  const handleRunWarningEvent = useCallback(
    (warningEvent: RunWarningEvent) => {
      appendTimeline(`warning: ${warningEvent.warning}`, warningEvent.ts);
    },
    [appendTimeline],
  );

  const transport = useMemo<ChatTransport<PortalUiMessage>>(
    () =>
      createControlPlaneTransport({
        apiBase: API_BASE,
        getRunConfig: () => runConfigRef.current,
        onRunStatus: handleRunStatusEvent,
        onTodoUpdate: handleTodoUpdateEvent,
        onRunWarning: handleRunWarningEvent,
        onRunClosed: () => {
          appendTimeline("run.closed");
        },
      }),
    [
      appendTimeline,
      handleRunStatusEvent,
      handleRunWarningEvent,
      handleTodoUpdateEvent,
    ],
  );

  const {
    messages,
    sendMessage,
    stop,
    status: chatStatus,
    clearError,
  } = useChat<PortalUiMessage>({
    transport,
    onError: (error) => {
      setErrorText(error.message);
      setRunDetail(error.message);
      setRunStatus("failed");
      appendTimeline(`run.error: ${error.message}`);
    },
    onFinish: () => {
      const runId = activeRunIdRef.current;
      if (runId) {
        void refreshRunPanels(runId);
      }
    },
  });

  const submitting = chatStatus === "submitted" || chatStatus === "streaming";

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

      activeRunIdRef.current = null;
      setInput("");
      setRunStatus("running");
      setRunDetail("");
      setErrorText("");
      setActiveRunId(null);
      setTodoItems([]);
      setTodoEvents([]);
      setPendingRequests([]);
      setTimeline([]);
      clearError();
      appendTimeline(`run.start (${provider})`);

      try {
        await sendMessage({
          text,
          metadata: {
            createdAt: new Date().toISOString(),
          },
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          appendTimeline("stream.aborted");
          setRunStatus("canceled");
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setErrorText(message);
        setRunDetail(message);
        setRunStatus("failed");
        appendTimeline(`run.error: ${message}`);
      } finally {
        const runId = activeRunIdRef.current;
        if (runId) {
          void refreshRunPanels(runId);
        }
      }
    },
    [
      appendTimeline,
      clearError,
      input,
      provider,
      refreshRunPanels,
      runStatus,
      sendMessage,
      submitting,
    ],
  );

  const handleStop = useCallback(async () => {
    try {
      if (activeRunId && runStatus === "running") {
        await fetchJson(`/runs/${activeRunId}/stop`, {
          method: "POST",
        });
        setRunStatus("canceled");
        appendTimeline("run.stop requested");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorText(message);
      appendTimeline(`run.stop failed: ${message}`);
    } finally {
      await stop();
    }
  }, [activeRunId, appendTimeline, fetchJson, runStatus, stop]);

  const handleReply = useCallback(
    async (request: HumanLoopRequest) => {
      const answer = (answerDrafts[request.questionId] ?? "").trim();
      if (!answer) {
        return;
      }

      setReplying((prev) => ({ ...prev, [request.questionId]: true }));
      setErrorText("");

      try {
        await fetchJson<{ ok: boolean; status?: string; duplicate?: boolean }>(
          "/human-loop/reply",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              runId: request.runId,
              questionId: request.questionId,
              answer,
            }),
          },
        );

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
    [answerDrafts, appendTimeline, fetchJson, refreshRunPanels],
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
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderKind)}
            disabled={runStatus === "running"}
          >
            <option value="codex-cli">codex-cli</option>
            <option value="opencode">opencode</option>
            <option value="claude-code">claude-code</option>
          </select>
        </label>

        <label>
          Model
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={runStatus === "running"}
            placeholder="输入模型 ID"
          />
        </label>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={requireHumanLoop}
            onChange={(e) => setRequireHumanLoop(e.target.checked)}
            disabled={runStatus === "running"}
          />
          <span>require human-loop</span>
        </label>
      </section>

      <main className="layout">
        <section className="chat-pane">
          <div className="messages" role="log" aria-live="polite">
            {messages.length === 0 ? (
              <div className="empty-state">
                <h2>输入你的任务指令</h2>
                <p>
                  消息会通过 <code>POST /api/runs/start</code> 进入真实执行链路，右侧同步展示
                  Todo 与 Human-loop。
                </p>
              </div>
            ) : (
              messages.map((message) => (
                <article key={message.id} className={`bubble bubble-${message.role}`}>
                  <header>
                    <strong>{message.role}</strong>
                    <time>
                      {message.metadata?.createdAt
                        ? formatTime(message.metadata.createdAt)
                        : "-"}
                    </time>
                  </header>
                  <pre>
                    {extractMessageText(message) ||
                      (message.role === "assistant" && runStatus === "running"
                        ? "..."
                        : "")}
                  </pre>
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
              <button
                type="submit"
                disabled={submitting || runStatus === "running" || !input.trim()}
              >
                发送
              </button>
              <button
                type="button"
                className="secondary"
                disabled={runStatus !== "running"}
                onClick={() => void handleStop()}
              >
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
                      <span>
                        [{event.status}] #{event.order} {event.content}
                      </span>
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
                      disabled={
                        replying[request.questionId] === true ||
                        !(answerDrafts[request.questionId] ?? "").trim()
                      }
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

function createControlPlaneTransport(input: {
  apiBase: string;
  getRunConfig: () => RunStartConfig;
  onRunStatus: (event: RunStatusEvent) => void;
  onTodoUpdate: (event: TodoUpdateEvent) => void;
  onRunWarning: (event: RunWarningEvent) => void;
  onRunClosed: () => void;
}): ChatTransport<PortalUiMessage> {
  return {
    sendMessages: async ({ messages, abortSignal }) => {
      const runConfig = input.getRunConfig();
      const runMessages = toRunMessages(messages);
      if (runMessages.length === 0) {
        throw new Error("消息不能为空");
      }

      const response = await fetch(`${input.apiBase}/runs/start`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          provider: runConfig.provider,
          model: runConfig.model,
          requireHumanLoop: runConfig.requireHumanLoop,
          messages: runMessages,
        }),
        signal: abortSignal ?? null,
      });

      if (!response.ok) {
        throw new Error(await resolveResponseError(response));
      }

      if (!response.body) {
        throw new Error("SSE 响应体为空");
      }

      return sseToUiMessageChunkStream({
        stream: response.body,
        abortSignal,
        onRunStatus: input.onRunStatus,
        onTodoUpdate: input.onTodoUpdate,
        onRunWarning: input.onRunWarning,
        onRunClosed: input.onRunClosed,
      });
    },
    reconnectToStream: async () => null,
  };
}

function sseToUiMessageChunkStream(input: {
  stream: ReadableStream<Uint8Array>;
  abortSignal: AbortSignal | undefined;
  onRunStatus: (event: RunStatusEvent) => void;
  onTodoUpdate: (event: TodoUpdateEvent) => void;
  onRunWarning: (event: RunWarningEvent) => void;
  onRunClosed: () => void;
}): ReadableStream<UIMessageChunk<PortalMessageMetadata>> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  return new ReadableStream<UIMessageChunk<PortalMessageMetadata>>({
    start(controller) {
      reader = input.stream.getReader();
      const decoder = new TextDecoder();
      const textPartId = `text-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const createdAt = new Date().toISOString();

      let buffer = "";
      let textStarted = false;
      let finished = false;
      let runId: string | undefined;
      const buildMetadata = (): PortalMessageMetadata =>
        runId ? { createdAt, runId } : { createdAt };

      const pushFinish = (finishReason: FinishReason = "stop") => {
        if (finished) {
          return;
        }
        if (textStarted) {
          controller.enqueue({
            type: "text-end",
            id: textPartId,
          });
        }
        controller.enqueue({
          type: "finish",
          finishReason,
          messageMetadata: buildMetadata(),
        });
        controller.close();
        finished = true;
      };

      const pushErrorAndFinish = (message: string) => {
        if (finished) {
          return;
        }
        controller.enqueue({
          type: "error",
          errorText: message,
        });
        pushFinish("error");
      };

      const ensureTextStarted = () => {
        if (textStarted) {
          return;
        }
        controller.enqueue({
          type: "text-start",
          id: textPartId,
        });
        textStarted = true;
      };

      const abortHandler = () => {
        void reader?.cancel();
      };

      input.abortSignal?.addEventListener("abort", abortHandler);

      controller.enqueue({
        type: "start",
        messageMetadata: {
          createdAt,
        },
      });

      void (async () => {
        try {
          while (true) {
            const result = await reader?.read();
            if (!result) {
              break;
            }
            const { value, done } = result;
            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const parsed = parseSseBuffer(buffer);
            buffer = parsed.rest;

            for (const event of parsed.events) {
              if (event.event === "run.closed") {
                input.onRunClosed();
                pushFinish("stop");
                return;
              }

              if (!event.data || typeof event.data !== "object") {
                continue;
              }

              const payload = event.data as { type?: string };

              if (payload.type === "run.status") {
                const statusEvent = payload as RunStatusEvent;
                runId = statusEvent.runId;
                input.onRunStatus(statusEvent);

                controller.enqueue({
                  type: "message-metadata",
                  messageMetadata: buildMetadata(),
                });

                if (statusEvent.status === "failed") {
                  pushErrorAndFinish(statusEvent.detail ?? "运行失败");
                  return;
                }

                if (statusEvent.status === "blocked") {
                  pushErrorAndFinish(statusEvent.detail ?? "运行被阻塞");
                  return;
                }

                if (statusEvent.status === "finished") {
                  const detail = (statusEvent.detail ?? "").toLowerCase();
                  if (detail === "canceled") {
                    controller.enqueue({
                      type: "abort",
                      reason: "canceled",
                    });
                  }
                  pushFinish("stop");
                  return;
                }

                continue;
              }

              if (payload.type === "message.delta") {
                const deltaEvent = payload as MessageDeltaEvent;
                ensureTextStarted();
                controller.enqueue({
                  type: "text-delta",
                  id: textPartId,
                  delta: deltaEvent.text,
                });
                continue;
              }

              if (payload.type === "todo.update") {
                input.onTodoUpdate(payload as TodoUpdateEvent);
                continue;
              }

              if (payload.type === "run.warning") {
                input.onRunWarning(payload as RunWarningEvent);
              }
            }
          }

          pushFinish("stop");
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            controller.enqueue({
              type: "abort",
              reason: "aborted",
            });
            pushFinish("other");
            return;
          }

          pushErrorAndFinish(error instanceof Error ? error.message : String(error));
        } finally {
          input.abortSignal?.removeEventListener("abort", abortHandler);
        }
      })();
    },
    cancel() {
      void reader?.cancel();
    },
  });
}

function toRunMessages(messages: PortalUiMessage[]): RunStartMessage[] {
  return messages
    .map((message) => ({
      role: message.role,
      content: extractMessageText(message).trim(),
    }))
    .filter((message) => message.content.length > 0);
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

function extractMessageText(message: PortalUiMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

async function resolveResponseError(response: Response): Promise<string> {
  const text = await response.text();
  let message = `请求失败(${response.status})`;
  if (!text) {
    return message;
  }

  try {
    const parsed = JSON.parse(text) as { error?: string; reason?: string };
    return parsed.error ?? parsed.reason ?? text;
  } catch {
    message = text;
  }

  return message;
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
