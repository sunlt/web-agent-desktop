import { type FormEvent } from "react";
import { formatTime } from "./utils";
import type { SessionTerminalController } from "./use-session-terminal";

interface SessionTerminalPanelProps {
  readonly terminal: SessionTerminalController;
}

export function SessionTerminalPanel({ terminal }: SessionTerminalPanelProps) {
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void terminal.execute();
  };

  return (
    <section className="panel">
      <h3>TTY</h3>
      <form className="tty-controls" onSubmit={onSubmit}>
        <label>
          cwd
          <input
            value={terminal.cwdDraft}
            onChange={(event) => terminal.setCwdDraft(event.target.value)}
            placeholder="/workspace"
          />
        </label>
        <label>
          timeout(ms)
          <input
            type="number"
            min={1_000}
            max={120_000}
            step={1000}
            value={terminal.timeoutMs}
            onChange={(event) => terminal.setTimeoutMs(Number(event.target.value) || 30_000)}
          />
        </label>
        <label className="tty-command">
          command
          <input
            value={terminal.commandDraft}
            onChange={(event) => terminal.setCommandDraft(event.target.value)}
            placeholder="ls -la"
          />
        </label>
        <div className="tty-actions">
          <button type="submit" disabled={!terminal.ready || terminal.busy}>
            {terminal.busy ? "执行中..." : "执行"}
          </button>
          <button type="button" className="secondary" onClick={terminal.clear}>
            清空
          </button>
        </div>
      </form>

      {!terminal.ready ? <p className="muted">请先设置 sessionId 才能执行命令。</p> : null}
      {terminal.error ? <p className="error-text panel-error">{terminal.error}</p> : null}

      <div className="tty-list">
        {terminal.entries.length === 0 ? (
          <p className="muted">暂无命令执行记录</p>
        ) : (
          terminal.entries.map((entry) => (
            <article key={entry.id} className="tty-entry">
              <header>
                <strong>{entry.command}</strong>
                <time>{formatTime(entry.ts)}</time>
              </header>
              <p className="muted tty-meta">
                cwd={entry.cwd} · exit={entry.exitCode} · {entry.durationMs}ms
                {entry.timedOut ? " · timeout" : ""}
                {entry.truncated ? " · truncated" : ""}
              </p>
              {entry.stdout ? <pre className="tty-stdout">{entry.stdout}</pre> : null}
              {entry.stderr ? <pre className="tty-stderr">{entry.stderr}</pre> : null}
            </article>
          ))
        )}
      </div>
    </section>
  );
}
