import type { SyncReason } from "../ports/workspace-sync-client.js";
import type { SessionSyncService as CallbackSessionSyncService } from "../services/callback-handler.js";
import type { SessionSyncService as ReconcileSessionSyncService } from "../services/reconciler.js";

export interface ExecutorManagerSessionSyncClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
}

export class ExecutorManagerSessionSyncClient
  implements CallbackSessionSyncService, ReconcileSessionSyncService
{
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: ExecutorManagerSessionSyncClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
  }

  async syncSessionWorkspace(
    sessionId: string,
    reason: SyncReason,
    _now: Date,
    runId?: string,
  ): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(
        `${this.baseUrl}/api/session-workers/${encodeURIComponent(sessionId)}/sync`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            reason,
            ...(runId ? { runId } : {}),
          }),
          signal: controller.signal,
        },
      );

      if (response.status === 404) {
        return false;
      }

      const body = (await safeReadJson(response)) as { synced?: boolean } | undefined;
      if (!response.ok) {
        throw new Error(
          `executor-manager sync failed: status=${response.status} body=${JSON.stringify(body ?? {})}`,
        );
      }
      return body?.synced !== false;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function safeReadJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
