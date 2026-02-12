import type {
  WorkspaceSyncClient,
  WorkspaceSyncRequest,
} from "../ports/workspace-sync-client.js";

export class NoopWorkspaceSyncClient implements WorkspaceSyncClient {
  async syncWorkspace(_: WorkspaceSyncRequest): Promise<void> {
    return;
  }
}
