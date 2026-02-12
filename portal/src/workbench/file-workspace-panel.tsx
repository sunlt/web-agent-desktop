import type { KeyboardEvent } from "react";
import { TextFilePreview } from "./text-file-preview";
import type { FileWorkspaceController } from "./use-file-workspace";

interface FileWorkspacePanelProps {
  readonly title: string;
  readonly workspace: FileWorkspaceController;
  readonly identity?: {
    readonly label: string;
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly placeholder?: string;
  };
  readonly hint?: string;
}

export function FileWorkspacePanel(input: FileWorkspacePanelProps) {
  const { title, workspace, identity, hint } = input;

  const onPathEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    void workspace.loadFileTree(workspace.fileTreePath);
  };

  return (
    <section className="panel">
      <h3>{title}</h3>
      <div className="files-controls">
        {identity ? (
          <label>
            {identity.label}
            <input
              value={identity.value}
              onChange={(event) => identity.onChange(event.target.value)}
              placeholder={identity.placeholder}
            />
          </label>
        ) : null}

        <div className="files-path-row">
          <input
            value={workspace.fileTreePath}
            onChange={(event) => workspace.setFileTreePath(event.target.value)}
            onKeyDown={onPathEnter}
            placeholder="/workspace"
          />
          <button
            type="button"
            className="secondary"
            disabled={workspace.fileBusy || !workspace.ready}
            onClick={() => void workspace.loadFileTree(workspace.fileTreePath)}
          >
            刷新
          </button>
          <button
            type="button"
            className="secondary"
            disabled={
              workspace.fileBusy ||
              !workspace.ready ||
              workspace.fileTreePath === "/" ||
              workspace.fileTreePath === "/workspace"
            }
            onClick={() => void workspace.loadFileTree(workspace.parentPath)}
          >
            上级
          </button>
        </div>

        <div className="files-action-row">
          <button
            type="button"
            className="secondary"
            disabled={workspace.fileBusy || !workspace.ready}
            onClick={() => void workspace.createDirectory()}
          >
            新建目录
          </button>
          <button
            type="button"
            className="secondary"
            disabled={workspace.fileBusy || !workspace.ready}
            onClick={() => void workspace.createTextFile()}
          >
            新建文件
          </button>
          <label className="upload-label">
            上传
            <input type="file" onChange={(event) => void workspace.uploadFile(event)} />
          </label>
        </div>
      </div>

      {hint ? <p className="muted files-hint">{hint}</p> : null}
      {workspace.fileListStatus === "loading" ? <p className="muted">文件列表加载中...</p> : null}
      {workspace.fileError ? <p className="error-text panel-error">{workspace.fileError}</p> : null}

      <div className="file-list">
        {workspace.fileEntries.length === 0 ? (
          <p className="muted">点击刷新加载文件列表</p>
        ) : (
          workspace.fileEntries.map((entry) => (
            <article
              key={entry.path}
              className={`file-row ${workspace.activeFilePath === entry.path ? "active" : ""}`}
            >
              <button
                type="button"
                className="file-entry"
                onClick={() =>
                  entry.isDirectory
                    ? void workspace.loadFileTree(entry.path)
                    : void workspace.openFile(entry.path)
                }
              >
                <span>{entry.isDirectory ? `📁 ${entry.name}` : entry.name}</span>
                <span>{entry.isDirectory ? "dir" : workspace.formatFileSize(entry.size)}</span>
              </button>
              <div className="file-row-actions">
                {!entry.isDirectory ? (
                  <button
                    type="button"
                    className="secondary"
                    disabled={workspace.fileBusy}
                    onClick={() => workspace.downloadPath(entry.path)}
                  >
                    下载
                  </button>
                ) : null}
                <button
                  type="button"
                  className="secondary"
                  disabled={workspace.fileBusy}
                  onClick={() => void workspace.renamePath(entry.path)}
                >
                  重命名
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={workspace.fileBusy}
                  onClick={() => void workspace.deletePath(entry.path)}
                >
                  删除
                </button>
              </div>
            </article>
          ))
        )}
      </div>

      <div className="preview-divider" />
      <h4>预览与编辑</h4>
      {!workspace.activeFilePath ? (
        <p className="muted">选择文件后可预览与编辑</p>
      ) : (
        <div className="preview-panel">
          <div className="preview-meta">
            <strong>{workspace.activeFilePath}</strong>
            <span>
              {workspace.activeFilePreview
                ? `${workspace.activeFilePreview.contentType} · ${workspace.formatFileSize(workspace.activeFilePreview.size)}`
                : "-"}
            </span>
          </div>
          {workspace.filePreviewMode === "text" && workspace.activeFilePreview ? (
            <TextFilePreview
              path={workspace.activeFilePath}
              preview={workspace.activeFilePreview}
              draft={workspace.fileDraft}
              setDraft={workspace.setFileDraft}
              busy={workspace.fileBusy}
              onLoadMore={workspace.handleLoadMoreFile}
              onSave={workspace.saveActiveFile}
            />
          ) : null}
          {workspace.filePreviewMode === "image" && workspace.activeFileInlineUrl ? (
            <img
              src={workspace.activeFileInlineUrl}
              alt={workspace.activeFilePath}
              className="preview-image"
            />
          ) : null}
          {workspace.filePreviewMode === "pdf" && workspace.activeFileInlineUrl ? (
            <iframe
              title={workspace.activeFilePath}
              src={workspace.activeFileInlineUrl}
              className="preview-frame"
            />
          ) : null}
          {workspace.filePreviewMode === "binary" ? (
            <p className="muted">二进制文件不支持在线编辑，请使用下载查看。</p>
          ) : null}
          <div className="preview-actions">
            {workspace.activeFileDownloadUrl ? (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  if (workspace.activeFilePath) {
                    workspace.downloadPath(workspace.activeFilePath);
                  }
                }}
              >
                下载文件
              </button>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
