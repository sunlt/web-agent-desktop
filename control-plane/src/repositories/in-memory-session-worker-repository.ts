import type { SessionWorker } from "../domain/session-worker.js";
import type { SessionWorkerRepository } from "./session-worker-repository.js";

export class InMemorySessionWorkerRepository implements SessionWorkerRepository {
  private readonly data = new Map<string, SessionWorker>();

  async findBySessionId(sessionId: string): Promise<SessionWorker | null> {
    const worker = this.data.get(sessionId);
    return worker ? clone(worker) : null;
  }

  async save(worker: SessionWorker): Promise<void> {
    this.data.set(worker.sessionId, clone(worker));
  }

  async listIdleRunning(cutoff: Date, limit: number): Promise<SessionWorker[]> {
    return Array.from(this.data.values())
      .filter((item) => item.state === "running" && item.lastActiveAt < cutoff)
      .sort((a, b) => a.lastActiveAt.getTime() - b.lastActiveAt.getTime())
      .slice(0, Math.max(0, limit))
      .map((item) => clone(item));
  }

  async listLongStopped(cutoff: Date, limit: number): Promise<SessionWorker[]> {
    return Array.from(this.data.values())
      .filter(
        (item) =>
          item.state === "stopped" &&
          item.stoppedAt !== null &&
          item.stoppedAt < cutoff,
      )
      .sort((a, b) => {
        const left = a.stoppedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const right = b.stoppedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
        return left - right;
      })
      .slice(0, Math.max(0, limit))
      .map((item) => clone(item));
  }

  async listStaleSyncCandidates(cutoff: Date, limit: number): Promise<SessionWorker[]> {
    return Array.from(this.data.values())
      .filter((item) => {
        if (item.state === "deleted") {
          return false;
        }
        if (item.lastSyncStatus === "running") {
          return false;
        }
        if (!item.lastSyncAt) {
          return true;
        }
        return item.lastSyncAt < cutoff;
      })
      .sort((a, b) => {
        const left = a.lastSyncAt?.getTime() ?? 0;
        const right = b.lastSyncAt?.getTime() ?? 0;
        return left - right;
      })
      .slice(0, Math.max(0, limit))
      .map((item) => clone(item));
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
