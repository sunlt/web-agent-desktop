import type { FormEvent, KeyboardEvent } from "react";
import type { ProviderKind } from "./transport";
import type { RunChatController } from "./use-run-chat";
import type { StoreAppItem } from "./store-types";
import {
  extractMessageText,
  formatTime,
  resolveHumanLoopTimeoutState,
} from "./utils";

interface ChatDesktopWindowProps {
  provider: ProviderKind;
  model: string;
  requireHumanLoop: boolean;
  setProvider: (provider: ProviderKind) => void;
  setModel: (model: string) => void;
  setRequireHumanLoop: (value: boolean) => void;
  activeStoreApp: StoreAppItem | null;
  runChat: RunChatController;
  onInputKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (event: FormEvent) => void;
}

export function ChatDesktopWindow(input: ChatDesktopWindowProps) {
  const {
    provider,
    model,
    requireHumanLoop,
    setProvider,
    setModel,
    setRequireHumanLoop,
    activeStoreApp,
    runChat,
    onInputKeyDown,
    onSubmit,
  } = input;

  const providerLocked = Boolean(activeStoreApp?.runtimeDefaults);

  return (
    <div className="window-chat-shell">
      <header className="chat-window-header">
        <div>
          <p className="eyebrow">Web Agent Desktop</p>
          <h2>ChatUI</h2>
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
            disabled={runChat.runStatus === "running" || providerLocked}
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
            disabled={runChat.runStatus === "running" || providerLocked}
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

      <div className="window-chat-layout">
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
          {runChat.historyError ? (
            <p className="error-text panel-error">{runChat.historyError}</p>
          ) : null}
          <div className="history-list">
            {runChat.chatHistory.length === 0 ? (
              <p className="muted">暂无历史会话</p>
            ) : (
              runChat.chatHistory.map((chat) => (
                <button
                  key={chat.chatId}
                  type="button"
                  className={`history-item ${
                    chat.chatId === runChat.activeChatId ? "active" : ""
                  }`}
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

        <section className="chat-pane panel">
          <div className="messages" role="log" aria-live="polite">
            {runChat.messages.length === 0 ? (
              <div className="empty-state">
                <h2>输入你的任务指令</h2>
                <p>
                  消息会通过 <code>POST /api/runs/start</code> 进入真实执行链路。
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

          {runChat.errorText ? (
            <p className="error-text panel-error">{runChat.errorText}</p>
          ) : null}
        </section>

        <aside className="chat-side-pane">
          <section className="panel">
            <h3>Run 状态</h3>
            <dl>
              <dt>chatId</dt>
              <dd>{runChat.activeChatId ?? "-"}</dd>
              <dt>runId</dt>
              <dd>{runChat.activeRunId ?? "-"}</dd>
              <dt>app</dt>
              <dd>
                {activeStoreApp
                  ? `${activeStoreApp.name} (${activeStoreApp.appId})`
                  : "-"}
              </dd>
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
                      className={`pending-card ${
                        timeoutState.timedOut ? "timeout" : ""
                      }`}
                    >
                      <header>
                        <strong>{request.questionId}</strong>
                        <time>{formatTime(request.requestedAt)}</time>
                      </header>
                      <p>{request.prompt}</p>
                      <p
                        className={`human-loop-timeout ${
                          timeoutState.timedOut ? "warning" : ""
                        }`}
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
                        {runChat.replying[request.questionId]
                          ? "提交中..."
                          : "提交回复"}
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
                        <time>
                          {formatTime(request.resolvedAt ?? request.requestedAt)}
                        </time>
                      </div>
                      <p>{request.prompt}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
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
      </div>
    </div>
  );
}
