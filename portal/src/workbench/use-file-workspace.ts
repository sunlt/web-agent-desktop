import { type ChangeEvent, useCallback, useMemo, useState } from "react";
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

export function useFileWorkspace(input: {
  readonly apiBase: string;
  readonly fileUserId: string;
  readonly fetchJson: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly appendTimeline: (label: string, ts?: string) => void;
}): FileWorkspaceController {
  const { apiBase, fileUserId, fetchJson, appendTimeline } = input;

  const [fileTreePath, setFileTreePath] = useState<string>("/workspace/public");
  const [fileEntries, setFileEntries] = useState<FileTreeEntry[]>([]);
  const [fileListStatus, setFileListStatus] = useState<FileListStatus>("idle");
  const [fileError, setFileError] = useState<string>("");
  const [fileBusy, setFileBusy] = useState<boolean>(false);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [activeFilePreview, setActiveFilePreview] = useState<FileReadResult | null>(null);
  const [filePreviewMode, setFilePreviewMode] = useState<FilePreviewMode>("none");
  const [fileDraft, setFileDraft] = useState<string>("");

  const activeFileDownloadUrl = useMemo(() => {
    if (!activeFilePath) {
      return null;
    }
    return `${apiBase}/files/download?userId=${encodeURIComponent(fileUserId)}&path=${encodeURIComponent(activeFilePath)}`;
  }, [activeFilePath, apiBase, fileUserId]);

  const activeFileInlineUrl = useMemo(() => {
    if (!activeFilePath) {
      return null;
    }
    return `${apiBase}/files/download?userId=${encodeURIComponent(fileUserId)}&path=${encodeURIComponent(activeFilePath)}&inline=1`;
  }, [activeFilePath, apiBase, fileUserId]);

  const loadFileTree = useCallback(
    async (path?: string) => {
      const targetPath = normalizeUiPath(path ?? fileTreePath);
      setFileListStatus("loading");
      setFileError("");
      try {
        const tree = await fetchJson<FileTreeResult>(
          `/files/tree?userId=${encodeURIComponent(fileUserId)}&path=${encodeURIComponent(targetPath)}`,
        );
        setFileTreePath(tree.path);
        setFileEntries(tree.entries ?? []);
        setFileListStatus("idle");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFileListStatus("error");
        setFileError(message);
      }
    },
    [fetchJson, fileTreePath, fileUserId],
  );

  const openFile = useCallback(
    async (path: string, offset?: number) => {
      const normalizedPath = normalizeUiPath(path);
      setFileBusy(true);
      setFileError("");
      try {
        const read = await fetchJson<FileReadResult>(
          `/files/file?userId=${encodeURIComponent(fileUserId)}&path=${encodeURIComponent(normalizedPath)}&limit=${FILE_READ_LIMIT}${offset ? `&offset=${offset}` : ""}`,
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
    [activeFilePreview, fetchJson, fileUserId],
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
    setFileBusy(true);
    setFileError("");
    try {
      await fetchJson<{ ok: boolean }>(`/files/file`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userId: fileUserId,
          path: activeFilePath,
          content: fileDraft,
          encoding: "utf8",
        }),
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
    appendTimeline,
    fetchJson,
    fileDraft,
    filePreviewMode,
    fileTreePath,
    fileUserId,
    loadFileTree,
    openFile,
  ]);

  const createDirectory = useCallback(async () => {
    const nextPath = window.prompt("新目录路径", joinUiPath(fileTreePath, "new-folder"));
    if (!nextPath) {
      return;
    }
    setFileBusy(true);
    setFileError("");
    try {
      await fetchJson<{ ok: boolean; path: string }>(`/files/mkdir`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userId: fileUserId,
          path: nextPath,
        }),
      });
      appendTimeline(`file.mkdir: ${nextPath}`);
      await loadFileTree(fileTreePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFileError(message);
    } finally {
      setFileBusy(false);
    }
  }, [appendTimeline, fetchJson, fileTreePath, fileUserId, loadFileTree]);

  const createTextFile = useCallback(async () => {
    const nextPath = window.prompt("新文件路径", joinUiPath(fileTreePath, "untitled.txt"));
    if (!nextPath) {
      return;
    }
    setFileBusy(true);
    setFileError("");
    try {
      await fetchJson<{ ok: boolean; path: string }>(`/files/file`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userId: fileUserId,
          path: nextPath,
          content: "",
          encoding: "utf8",
        }),
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
  }, [appendTimeline, fetchJson, fileTreePath, fileUserId, loadFileTree, openFile]);

  const renamePath = useCallback(
    async (path: string) => {
      const nextPath = window.prompt("重命名为", path);
      if (!nextPath || nextPath === path) {
        return;
      }
      setFileBusy(true);
      setFileError("");
      try {
        await fetchJson<{ ok: boolean; path: string; newPath: string }>(
          `/files/rename`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              userId: fileUserId,
              path,
              newPath: nextPath,
            }),
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
    [activeFilePath, appendTimeline, fetchJson, fileTreePath, fileUserId, loadFileTree, openFile],
  );

  const deletePath = useCallback(
    async (path: string) => {
      if (!window.confirm(`确认删除 ${path} 吗？`)) {
        return;
      }
      setFileBusy(true);
      setFileError("");
      try {
        await fetchJson<{ ok: boolean; path: string }>(
          `/files/file?userId=${encodeURIComponent(fileUserId)}&path=${encodeURIComponent(path)}`,
          {
            method: "DELETE",
          },
        );
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
    [activeFilePath, appendTimeline, fetchJson, fileTreePath, fileUserId, loadFileTree],
  );

  const uploadFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) {
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
        await fetchJson<{ ok: boolean; path: string }>(`/files/upload`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            userId: fileUserId,
            path: targetPath,
            contentBase64: uint8ArrayToBase64(fileBuffer),
          }),
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
    [appendTimeline, fetchJson, fileTreePath, fileUserId, loadFileTree],
  );

  const downloadPath = useCallback(
    (path: string) => {
      const url = `${apiBase}/files/download?userId=${encodeURIComponent(fileUserId)}&path=${encodeURIComponent(path)}`;
      const popup = window.open(url, "_blank", "noopener");
      if (!popup) {
        window.location.href = url;
      }
    },
    [apiBase, fileUserId],
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
