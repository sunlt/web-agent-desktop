import type { Pool } from "pg";
import type {
  HumanLoopRequestStatus,
  HumanLoopRequestRecord,
  RunStatus,
  TodoStatus,
} from "../services/callback-handler.js";
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

  async listTodoItems(input: {
    runId: string;
    limit?: number;
  }): Promise<
    ReadonlyArray<{
      runId: string;
      todoId: string;
      content: string;
      status: TodoStatus;
      order: number;
      updatedAt: Date;
    }>
  > {
    const hasLimit = typeof input.limit === "number";
    const result = await this.pool.query<{
      run_id: string;
      todo_id: string;
      content: string;
      status: TodoStatus;
      order_no: number;
      updated_at: Date;
    }>(
      `
        SELECT run_id, todo_id, content, status, order_no, updated_at
        FROM todo_items
        WHERE run_id = $1
        ORDER BY order_no ASC, updated_at ASC
        ${hasLimit ? "LIMIT $2" : ""}
      `,
      hasLimit ? [input.runId, input.limit] : [input.runId],
    );

    return result.rows.map((row) => ({
      runId: row.run_id,
      todoId: row.todo_id,
      content: row.content,
      status: row.status,
      order: row.order_no,
      updatedAt: row.updated_at,
    }));
  }

  async listTodoEvents(input: {
    runId: string;
    limit?: number;
  }): Promise<
    ReadonlyArray<{
      eventId: string;
      runId: string;
      todoId: string;
      content: string;
      status: TodoStatus;
      order: number;
      eventTs: Date;
      payload: Record<string, unknown>;
    }>
  > {
    const hasLimit = typeof input.limit === "number";
    const result = await this.pool.query<{
      event_id: string;
      run_id: string;
      todo_id: string;
      content: string;
      status: TodoStatus;
      order_no: number;
      event_ts: Date;
      payload: Record<string, unknown> | null;
    }>(
      `
        SELECT event_id, run_id, todo_id, content, status, order_no, event_ts, payload
        FROM todo_item_events
        WHERE run_id = $1
        ORDER BY event_ts ASC, created_at ASC
        ${hasLimit ? "LIMIT $2" : ""}
      `,
      hasLimit ? [input.runId, input.limit] : [input.runId],
    );

    return result.rows.map((row) => ({
      eventId: row.event_id,
      runId: row.run_id,
      todoId: row.todo_id,
      content: row.content,
      status: row.status,
      order: row.order_no,
      eventTs: row.event_ts,
      payload: row.payload ?? {},
    }));
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
    await this.markRequestStatus({
      questionId: input.questionId,
      runId: input.runId,
      status: "resolved",
      resolvedAt: input.resolvedAt,
    });
  }

  async markRequestStatus(input: {
    questionId: string;
    runId: string;
    status: Exclude<HumanLoopRequestStatus, "pending">;
    resolvedAt: Date;
  }): Promise<void> {
    await this.pool.query(
      `
        UPDATE human_loop_requests
        SET status = $3,
            resolved_at = $4,
            updated_at = $4
        WHERE question_id = $1
          AND run_id = $2
      `,
      [input.questionId, input.runId, input.status, input.resolvedAt],
    );
  }

  async listPendingRequests(input: {
    runId?: string;
    limit?: number;
  }): Promise<readonly HumanLoopRequestRecord[]> {
    return this.listRequests({
      runId: input.runId,
      limit: input.limit,
      status: "pending",
    });
  }

  async listRequests(input: {
    runId?: string;
    limit?: number;
    status?: HumanLoopRequestStatus;
  }): Promise<readonly HumanLoopRequestRecord[]> {
    const clauses = [`1 = 1`];
    const values: unknown[] = [];

    if (input.status) {
      values.push(input.status);
      clauses.push(`status = $${values.length}`);
    }

    if (input.runId) {
      values.push(input.runId);
      clauses.push(`run_id = $${values.length}`);
    }

    let limitClause = "";
    if (typeof input.limit === "number") {
      values.push(input.limit);
      limitClause = `LIMIT $${values.length}`;
    }

    const result = await this.pool.query<{
      question_id: string;
      run_id: string;
      session_id: string;
      prompt: string;
      metadata: Record<string, unknown> | null;
      status: HumanLoopRequestRecord["status"];
      created_at: Date;
      resolved_at: Date | null;
    }>(
      `
        SELECT
          question_id,
          run_id,
          session_id,
          prompt,
          metadata,
          status,
          created_at,
          resolved_at
        FROM human_loop_requests
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC
        ${limitClause}
      `,
      values,
    );

    return result.rows.map((row) => ({
      questionId: row.question_id,
      runId: row.run_id,
      sessionId: row.session_id,
      prompt: row.prompt,
      metadata: row.metadata ?? {},
      status: row.status,
      requestedAt: row.created_at,
      resolvedAt: row.resolved_at,
    }));
  }

  async findRequest(questionId: string): Promise<HumanLoopRequestRecord | null> {
    const result = await this.pool.query<{
      question_id: string;
      run_id: string;
      session_id: string;
      prompt: string;
      metadata: Record<string, unknown> | null;
      status: HumanLoopRequestRecord["status"];
      created_at: Date;
      resolved_at: Date | null;
    }>(
      `
        SELECT
          question_id,
          run_id,
          session_id,
          prompt,
          metadata,
          status,
          created_at,
          resolved_at
        FROM human_loop_requests
        WHERE question_id = $1
      `,
      [questionId],
    );

    if ((result.rowCount ?? 0) === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      questionId: row.question_id,
      runId: row.run_id,
      sessionId: row.session_id,
      prompt: row.prompt,
      metadata: row.metadata ?? {},
      status: row.status,
      requestedAt: row.created_at,
      resolvedAt: row.resolved_at,
    };
  }

  async saveResponse(input: {
    questionId: string;
    runId: string;
    answer: string;
    createdAt: Date;
  }): Promise<{ readonly inserted: boolean }> {
    const result = await this.pool.query(
      `
        INSERT INTO human_loop_responses (question_id, run_id, answer, created_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (question_id, run_id) DO NOTHING
      `,
      [input.questionId, input.runId, input.answer, input.createdAt],
    );

    return {
      inserted: (result.rowCount ?? 0) > 0,
    };
  }
}
