import type { ProviderKind } from "./workbench/transport";
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import { FileWorkspacePanel } from "./workbench/file-workspace-panel";
import { SessionTerminalPanel } from "./workbench/session-terminal-panel";
import { useFileWorkspace } from "./workbench/use-file-workspace";
import { useRunChat } from "./workbench/use-run-chat";
import { useSessionTerminal } from "./workbench/use-session-terminal";
import {
  extractMessageText,
  formatTime,
  resolveHumanLoopTimeoutState,
} from "./workbench/utils";

type StoreAppItem = {
  appId: string;
  name: string;
  enabled: boolean;
  canView: boolean;
  canUse: boolean;
  runtimeDefaults: {
    provider: ProviderKind;
    model: string;
    timeoutMs: number | null;
    credentialEnvKeys: string[];
  } | null;
};

type StoreStatus = "idle" | "loading" | "error";

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
  }, [globalFileUserId, runChat]);

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

  return (
    <div className="app-root">
      <header className="app-header">
        <div>
          <p className="eyebrow">Agent Workbench</p>
          <h1>ChatUI · Todo · Human Loop · TTY · Files · Store</h1>
        </div>
        <div className="run-chip" data-status={runChat.runStatus}>
          <span className="run-dot" />
          <span>{runChat.runStatus}</span>
        </div>
      </header>

      <section className="control-bar">
        <label>
          Provider
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value as ProviderKind)}
            disabled={runChat.runStatus === "running" || Boolean(activeStoreApp?.runtimeDefaults)}
          >
            <option value="codex-app-server">codex-app-server</option>
            <option value="codex-cli">codex-cli</option>
            <option value="opencode">opencode</option>
            <option value="claude-code">claude-code</option>
          </select>
        </label>

        <label>
          Model
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            disabled={runChat.runStatus === "running" || Boolean(activeStoreApp?.runtimeDefaults)}
            placeholder="输入模型 ID"
          />
        </label>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={requireHumanLoop}
            onChange={(event) => setRequireHumanLoop(event.target.checked)}
            disabled={runChat.runStatus === "running"}
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
              onClick={() => void runChat.handleCreateChat()}
              disabled={runChat.submitting || runChat.runStatus === "running"}
            >
              新建
            </button>
          </div>
          {runChat.historyStatus === "loading" ? (
            <p className="muted">会话加载中...</p>
          ) : null}
          {runChat.historyError ? <p className="error-text">{runChat.historyError}</p> : null}
          <div className="history-list">
            {runChat.chatHistory.length === 0 ? (
              <p className="muted">暂无历史会话</p>
            ) : (
              runChat.chatHistory.map((chat) => (
                <button
                  key={chat.chatId}
                  type="button"
                  className={`history-item ${chat.chatId === runChat.activeChatId ? "active" : ""}`}
                  onClick={() => void runChat.handleSelectChat(chat.chatId)}
                  disabled={runChat.submitting || runChat.runStatus === "running"}
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
            {runChat.messages.length === 0 ? (
              <div className="empty-state">
                <h2>输入你的任务指令</h2>
                <p>
                  消息会通过 <code>POST /api/runs/start</code> 进入真实执行链路，右侧同步展示
                  Todo 与 Human-loop。
                </p>
              </div>
            ) : (
              runChat.messages.map((message) => (
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
                      (message.role === "assistant" && runChat.runStatus === "running"
                        ? "..."
                        : "")}
                  </pre>
                </article>
              ))
            )}
          </div>

          <form className="composer" onSubmit={onSubmit}>
            <textarea
              value={runChat.input}
              onChange={(event) => runChat.setInput(event.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              rows={3}
              disabled={runChat.submitting}
            />
            <div className="composer-actions">
              <button
                type="submit"
                disabled={
                  runChat.submitting ||
                  runChat.runStatus === "running" ||
                  !runChat.input.trim()
                }
              >
                发送
              </button>
              <button
                type="button"
                className="secondary"
                disabled={runChat.runStatus !== "running"}
                onClick={() => void runChat.handleStop()}
              >
                停止
              </button>
            </div>
          </form>

          {runChat.errorText ? <p className="error-text">{runChat.errorText}</p> : null}
        </section>

        <aside className="side-pane">
          <section className="panel">
            <h3>Run 状态</h3>
            <dl>
              <dt>chatId</dt>
              <dd>{runChat.activeChatId ?? "-"}</dd>
              <dt>runId</dt>
              <dd>{runChat.activeRunId ?? "-"}</dd>
              <dt>app</dt>
              <dd>{activeStoreApp ? `${activeStoreApp.name} (${activeStoreApp.appId})` : "-"}</dd>
              <dt>status</dt>
              <dd>{runChat.runStatus}</dd>
              <dt>stream</dt>
              <dd>
                {runChat.streamConnection.state}
                {runChat.streamConnection.state === "reconnecting"
                  ? ` (#${runChat.streamConnection.attempt})`
                  : ""}
              </dd>
              <dt>detail</dt>
              <dd>{runChat.runDetail || "-"}</dd>
            </dl>
          </section>

          <section className="panel">
            <h3>应用商店</h3>
            <div className="store-controls">
              <button
                type="button"
                className="secondary"
                disabled={storeStatus === "loading" || !globalFileUserId.trim()}
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
              <>
                <p className="muted">
                  新会话默认绑定应用：<code>{activeStoreApp.appId}</code>
                </p>
                {activeStoreApp.runtimeDefaults ? (
                  <p className="muted">
                    已锁定 provider/model：
                    <code>
                      {activeStoreApp.runtimeDefaults.provider} /{" "}
                      {activeStoreApp.runtimeDefaults.model}
                    </code>
                  </p>
                ) : null}
              </>
            ) : null}
          </section>

          <section className="panel">
            <h3>Todo</h3>
            <div className="todo-grid">
              {(Object.keys(runChat.groupedTodos) as Array<keyof typeof runChat.groupedTodos>).map(
                (status) => (
                  <div key={status} className="todo-column">
                    <h4>
                      {status} <span>{runChat.groupedTodos[status].length}</span>
                    </h4>
                    {runChat.groupedTodos[status].length === 0 ? (
                      <p className="muted">空</p>
                    ) : (
                      runChat.groupedTodos[status].map((item) => (
                        <div key={`${item.runId}-${item.todoId}`} className="todo-card">
                          <div className="todo-order">#{item.order}</div>
                          <div className="todo-content">{item.content}</div>
                        </div>
                      ))
                    )}
                  </div>
                ),
              )}
            </div>
            <div className="todo-events">
              <h4>Todo Timeline</h4>
              {runChat.todoEvents.length === 0 ? (
                <p className="muted">暂无事件</p>
              ) : (
                <ul>
                  {runChat.todoEvents.slice(-20).map((event) => (
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
            {runChat.pendingRequests.length === 0 ? (
              <p className="muted">当前无待回复问题</p>
            ) : (
              <div className="pending-list">
                {runChat.pendingRequests.map((request) => {
                  const timeoutState = resolveHumanLoopTimeoutState(
                    {
                      requestedAt: request.requestedAt,
                      metadata: request.metadata,
                    },
                    runChat.nowTick,
                  );
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
                        value={runChat.answerDrafts[request.questionId] ?? ""}
                        onChange={(event) =>
                          runChat.setAnswerDrafts((prev) => ({
                            ...prev,
                            [request.questionId]: event.target.value,
                          }))
                        }
                        rows={2}
                      />
                      {runChat.replyFeedback[request.questionId] ? (
                        <p className="human-loop-feedback">
                          {runChat.replyFeedback[request.questionId]}
                        </p>
                      ) : null}
                      <button
                        type="button"
                        disabled={
                          runChat.replying[request.questionId] === true ||
                          !(runChat.answerDrafts[request.questionId] ?? "").trim()
                        }
                        onClick={() => void runChat.handleReply(request)}
                      >
                        {runChat.replying[request.questionId] ? "提交中..." : "提交回复"}
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
            <div className="resolved-list-wrap">
              <h4>Resolved 历史</h4>
              {runChat.resolvedRequests.length === 0 ? (
                <p className="muted">暂无已处理问题</p>
              ) : (
                <ul className="resolved-list">
                  {runChat.resolvedRequests.slice(0, 20).map((request) => (
                    <li key={`${request.runId}-${request.questionId}`}>
                      <div className="resolved-head">
                        <strong>{request.questionId}</strong>
                        <time>{formatTime(request.resolvedAt ?? request.requestedAt)}</time>
                      </div>
                      <p>{request.prompt}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <FileWorkspacePanel
            title="执行器工作目录文件"
            workspace={executorWorkspace}
            identity={{
              label: "sessionId",
              value: workspaceSessionId,
              onChange: setWorkspaceSessionId,
              placeholder: runChat.activeChatId ?? "chat/session id",
            }}
            hint="基于 executor-manager 会话 worker，根目录为 /workspace。"
          />

          <SessionTerminalPanel terminal={sessionTerminal} />

          <FileWorkspacePanel
            title="全局文件管理"
            workspace={globalFileWorkspace}
            identity={{
              label: "userId",
              value: globalFileUserId,
              onChange: setGlobalFileUserId,
              placeholder: "u-alice",
            }}
            hint="用于访问 RBAC 控制的全局文件树（/files）。"
          />

          <section className="panel">
            <h3>Run Timeline</h3>
            {runChat.timeline.length === 0 ? (
              <p className="muted">暂无事件</p>
            ) : (
              <ul className="timeline-list">
                {runChat.timeline.slice(-30).map((entry) => (
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
