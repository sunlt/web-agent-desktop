import { useCallback, useMemo, useState } from "react";

export interface TerminalEntry {
  readonly id: string;
  readonly ts: string;
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SessionTerminalController {
  readonly sessionId: string;
  readonly ready: boolean;
  readonly busy: boolean;
  readonly error: string;
  readonly commandDraft: string;
  readonly setCommandDraft: (value: string) => void;
  readonly cwdDraft: string;
  readonly setCwdDraft: (value: string) => void;
  readonly timeoutMs: number;
  readonly setTimeoutMs: (value: number) => void;
  readonly entries: TerminalEntry[];
  readonly execute: () => Promise<void>;
  readonly clear: () => void;
}

interface TerminalExecResponse {
  readonly ok: boolean;
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export function useSessionTerminal(input: {
  readonly sessionId: string;
  readonly fetchJson: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly appendTimeline: (label: string, ts?: string) => void;
}): SessionTerminalController {
  const { sessionId, fetchJson, appendTimeline } = input;

  const [commandDraft, setCommandDraft] = useState<string>("ls -la");
  const [cwdDraft, setCwdDraft] = useState<string>("/workspace");
  const [timeoutMs, setTimeoutMs] = useState<number>(30_000);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [entries, setEntries] = useState<TerminalEntry[]>([]);

  const ready = useMemo(() => sessionId.trim().length > 0, [sessionId]);

  const execute = useCallback(async () => {
    if (!ready) {
      setError("请先输入 sessionId");
      return;
    }

    const command = commandDraft.trim();
    if (!command) {
      setError("请输入命令");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const response = await fetchJson<TerminalExecResponse>(
        `/session-workers/${encodeURIComponent(sessionId)}/tty/exec`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            command,
            cwd: cwdDraft.trim() || undefined,
            timeoutMs,
          }),
        },
      );

      const entry: TerminalEntry = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        ts: new Date().toISOString(),
        command: response.command,
        cwd: response.cwd,
        exitCode: response.exitCode,
        durationMs: response.durationMs,
        timedOut: response.timedOut,
        truncated: response.truncated,
        stdout: response.stdout,
        stderr: response.stderr,
      };
      setEntries((prev) => [entry, ...prev].slice(0, 50));
      appendTimeline(`tty.exec: ${command} (exit=${entry.exitCode})`);
    } catch (execError) {
      setError(execError instanceof Error ? execError.message : String(execError));
    } finally {
      setBusy(false);
    }
  }, [appendTimeline, commandDraft, cwdDraft, fetchJson, ready, sessionId, timeoutMs]);

  const clear = useCallback(() => {
    setEntries([]);
    setError("");
  }, []);

  return {
    sessionId,
    ready,
    busy,
    error,
    commandDraft,
    setCommandDraft,
    cwdDraft,
    setCwdDraft,
    timeoutMs,
    setTimeoutMs,
    entries,
    execute,
    clear,
  };
}
