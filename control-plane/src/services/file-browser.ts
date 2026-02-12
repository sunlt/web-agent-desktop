import {
  mkdir,
  open,
  readdir,
  rename as renameFile,
  rm,
  stat,
  writeFile as writeFileToDisk,
  readFile as readFileFromDisk,
} from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

const DEFAULT_READ_LIMIT = 64 * 1024;

export type FileBrowserErrorCode =
  | "invalid_path"
  | "not_found"
  | "is_directory"
  | "not_directory"
  | "already_exists"
  | "io_error";

export class FileBrowserError extends Error {
  readonly code: FileBrowserErrorCode;

  constructor(code: FileBrowserErrorCode, message: string) {
    super(message);
    this.name = "FileBrowserError";
    this.code = code;
  }
}

export interface FileTreeEntry {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  readonly size: number;
}

export interface FileTreeResult {
  readonly path: string;
  readonly entries: readonly FileTreeEntry[];
}

export interface FileDownloadResult {
  readonly path: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly content: Buffer;
}

export interface FileReadResult {
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

export interface FileWriteResult {
  readonly path: string;
  readonly size: number;
}

export interface FileRenameResult {
  readonly path: string;
  readonly newPath: string;
}

export interface FileDeleteResult {
  readonly path: string;
  readonly deleted: true;
}

export interface FileMkdirResult {
  readonly path: string;
}

export interface FileBrowser {
  listTree(path: string): Promise<FileTreeResult>;
  download(path: string): Promise<FileDownloadResult>;
  readFile(
    path: string,
    input?: {
      offset?: number;
      limit?: number;
    },
  ): Promise<FileReadResult>;
  writeFile(
    path: string,
    input: {
      content: string;
      encoding?: "utf8" | "base64";
    },
  ): Promise<FileWriteResult>;
  rename(path: string, newPath: string): Promise<FileRenameResult>;
  deletePath(path: string): Promise<FileDeleteResult>;
  mkdir(path: string): Promise<FileMkdirResult>;
}

export class LocalFileBrowser implements FileBrowser {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async listTree(path: string): Promise<FileTreeResult> {
    const normalized = normalizePath(path);
    const target = this.resolveWithinRoot(normalized);

    try {
      const dir = await readdir(target, { withFileTypes: true });
      const entries = await Promise.all(
        dir
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(async (item) => {
            const itemLogicalPath = joinPath(normalized, item.name);
            const itemRealPath = this.resolveWithinRoot(itemLogicalPath);
            const fileStat = await stat(itemRealPath);
            return {
              name: item.name,
              path: itemLogicalPath,
              isDirectory: item.isDirectory(),
              size: fileStat.size,
            } satisfies FileTreeEntry;
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

  async download(path: string): Promise<FileDownloadResult> {
    const normalized = normalizePath(path);
    const target = this.resolveWithinRoot(normalized);

    try {
      const fileStat = await stat(target);
      if (fileStat.isDirectory()) {
        throw new FileBrowserError("is_directory", "cannot download directory");
      }

      const content = await readFileFromDisk(target);
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

  async readFile(
    path: string,
    input?: {
      offset?: number;
      limit?: number;
    },
  ): Promise<FileReadResult> {
    const normalized = normalizePath(path);
    const target = this.resolveWithinRoot(normalized);
    const offset = clampOffset(input?.offset);
    const limit = clampLimit(input?.limit);

    try {
      const fileStat = await stat(target);
      if (fileStat.isDirectory()) {
        throw new FileBrowserError("is_directory", "cannot read directory");
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

  async writeFile(
    path: string,
    input: {
      content: string;
      encoding?: "utf8" | "base64";
    },
  ): Promise<FileWriteResult> {
    const normalized = normalizePath(path);
    assertNonRootPath(normalized);
    const target = this.resolveWithinRoot(normalized);
    const encoding = input.encoding ?? "utf8";
    const contentBuffer = decodeContent(input.content, encoding);

    try {
      await this.ensureWritableFilePath(target);
      await mkdir(dirname(target), { recursive: true });
      await writeFileToDisk(target, contentBuffer);
      const nextStat = await stat(target);
      return {
        path: normalized,
        size: nextStat.size,
      };
    } catch (error) {
      throw mapFsError(error, "写入文件失败");
    }
  }

  async rename(path: string, newPath: string): Promise<FileRenameResult> {
    const normalized = normalizePath(path);
    const normalizedTarget = normalizePath(newPath);
    assertNonRootPath(normalized);
    assertNonRootPath(normalizedTarget);
    const source = this.resolveWithinRoot(normalized);
    const target = this.resolveWithinRoot(normalizedTarget);

    try {
      if (source === target) {
        return {
          path: normalized,
          newPath: normalizedTarget,
        };
      }

      const sourceStat = await stat(source);
      if (!sourceStat) {
        throw new FileBrowserError("not_found", "source path not found");
      }

      await mkdir(dirname(target), { recursive: true });
      const targetExists = await exists(target);
      if (targetExists) {
        throw new FileBrowserError("already_exists", "target path already exists");
      }

      await renameFile(source, target);
      return {
        path: normalized,
        newPath: normalizedTarget,
      };
    } catch (error) {
      throw mapFsError(error, "重命名失败");
    }
  }

  async deletePath(path: string): Promise<FileDeleteResult> {
    const normalized = normalizePath(path);
    assertNonRootPath(normalized);
    const target = this.resolveWithinRoot(normalized);

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

  async mkdir(path: string): Promise<FileMkdirResult> {
    const normalized = normalizePath(path);
    const target = this.resolveWithinRoot(normalized);

    try {
      const existingStat = await stat(target).catch((error: unknown) => {
        const mapped = mapFsError(error, "创建目录失败");
        if (mapped.code === "not_found") {
          return null;
        }
        throw mapped;
      });

      if (existingStat && !existingStat.isDirectory()) {
        throw new FileBrowserError("not_directory", "path exists and is not directory");
      }

      await mkdir(target, { recursive: true });
      return {
        path: normalized,
      };
    } catch (error) {
      throw mapFsError(error, "创建目录失败");
    }
  }

  private async ensureWritableFilePath(path: string): Promise<void> {
    const existing = await stat(path).catch((error: unknown) => {
      const mapped = mapFsError(error, "写入文件失败");
      if (mapped.code === "not_found") {
        return null;
      }
      throw mapped;
    });

    if (existing && existing.isDirectory()) {
      throw new FileBrowserError("is_directory", "target path is a directory");
    }
  }

  private resolveWithinRoot(logicalPath: string): string {
    const relative = logicalPath.replace(/^\/+/, "");
    const target = resolve(this.root, relative);
    if (target !== this.root && !target.startsWith(`${this.root}/`)) {
      throw new FileBrowserError("invalid_path", "path escapes root");
    }
    return target;
  }
}

export class LocalReadonlyFileBrowser extends LocalFileBrowser {}

function normalizePath(path: string): string {
  if (!path || path.trim() === "") {
    return "/";
  }
  return path.startsWith("/") ? path : `/${path}`;
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

function joinPath(base: string, child: string): string {
  if (base === "/") {
    return `/${child}`;
  }
  return `${base}/${child}`;
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
    throw new FileBrowserError("invalid_path", "base64 content is invalid");
  }
}

function assertNonRootPath(path: string): void {
  if (path === "/") {
    throw new FileBrowserError("invalid_path", "root path is not allowed");
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

function mapFsError(error: unknown, fallback: string): FileBrowserError {
  if (error instanceof FileBrowserError) {
    return error;
  }

  const withCode = error as { code?: string; message?: string };
  switch (withCode?.code) {
    case "ENOENT":
      return new FileBrowserError("not_found", withCode.message ?? "path not found");
    case "EISDIR":
      return new FileBrowserError("is_directory", withCode.message ?? "path is directory");
    case "ENOTDIR":
      return new FileBrowserError("not_directory", withCode.message ?? "path is not directory");
    case "EEXIST":
      return new FileBrowserError("already_exists", withCode.message ?? "path already exists");
    default:
      return new FileBrowserError("io_error", withCode?.message ?? fallback);
  }
}
