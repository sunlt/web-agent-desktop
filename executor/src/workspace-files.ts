import {
  mkdir,
  open,
  readdir,
  rename as renamePath,
  rm,
  stat,
  writeFile,
  readFile,
} from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

const DEFAULT_READ_LIMIT = 64 * 1024;

export type WorkspaceFileErrorCode =
  | "invalid_path"
  | "not_found"
  | "is_directory"
  | "not_directory"
  | "already_exists"
  | "io_error";

export class WorkspaceFileError extends Error {
  readonly code: WorkspaceFileErrorCode;

  constructor(code: WorkspaceFileErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceFileError";
    this.code = code;
  }
}

export interface WorkspaceFileTreeEntry {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  readonly size: number;
}

export interface WorkspaceFileTreeResult {
  readonly path: string;
  readonly entries: readonly WorkspaceFileTreeEntry[];
}

export interface WorkspaceFileDownloadResult {
  readonly path: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly content: Buffer;
}

export interface WorkspaceFileReadResult {
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

export class WorkspaceFileBrowser {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async listTree(path: string): Promise<WorkspaceFileTreeResult> {
    const normalized = normalizeWorkspacePath(path);
    const target = resolveWorkspacePath(this.root, normalized);

    try {
      const dirents = await readdir(target, { withFileTypes: true });
      const entries = await Promise.all(
        dirents
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(async (item) => {
            const logicalPath = joinWorkspacePath(normalized, item.name);
            const fullPath = resolveWorkspacePath(this.root, logicalPath);
            const fileStat = await stat(fullPath);
            return {
              name: item.name,
              path: logicalPath,
              isDirectory: item.isDirectory(),
              size: fileStat.size,
            } satisfies WorkspaceFileTreeEntry;
          }),
      );

      return {
        path: normalized,
        entries,
      };
    } catch (error) {
      throw mapFsError(error, "读取目录失败");
    }
  }

  async readFile(
    path: string,
    input?: {
      offset?: number;
      limit?: number;
    },
  ): Promise<WorkspaceFileReadResult> {
    const normalized = normalizeWorkspacePath(path);
    const target = resolveWorkspacePath(this.root, normalized);
    const offset = clampOffset(input?.offset);
    const limit = clampLimit(input?.limit);

    try {
      const fileStat = await stat(target);
      if (fileStat.isDirectory()) {
        throw new WorkspaceFileError("is_directory", "cannot read directory");
      }

      if (offset >= fileStat.size) {
        return {
          path: normalized,
          fileName: basename(target),
          contentType: detectContentType(target),
          size: fileStat.size,
          offset,
          limit,
          readBytes: 0,
          nextOffset: null,
          truncated: false,
          encoding: "utf8",
          content: "",
        };
      }

      const maxBytes = Math.min(limit, fileStat.size - offset);
      const handle = await open(target, "r");
      try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, offset);
        const resultBuffer = buffer.subarray(0, bytesRead);
        const nextOffset = offset + bytesRead < fileStat.size ? offset + bytesRead : null;
        const contentType = detectContentType(target);
        const isText = isTextContentType(contentType);
        return {
          path: normalized,
          fileName: basename(target),
          contentType,
          size: fileStat.size,
          offset,
          limit,
          readBytes: bytesRead,
          nextOffset,
          truncated: nextOffset !== null,
          encoding: isText ? "utf8" : "base64",
          content: isText
            ? resultBuffer.toString("utf8")
            : resultBuffer.toString("base64"),
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      throw mapFsError(error, "读取文件失败");
    }
  }

  async download(path: string): Promise<WorkspaceFileDownloadResult> {
    const normalized = normalizeWorkspacePath(path);
    const target = resolveWorkspacePath(this.root, normalized);

    try {
      const fileStat = await stat(target);
      if (fileStat.isDirectory()) {
        throw new WorkspaceFileError("is_directory", "cannot download directory");
      }
      const content = await readFile(target);
      return {
        path: normalized,
        fileName: basename(target),
        contentType: detectContentType(target),
        content,
      };
    } catch (error) {
      throw mapFsError(error, "下载文件失败");
    }
  }

  async writeFile(input: {
    path: string;
    content: string;
    encoding?: "utf8" | "base64";
  }): Promise<{ path: string; size: number }> {
    const normalized = normalizeWorkspacePath(input.path);
    assertNonRootPath(normalized);
    const target = resolveWorkspacePath(this.root, normalized);
    const encoding = input.encoding ?? "utf8";
    const contentBuffer = decodeContent(input.content, encoding);

    try {
      await ensureWritableFilePath(target);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contentBuffer);
      const nextStat = await stat(target);
      return {
        path: normalized,
        size: nextStat.size,
      };
    } catch (error) {
      throw mapFsError(error, "写入文件失败");
    }
  }

  async rename(path: string, newPath: string): Promise<{ path: string; newPath: string }> {
    const normalized = normalizeWorkspacePath(path);
    const normalizedTarget = normalizeWorkspacePath(newPath);
    assertNonRootPath(normalized);
    assertNonRootPath(normalizedTarget);

    const source = resolveWorkspacePath(this.root, normalized);
    const target = resolveWorkspacePath(this.root, normalizedTarget);

    try {
      if (source === target) {
        return {
          path: normalized,
          newPath: normalizedTarget,
        };
      }

      const sourceStat = await stat(source);
      if (!sourceStat) {
        throw new WorkspaceFileError("not_found", "source path not found");
      }

      await mkdir(dirname(target), { recursive: true });
      const targetExists = await exists(target);
      if (targetExists) {
        throw new WorkspaceFileError("already_exists", "target path already exists");
      }

      await renamePath(source, target);
      return {
        path: normalized,
        newPath: normalizedTarget,
      };
    } catch (error) {
      throw mapFsError(error, "重命名失败");
    }
  }

  async deletePath(path: string): Promise<{ path: string; deleted: true }> {
    const normalized = normalizeWorkspacePath(path);
    assertNonRootPath(normalized);
    const target = resolveWorkspacePath(this.root, normalized);

    try {
      const targetStat = await stat(target);
      if (targetStat.isDirectory()) {
        await rm(target, { recursive: true, force: false });
      } else {
        await rm(target, { force: false });
      }
      return {
        path: normalized,
        deleted: true,
      };
    } catch (error) {
      throw mapFsError(error, "删除失败");
    }
  }

  async mkdir(path: string): Promise<{ path: string }> {
    const normalized = normalizeWorkspacePath(path);
    const target = resolveWorkspacePath(this.root, normalized);

    try {
      const existingStat = await stat(target).catch((error: unknown) => {
        const mapped = mapFsError(error, "创建目录失败");
        if (mapped.code === "not_found") {
          return null;
        }
        throw mapped;
      });

      if (existingStat && !existingStat.isDirectory()) {
        throw new WorkspaceFileError("not_directory", "path exists and is not directory");
      }

      await mkdir(target, { recursive: true });
      return {
        path: normalized,
      };
    } catch (error) {
      throw mapFsError(error, "创建目录失败");
    }
  }
}

export function normalizeWorkspacePath(path: string): string {
  if (!path || path.trim().length === 0) {
    return "/workspace";
  }
  if (!path.startsWith("/")) {
    return `/workspace/${path.replace(/^\/+/, "")}`;
  }
  if (path === "/") {
    return "/workspace";
  }
  return path;
}

export function resolveWorkspacePath(root: string, workspacePath: string): string {
  const normalized = normalizeWorkspacePath(workspacePath);
  if (!normalized.startsWith("/workspace")) {
    throw new WorkspaceFileError("invalid_path", `invalid workspace path: ${workspacePath}`);
  }
  const relPath = normalized.slice("/workspace".length).replace(/^\/+/, "");
  const resolvedPath = resolve(root, relPath);
  const resolvedRoot = resolve(root);
  const expectedPrefix = `${resolvedRoot}${resolvedPath === resolvedRoot ? "" : "/"}`;
  if (!(resolvedPath === resolvedRoot || resolvedPath.startsWith(expectedPrefix))) {
    throw new WorkspaceFileError("invalid_path", `workspace path escapes root: ${workspacePath}`);
  }
  return resolvedPath;
}

function clampOffset(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function clampLimit(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_READ_LIMIT;
  }
  return Math.min(Math.floor(value), 1024 * 1024);
}

function joinWorkspacePath(base: string, child: string): string {
  if (base === "/workspace") {
    return `/workspace/${child}`;
  }
  return `${base}/${child}`;
}

function assertNonRootPath(path: string): void {
  if (path === "/workspace") {
    throw new WorkspaceFileError("invalid_path", "workspace root path is not allowed");
  }
}

async function ensureWritableFilePath(path: string): Promise<void> {
  const existing = await stat(path).catch((error: unknown) => {
    const mapped = mapFsError(error, "写入文件失败");
    if (mapped.code === "not_found") {
      return null;
    }
    throw mapped;
  });

  if (existing && existing.isDirectory()) {
    throw new WorkspaceFileError("is_directory", "target path is a directory");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const mapped = mapFsError(error, "检查路径失败");
    if (mapped.code === "not_found") {
      return false;
    }
    throw mapped;
  }
}

function detectContentType(path: string): string {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case ".txt":
    case ".md":
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".json":
    case ".yml":
    case ".yaml":
    case ".css":
    case ".html":
    case ".xml":
    case ".log":
      return "text/plain; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function isTextContentType(contentType: string): boolean {
  return contentType.startsWith("text/");
}

function decodeContent(raw: string, encoding: "utf8" | "base64"): Buffer {
  if (encoding === "utf8") {
    return Buffer.from(raw, "utf8");
  }
  try {
    return Buffer.from(raw, "base64");
  } catch {
    throw new WorkspaceFileError("invalid_path", "base64 content is invalid");
  }
}

export function mapFsError(error: unknown, fallback: string): WorkspaceFileError {
  if (error instanceof WorkspaceFileError) {
    return error;
  }

  const withCode = error as { code?: string; message?: string };
  switch (withCode?.code) {
    case "ENOENT":
      return new WorkspaceFileError("not_found", withCode.message ?? "path not found");
    case "EISDIR":
      return new WorkspaceFileError("is_directory", withCode.message ?? "path is directory");
    case "ENOTDIR":
      return new WorkspaceFileError("not_directory", withCode.message ?? "path is not directory");
    case "EEXIST":
      return new WorkspaceFileError("already_exists", withCode.message ?? "path already exists");
    default:
      return new WorkspaceFileError("io_error", withCode?.message ?? fallback);
  }
}
