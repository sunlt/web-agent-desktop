import type { CSSProperties, FormEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatDesktopWindow } from "./workbench/chat-desktop-window";
import { FilesDesktopWindow } from "./workbench/files-desktop-window";
import type { StoreAppItem } from "./workbench/store-types";
import { StoreDesktopWindow } from "./workbench/store-desktop-window";
import { TodoDesktopWindow } from "./workbench/todo-desktop-window";
import type { ProviderKind } from "./workbench/transport";
import { TtyDesktopWindow } from "./workbench/tty-desktop-window";
import { useFileWorkspace } from "./workbench/use-file-workspace";
import { useRunChat } from "./workbench/use-run-chat";
import { useSessionTerminal } from "./workbench/use-session-terminal";

type StoreStatus = "idle" | "loading" | "error";
type DesktopAppId = "chat" | "store" | "todo" | "files" | "tty";

type DesktopWindowState = {
  open: boolean;
  minimized: boolean;
  zIndex: number;
};

type DesktopFrame = {
  top: number;
  left: number;
  width: number;
  height: number;
};

type DesktopAppMeta = {
  title: string;
  badge: string;
  description: string;
  defaultOpen: boolean;
  frame: DesktopFrame;
};

const DESKTOP_APP_BASE_Z: Record<DesktopAppId, number> = {
  chat: 40,
  store: 30,
  todo: 20,
  files: 10,
  tty: 11,
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(
  /\/$/,
  "",
);

const DEFAULT_MODEL: Record<ProviderKind, string> = {
  "codex-app-server": "gpt-5.1-codex",
  "codex-cli": "gpt-5.1-codex",
  opencode: "openai/gpt-5.1-codex",
  "claude-code": "claude-sonnet-4-20250514",
};

const DESKTOP_APP_ORDER: readonly DesktopAppId[] = [
  "chat",
  "store",
  "todo",
  "files",
  "tty",
];

const DESKTOP_APP_META: Record<DesktopAppId, DesktopAppMeta> = {
  chat: {
    title: "ChatUI",
    badge: "CH",
    description: "聊天与执行主界面",
    defaultOpen: true,
    frame: { top: 24, left: 140, width: 930, height: 760 },
  },
  store: {
    title: "应用商店",
    badge: "ST",
    description: "选择可见/可用应用",
    defaultOpen: true,
    frame: { top: 24, left: 1088, width: 360, height: 430 },
  },
  todo: {
    title: "TodoList",
    badge: "TD",
    description: "任务状态与时间线",
    defaultOpen: true,
    frame: { top: 472, left: 1088, width: 360, height: 312 },
  },
  files: {
    title: "Files",
    badge: "FI",
    description: "会话/全局文件管理",
    defaultOpen: true,
    frame: { top: 56, left: 170, width: 1180, height: 700 },
  },
  tty: {
    title: "TTY",
    badge: "TT",
    description: "会话命令执行",
    defaultOpen: true,
    frame: { top: 80, left: 260, width: 920, height: 620 },
  },
};

function createInitialDesktopWindows(): Record<DesktopAppId, DesktopWindowState> {
  return DESKTOP_APP_ORDER.reduce(
    (acc, appId) => {
      const meta = DESKTOP_APP_META[appId];
      acc[appId] = {
        open: meta.defaultOpen,
        minimized: false,
        zIndex: DESKTOP_APP_BASE_Z[appId],
      };
      return acc;
    },
    {} as Record<DesktopAppId, DesktopWindowState>,
  );
}

function formatDesktopClock(now: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
}

export default function App() {
  const [provider, setProvider] = useState<ProviderKind>("codex-app-server");
  const [model, setModel] = useState<string>(DEFAULT_MODEL["codex-app-server"]);
  const [requireHumanLoop, setRequireHumanLoop] = useState<boolean>(true);

  const [globalFileUserId, setGlobalFileUserId] = useState<string>("u-alice");
  const [workspaceSessionId, setWorkspaceSessionId] = useState<string>("");
  const [storeApps, setStoreApps] = useState<StoreAppItem[]>([]);
  const [storeStatus, setStoreStatus] = useState<StoreStatus>("idle");
  const [storeError, setStoreError] = useState<string>("");
  const [activeAppId, setActiveAppId] = useState<string>("");

  const [desktopWindows, setDesktopWindows] = useState<Record<
    DesktopAppId,
    DesktopWindowState
  >>(createInitialDesktopWindows);
  const [focusedDesktopApp, setFocusedDesktopApp] = useState<DesktopAppId | null>(
    "chat",
  );
  const [clockLabel, setClockLabel] = useState<string>(() =>
    formatDesktopClock(Date.now()),
  );

  const desktopZRef = useRef<number>(50);

  const activeStoreApp = useMemo(
    () => storeApps.find((item) => item.appId === activeAppId) ?? null,
    [activeAppId, storeApps],
  );

  useEffect(() => {
    const runtimeDefaults = activeStoreApp?.runtimeDefaults;
    if (runtimeDefaults && runtimeDefaults.provider === provider) {
      setModel(runtimeDefaults.model);
      return;
    }
    setModel(DEFAULT_MODEL[provider]);
  }, [activeStoreApp?.runtimeDefaults, provider]);

  useEffect(() => {
    const runtimeDefaults = activeStoreApp?.runtimeDefaults;
    if (!runtimeDefaults) {
      return;
    }
    setProvider(runtimeDefaults.provider);
    setModel(runtimeDefaults.model);
  }, [activeStoreApp?.appId, activeStoreApp?.runtimeDefaults]);

  const runChat = useRunChat({
    apiBase: API_BASE,
    provider,
    model,
    requireHumanLoop,
    activeStoreApp,
    historyUserId: globalFileUserId,
  });

  useEffect(() => {
    if (!workspaceSessionId.trim() && runChat.activeChatId) {
      setWorkspaceSessionId(runChat.activeChatId);
    }
  }, [runChat.activeChatId, workspaceSessionId]);

  const executorWorkspace = useFileWorkspace({
    apiBase: API_BASE,
    scope: {
      kind: "executor-workspace",
      sessionId: workspaceSessionId,
    },
    initialPath: "/workspace",
    fetchJson: runChat.fetchJson,
    appendTimeline: runChat.appendTimeline,
  });

  const globalFileWorkspace = useFileWorkspace({
    apiBase: API_BASE,
    scope: {
      kind: "global",
      userId: globalFileUserId,
    },
    initialPath: "/workspace/public",
    fetchJson: runChat.fetchJson,
    appendTimeline: runChat.appendTimeline,
  });

  const sessionTerminal = useSessionTerminal({
    sessionId: workspaceSessionId,
    fetchJson: runChat.fetchJson,
    appendTimeline: runChat.appendTimeline,
  });

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClockLabel(formatDesktopClock(Date.now()));
    }, 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const nextDesktopZ = useCallback((): number => {
    desktopZRef.current += 1;
    return desktopZRef.current;
  }, []);

  const focusDesktopWindow = useCallback(
    (appId: DesktopAppId) => {
      setDesktopWindows((prev) => {
        const current = prev[appId];
        if (!current.open) {
          return prev;
        }
        return {
          ...prev,
          [appId]: {
            ...current,
            minimized: false,
            zIndex: nextDesktopZ(),
          },
        };
      });
      setFocusedDesktopApp(appId);
    },
    [nextDesktopZ],
  );

  const launchDesktopWindow = useCallback(
    (appId: DesktopAppId) => {
      setDesktopWindows((prev) => ({
        ...prev,
        [appId]: {
          ...prev[appId],
          open: true,
          minimized: false,
          zIndex: nextDesktopZ(),
        },
      }));
      setFocusedDesktopApp(appId);
    },
    [nextDesktopZ],
  );

  const minimizeDesktopWindow = useCallback((appId: DesktopAppId) => {
    setDesktopWindows((prev) => ({
      ...prev,
      [appId]: {
        ...prev[appId],
        minimized: true,
      },
    }));
    setFocusedDesktopApp((prev) => (prev === appId ? null : prev));
  }, []);

  const closeDesktopWindow = useCallback((appId: DesktopAppId) => {
    setDesktopWindows((prev) => ({
      ...prev,
      [appId]: {
        ...prev[appId],
        open: false,
        minimized: false,
      },
    }));
    setFocusedDesktopApp((prev) => (prev === appId ? null : prev));
  }, []);

  const toggleTaskbarWindow = useCallback(
    (appId: DesktopAppId) => {
      const current = desktopWindows[appId];
      if (!current.open) {
        launchDesktopWindow(appId);
        return;
      }
      if (current.minimized) {
        focusDesktopWindow(appId);
        return;
      }
      if (focusedDesktopApp === appId) {
        minimizeDesktopWindow(appId);
        return;
      }
      focusDesktopWindow(appId);
    },
    [
      desktopWindows,
      focusDesktopWindow,
      focusedDesktopApp,
      launchDesktopWindow,
      minimizeDesktopWindow,
    ],
  );

  const refreshStoreApps = useCallback(async () => {
    const userId = globalFileUserId.trim();
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
      const result = await runChat.fetchJson<{ apps: StoreAppItem[] }>(
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
  }, [globalFileUserId, runChat.fetchJson]);

  useEffect(() => {
    void refreshStoreApps();
  }, [refreshStoreApps]);

  const onInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void runChat.handleSend();
      }
    },
    [runChat],
  );

  const onSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      void runChat.handleSend();
    },
    [runChat],
  );

  const visibleDesktopApps = useMemo(
    () =>
      DESKTOP_APP_ORDER.filter(
        (appId) => desktopWindows[appId].open && !desktopWindows[appId].minimized,
      ).sort((a, b) => desktopWindows[a].zIndex - desktopWindows[b].zIndex),
    [desktopWindows],
  );

  const renderWindowBody = (appId: DesktopAppId) => {
    switch (appId) {
      case "chat":
        return (
          <ChatDesktopWindow
            provider={provider}
            model={model}
            requireHumanLoop={requireHumanLoop}
            setProvider={setProvider}
            setModel={setModel}
            setRequireHumanLoop={setRequireHumanLoop}
            activeStoreApp={activeStoreApp}
            runChat={runChat}
            onInputKeyDown={onInputKeyDown}
            onSubmit={onSubmit}
          />
        );
      case "store":
        return (
          <StoreDesktopWindow
            globalFileUserId={globalFileUserId}
            setGlobalFileUserId={setGlobalFileUserId}
            storeStatus={storeStatus}
            storeError={storeError}
            storeApps={storeApps}
            activeAppId={activeAppId}
            setActiveAppId={setActiveAppId}
            activeStoreApp={activeStoreApp}
            refreshStoreApps={refreshStoreApps}
          />
        );
      case "todo":
        return <TodoDesktopWindow runChat={runChat} />;
      case "files":
        return (
          <FilesDesktopWindow
            executorWorkspace={executorWorkspace}
            globalFileWorkspace={globalFileWorkspace}
            workspaceSessionId={workspaceSessionId}
            setWorkspaceSessionId={setWorkspaceSessionId}
            activeChatId={runChat.activeChatId}
            globalFileUserId={globalFileUserId}
            setGlobalFileUserId={setGlobalFileUserId}
          />
        );
      case "tty":
        return (
          <TtyDesktopWindow
            workspaceSessionId={workspaceSessionId}
            setWorkspaceSessionId={setWorkspaceSessionId}
            activeChatId={runChat.activeChatId}
            terminal={sessionTerminal}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="desktop-root">
      <section className="desktop-surface">
        <nav className="desktop-icons" aria-label="桌面图标">
          {DESKTOP_APP_ORDER.map((appId) => {
            const meta = DESKTOP_APP_META[appId];
            const state = desktopWindows[appId];
            const isActive = state.open && !state.minimized;
            return (
              <button
                key={appId}
                type="button"
                className={`desktop-icon ${isActive ? "active" : ""}`}
                onClick={() => launchDesktopWindow(appId)}
                title={meta.description}
              >
                <span className="desktop-icon-badge">{meta.badge}</span>
                <span className="desktop-icon-title">{meta.title}</span>
              </button>
            );
          })}
        </nav>

        <div className="desktop-window-layer">
          {visibleDesktopApps.map((appId) => {
            const meta = DESKTOP_APP_META[appId];
            const windowState = desktopWindows[appId];
            const style: CSSProperties = {
              top: meta.frame.top,
              left: meta.frame.left,
              width: meta.frame.width,
              height: meta.frame.height,
              zIndex: windowState.zIndex,
            };

            return (
              <section
                key={appId}
                className={`desktop-window ${
                  focusedDesktopApp === appId ? "focused" : ""
                }`}
                style={style}
              >
                <header
                  className="desktop-window-header"
                  onMouseDown={() => focusDesktopWindow(appId)}
                >
                  <div className="desktop-window-title">
                    <span className="desktop-badge">{meta.badge}</span>
                    <h2>{meta.title}</h2>
                  </div>
                  <div className="desktop-window-actions">
                    <button
                      type="button"
                      className="secondary window-action"
                      onClick={(event) => {
                        event.stopPropagation();
                        minimizeDesktopWindow(appId);
                      }}
                      aria-label={`最小化 ${meta.title}`}
                    >
                      _
                    </button>
                    <button
                      type="button"
                      className="secondary window-action"
                      onClick={(event) => {
                        event.stopPropagation();
                        closeDesktopWindow(appId);
                      }}
                      aria-label={`关闭 ${meta.title}`}
                    >
                      x
                    </button>
                  </div>
                </header>
                <div className="desktop-window-content">{renderWindowBody(appId)}</div>
              </section>
            );
          })}
        </div>
      </section>

      <footer className="desktop-taskbar">
        <button
          type="button"
          className="taskbar-start"
          onClick={() => launchDesktopWindow("chat")}
        >
          WEB
        </button>
        <div className="taskbar-apps" role="tablist" aria-label="任务栏应用">
          {DESKTOP_APP_ORDER.map((appId) => {
            const meta = DESKTOP_APP_META[appId];
            const state = desktopWindows[appId];
            const selected =
              state.open && !state.minimized && focusedDesktopApp === appId;
            const active = state.open && !state.minimized;
            return (
              <button
                key={appId}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`taskbar-app ${active ? "active" : ""} ${
                  selected ? "focused" : ""
                }`}
                onClick={() => toggleTaskbarWindow(appId)}
                title={meta.description}
              >
                <span>{meta.badge}</span>
                <span>{meta.title}</span>
              </button>
            );
          })}
        </div>
        <div className="taskbar-right">
          <span className="taskbar-run-status" data-status={runChat.runStatus}>
            {runChat.runStatus}
          </span>
          <time>{clockLabel}</time>
        </div>
      </footer>
    </div>
  );
}
