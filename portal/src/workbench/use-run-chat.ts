import { useChat } from "@ai-sdk/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createControlPlaneTransport,
  type ProviderKind,
  type RunStartConfig,
  type StreamLifecycleEvent,
  type RunStatusEvent,
  type RunWarningEvent,
  type TodoUpdateEvent,
} from "./transport";
import {
  type HistoryStatus,
  type HumanLoopRequest,
  type PortalUiMessage,
  type StreamConnection,
  type TodoEvent,
  type TodoItem,
  type TodoStatus,
  type TimelineEntry,
} from "./run-chat-types";
import {
  resolveResponseError,
  sortHistorySummaries,
  toHistoryMessages,
  toPortalMessages,
  type HistoryStoredMessage,
  type HistorySummary,
} from "./utils";

const POLL_MS = 3500;
const MAX_TIMELINE = 200;

type UiRunStatus =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "canceled";

interface ActiveStoreApp {
  readonly appId: string;
  readonly name: string;
  readonly runtimeDefaults: {
    readonly provider: ProviderKind;
    readonly model: string;
    readonly timeoutMs: number | null;
    readonly credentialEnvKeys: readonly string[];
  } | null;
}

export interface RunChatController {
  readonly input: string;
  readonly setInput: (value: string) => void;
  readonly messages: PortalUiMessage[];
  readonly runStatus: UiRunStatus;
  readonly runDetail: string;
  readonly activeRunId: string | null;
  readonly activeChatId: string | null;
  readonly chatHistory: HistorySummary[];
  readonly historyStatus: HistoryStatus;
  readonly historyError: string;
  readonly todoItems: TodoItem[];
  readonly groupedTodos: Record<TodoStatus, TodoItem[]>;
  readonly todoEvents: TodoEvent[];
  readonly pendingRequests: HumanLoopRequest[];
  readonly resolvedRequests: HumanLoopRequest[];
  readonly answerDrafts: Record<string, string>;
  readonly setAnswerDrafts: (
    updater: (prev: Record<string, string>) => Record<string, string>,
  ) => void;
  readonly replying: Record<string, boolean>;
  readonly replyFeedback: Record<string, string>;
  readonly timeline: TimelineEntry[];
  readonly errorText: string;
  readonly streamConnection: StreamConnection;
  readonly nowTick: number;
  readonly submitting: boolean;
  readonly appendTimeline: (label: string, ts?: string) => void;
  readonly fetchJson: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly handleCreateChat: () => Promise<void>;
  readonly handleSelectChat: (chatId: string) => Promise<void>;
  readonly handleSend: () => Promise<void>;
  readonly handleStop: () => Promise<void>;
  readonly handleReply: (request: HumanLoopRequest) => Promise<void>;
}

export function useRunChat(input: {
  readonly apiBase: string;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly requireHumanLoop: boolean;
  readonly activeStoreApp: ActiveStoreApp | null;
  readonly historyUserId: string;
}): RunChatController {
  const {
    apiBase,
    provider,
    model,
    requireHumanLoop,
    activeStoreApp,
    historyUserId,
  } = input;
  const scopedHistoryUserId = historyUserId.trim() || "u-anon";

  const [inputText, setInputText] = useState<string>("");
  const [runStatus, setRunStatus] = useState<UiRunStatus>("idle");
  const [runDetail, setRunDetail] = useState<string>("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<HistorySummary[]>([]);
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>("idle");
  const [historyError, setHistoryError] = useState<string>("");
  const [todoItems, setTodoItems] = useState<TodoItem[]>([]);
  const [todoEvents, setTodoEvents] = useState<TodoEvent[]>([]);
  const [pendingRequests, setPendingRequests] = useState<HumanLoopRequest[]>([]);
  const [resolvedRequests, setResolvedRequests] = useState<HumanLoopRequest[]>([]);
  const [answerDrafts, setAnswerDraftsRaw] = useState<Record<string, string>>({});
  const [replying, setReplying] = useState<Record<string, boolean>>({});
  const [replyFeedback, setReplyFeedback] = useState<Record<string, string>>({});
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [errorText, setErrorText] = useState<string>("");
  const [streamConnection, setStreamConnection] = useState<StreamConnection>({
    state: "idle",
    attempt: 0,
    cursor: 0,
    reason: "",
  });
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  const activeRunIdRef = useRef<string | null>(null);
  const activeChatIdRef = useRef<string | null>(null);
  const historyBootstrappedRef = useRef(false);
  const runConfigRef = useRef<RunStartConfig>({
    provider: "codex-app-server",
    model: "gpt-5.1-codex",
    requireHumanLoop: true,
  });

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

  useEffect(() => {
    activeRunIdRef.current = activeRunId;
  }, [activeRunId]);

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  useEffect(() => {
    const baseConfig: RunStartConfig = {
      provider,
      model,
      requireHumanLoop,
    };
    if (activeStoreApp) {
      const providerOptions: Record<string, unknown> = {
        storeAppId: activeStoreApp.appId,
      };
      if (
        activeStoreApp.runtimeDefaults &&
        typeof activeStoreApp.runtimeDefaults.timeoutMs === "number"
      ) {
        providerOptions.timeoutMs = activeStoreApp.runtimeDefaults.timeoutMs;
      }
      runConfigRef.current = {
        ...baseConfig,
        executionProfile: activeStoreApp.appId,
        providerOptions,
      };
      return;
    }
    runConfigRef.current = baseConfig;
  }, [activeStoreApp, model, provider, requireHumanLoop]);

  useEffect(() => {
    if (pendingRequests.length === 0) {
      return;
    }
    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 15_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [pendingRequests.length]);

  useEffect(() => {
    setReplyFeedback((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(([questionId]) =>
          pendingRequests.some((request) => request.questionId === questionId),
        ),
      ),
    );
  }, [pendingRequests]);

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

  const fetchJson = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const response = await fetch(`${apiBase}${path}`, init);
      if (!response.ok) {
        throw new Error(await resolveResponseError(response));
      }
      return (await response.json()) as T;
    },
    [apiBase],
  );

  const upsertHistorySummary = useCallback((chat: HistorySummary) => {
    setChatHistory((prev) => sortHistorySummaries([chat, ...prev]));
  }, []);

  const refreshRunPanels = useCallback(
    async (runId: string) => {
      const [todos, todoHistory, pending, resolved] = await Promise.all([
        fetchJson<{ items: TodoItem[] }>(
          `/runs/${encodeURIComponent(runId)}/todos?limit=500`,
        ),
        fetchJson<{ events: TodoEvent[] }>(
          `/runs/${encodeURIComponent(runId)}/todos/events?limit=500`,
        ),
        fetchJson<{ requests: HumanLoopRequest[] }>(
          `/human-loop/pending?runId=${encodeURIComponent(runId)}&limit=200`,
        ),
        fetchJson<{ requests: HumanLoopRequest[] }>(
          `/human-loop/requests?runId=${encodeURIComponent(runId)}&status=resolved&limit=200`,
        ),
      ]);

      setTodoItems(todos.items ?? []);
      setTodoEvents(todoHistory.events ?? []);
      setPendingRequests(pending.requests ?? []);
      setResolvedRequests(
        [...(resolved.requests ?? [])].sort((a, b) => {
          const aTs = new Date(a.resolvedAt ?? a.requestedAt).getTime();
          const bTs = new Date(b.resolvedAt ?? b.requestedAt).getTime();
          return bTs - aTs;
        }),
      );
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
        setStreamConnection({
          state: "connected",
          attempt: 0,
          cursor: 0,
          reason: "",
        });
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

      setTodoItems((prev) => {
        const idx = prev.findIndex(
          (value) => value.todoId === item.todoId && value.runId === item.runId,
        );
        if (idx === -1) {
          return [...prev, item];
        }
        const next = [...prev];
        next[idx] = item;
        return next;
      });
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
    [appendTimeline],
  );

  const handleRunWarningEvent = useCallback(
    (warningEvent: RunWarningEvent) => {
      appendTimeline(`warning: ${warningEvent.warning}`, warningEvent.ts);
    },
    [appendTimeline],
  );

  const handleStreamLifecycle = useCallback(
    (event: StreamLifecycleEvent) => {
      if (event.kind === "reconnecting") {
        setStreamConnection({
          state: "reconnecting",
          attempt: event.attempt,
          cursor: event.cursor,
          reason: event.reason ?? "",
        });
        setRunDetail(`流式连接中断，正在重连（第 ${event.attempt} 次）`);
        appendTimeline(
          `stream.reconnecting #${event.attempt} (cursor=${event.cursor})`,
        );
        return;
      }

      if (event.kind === "reconnected") {
        setStreamConnection({
          state: "connected",
          attempt: event.attempt,
          cursor: event.cursor,
          reason: "",
        });
        setRunDetail("");
        appendTimeline(`stream.reconnected #${event.attempt}`);
        return;
      }

      setStreamConnection({
        state: "recover_failed",
        attempt: event.attempt,
        cursor: event.cursor,
        reason: event.reason ?? "重连失败",
      });
      setRunDetail("流式连接中断且重连失败");
      appendTimeline(`stream.reconnect_failed: ${event.reason ?? "unknown"}`);
    },
    [appendTimeline],
  );

  const transport = useMemo(
    () =>
      createControlPlaneTransport({
        apiBase,
        getRunConfig: () => runConfigRef.current,
        onRunStatus: handleRunStatusEvent,
        onTodoUpdate: handleTodoUpdateEvent,
        onRunWarning: handleRunWarningEvent,
        onRunClosed: () => {
          appendTimeline("run.closed");
        },
        onStreamLifecycle: handleStreamLifecycle,
      }),
    [
      apiBase,
      appendTimeline,
      handleStreamLifecycle,
      handleRunStatusEvent,
      handleRunWarningEvent,
      handleTodoUpdateEvent,
    ],
  );

  const {
    messages,
    setMessages,
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
      setStreamConnection((prev) => ({
        ...prev,
        state: "recover_failed",
        reason: error.message,
      }));
      appendTimeline(`run.error: ${error.message}`);
    },
    onFinish: (event) => {
      const runId = activeRunIdRef.current;
      if (runId) {
        void refreshRunPanels(runId);
      }
      const chatId = activeChatIdRef.current;
      if (chatId) {
        void persistChatHistory(chatId, event.messages as PortalUiMessage[]);
      }
    },
  });

  const submitting = chatStatus === "submitted" || chatStatus === "streaming";

  const createHistorySession = useCallback(async () => {
    const title = activeStoreApp ? `[${activeStoreApp.name}] 新会话` : "新会话";
    const created = await fetchJson<{ chat: HistorySummary }>(
      `/chat-opencode-history?userId=${encodeURIComponent(scopedHistoryUserId)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userId: scopedHistoryUserId,
          provider,
          model,
          title,
        }),
      },
    );
    upsertHistorySummary(created.chat);
    return created.chat.chatId;
  }, [activeStoreApp, fetchJson, model, provider, upsertHistorySummary]);

  const persistChatHistory = useCallback(
    async (chatId: string, snapshot: readonly PortalUiMessage[]) => {
      const payloadMessages = toHistoryMessages(snapshot);
      const firstUser = payloadMessages.find((item) => item.role === "user");
      const title = firstUser
        ? firstUser.content.slice(0, 24).trim() || "新会话"
        : "新会话";

      const saved = await fetchJson<{ chat: HistorySummary }>(
        `/chat-opencode-history/${encodeURIComponent(chatId)}?userId=${encodeURIComponent(scopedHistoryUserId)}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            title,
            provider,
            model,
            messages: payloadMessages,
          }),
        },
      );

      upsertHistorySummary(saved.chat);
    },
    [fetchJson, model, provider, scopedHistoryUserId, upsertHistorySummary],
  );

  const resetRunView = useCallback(() => {
    activeRunIdRef.current = null;
    setActiveRunId(null);
    setRunStatus("idle");
    setRunDetail("");
    setErrorText("");
    setTodoItems([]);
    setTodoEvents([]);
    setPendingRequests([]);
    setResolvedRequests([]);
    setTimeline([]);
    setStreamConnection({
      state: "idle",
      attempt: 0,
      cursor: 0,
      reason: "",
    });
    clearError();
  }, [clearError]);

  const loadChatDetail = useCallback(
    async (chatId: string) => {
      setHistoryStatus("loading");
      setHistoryError("");
      try {
        const detail = await fetchJson<{
          chat: HistorySummary;
          messages: HistoryStoredMessage[];
        }>(
          `/chat-opencode-history/${encodeURIComponent(chatId)}?userId=${encodeURIComponent(scopedHistoryUserId)}`,
        );

        setMessages(
          toPortalMessages(detail.messages, (createdAt) => ({ createdAt })),
        );
        upsertHistorySummary(detail.chat);
        setActiveChatId(detail.chat.chatId);
        resetRunView();
        setHistoryStatus("idle");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setHistoryStatus("error");
        setHistoryError(message);
      }
    },
    [fetchJson, resetRunView, scopedHistoryUserId, setMessages, upsertHistorySummary],
  );

  const ensureActiveChat = useCallback(async () => {
    const current = activeChatIdRef.current;
    if (current) {
      return current;
    }

    const chatId = await createHistorySession();
    setActiveChatId(chatId);
    setMessages([]);
    return chatId;
  }, [createHistorySession, setMessages]);

  const handleCreateChat = useCallback(async () => {
    if (submitting || runStatus === "running") {
      return;
    }
    setHistoryError("");
    try {
      const chatId = await createHistorySession();
      setActiveChatId(chatId);
      setMessages([]);
      setInputText("");
      resetRunView();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHistoryError(message);
    }
  }, [createHistorySession, resetRunView, runStatus, setMessages, submitting]);

  const handleSelectChat = useCallback(
    async (chatId: string) => {
      if (submitting || runStatus === "running" || chatId === activeChatIdRef.current) {
        return;
      }
      setInputText("");
      await loadChatDetail(chatId);
    },
    [loadChatDetail, runStatus, submitting],
  );

  useEffect(() => {
    if (historyBootstrappedRef.current) {
      return;
    }
    historyBootstrappedRef.current = true;

    let cancelled = false;

    void (async () => {
      setHistoryStatus("loading");
      setHistoryError("");
      try {
        const list = await fetchJson<{ chats: HistorySummary[] }>(
          `/chat-opencode-history?limit=50&userId=${encodeURIComponent(scopedHistoryUserId)}`,
        );
        if (cancelled) {
          return;
        }

        const sorted = sortHistorySummaries(list.chats ?? []);
        setChatHistory(sorted);

        if (sorted.length === 0) {
          const chatId = await createHistorySession();
          if (cancelled) {
            return;
          }
          setActiveChatId(chatId);
          setMessages([]);
          setHistoryStatus("idle");
          return;
        }

        const firstChat = sorted[0];
        if (!firstChat) {
          setHistoryStatus("idle");
          return;
        }
        await loadChatDetail(firstChat.chatId);
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setHistoryStatus("error");
        setHistoryError(message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [createHistorySession, fetchJson, loadChatDetail, scopedHistoryUserId, setMessages]);

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
  }, [activeRunId, refreshRunPanels, runStatus]);

  const handleSend = useCallback(async () => {
    if (submitting || runStatus === "running") {
      return;
    }

    const text = inputText.trim();
    if (!text) {
      return;
    }

    activeRunIdRef.current = null;
    setInputText("");
    setRunStatus("running");
    setRunDetail("");
    setErrorText("");
    setActiveRunId(null);
    setTodoItems([]);
    setTodoEvents([]);
    setPendingRequests([]);
    setResolvedRequests([]);
    setTimeline([]);
    setStreamConnection({
      state: "connected",
      attempt: 0,
      cursor: 0,
      reason: "",
    });
    clearError();
    appendTimeline(
      `run.start (${provider}${activeStoreApp ? ` / app:${activeStoreApp.appId}` : ""})`,
    );

    try {
      const chatId = await ensureActiveChat();
      setActiveChatId(chatId);
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
  }, [
    activeStoreApp,
    appendTimeline,
    clearError,
    ensureActiveChat,
    inputText,
    provider,
    refreshRunPanels,
    runStatus,
    sendMessage,
    submitting,
  ]);

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
      setStreamConnection({
        state: "idle",
        attempt: 0,
        cursor: 0,
        reason: "",
      });
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
      setReplyFeedback((prev) => {
        const next = { ...prev };
        delete next[request.questionId];
        return next;
      });

      try {
        const replyResult = await fetchJson<{
          ok: boolean;
          status?: string;
          duplicate?: boolean;
        }>(
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

        if (replyResult.duplicate) {
          setReplyFeedback((prev) => ({
            ...prev,
            [request.questionId]: "该问题已处理（幂等返回），无需重复提交。",
          }));
          appendTimeline(`human-loop duplicate: ${request.questionId}`);
          await refreshRunPanels(request.runId);
          return;
        }

        setAnswerDraftsRaw((prev) => {
          const next = { ...prev };
          delete next[request.questionId];
          return next;
        });

        setReplyFeedback((prev) => ({
          ...prev,
          [request.questionId]: "回复已提交，等待 run 继续。",
        }));
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

  const setAnswerDrafts = useCallback(
    (updater: (prev: Record<string, string>) => Record<string, string>) => {
      setAnswerDraftsRaw(updater);
    },
    [],
  );

  return {
    input: inputText,
    setInput: setInputText,
    messages,
    runStatus, runDetail, activeRunId, activeChatId,
    chatHistory, historyStatus, historyError,
    todoItems, groupedTodos, todoEvents,
    pendingRequests, resolvedRequests, answerDrafts, setAnswerDrafts,
    replying, replyFeedback, timeline, errorText,
    streamConnection, nowTick, submitting, appendTimeline, fetchJson,
    handleCreateChat, handleSelectChat, handleSend, handleStop, handleReply,
  };
}
