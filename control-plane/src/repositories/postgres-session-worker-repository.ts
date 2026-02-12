import type { Pool, QueryResultRow } from "pg";
import type { SessionWorker, SessionWorkerState, SyncStatus } from "../domain/session-worker.js";
import type { SessionWorkerRepository } from "./session-worker-repository.js";

interface SessionWorkerRow extends QueryResultRow {
  session_id: string;
  container_id: string;
  workspace_s3_prefix: string;
  state: SessionWorkerState;
  last_active_at: Date | string;
  stopped_at: Date | string | null;
  last_sync_at: Date | string | null;
  last_sync_status: SyncStatus;
  last_sync_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export class PostgresSessionWorkerRepository implements SessionWorkerRepository {
  constructor(private readonly pool: Pool) {}

  async findBySessionId(sessionId: string): Promise<SessionWorker | null> {
    const result = await this.pool.query<SessionWorkerRow>(
      `
        SELECT
          session_id,
          container_id,
          workspace_s3_prefix,
          state,
          last_active_at,
          stopped_at,
          last_sync_at,
          last_sync_status,
          last_sync_error,
          created_at,
          updated_at
        FROM session_workers
        WHERE session_id = $1
      `,
      [sessionId],
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapRow(result.rows[0]);
  }

  async save(worker: SessionWorker): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO session_workers (
          session_id,
          container_id,
          workspace_s3_prefix,
          state,
          last_active_at,
          stopped_at,
          last_sync_at,
          last_sync_status,
          last_sync_error,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (session_id)
        DO UPDATE SET
          container_id = EXCLUDED.container_id,
          workspace_s3_prefix = EXCLUDED.workspace_s3_prefix,
          state = EXCLUDED.state,
          last_active_at = EXCLUDED.last_active_at,
          stopped_at = EXCLUDED.stopped_at,
          last_sync_at = EXCLUDED.last_sync_at,
          last_sync_status = EXCLUDED.last_sync_status,
          last_sync_error = EXCLUDED.last_sync_error,
          updated_at = EXCLUDED.updated_at
      `,
      [
        worker.sessionId,
        worker.containerId,
        worker.workspaceS3Prefix,
        worker.state,
        worker.lastActiveAt,
        worker.stoppedAt,
        worker.lastSyncAt,
        worker.lastSyncStatus,
        worker.lastSyncError,
        worker.createdAt,
        worker.updatedAt,
      ],
    );
  }

  async listIdleRunning(cutoff: Date, limit: number): Promise<SessionWorker[]> {
    const result = await this.pool.query<SessionWorkerRow>(
      `
        SELECT
          session_id,
          container_id,
          workspace_s3_prefix,
          state,
          last_active_at,
          stopped_at,
          last_sync_at,
          last_sync_status,
          last_sync_error,
          created_at,
          updated_at
        FROM session_workers
        WHERE state = 'running'
          AND last_active_at < $1
        ORDER BY last_active_at ASC
        LIMIT $2
      `,
      [cutoff, limit],
    );

    return result.rows.map(mapRow);
  }

  async listLongStopped(cutoff: Date, limit: number): Promise<SessionWorker[]> {
    const result = await this.pool.query<SessionWorkerRow>(
      `
        SELECT
          session_id,
          container_id,
          workspace_s3_prefix,
          state,
          last_active_at,
          stopped_at,
          last_sync_at,
          last_sync_status,
          last_sync_error,
          created_at,
          updated_at
        FROM session_workers
        WHERE state = 'stopped'
          AND stopped_at IS NOT NULL
          AND stopped_at < $1
        ORDER BY stopped_at ASC
        LIMIT $2
      `,
      [cutoff, limit],
    );

    return result.rows.map(mapRow);
  }

  async listStaleSyncCandidates(cutoff: Date, limit: number): Promise<SessionWorker[]> {
    const result = await this.pool.query<SessionWorkerRow>(
      `
        SELECT
          session_id,
          container_id,
          workspace_s3_prefix,
          state,
          last_active_at,
          stopped_at,
          last_sync_at,
          last_sync_status,
          last_sync_error,
          created_at,
          updated_at
        FROM session_workers
        WHERE state IN ('running', 'stopped')
          AND last_sync_status <> 'running'
          AND (last_sync_at IS NULL OR last_sync_at < $1)
        ORDER BY COALESCE(last_sync_at, TIMESTAMPTZ 'epoch') ASC
        LIMIT $2
      `,
      [cutoff, limit],
    );

    return result.rows.map(mapRow);
  }
}

function mapRow(row: SessionWorkerRow): SessionWorker {
  return {
    sessionId: row.session_id,
    containerId: row.container_id,
    workspaceS3Prefix: row.workspace_s3_prefix,
    state: row.state,
    lastActiveAt: toDate(row.last_active_at),
    stoppedAt: toDateNullable(row.stopped_at),
    lastSyncAt: toDateNullable(row.last_sync_at),
    lastSyncStatus: row.last_sync_status,
    lastSyncError: row.last_sync_error,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function toDate(input: Date | string): Date {
  return input instanceof Date ? input : new Date(input);
}

function toDateNullable(input: Date | string | null): Date | null {
  if (!input) {
    return null;
  }
  return toDate(input);
}
