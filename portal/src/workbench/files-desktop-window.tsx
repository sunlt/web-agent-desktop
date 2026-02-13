import { FileWorkspacePanel } from "./file-workspace-panel";
import type { FileWorkspaceController } from "./use-file-workspace";

interface FilesDesktopWindowProps {
  executorWorkspace: FileWorkspaceController;
  globalFileWorkspace: FileWorkspaceController;
  workspaceSessionId: string;
  setWorkspaceSessionId: (sessionId: string) => void;
  activeChatId: string | null;
  globalFileUserId: string;
  setGlobalFileUserId: (userId: string) => void;
}

export function FilesDesktopWindow(input: FilesDesktopWindowProps) {
  const {
    executorWorkspace,
    globalFileWorkspace,
    workspaceSessionId,
    setWorkspaceSessionId,
    activeChatId,
    globalFileUserId,
    setGlobalFileUserId,
  } = input;

  return (
    <div className="window-files-grid">
      <FileWorkspacePanel
        title="执行器工作目录文件"
        workspace={executorWorkspace}
        identity={{
          label: "sessionId",
          value: workspaceSessionId,
          onChange: setWorkspaceSessionId,
          placeholder: activeChatId ?? "chat/session id",
        }}
        hint="基于 executor-manager 会话 worker，根目录为 /workspace。"
      />

      <FileWorkspacePanel
        title="全局文件管理"
        workspace={globalFileWorkspace}
        identity={{
          label: "userId",
          value: globalFileUserId,
          onChange: setGlobalFileUserId,
          placeholder: "u-alice",
        }}
        hint="用于访问 RBAC 控制的全局文件树（/files）。"
      />
    </div>
  );
}
