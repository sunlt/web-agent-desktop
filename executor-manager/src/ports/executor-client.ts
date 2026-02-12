import type { RestorePlan } from "../domain/runtime-manifest.js";
import type { ExecutionTraceMeta } from "./workspace-sync-client.js";

export interface ExecutorWorkspaceValidationResult {
  readonly ok: boolean;
  readonly missingRequiredPaths: readonly string[];
}

export interface ExecutorWorkspaceFileTreeEntry {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  readonly size: number;
}

export interface ExecutorWorkspaceFileTreeResult {
  readonly path: string;
  readonly entries: readonly ExecutorWorkspaceFileTreeEntry[];
}

export interface ExecutorWorkspaceFileReadResult {
  readonly path: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
  readonly offset: number;
  readonly limit: number;
  readonly readBytes: number;
  readonly nextOffset: number | null;
  readonly truncated: boolean;
  readonly encoding: "utf8" | "base64";
  readonly content: string;
}

export interface ExecutorWorkspaceFileDownloadResult {
  readonly path: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly content: Buffer;
}

export interface ExecutorWorkspaceTerminalResult {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export interface ExecutorClient {
  restoreWorkspace(input: {
    sessionId: string;
    containerId: string;
    plan: RestorePlan;
    trace?: ExecutionTraceMeta;
  }): Promise<void>;

  linkAgentData(input: {
    sessionId: string;
    containerId: string;
    trace?: ExecutionTraceMeta;
  }): Promise<void>;

  validateWorkspace(input: {
    sessionId: string;
    containerId: string;
    requiredPaths: readonly string[];
    trace?: ExecutionTraceMeta;
  }): Promise<ExecutorWorkspaceValidationResult>;

  listWorkspaceTree(input: {
    sessionId: string;
    containerId: string;
    path: string;
    trace?: ExecutionTraceMeta;
  }): Promise<ExecutorWorkspaceFileTreeResult>;

  readWorkspaceFile(input: {
    sessionId: string;
    containerId: string;
    path: string;
    offset?: number;
    limit?: number;
    trace?: ExecutionTraceMeta;
  }): Promise<ExecutorWorkspaceFileReadResult>;

  writeWorkspaceFile(input: {
    sessionId: string;
    containerId: string;
    path: string;
    content: string;
    encoding?: "utf8" | "base64";
    trace?: ExecutionTraceMeta;
  }): Promise<{ path: string; size: number }>;

  uploadWorkspaceFile(input: {
    sessionId: string;
    containerId: string;
    path: string;
    contentBase64: string;
    trace?: ExecutionTraceMeta;
  }): Promise<{ path: string; size: number }>;

  renameWorkspacePath(input: {
    sessionId: string;
    containerId: string;
    path: string;
    newPath: string;
    trace?: ExecutionTraceMeta;
  }): Promise<{ path: string; newPath: string }>;

  deleteWorkspacePath(input: {
    sessionId: string;
    containerId: string;
    path: string;
    trace?: ExecutionTraceMeta;
  }): Promise<{ path: string; deleted: true }>;

  mkdirWorkspacePath(input: {
    sessionId: string;
    containerId: string;
    path: string;
    trace?: ExecutionTraceMeta;
  }): Promise<{ path: string }>;

  downloadWorkspaceFile(input: {
    sessionId: string;
    containerId: string;
    path: string;
    trace?: ExecutionTraceMeta;
  }): Promise<ExecutorWorkspaceFileDownloadResult>;

  executeWorkspaceCommand(input: {
    sessionId: string;
    containerId: string;
    command: string;
    cwd?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    trace?: ExecutionTraceMeta;
  }): Promise<ExecutorWorkspaceTerminalResult>;
}
