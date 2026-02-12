import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolveWorkspacePath } from "./workspace-files.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;

export interface WorkspaceTerminalExecResult {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export async function execWorkspaceCommand(input: {
  root: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<WorkspaceTerminalExecResult> {
  const command = input.command.trim();
  if (!command) {
    throw new Error("command is required");
  }
  const rewrittenCommand = rewriteWorkspaceAbsolutePath(command, input.root);

  const cwdPath = resolveWorkspacePath(input.root, input.cwd ?? "/workspace");
  const cwdStat = await stat(cwdPath);
  if (!cwdStat.isDirectory()) {
    throw new Error(`cwd is not directory: ${input.cwd ?? "/workspace"}`);
  }

  const timeoutMs = clampPositiveInt(input.timeoutMs, DEFAULT_TIMEOUT_MS, 120_000);
  const maxOutputBytes = clampPositiveInt(
    input.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    2 * 1024 * 1024,
  );

  const startTs = Date.now();

  return await new Promise<WorkspaceTerminalExecResult>((resolvePromise, rejectPromise) => {
    const child = spawn("sh", ["-lc", rewrittenCommand], {
      cwd: cwdPath,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let truncated = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const accepted = takeBufferChunk(chunk, stdoutSize, maxOutputBytes);
      if (accepted.length < chunk.length) {
        truncated = true;
      }
      if (accepted.length > 0) {
        stdoutChunks.push(accepted);
        stdoutSize += accepted.length;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const accepted = takeBufferChunk(chunk, stderrSize, maxOutputBytes);
      if (accepted.length < chunk.length) {
        truncated = true;
      }
      if (accepted.length > 0) {
        stderrChunks.push(accepted);
        stderrSize += accepted.length;
      }
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - startTs;
      resolvePromise({
        command,
        cwd: workspaceLogicalPath(cwdPath, input.root),
        exitCode: code ?? (timedOut ? 124 : 1),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        durationMs,
        timedOut,
        truncated,
      });
    });
  });
}

function rewriteWorkspaceAbsolutePath(command: string, root: string): string {
  return command.replace(/\/workspace(?=\/|$)/g, root);
}

function takeBufferChunk(chunk: Buffer, currentSize: number, maxSize: number): Buffer {
  if (currentSize >= maxSize) {
    return Buffer.alloc(0);
  }
  if (currentSize + chunk.length <= maxSize) {
    return chunk;
  }
  const remaining = maxSize - currentSize;
  return chunk.subarray(0, remaining);
}

function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), max);
}

function workspaceLogicalPath(absPath: string, root: string): string {
  if (absPath === root) {
    return "/workspace";
  }
  const rel = absPath.slice(root.length).replace(/^\/+/, "");
  return rel ? `/workspace/${rel}` : "/workspace";
}
