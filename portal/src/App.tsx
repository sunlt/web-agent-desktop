import { useChat } from "@ai-sdk/react";
import type {
  ChatTransport,
  FinishReason,
  UIMessage,
  UIMessageChunk,
} from "ai";
import {
  ChangeEvent,
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
  executionProfile?: string;
  providerOptions?: Record<string, unknown>;
};

type HistoryStatus = "idle" | "loading" | "error";

type ChatHistorySummary = {
  chatId: string;
  sessionId: string;
  title: string;
  provider: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
};

type ChatHistoryMessage = {
  id: string;
  chatId: string;
  role: "system" | "user" | "assistant";
  content: string;
  createdAt: string;
};

type FileTreeEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
};

type FileTreeResult = {
  path: string;
  entries: FileTreeEntry[];
};

type FileReadResult = {
  path: string;
  fileName: string;
  contentType: string;
  size: number;
  offset: number;
  limit: number;
  readBytes: number;
  nextOffset: number | null;
  truncated: boolean;
  encoding: "utf8" | "base64";
  content: string;
};

type FileListStatus = "idle" | "loading" | "error";
type FilePreviewMode = "none" | "text" | "image" | "pdf" | "binary";

type StoreAppItem = {
  appId: string;
  name: string;
  enabled: boolean;
  canView: boolean;
  canUse: boolean;
};

type StoreStatus = "idle" | "loading" | "error";

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(
  /\/$/,
  "",
);
const POLL_MS = 3500;
const MAX_TIMELINE = 200;
const FILE_READ_LIMIT = 256 * 1024;
const HUMAN_LOOP_TIMEOUT_MS = 5 * 60 * 1000;

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
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatHistorySummary[]>([]);
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>("idle");
  const [historyError, setHistoryError] = useState<string>("");

  const [todoItems, setTodoItems] = useState<TodoItem[]>([]);
  const [todoEvents, setTodoEvents] = useState<TodoEvent[]>([]);
  const [pendingRequests, setPendingRequests] = useState<HumanLoopRequest[]>([]);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [replying, setReplying] = useState<Record<string, boolean>>({});
  const [replyFeedback, setReplyFeedback] = useState<Record<string, string>>({});

  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [errorText, setErrorText] = useState<string>("");
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const [fileUserId, setFileUserId] = useState<string>("u-alice");
  const [storeApps, setStoreApps] = useState<StoreAppItem[]>([]);
  const [storeStatus, setStoreStatus] = useState<StoreStatus>("idle");
  const [storeError, setStoreError] = useState<string>("");
  const [activeAppId, setActiveAppId] = useState<string>("");
  const [fileTreePath, setFileTreePath] = useState<string>("/workspace/public");
  const [fileEntries, setFileEntries] = useState<FileTreeEntry[]>([]);
  const [fileListStatus, setFileListStatus] = useState<FileListStatus>("idle");
  const [fileError, setFileError] = useState<string>("");
  const [fileBusy, setFileBusy] = useState<boolean>(false);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [activeFilePreview, setActiveFilePreview] = useState<FileReadResult | null>(null);
  const [filePreviewMode, setFilePreviewMode] = useState<FilePreviewMode>("none");
  const [fileDraft, setFileDraft] = useState<string>("");

  const activeRunIdRef = useRef<string | null>(null);
  const activeChatIdRef = useRef<string | null>(null);
  const historyBootstrappedRef = useRef(false);
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
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  useEffect(() => {
    const baseConfig: RunStartConfig = {
      provider,
      model,
      requireHumanLoop,
    };
    if (activeAppId) {
      runConfigRef.current = {
        ...baseConfig,
        executionProfile: activeAppId,
        providerOptions: { storeAppId: activeAppId },
      };
      return;
    }
    runConfigRef.current = baseConfig;
  }, [provider, model, requireHumanLoop, activeAppId]);

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

  const activeStoreApp = useMemo(
    () => storeApps.find((item) => item.appId === activeAppId) ?? null,
    [activeAppId, storeApps],
  );

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

  const refreshStoreApps = useCallback(async () => {
    const userId = fileUserId.trim();
    if (!userId) {
      setStoreApps([]);
      setStoreStatus("idle");
      setStoreError("");
      setActiveAppId("");
      return;
    }

    setStoreStatus("loading");
    setStoreError("");

    try {
      const result = await fetchJson<{ apps: StoreAppItem[] }>(
        `/apps/store?userId=${encodeURIComponent(userId)}`,
      );
      const apps = result.apps ?? [];
      setStoreApps(apps);
      setStoreStatus("idle");
      setActiveAppId((prev) => {
        if (prev && apps.some((item) => item.appId === prev)) {
          return prev;
        }
        const preferred =
          apps.find((item) => item.canUse) ?? apps.find((item) => item.canView);
        return preferred?.appId ?? "";
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStoreStatus("error");
      setStoreError(message);
    }
  }, [fetchJson, fileUserId]);

  const activeFileDownloadUrl = useMemo(() => {
    if (!activeFilePath) {
      return null;
    }
    return `${API_BASE}/files/download?userId=${encodeURIComponent(fileUserId)}&path=${encodeURIComponent(activeFilePath)}`;
  }, [activeFilePath, fileUserId]);

  const activeFileInlineUrl = useMemo(() => {
    if (!activeFilePath) {
      return null;
    }
    return `${API_BASE}/files/download?userId=${encodeURIComponent(fileUserId)}&path=${encodeURIComponent(activeFilePath)}&inline=1`;
  }, [activeFilePath, fileUserId]);

  const loadFileTree = useCallback(
    async (path?: string) => {
      const targetPath = normalizeUiPath(path ?? fileTreePath);
      setFileListStatus("loading");
      setFileError("");
      try {
        const tree = await fetchJson<FileTreeResult>(
          `/files/tree?userId=${encodeURIComponent(fileUserId)}&path=${encodeURIComponent(targetPath)}`,
        );
        setFileTreePath(tree.path);
        setFileEntries(tree.entries ?? []);
        setFileListStatus("idle");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFileListStatus("error");
        setFileError(message);
      }
    },
    [fetchJson, fileTreePath, fileUserId],
  );

  const openFile = useCallback(
    async (path: string, offset?: number) => {
      const normalizedPath = normalizeUiPath(path);
      setFileBusy(true);
      setFileError("");
      try {
        const read = await fetchJson<FileReadResult>(
          `/files/file?userId=${encodeURIComponent(fileUserId)}&path=${encodeURIComponent(normalizedPath)}&limit=${FILE_READ_LIMIT}${offset ? `&offset=${offset}` : ""}`,
        );
        const mode = resolveFilePreviewMode(read.path, read.contentType, read.encoding);

        setActiveFilePath(read.path);
        setFilePreviewMode(mode);

        if (offset && activeFilePreview) {
          const mergedContent = `${activeFilePreview.content}${read.content}`;
          const merged: FileReadResult = {
            ...read,
            offset: 0,
            readBytes: activeFilePreview.readBytes + read.readBytes,
            content: mergedContent,
          };
          setActiveFilePreview(merged);
          if (mode === "text") {
            setFileDraft(mergedContent);
          }
        } else {
          setActiveFilePreview(read);
          if (mode === "text") {
            setFileDraft(read.content);
          } else {
            setFileDraft("");
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFileError(message);
      } finally {
        setFileBusy(false);
      }
    },
    [activeFilePreview, fetchJson, fileUserId],
  );

  const handleLoadMoreFile = useCallback(async () => {
    if (
      !activeFilePreview ||
      activeFilePreview.encoding !== "utf8" ||
      activeFilePreview.nextOffset === null
    ) {
      return;
    }
    await openFile(activeFilePreview.path, activeFilePreview.nextOffset);
  }, [activeFilePreview, openFile]);

  const saveActiveFile = useCallback(async () => {
    if (!activeFilePath || filePreviewMode !== "text") {
      return;
    }
    setFileBusy(true);
    setFileError("");
    try {
      await fetchJson<{ ok: boolean }>(`/files/file`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userId: fileUserId,
          path: activeFilePath,
          content: fileDraft,
          encoding: "utf8",
        }),
      });
      appendTimeline(`file.write: ${activeFilePath}`);
      await Promise.all([openFile(activeFilePath), loadFileTree(fileTreePath)]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFileError(message);
    } finally {
      setFileBusy(false);
    }
  }, [
    activeFilePath,
    appendTimeline,
    fetchJson,
    fileDraft,
    filePreviewMode,
    fileTreePath,
    fileUserId,
    loadFileTree,
    openFile,
  ]);

  const createDirectory = useCallback(async () => {
    const nextPath = window.prompt("新目录路径", joinUiPath(fileTreePath, "new-folder"));
    if (!nextPath) {
      return;
    }
    setFileBusy(true);
    setFileError("");
    try {
      await fetchJson<{ ok: boolean; path: string }>(`/files/mkdir`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userId: fileUserId,
          path: nextPath,
        }),
      });
      appendTimeline(`file.mkdir: ${nextPath}`);
      await loadFileTree(fileTreePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFileError(message);
    } finally {
      setFileBusy(false);
    }
  }, [appendTimeline, fetchJson, fileTreePath, fileUserId, loadFileTree]);

  const createTextFile = useCallback(async () => {
    const nextPath = window.prompt("新文件路径", joinUiPath(fileTreePath, "untitled.txt"));
    if (!nextPath) {
      return;
    }
    setFileBusy(true);
    setFileError("");
    try {
      await fetchJson<{ ok: boolean; path: string }>(`/files/file`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userId: fileUserId,
          path: nextPath,
          content: "",
          encoding: "utf8",
        }),
      });
      appendTimeline(`file.create: ${nextPath}`);
      await loadFileTree(fileTreePath);
      await openFile(nextPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFileError(message);
    } finally {
      setFileBusy(false);
    }
  }, [appendTimeline, fetchJson, fileTreePath, fileUserId, loadFileTree, openFile]);

  const renamePath = useCallback(
    async (path: string) => {
      const nextPath = window.prompt("重命名为", path);
      if (!nextPath || nextPath === path) {
        return;
      }
      setFileBusy(true);
      setFileError("");
      try {
        await fetchJson<{ ok: boolean; path: string; newPath: string }>(
          `/files/rename`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              userId: fileUserId,
              path,
              newPath: nextPath,
            }),
          },
        );
        appendTimeline(`file.rename: ${path} -> ${nextPath}`);
        if (activeFilePath === path) {
          await openFile(nextPath);
        }
        await loadFileTree(fileTreePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFileError(message);
      } finally {
        setFileBusy(false);
      }
    },
    [activeFilePath, appendTimeline, fetchJson, fileTreePath, fileUserId, loadFileTree, openFile],
  );

  const deletePath = useCallback(
    async (path: string) => {
      if (!window.confirm(`确认删除 ${path} 吗？`)) {
        return;
      }
      setFileBusy(true);
      setFileError("");
      try {
        await fetchJson<{ ok: boolean; path: string }>(
          `/files/file?userId=${encodeURIComponent(fileUserId)}&path=${encodeURIComponent(path)}`,
          {
            method: "DELETE",
          },
        );
        appendTimeline(`file.delete: ${path}`);
        if (activeFilePath === path) {
          setActiveFilePath(null);
          setActiveFilePreview(null);
          setFilePreviewMode("none");
          setFileDraft("");
        }
        await loadFileTree(fileTreePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFileError(message);
      } finally {
        setFileBusy(false);
      }
    },
    [activeFilePath, appendTimeline, fetchJson, fileTreePath, fileUserId, loadFileTree],
  );

  const uploadFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) {
        return;
      }

      const targetPath = window.prompt("上传目标路径", joinUiPath(fileTreePath, file.name));
      if (!targetPath) {
        return;
      }

      setFileBusy(true);
      setFileError("");
      try {
        const fileBuffer = new Uint8Array(await file.arrayBuffer());
        await fetchJson<{ ok: boolean; path: string }>(`/files/upload`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            userId: fileUserId,
            path: targetPath,
            contentBase64: uint8ArrayToBase64(fileBuffer),
          }),
        });
        appendTimeline(`file.upload: ${targetPath}`);
        await loadFileTree(fileTreePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFileError(message);
      } finally {
        setFileBusy(false);
      }
    },
    [appendTimeline, fetchJson, fileTreePath, fileUserId, loadFileTree],
  );

  const downloadPath = useCallback(
    (path: string) => {
      const url = `${API_BASE}/files/download?userId=${encodeURIComponent(fileUserId)}&path=${encodeURIComponent(path)}`;
      const popup = window.open(url, "_blank", "noopener");
      if (!popup) {
        window.location.href = url;
      }
    },
    [fileUserId],
  );

  const upsertHistorySummary = useCallback((chat: ChatHistorySummary) => {
    setChatHistory((prev) => sortHistorySummaries([chat, ...prev]));
  }, []);

  const persistChatHistory = useCallback(
    async (chatId: string, snapshot: readonly PortalUiMessage[]) => {
      const payloadMessages = toHistoryMessages(snapshot);
      const firstUser = payloadMessages.find((item) => item.role === "user");
      const title = firstUser
        ? firstUser.content.slice(0, 24).trim() || "新会话"
        : "新会话";

      const saved = await fetchJson<{ chat: ChatHistorySummary }>(
        `/chat-opencode-history/${encodeURIComponent(chatId)}`,
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
    [fetchJson, model, provider, upsertHistorySummary],
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
    const defaultTitle = activeStoreApp ? `[${activeStoreApp.name}] 新会话` : "新会话";
    const created = await fetchJson<{ chat: ChatHistorySummary }>(
      "/chat-opencode-history",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider,
          model,
          title: defaultTitle,
        }),
      },
    );
    upsertHistorySummary(created.chat);
    return created.chat.chatId;
  }, [activeStoreApp, fetchJson, model, provider, upsertHistorySummary]);

  const resetRunView = useCallback(() => {
    activeRunIdRef.current = null;
    setActiveRunId(null);
    setRunStatus("idle");
    setRunDetail("");
    setErrorText("");
    setTodoItems([]);
    setTodoEvents([]);
    setPendingRequests([]);
    setTimeline([]);
    clearError();
  }, [clearError]);

  const loadChatDetail = useCallback(
    async (chatId: string) => {
      setHistoryStatus("loading");
      setHistoryError("");
      try {
        const detail = await fetchJson<{
          chat: ChatHistorySummary;
          messages: ChatHistoryMessage[];
        }>(`/chat-opencode-history/${encodeURIComponent(chatId)}`);

        setMessages(toPortalMessages(detail.messages));
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
    [fetchJson, resetRunView, setMessages, upsertHistorySummary],
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
      setInput("");
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
      setInput("");
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
        const list = await fetchJson<{ chats: ChatHistorySummary[] }>(
          "/chat-opencode-history?limit=50",
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
  }, [createHistorySession, fetchJson, loadChatDetail, setMessages]);

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

  useEffect(() => {
    void refreshStoreApps();
  }, [refreshStoreApps]);

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
    },
    [
      appendTimeline,
      activeStoreApp,
      clearError,
      ensureActiveChat,
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

        setAnswerDrafts((prev) => {
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
          <h1>ChatUI · Todo · Human Loop · Files · Store</h1>
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
        <aside className="history-pane panel">
          <div className="history-header">
            <h3>历史会话</h3>
            <button
              type="button"
              className="secondary"
              onClick={() => void handleCreateChat()}
              disabled={submitting || runStatus === "running"}
            >
              新建
            </button>
          </div>
          {historyStatus === "loading" ? (
            <p className="muted">会话加载中...</p>
          ) : null}
          {historyError ? <p className="error-text">{historyError}</p> : null}
          <div className="history-list">
            {chatHistory.length === 0 ? (
              <p className="muted">暂无历史会话</p>
            ) : (
              chatHistory.map((chat) => (
                <button
                  key={chat.chatId}
                  type="button"
                  className={`history-item ${chat.chatId === activeChatId ? "active" : ""}`}
                  onClick={() => void handleSelectChat(chat.chatId)}
                  disabled={submitting || runStatus === "running"}
                >
                  <strong>{chat.title}</strong>
                  <span>{formatTime(chat.lastMessageAt ?? chat.updatedAt)}</span>
                </button>
              ))
            )}
          </div>
        </aside>

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
              <dt>chatId</dt>
              <dd>{activeChatId ?? "-"}</dd>
              <dt>runId</dt>
              <dd>{activeRunId ?? "-"}</dd>
              <dt>app</dt>
              <dd>{activeStoreApp ? `${activeStoreApp.name} (${activeStoreApp.appId})` : "-"}</dd>
              <dt>status</dt>
              <dd>{runStatus}</dd>
              <dt>detail</dt>
              <dd>{runDetail || "-"}</dd>
            </dl>
          </section>

          <section className="panel">
            <h3>应用商店</h3>
            <div className="store-controls">
              <button
                type="button"
                className="secondary"
                disabled={storeStatus === "loading" || !fileUserId.trim()}
                onClick={() => void refreshStoreApps()}
              >
                {storeStatus === "loading" ? "刷新中..." : "刷新应用"}
              </button>
            </div>
            {storeError ? <p className="error-text">{storeError}</p> : null}
            <div className="store-list">
              {storeApps.length === 0 ? (
                <p className="muted">当前用户无可见应用</p>
              ) : (
                storeApps.map((app) => (
                  <button
                    key={app.appId}
                    type="button"
                    className={`store-item ${activeAppId === app.appId ? "active" : ""}`}
                    disabled={!app.canUse}
                    onClick={() => setActiveAppId(app.appId)}
                    title={app.canUse ? app.appId : "无使用权限"}
                  >
                    <strong>{app.name}</strong>
                    <span>{app.appId}</span>
                    <span>{app.canUse ? "可用" : "仅可见"}</span>
                  </button>
                ))
              )}
            </div>
            {activeStoreApp ? (
              <p className="muted">
                新会话默认绑定应用：<code>{activeStoreApp.appId}</code>
              </p>
            ) : null}
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
                {pendingRequests.map((request) => {
                  const timeoutState = resolveHumanLoopTimeoutState(request, nowTick);
                  return (
                    <article
                      key={request.questionId}
                      className={`pending-card ${timeoutState.timedOut ? "timeout" : ""}`}
                    >
                      <header>
                        <strong>{request.questionId}</strong>
                        <time>{formatTime(request.requestedAt)}</time>
                      </header>
                      <p>{request.prompt}</p>
                      <p
                        className={`human-loop-timeout ${timeoutState.timedOut ? "warning" : ""}`}
                      >
                        {timeoutState.text}
                      </p>
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
                      {replyFeedback[request.questionId] ? (
                        <p className="human-loop-feedback">
                          {replyFeedback[request.questionId]}
                        </p>
                      ) : null}
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
                  );
                })}
              </div>
            )}
          </section>

          <section className="panel">
            <h3>Files</h3>
            <div className="files-controls">
              <label>
                userId
                <input
                  value={fileUserId}
                  onChange={(event) => setFileUserId(event.target.value)}
                  placeholder="u-alice"
                />
              </label>
              <div className="files-path-row">
                <input
                  value={fileTreePath}
                  onChange={(event) => setFileTreePath(event.target.value)}
                  placeholder="/workspace/public"
                />
                <button
                  type="button"
                  className="secondary"
                  disabled={fileBusy || !fileUserId.trim()}
                  onClick={() => void loadFileTree(fileTreePath)}
                >
                  刷新
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={fileBusy || fileTreePath === "/"}
                  onClick={() => void loadFileTree(parentUiPath(fileTreePath))}
                >
                  上级
                </button>
              </div>
              <div className="files-action-row">
                <button
                  type="button"
                  className="secondary"
                  disabled={fileBusy || !fileUserId.trim()}
                  onClick={() => void createDirectory()}
                >
                  新建目录
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={fileBusy || !fileUserId.trim()}
                  onClick={() => void createTextFile()}
                >
                  新建文件
                </button>
                <label className="upload-label">
                  上传
                  <input type="file" onChange={(event) => void uploadFile(event)} />
                </label>
              </div>
            </div>
            {fileListStatus === "loading" ? <p className="muted">文件列表加载中...</p> : null}
            {fileError ? <p className="error-text">{fileError}</p> : null}
            <div className="file-list">
              {fileEntries.length === 0 ? (
                <p className="muted">点击刷新加载文件列表</p>
              ) : (
                fileEntries.map((entry) => (
                  <article
                    key={entry.path}
                    className={`file-row ${activeFilePath === entry.path ? "active" : ""}`}
                  >
                    <button
                      type="button"
                      className="file-entry"
                      onClick={() =>
                        entry.isDirectory
                          ? void loadFileTree(entry.path)
                          : void openFile(entry.path)
                      }
                    >
                      <span>{entry.isDirectory ? `📁 ${entry.name}` : entry.name}</span>
                      <span>{entry.isDirectory ? "dir" : formatBytes(entry.size)}</span>
                    </button>
                    <div className="file-row-actions">
                      {!entry.isDirectory ? (
                        <button
                          type="button"
                          className="secondary"
                          disabled={fileBusy}
                          onClick={() => downloadPath(entry.path)}
                        >
                          下载
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="secondary"
                        disabled={fileBusy}
                        onClick={() => void renamePath(entry.path)}
                      >
                        重命名
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={fileBusy}
                        onClick={() => void deletePath(entry.path)}
                      >
                        删除
                      </button>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>

          <section className="panel">
            <h3>Preview</h3>
            {!activeFilePath ? (
              <p className="muted">选择文件后可预览与编辑</p>
            ) : (
              <div className="preview-panel">
                <div className="preview-meta">
                  <strong>{activeFilePath}</strong>
                  <span>
                    {activeFilePreview
                      ? `${activeFilePreview.contentType} · ${formatBytes(activeFilePreview.size)}`
                      : "-"}
                  </span>
                </div>
                {filePreviewMode === "text" ? (
                  <>
                    <textarea
                      className="file-editor"
                      value={fileDraft}
                      onChange={(event) => setFileDraft(event.target.value)}
                      rows={10}
                      disabled={fileBusy}
                    />
                    <div className="preview-actions">
                      <button
                        type="button"
                        disabled={
                          fileBusy ||
                          !activeFilePreview ||
                          activeFilePreview.truncated ||
                          activeFilePreview.encoding !== "utf8"
                        }
                        onClick={() => void saveActiveFile()}
                      >
                        保存
                      </button>
                      {activeFilePreview?.nextOffset !== null ? (
                        <button
                          type="button"
                          className="secondary"
                          disabled={fileBusy}
                          onClick={() => void handleLoadMoreFile()}
                        >
                          继续加载
                        </button>
                      ) : null}
                      {activeFilePreview?.truncated ? (
                        <p className="muted">当前为分段读取，加载完整后才可保存。</p>
                      ) : null}
                    </div>
                  </>
                ) : null}
                {filePreviewMode === "image" && activeFileInlineUrl ? (
                  <img
                    src={activeFileInlineUrl}
                    alt={activeFilePath}
                    className="preview-image"
                  />
                ) : null}
                {filePreviewMode === "pdf" && activeFileInlineUrl ? (
                  <iframe
                    title={activeFilePath}
                    src={activeFileInlineUrl}
                    className="preview-frame"
                  />
                ) : null}
                {filePreviewMode === "binary" ? (
                  <p className="muted">二进制文件不支持在线编辑，请使用下载查看。</p>
                ) : null}
                <div className="preview-actions">
                  {activeFileDownloadUrl ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => downloadPath(activeFilePath)}
                    >
                      下载文件
                    </button>
                  ) : null}
                </div>
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
          executionProfile: runConfig.executionProfile,
          providerOptions: runConfig.providerOptions,
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

function toHistoryMessages(messages: readonly PortalUiMessage[]): Array<{
  role: "system" | "user" | "assistant";
  content: string;
  createdAt: string;
}> {
  return messages
    .map((message) => ({
      role: message.role,
      content: extractMessageText(message).trim(),
      createdAt: message.metadata?.createdAt ?? new Date().toISOString(),
    }))
    .filter((item) => item.content.length > 0);
}

function toPortalMessages(messages: readonly ChatHistoryMessage[]): PortalUiMessage[] {
  return messages.map((message) => ({
    id: `h-${message.id}`,
    role: message.role,
    metadata: {
      createdAt: message.createdAt,
    },
    parts: [
      {
        type: "text",
        text: message.content,
        state: "done",
      },
    ],
  }));
}

function sortHistorySummaries(
  chats: readonly ChatHistorySummary[],
): ChatHistorySummary[] {
  return Array.from(
    chats.reduce((map, item) => map.set(item.chatId, item), new Map<string, ChatHistorySummary>()).values(),
  ).sort((a, b) => {
    const aTs = new Date(a.lastMessageAt ?? a.updatedAt).getTime();
    const bTs = new Date(b.lastMessageAt ?? b.updatedAt).getTime();
    return bTs - aTs;
  });
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

function normalizeUiPath(path: string): string {
  if (!path.trim()) {
    return "/";
  }
  return path.startsWith("/") ? path : `/${path}`;
}

function joinUiPath(base: string, child: string): string {
  const normalizedBase = normalizeUiPath(base);
  if (normalizedBase === "/") {
    return `/${child}`;
  }
  return `${normalizedBase}/${child}`.replace(/\/+/g, "/");
}

function parentUiPath(path: string): string {
  const normalized = normalizeUiPath(path);
  if (normalized === "/") {
    return "/";
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return "/";
  }
  return `/${parts.slice(0, -1).join("/")}`;
}

function resolveFilePreviewMode(
  path: string,
  contentType: string,
  encoding: "utf8" | "base64",
): FilePreviewMode {
  if (encoding === "utf8") {
    return "text";
  }

  const lowerPath = path.toLowerCase();
  if (contentType.startsWith("image/")) {
    return "image";
  }
  if (contentType === "application/pdf" || lowerPath.endsWith(".pdf")) {
    return "pdf";
  }
  return "binary";
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) {
    return "-";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function uint8ArrayToBase64(input: Uint8Array): string {
  let binary = "";
  for (const item of input) {
    binary += String.fromCharCode(item);
  }
  return btoa(binary);
}

function resolveHumanLoopTimeoutState(
  request: HumanLoopRequest,
  nowMs: number,
): {
  timedOut: boolean;
  text: string;
} {
  const requestedMs = new Date(request.requestedAt).getTime();
  if (!Number.isFinite(requestedMs)) {
    return {
      timedOut: false,
      text: "等待中",
    };
  }

  const deadlineMs = resolveHumanLoopDeadlineMs(request, requestedMs);
  const remainingMs = deadlineMs - nowMs;
  if (remainingMs <= 0) {
    return {
      timedOut: true,
      text: `已超时 ${formatDuration(Math.abs(remainingMs))}（仅提示，不自动完成）`,
    };
  }

  return {
    timedOut: false,
    text: `剩余 ${formatDuration(remainingMs)}`,
  };
}

function resolveHumanLoopDeadlineMs(
  request: HumanLoopRequest,
  requestedMs: number,
): number {
  const metadata = request.metadata;
  const deadlineAt = asString(metadata.deadlineAt);
  if (deadlineAt) {
    const deadlineMs = new Date(deadlineAt).getTime();
    if (Number.isFinite(deadlineMs)) {
      return deadlineMs;
    }
  }

  const timeoutMs = asNumber(metadata.timeoutMs);
  if (timeoutMs && timeoutMs > 0) {
    return requestedMs + timeoutMs;
  }

  return requestedMs + HUMAN_LOOP_TIMEOUT_MS;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${minutes.toString().padStart(2, "0")}m`;
  }
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
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
