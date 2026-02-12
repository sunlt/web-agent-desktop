import type { Pool } from "pg";
import type { RunStatus, TodoStatus } from "../services/callback-handler.js";
import type { RunCallbackRepository } from "./run-callback-repository.js";

export class PostgresRunCallbackRepository
  implements RunCallbackRepository
{
  constructor(private readonly pool: Pool) {}

  async bindRun(runId: string, sessionId: string): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO agent_runs (run_id, session_id, status, created_at, updated_at)
        VALUES ($1, $2, 'running', NOW(), NOW())
        ON CONFLICT (run_id)
        DO UPDATE SET
          session_id = EXCLUDED.session_id,
          updated_at = NOW()
      `,
      [runId, sessionId],
    );
  }

  async recordEventIfNew(input: {
    eventId: string;
    runId: string;
    eventType: string;
    payload: Record<string, unknown>;
    eventTs: Date;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `
        INSERT INTO run_events (event_id, run_id, event_type, payload, event_ts)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (event_id) DO NOTHING
      `,
      [
        input.eventId,
        input.runId,
        input.eventType,
        JSON.stringify(input.payload),
        input.eventTs,
      ],
    );

    return (result.rowCount ?? 0) > 0;
  }

  async findRunContext(
    runId: string,
  ): Promise<{ runId: string; sessionId: string } | null> {
    const result = await this.pool.query<{
      run_id: string;
      session_id: string;
    }>(
      `
        SELECT run_id, session_id
        FROM agent_runs
        WHERE run_id = $1
      `,
      [runId],
    );

    if ((result.rowCount ?? 0) === 0) {
      return null;
    }

    return {
      runId: result.rows[0].run_id,
      sessionId: result.rows[0].session_id,
    };
  }

  async updateRunStatus(input: {
    runId: string;
    status: RunStatus;
    updatedAt: Date;
  }): Promise<void> {
    await this.pool.query(
      `
        UPDATE agent_runs
        SET status = $2,
            updated_at = $3
        WHERE run_id = $1
      `,
      [input.runId, input.status, input.updatedAt],
    );
  }

  async finalizeUsage(input: {
    runId: string;
    usage: Record<string, unknown>;
    finalizedAt: Date;
  }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO usage_logs (run_id, usage, finalized_at)
        VALUES ($1, $2::jsonb, $3)
        ON CONFLICT (run_id) DO NOTHING
      `,
      [input.runId, JSON.stringify(input.usage), input.finalizedAt],
    );

    await this.pool.query(
      `
        UPDATE agent_runs
        SET usage = CASE WHEN finalized_at IS NULL THEN $2::jsonb ELSE usage END,
            finalized_at = COALESCE(finalized_at, $3),
            updated_at = $3
        WHERE run_id = $1
      `,
      [input.runId, JSON.stringify(input.usage), input.finalizedAt],
    );
  }

  async upsertTodo(input: {
    runId: string;
    todoId: string;
    content: string;
    status: TodoStatus;
    order: number;
    updatedAt: Date;
  }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO todo_items (run_id, todo_id, content, status, order_no, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (run_id, todo_id)
        DO UPDATE SET
          content = EXCLUDED.content,
          status = EXCLUDED.status,
          order_no = EXCLUDED.order_no,
          updated_at = EXCLUDED.updated_at
      `,
      [
        input.runId,
        input.todoId,
        input.content,
        input.status,
        input.order,
        input.updatedAt,
      ],
    );
  }

  async appendTodoEvent(input: {
    eventId: string;
    runId: string;
    todoId: string;
    content: string;
    status: TodoStatus;
    order: number;
    eventTs: Date;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO todo_item_events (
          event_id,
          run_id,
          todo_id,
          status,
          content,
          order_no,
          event_ts,
          payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        ON CONFLICT (event_id) DO NOTHING
      `,
      [
        input.eventId,
        input.runId,
        input.todoId,
        input.status,
        input.content,
        input.order,
        input.eventTs,
        JSON.stringify(input.payload),
      ],
    );
  }

  async upsertPendingRequest(input: {
    questionId: string;
    runId: string;
    sessionId: string;
    prompt: string;
    metadata: Record<string, unknown>;
    requestedAt: Date;
  }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO human_loop_requests (
          question_id,
          run_id,
          session_id,
          prompt,
          status,
          metadata,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, 'pending', $5::jsonb, $6, $6)
        ON CONFLICT (question_id)
        DO UPDATE SET
          prompt = EXCLUDED.prompt,
          metadata = EXCLUDED.metadata,
          updated_at = EXCLUDED.updated_at
      `,
      [
        input.questionId,
        input.runId,
        input.sessionId,
        input.prompt,
        JSON.stringify(input.metadata),
        input.requestedAt,
      ],
    );
  }

  async markResolved(input: {
    questionId: string;
    runId: string;
    resolvedAt: Date;
  }): Promise<void> {
    await this.pool.query(
      `
        UPDATE human_loop_requests
        SET status = 'resolved',
            resolved_at = $3,
            updated_at = $3
        WHERE question_id = $1
          AND run_id = $2
      `,
      [input.questionId, input.runId, input.resolvedAt],
    );
  }
}
