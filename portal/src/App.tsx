import type { ProviderKind } from "./workbench/transport";
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useFileWorkspace } from "./workbench/use-file-workspace";
import { useRunChat } from "./workbench/use-run-chat";
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
};

type StoreStatus = "idle" | "loading" | "error";

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(
  /\/$/,
  "",
);

const DEFAULT_MODEL: Record<ProviderKind, string> = {
  "codex-cli": "gpt-5.1-codex",
  opencode: "openai/gpt-5.1-codex",
  "claude-code": "claude-sonnet-4-20250514",
};

export default function App() {
  const [provider, setProvider] = useState<ProviderKind>("codex-cli");
  const [model, setModel] = useState<string>(DEFAULT_MODEL["codex-cli"]);
  const [requireHumanLoop, setRequireHumanLoop] = useState<boolean>(true);

  const [fileUserId, setFileUserId] = useState<string>("u-alice");
  const [storeApps, setStoreApps] = useState<StoreAppItem[]>([]);
  const [storeStatus, setStoreStatus] = useState<StoreStatus>("idle");
  const [storeError, setStoreError] = useState<string>("");
  const [activeAppId, setActiveAppId] = useState<string>("");

  useEffect(() => {
    setModel(DEFAULT_MODEL[provider]);
  }, [provider]);

  const activeStoreApp = useMemo(
    () => storeApps.find((item) => item.appId === activeAppId) ?? null,
    [activeAppId, storeApps],
  );

  const runChat = useRunChat({
    apiBase: API_BASE,
    provider,
    model,
    requireHumanLoop,
    activeStoreApp,
  });

  const fileWorkspace = useFileWorkspace({
    apiBase: API_BASE,
    fileUserId,
    fetchJson: runChat.fetchJson,
    appendTimeline: runChat.appendTimeline,
  });

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
  }, [fileUserId, runChat]);

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
          <h1>ChatUI · Todo · Human Loop · Files · Store</h1>
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
            disabled={runChat.runStatus === "running"}
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
            onChange={(event) => setModel(event.target.value)}
            disabled={runChat.runStatus === "running"}
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
                  value={fileWorkspace.fileTreePath}
                  onChange={(event) => fileWorkspace.setFileTreePath(event.target.value)}
                  placeholder="/workspace/public"
                />
                <button
                  type="button"
                  className="secondary"
                  disabled={fileWorkspace.fileBusy || !fileUserId.trim()}
                  onClick={() => void fileWorkspace.loadFileTree(fileWorkspace.fileTreePath)}
                >
                  刷新
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={fileWorkspace.fileBusy || fileWorkspace.fileTreePath === "/"}
                  onClick={() => void fileWorkspace.loadFileTree(fileWorkspace.parentPath)}
                >
                  上级
                </button>
              </div>
              <div className="files-action-row">
                <button
                  type="button"
                  className="secondary"
                  disabled={fileWorkspace.fileBusy || !fileUserId.trim()}
                  onClick={() => void fileWorkspace.createDirectory()}
                >
                  新建目录
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={fileWorkspace.fileBusy || !fileUserId.trim()}
                  onClick={() => void fileWorkspace.createTextFile()}
                >
                  新建文件
                </button>
                <label className="upload-label">
                  上传
                  <input
                    type="file"
                    onChange={(event) => void fileWorkspace.uploadFile(event)}
                  />
                </label>
              </div>
            </div>
            {fileWorkspace.fileListStatus === "loading" ? (
              <p className="muted">文件列表加载中...</p>
            ) : null}
            {fileWorkspace.fileError ? <p className="error-text">{fileWorkspace.fileError}</p> : null}
            <div className="file-list">
              {fileWorkspace.fileEntries.length === 0 ? (
                <p className="muted">点击刷新加载文件列表</p>
              ) : (
                fileWorkspace.fileEntries.map((entry) => (
                  <article
                    key={entry.path}
                    className={`file-row ${fileWorkspace.activeFilePath === entry.path ? "active" : ""}`}
                  >
                    <button
                      type="button"
                      className="file-entry"
                      onClick={() =>
                        entry.isDirectory
                          ? void fileWorkspace.loadFileTree(entry.path)
                          : void fileWorkspace.openFile(entry.path)
                      }
                    >
                      <span>{entry.isDirectory ? `📁 ${entry.name}` : entry.name}</span>
                      <span>
                        {entry.isDirectory ? "dir" : fileWorkspace.formatFileSize(entry.size)}
                      </span>
                    </button>
                    <div className="file-row-actions">
                      {!entry.isDirectory ? (
                        <button
                          type="button"
                          className="secondary"
                          disabled={fileWorkspace.fileBusy}
                          onClick={() => fileWorkspace.downloadPath(entry.path)}
                        >
                          下载
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="secondary"
                        disabled={fileWorkspace.fileBusy}
                        onClick={() => void fileWorkspace.renamePath(entry.path)}
                      >
                        重命名
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={fileWorkspace.fileBusy}
                        onClick={() => void fileWorkspace.deletePath(entry.path)}
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
            {!fileWorkspace.activeFilePath ? (
              <p className="muted">选择文件后可预览与编辑</p>
            ) : (
              <div className="preview-panel">
                <div className="preview-meta">
                  <strong>{fileWorkspace.activeFilePath}</strong>
                  <span>
                    {fileWorkspace.activeFilePreview
                      ? `${fileWorkspace.activeFilePreview.contentType} · ${fileWorkspace.formatFileSize(fileWorkspace.activeFilePreview.size)}`
                      : "-"}
                  </span>
                </div>
                {fileWorkspace.filePreviewMode === "text" ? (
                  <>
                    <textarea
                      className="file-editor"
                      value={fileWorkspace.fileDraft}
                      onChange={(event) => fileWorkspace.setFileDraft(event.target.value)}
                      rows={10}
                      disabled={fileWorkspace.fileBusy}
                    />
                    <div className="preview-actions">
                      <button
                        type="button"
                        disabled={
                          fileWorkspace.fileBusy ||
                          !fileWorkspace.activeFilePreview ||
                          fileWorkspace.activeFilePreview.truncated ||
                          fileWorkspace.activeFilePreview.encoding !== "utf8"
                        }
                        onClick={() => void fileWorkspace.saveActiveFile()}
                      >
                        保存
                      </button>
                      {fileWorkspace.activeFilePreview?.nextOffset !== null ? (
                        <button
                          type="button"
                          className="secondary"
                          disabled={fileWorkspace.fileBusy}
                          onClick={() => void fileWorkspace.handleLoadMoreFile()}
                        >
                          继续加载
                        </button>
                      ) : null}
                      {fileWorkspace.activeFilePreview?.truncated ? (
                        <p className="muted">当前为分段读取，加载完整后才可保存。</p>
                      ) : null}
                    </div>
                  </>
                ) : null}
                {fileWorkspace.filePreviewMode === "image" && fileWorkspace.activeFileInlineUrl ? (
                  <img
                    src={fileWorkspace.activeFileInlineUrl}
                    alt={fileWorkspace.activeFilePath}
                    className="preview-image"
                  />
                ) : null}
                {fileWorkspace.filePreviewMode === "pdf" && fileWorkspace.activeFileInlineUrl ? (
                  <iframe
                    title={fileWorkspace.activeFilePath}
                    src={fileWorkspace.activeFileInlineUrl}
                    className="preview-frame"
                  />
                ) : null}
                {fileWorkspace.filePreviewMode === "binary" ? (
                  <p className="muted">二进制文件不支持在线编辑，请使用下载查看。</p>
                ) : null}
                <div className="preview-actions">
                  {fileWorkspace.activeFileDownloadUrl ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        if (fileWorkspace.activeFilePath) {
                          fileWorkspace.downloadPath(fileWorkspace.activeFilePath);
                        }
                      }}
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
