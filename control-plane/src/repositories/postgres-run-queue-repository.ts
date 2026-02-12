import type { Pool } from "pg";
import type {
  ClaimRunQueueInput,
  RunQueueItem,
  RunQueueRepository,
} from "./run-queue-repository.js";

export class PostgresRunQueueRepository implements RunQueueRepository {
  constructor(private readonly pool: Pool) {}

  async enqueue(input: {
    runId: string;
    sessionId: string;
    provider: RunQueueItem["provider"];
    maxAttempts: number;
    payload: RunQueueItem["payload"];
    now: Date;
  }): Promise<{ accepted: boolean; runId: string }> {
    const result = await this.pool.query(
      `
        INSERT INTO run_queue (
          run_id,
          session_id,
          provider,
          status,
          lock_owner,
          lock_expires_at,
          attempts,
          max_attempts,
          payload,
          error_message,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, 'queued', NULL, NULL, 0, $4, $5::jsonb, NULL, $6, $6)
        ON CONFLICT (run_id) DO NOTHING
        RETURNING run_id
      `,
      [
        input.runId,
        input.sessionId,
        input.provider,
        Math.max(1, input.maxAttempts),
        JSON.stringify(input.payload),
        input.now,
      ],
    );

    return {
      accepted: result.rowCount === 1,
      runId: input.runId,
    };
  }

  async claimNext(input: ClaimRunQueueInput): Promise<RunQueueItem | null> {
    const lockExpiresAt = new Date(input.now.getTime() + input.lockMs);
    const result = await this.pool.query(
      `
        WITH next_item AS (
          SELECT run_id
          FROM run_queue
          WHERE (
            status = 'queued'
            AND (lock_expires_at IS NULL OR lock_expires_at <= $1)
          )
          OR (
            status = 'claimed'
            AND lock_expires_at IS NOT NULL
            AND lock_expires_at <= $1
          )
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE run_queue q
        SET
          status = 'claimed',
          lock_owner = $2,
          lock_expires_at = $3,
          attempts = q.attempts + 1,
          error_message = NULL,
          updated_at = $1
        FROM next_item
        WHERE q.run_id = next_item.run_id
        RETURNING q.*
      `,
      [input.now, input.owner, lockExpiresAt],
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapRow(result.rows[0]);
  }

  async markSucceeded(input: { runId: string; now: Date }): Promise<void> {
    await this.pool.query(
      `
        UPDATE run_queue
        SET
          status = 'succeeded',
          lock_owner = NULL,
          lock_expires_at = NULL,
          error_message = NULL,
          updated_at = $2
        WHERE run_id = $1
      `,
      [input.runId, input.now],
    );
  }

  async markCanceled(input: {
    runId: string;
    now: Date;
    reason?: string;
  }): Promise<void> {
    await this.pool.query(
      `
        UPDATE run_queue
        SET
          status = 'canceled',
          lock_owner = NULL,
          lock_expires_at = NULL,
          error_message = $3,
          updated_at = $2
        WHERE run_id = $1
      `,
      [input.runId, input.now, input.reason ?? null],
    );
  }

  async markRetryOrFailed(input: {
    runId: string;
    now: Date;
    retryDelayMs: number;
    errorMessage: string;
  }): Promise<{
    status: "queued" | "failed";
    attempts: number;
    maxAttempts: number;
  }> {
    const retryAt = new Date(input.now.getTime() + input.retryDelayMs);
    const result = await this.pool.query<{
      status: "queued" | "failed";
      attempts: number;
      max_attempts: number;
    }>(
      `
        UPDATE run_queue
        SET
          status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
          lock_owner = NULL,
          lock_expires_at = CASE WHEN attempts >= max_attempts THEN NULL ELSE $3 END,
          error_message = $4,
          updated_at = $2
        WHERE run_id = $1
        RETURNING status, attempts, max_attempts
      `,
      [input.runId, input.now, retryAt, input.errorMessage],
    );

    if (result.rowCount === 0) {
      return {
        status: "failed",
        attempts: 0,
        maxAttempts: 0,
      };
    }

    return {
      status: result.rows[0].status,
      attempts: result.rows[0].attempts,
      maxAttempts: result.rows[0].max_attempts,
    };
  }

  async findByRunId(runId: string): Promise<RunQueueItem | null> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM run_queue
        WHERE run_id = $1
      `,
      [runId],
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapRow(result.rows[0]);
  }
}

function mapRow(row: any): RunQueueItem {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    provider: row.provider,
    status: row.status,
    lockOwner: row.lock_owner,
    lockExpiresAt: row.lock_expires_at,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    payload: row.payload,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
