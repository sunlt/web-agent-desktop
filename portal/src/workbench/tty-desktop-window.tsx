import { SessionTerminalPanel } from "./session-terminal-panel";
import type { SessionTerminalController } from "./use-session-terminal";

interface TtyDesktopWindowProps {
  workspaceSessionId: string;
  setWorkspaceSessionId: (sessionId: string) => void;
  activeChatId: string | null;
  terminal: SessionTerminalController;
}

export function TtyDesktopWindow(input: TtyDesktopWindowProps) {
  const { workspaceSessionId, setWorkspaceSessionId, activeChatId, terminal } =
    input;

  return (
    <div className="window-tty-shell">
      <section className="panel">
        <h3>TTY 会话</h3>
        <label className="field-label">
          sessionId
          <input
            value={workspaceSessionId}
            onChange={(event) => setWorkspaceSessionId(event.target.value)}
            placeholder={activeChatId ?? "chat/session id"}
          />
        </label>
        <p className="muted">TTY 与执行器工作目录共享 session worker。</p>
      </section>
      <SessionTerminalPanel terminal={terminal} />
    </div>
  );
}
