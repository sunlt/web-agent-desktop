import type { SessionWorker } from "../domain/session-worker.js";

export interface SessionWorkerRepository {
  findBySessionId(sessionId: string): Promise<SessionWorker | null>;
  save(worker: SessionWorker): Promise<void>;
  listIdleRunning(cutoff: Date, limit: number): Promise<SessionWorker[]>;
  listLongStopped(cutoff: Date, limit: number): Promise<SessionWorker[]>;
  listStaleSyncCandidates(cutoff: Date, limit: number): Promise<SessionWorker[]>;
}
