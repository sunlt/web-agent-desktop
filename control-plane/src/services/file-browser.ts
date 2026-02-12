import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

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

export interface FileBrowser {
  listTree(path: string): Promise<FileTreeResult>;
  download(path: string): Promise<FileDownloadResult>;
}

export class LocalReadonlyFileBrowser implements FileBrowser {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async listTree(path: string): Promise<FileTreeResult> {
    const normalized = normalizePath(path);
    const target = this.resolveWithinRoot(normalized);
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
  }

  async download(path: string): Promise<FileDownloadResult> {
    const normalized = normalizePath(path);
    const target = this.resolveWithinRoot(normalized);
    const fileStat = await stat(target);
    if (fileStat.isDirectory()) {
      throw new Error("cannot download directory");
    }

    const content = await readFile(target);
    return {
      path: normalized,
      fileName: basename(target),
      contentType: detectContentType(target),
      content,
    };
  }

  private resolveWithinRoot(logicalPath: string): string {
    const relative = logicalPath.replace(/^\/+/, "");
    const target = resolve(this.root, relative);
    if (target !== this.root && !target.startsWith(`${this.root}/`)) {
      throw new Error("path escapes root");
    }
    return target;
  }
}

function normalizePath(path: string): string {
  if (!path || path.trim() === "") {
    return "/";
  }
  return path.startsWith("/") ? path : `/${path}`;
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
    case ".json":
      return "text/plain; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}
