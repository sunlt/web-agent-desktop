import { type ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  formatBytes,
  joinUiPath,
  normalizeUiPath,
  parentUiPath,
  resolveFilePreviewMode,
  type FilePreviewMode,
  uint8ArrayToBase64,
} from "./utils";

const FILE_READ_LIMIT = 256 * 1024;

export interface FileTreeEntry {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  readonly size: number;
}

export interface FileTreeResult {
  readonly path: string;
  readonly entries: FileTreeEntry[];
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

export type FileWorkspaceScope =
  | {
      readonly kind: "global";
      readonly userId: string;
    }
  | {
      readonly kind: "executor-workspace";
      readonly sessionId: string;
    };

type FileListStatus = "idle" | "loading" | "error";

export interface FileWorkspaceController {
  readonly fileTreePath: string;
  readonly setFileTreePath: (value: string) => void;
  readonly fileEntries: FileTreeEntry[];
  readonly fileListStatus: FileListStatus;
  readonly fileError: string;
  readonly fileBusy: boolean;
  readonly activeFilePath: string | null;
  readonly activeFilePreview: FileReadResult | null;
  readonly filePreviewMode: FilePreviewMode;
  readonly fileDraft: string;
  readonly setFileDraft: (value: string) => void;
  readonly activeFileDownloadUrl: string | null;
  readonly activeFileInlineUrl: string | null;
  readonly ready: boolean;
  readonly loadFileTree: (path?: string) => Promise<void>;
  readonly openFile: (path: string, offset?: number) => Promise<void>;
  readonly handleLoadMoreFile: () => Promise<void>;
  readonly saveActiveFile: () => Promise<void>;
  readonly createDirectory: () => Promise<void>;
  readonly createTextFile: () => Promise<void>;
  readonly renamePath: (path: string) => Promise<void>;
  readonly deletePath: (path: string) => Promise<void>;
  readonly uploadFile: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  readonly downloadPath: (path: string) => void;
  readonly formatFileSize: (size: number) => string;
  readonly parentPath: string;
}

interface FileApiAdapter {
  readonly ready: boolean;
  readonly missingHint: string;
  readonly tree: (path: string) => string;
  readonly read: (path: string, offset?: number, limit?: number) => string;
  readonly writeUrl: string;
  readonly writeBody: (input: {
    path: string;
    content: string;
    encoding: "utf8" | "base64";
  }) => Record<string, unknown>;
  readonly uploadUrl: string;
  readonly uploadBody: (input: {
    path: string;
    contentBase64: string;
  }) => Record<string, unknown>;
  readonly renameUrl: string;
  readonly renameBody: (input: {
    path: string;
    newPath: string;
  }) => Record<string, unknown>;
  readonly remove: (path: string) => string;
  readonly mkdirUrl: string;
  readonly mkdirBody: (input: { path: string }) => Record<string, unknown>;
  readonly downloadUrl: (path: string, inline: boolean) => string;
}

export function useFileWorkspace(input: {
  readonly apiBase: string;
  readonly scope: FileWorkspaceScope;
  readonly fetchJson: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly appendTimeline: (label: string, ts?: string) => void;
  readonly initialPath?: string;
}): FileWorkspaceController {
  const { apiBase, scope, fetchJson, appendTimeline, initialPath } = input;

  const adapter = useMemo(
    () => createFileApiAdapter(apiBase, scope),
    [apiBase, scope],
  );

  const [fileTreePath, setFileTreePath] = useState<string>(() => {
    if (initialPath) {
      return normalizeUiPath(initialPath);
    }
    return scope.kind === "global" ? "/workspace/public" : "/workspace";
  });
  const [fileEntries, setFileEntries] = useState<FileTreeEntry[]>([]);
  const [fileListStatus, setFileListStatus] = useState<FileListStatus>("idle");
  const [fileError, setFileError] = useState<string>("");
  const [fileBusy, setFileBusy] = useState<boolean>(false);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [activeFilePreview, setActiveFilePreview] = useState<FileReadResult | null>(null);
  const [filePreviewMode, setFilePreviewMode] = useState<FilePreviewMode>("none");
  const [fileDraft, setFileDraft] = useState<string>("");

  const scopeKey = useMemo(() => {
    if (scope.kind === "global") {
      return `global:${scope.userId.trim()}`;
    }
    return `workspace:${scope.sessionId.trim()}`;
  }, [scope]);

  useEffect(() => {
    setFileEntries([]);
    setFileListStatus("idle");
    setFileError("");
    setFileBusy(false);
    setActiveFilePath(null);
    setActiveFilePreview(null);
    setFilePreviewMode("none");
    setFileDraft("");
  }, [scopeKey]);

  const activeFileDownloadUrl = useMemo(() => {
    if (!activeFilePath || !adapter.ready) {
      return null;
    }
    return adapter.downloadUrl(activeFilePath, false);
  }, [activeFilePath, adapter]);

  const activeFileInlineUrl = useMemo(() => {
    if (!activeFilePath || !adapter.ready) {
      return null;
    }
    return adapter.downloadUrl(activeFilePath, true);
  }, [activeFilePath, adapter]);

  const loadFileTree = useCallback(
    async (path?: string) => {
      if (!adapter.ready) {
        setFileListStatus("error");
        setFileError(adapter.missingHint);
        return;
      }
      const targetPath = normalizeUiPath(path ?? fileTreePath);
      setFileListStatus("loading");
      setFileError("");
      try {
        const tree = await fetchJson<FileTreeResult>(adapter.tree(targetPath));
        setFileTreePath(tree.path);
        setFileEntries(tree.entries ?? []);
        setFileListStatus("idle");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFileListStatus("error");
        setFileError(message);
      }
    },
    [adapter, fetchJson, fileTreePath],
  );

  const openFile = useCallback(
    async (path: string, offset?: number) => {
      if (!adapter.ready) {
        setFileError(adapter.missingHint);
        return;
      }

      const normalizedPath = normalizeUiPath(path);
      setFileBusy(true);
      setFileError("");
      try {
        const read = await fetchJson<FileReadResult>(
          adapter.read(normalizedPath, offset, FILE_READ_LIMIT),
        );
        const mode = resolveFilePreviewMode(read.path, read.contentType, read.encoding);

        setActiveFilePath(read.path);
        setFilePreviewMode(mode);

        if (offset && activeFilePreview) {
          const mergedContent = `${activeFilePreview.content}${read.content}`;
          const merged: FileReadResult = {
            ...read,
            offset: 0,
            readBytes: activeFilePreview.readBytes + read.readBytes,
            content: mergedContent,
          };
          setActiveFilePreview(merged);
          if (mode === "text") {
            setFileDraft(mergedContent);
          }
        } else {
          setActiveFilePreview(read);
          if (mode === "text") {
            setFileDraft(read.content);
          } else {
            setFileDraft("");
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFileError(message);
      } finally {
        setFileBusy(false);
      }
    },
    [activeFilePreview, adapter, fetchJson],
  );

  const handleLoadMoreFile = useCallback(async () => {
    if (
      !activeFilePreview ||
      activeFilePreview.encoding !== "utf8" ||
      activeFilePreview.nextOffset === null
    ) {
      return;
    }
    await openFile(activeFilePreview.path, activeFilePreview.nextOffset);
  }, [activeFilePreview, openFile]);

  const saveActiveFile = useCallback(async () => {
    if (!activeFilePath || filePreviewMode !== "text") {
      return;
    }
    if (!adapter.ready) {
      setFileError(adapter.missingHint);
      return;
    }

    setFileBusy(true);
    setFileError("");
    try {
      await fetchJson<{ ok: boolean }>(adapter.writeUrl, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(
          adapter.writeBody({
            path: activeFilePath,
            content: fileDraft,
            encoding: "utf8",
          }),
        ),
      });
      appendTimeline(`file.write: ${activeFilePath}`);
      await Promise.all([openFile(activeFilePath), loadFileTree(fileTreePath)]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFileError(message);
    } finally {
      setFileBusy(false);
    }
  }, [
    activeFilePath,
    adapter,
    appendTimeline,
    fetchJson,
    fileDraft,
    filePreviewMode,
    fileTreePath,
    loadFileTree,
    openFile,
  ]);

  const createDirectory = useCallback(async () => {
    const nextPath = window.prompt("新目录路径", joinUiPath(fileTreePath, "new-folder"));
    if (!nextPath) {
      return;
    }
    if (!adapter.ready) {
      setFileError(adapter.missingHint);
      return;
    }

    setFileBusy(true);
    setFileError("");
    try {
      await fetchJson<{ ok: boolean; path: string }>(adapter.mkdirUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(
          adapter.mkdirBody({
            path: nextPath,
          }),
        ),
      });
      appendTimeline(`file.mkdir: ${nextPath}`);
      await loadFileTree(fileTreePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFileError(message);
    } finally {
      setFileBusy(false);
    }
  }, [adapter, appendTimeline, fetchJson, fileTreePath, loadFileTree]);

  const createTextFile = useCallback(async () => {
    const nextPath = window.prompt("新文件路径", joinUiPath(fileTreePath, "untitled.txt"));
    if (!nextPath) {
      return;
    }
    if (!adapter.ready) {
      setFileError(adapter.missingHint);
      return;
    }

    setFileBusy(true);
    setFileError("");
    try {
      await fetchJson<{ ok: boolean; path: string }>(adapter.writeUrl, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(
          adapter.writeBody({
            path: nextPath,
            content: "",
            encoding: "utf8",
          }),
        ),
      });
      appendTimeline(`file.create: ${nextPath}`);
      await loadFileTree(fileTreePath);
      await openFile(nextPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFileError(message);
    } finally {
      setFileBusy(false);
    }
  }, [adapter, appendTimeline, fetchJson, fileTreePath, loadFileTree, openFile]);

  const renamePath = useCallback(
    async (path: string) => {
      const nextPath = window.prompt("重命名为", path);
      if (!nextPath || nextPath === path) {
        return;
      }
      if (!adapter.ready) {
        setFileError(adapter.missingHint);
        return;
      }

      setFileBusy(true);
      setFileError("");
      try {
        await fetchJson<{ ok: boolean; path: string; newPath: string }>(
          adapter.renameUrl,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify(
              adapter.renameBody({
                path,
                newPath: nextPath,
              }),
            ),
          },
        );
        appendTimeline(`file.rename: ${path} -> ${nextPath}`);
        if (activeFilePath === path) {
          await openFile(nextPath);
        }
        await loadFileTree(fileTreePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFileError(message);
      } finally {
        setFileBusy(false);
      }
    },
    [activeFilePath, adapter, appendTimeline, fetchJson, fileTreePath, loadFileTree, openFile],
  );

  const deletePath = useCallback(
    async (path: string) => {
      if (!window.confirm(`确认删除 ${path} 吗？`)) {
        return;
      }
      if (!adapter.ready) {
        setFileError(adapter.missingHint);
        return;
      }

      setFileBusy(true);
      setFileError("");
      try {
        await fetchJson<{ ok: boolean; path: string }>(adapter.remove(path), {
          method: "DELETE",
        });
        appendTimeline(`file.delete: ${path}`);
        if (activeFilePath === path) {
          setActiveFilePath(null);
          setActiveFilePreview(null);
          setFilePreviewMode("none");
          setFileDraft("");
        }
        await loadFileTree(fileTreePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFileError(message);
      } finally {
        setFileBusy(false);
      }
    },
    [activeFilePath, adapter, appendTimeline, fetchJson, fileTreePath, loadFileTree],
  );

  const uploadFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) {
        return;
      }
      if (!adapter.ready) {
        setFileError(adapter.missingHint);
        return;
      }

      const targetPath = window.prompt("上传目标路径", joinUiPath(fileTreePath, file.name));
      if (!targetPath) {
        return;
      }

      setFileBusy(true);
      setFileError("");
      try {
        const fileBuffer = new Uint8Array(await file.arrayBuffer());
        await fetchJson<{ ok: boolean; path: string }>(adapter.uploadUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(
            adapter.uploadBody({
              path: targetPath,
              contentBase64: uint8ArrayToBase64(fileBuffer),
            }),
          ),
        });
        appendTimeline(`file.upload: ${targetPath}`);
        await loadFileTree(fileTreePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFileError(message);
      } finally {
        setFileBusy(false);
      }
    },
    [adapter, appendTimeline, fetchJson, fileTreePath, loadFileTree],
  );

  const downloadPath = useCallback(
    (path: string) => {
      if (!adapter.ready) {
        setFileError(adapter.missingHint);
        return;
      }
      const url = adapter.downloadUrl(path, false);
      const popup = window.open(url, "_blank", "noopener");
      if (!popup) {
        window.location.href = url;
      }
    },
    [adapter],
  );

  return {
    fileTreePath,
    setFileTreePath,
    fileEntries,
    fileListStatus,
    fileError,
    fileBusy,
    activeFilePath,
    activeFilePreview,
    filePreviewMode,
    fileDraft,
    setFileDraft,
    activeFileDownloadUrl,
    activeFileInlineUrl,
    ready: adapter.ready,
    loadFileTree,
    openFile,
    handleLoadMoreFile,
    saveActiveFile,
    createDirectory,
    createTextFile,
    renamePath,
    deletePath,
    uploadFile,
    downloadPath,
    formatFileSize: formatBytes,
    parentPath: parentUiPath(fileTreePath),
  };
}

function createFileApiAdapter(apiBase: string, scope: FileWorkspaceScope): FileApiAdapter {
  if (scope.kind === "global") {
    const userId = scope.userId.trim();
    const ready = userId.length > 0;

    return {
      ready,
      missingHint: "请先输入 userId",
      tree: (path) =>
        `/files/tree?userId=${encodeURIComponent(userId)}&path=${encodeURIComponent(path)}`,
      read: (path, offset, limit) =>
        `/files/file?userId=${encodeURIComponent(userId)}&path=${encodeURIComponent(path)}${typeof limit === "number" ? `&limit=${limit}` : ""}${typeof offset === "number" ? `&offset=${offset}` : ""}`,
      writeUrl: "/files/file",
      writeBody: (input) => ({
        userId,
        path: input.path,
        content: input.content,
        encoding: input.encoding,
      }),
      uploadUrl: "/files/upload",
      uploadBody: (input) => ({
        userId,
        path: input.path,
        contentBase64: input.contentBase64,
      }),
      renameUrl: "/files/rename",
      renameBody: (input) => ({
        userId,
        path: input.path,
        newPath: input.newPath,
      }),
      remove: (path) =>
        `/files/file?userId=${encodeURIComponent(userId)}&path=${encodeURIComponent(path)}`,
      mkdirUrl: "/files/mkdir",
      mkdirBody: (input) => ({
        userId,
        path: input.path,
      }),
      downloadUrl: (path, inline) =>
        `${apiBase}/files/download?userId=${encodeURIComponent(userId)}&path=${encodeURIComponent(path)}${inline ? "&inline=1" : ""}`,
    };
  }

  const sessionId = scope.sessionId.trim();
  const ready = sessionId.length > 0;
  const base = `/session-workers/${encodeURIComponent(sessionId)}/workspace`;

  return {
    ready,
    missingHint: "请先输入 sessionId",
    tree: (path) => `${base}/tree?path=${encodeURIComponent(path)}`,
    read: (path, offset, limit) =>
      `${base}/file?path=${encodeURIComponent(path)}${typeof limit === "number" ? `&limit=${limit}` : ""}${typeof offset === "number" ? `&offset=${offset}` : ""}`,
    writeUrl: `${base}/file`,
    writeBody: (input) => ({
      path: input.path,
      content: input.content,
      encoding: input.encoding,
    }),
    uploadUrl: `${base}/upload`,
    uploadBody: (input) => ({
      path: input.path,
      contentBase64: input.contentBase64,
    }),
    renameUrl: `${base}/rename`,
    renameBody: (input) => ({
      path: input.path,
      newPath: input.newPath,
    }),
    remove: (path) => `${base}/file?path=${encodeURIComponent(path)}`,
    mkdirUrl: `${base}/mkdir`,
    mkdirBody: (input) => ({
      path: input.path,
    }),
    downloadUrl: (path, inline) =>
      `${apiBase}${base}/download?path=${encodeURIComponent(path)}${inline ? "&inline=1" : ""}`,
  };
}
