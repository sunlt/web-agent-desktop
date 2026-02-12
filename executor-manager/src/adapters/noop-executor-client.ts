import type {
  ExecutorClient,
  ExecutorWorkspaceFileDownloadResult,
  ExecutorWorkspaceFileReadResult,
  ExecutorWorkspaceFileTreeResult,
  ExecutorWorkspaceTerminalResult,
  ExecutorWorkspaceValidationResult,
} from "../ports/executor-client.js";

export class NoopExecutorClient implements ExecutorClient {
  async restoreWorkspace(_: {
    sessionId: string;
    containerId: string;
    plan: unknown;
  }): Promise<void> {
    return;
  }

  async linkAgentData(_: {
    sessionId: string;
    containerId: string;
  }): Promise<void> {
    return;
  }

  async validateWorkspace(_: {
    sessionId: string;
    containerId: string;
    requiredPaths: readonly string[];
  }): Promise<ExecutorWorkspaceValidationResult> {
    return {
      ok: true,
      missingRequiredPaths: [],
    };
  }

  async listWorkspaceTree(input: {
    sessionId: string;
    containerId: string;
    path: string;
  }): Promise<ExecutorWorkspaceFileTreeResult> {
    return {
      path: input.path,
      entries: [],
    };
  }

  async readWorkspaceFile(input: {
    sessionId: string;
    containerId: string;
    path: string;
  }): Promise<ExecutorWorkspaceFileReadResult> {
    return {
      path: input.path,
      fileName: input.path.split("/").at(-1) ?? "file",
      contentType: "text/plain; charset=utf-8",
      size: 0,
      offset: 0,
      limit: 0,
      readBytes: 0,
      nextOffset: null,
      truncated: false,
      encoding: "utf8",
      content: "",
    };
  }

  async writeWorkspaceFile(input: {
    sessionId: string;
    containerId: string;
    path: string;
    content: string;
  }): Promise<{ path: string; size: number }> {
    return {
      path: input.path,
      size: Buffer.byteLength(input.content, "utf8"),
    };
  }

  async uploadWorkspaceFile(input: {
    sessionId: string;
    containerId: string;
    path: string;
    contentBase64: string;
  }): Promise<{ path: string; size: number }> {
    return {
      path: input.path,
      size: Buffer.from(input.contentBase64, "base64").byteLength,
    };
  }

  async renameWorkspacePath(input: {
    sessionId: string;
    containerId: string;
    path: string;
    newPath: string;
  }): Promise<{ path: string; newPath: string }> {
    return {
      path: input.path,
      newPath: input.newPath,
    };
  }

  async deleteWorkspacePath(input: {
    sessionId: string;
    containerId: string;
    path: string;
  }): Promise<{ path: string; deleted: true }> {
    return {
      path: input.path,
      deleted: true,
    };
  }

  async mkdirWorkspacePath(input: {
    sessionId: string;
    containerId: string;
    path: string;
  }): Promise<{ path: string }> {
    return {
      path: input.path,
    };
  }

  async downloadWorkspaceFile(input: {
    sessionId: string;
    containerId: string;
    path: string;
  }): Promise<ExecutorWorkspaceFileDownloadResult> {
    return {
      path: input.path,
      fileName: input.path.split("/").at(-1) ?? "file",
      contentType: "application/octet-stream",
      content: Buffer.alloc(0),
    };
  }

  async executeWorkspaceCommand(input: {
    sessionId: string;
    containerId: string;
    command: string;
  }): Promise<ExecutorWorkspaceTerminalResult> {
    return {
      command: input.command,
      cwd: "/workspace",
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 0,
      timedOut: false,
      truncated: false,
    };
  }
}
