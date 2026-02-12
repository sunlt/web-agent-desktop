import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type {
  ChatHistoryMessageRecord,
  ChatHistoryRepository,
  ChatHistorySessionRecord,
  CreateChatHistorySessionInput,
  ReplaceChatHistoryMessagesInput,
} from "./chat-history-repository.js";

export class PostgresChatHistoryRepository implements ChatHistoryRepository {
  constructor(private readonly pool: Pool) {}

  async listSessions(input?: {
    limit?: number;
  }): Promise<readonly ChatHistorySessionRecord[]> {
    const hasLimit = typeof input?.limit === "number";
    const result = await this.pool.query<{
      chat_id: string;
      session_id: string;
      title: string;
      provider: string | null;
      model: string | null;
      created_at: Date;
      updated_at: Date;
      last_message_at: Date | null;
    }>(
      `
        SELECT
          chat_id,
          session_id,
          title,
          provider,
          model,
          created_at,
          updated_at,
          last_message_at
        FROM chat_sessions
        ORDER BY COALESCE(last_message_at, updated_at) DESC, created_at DESC
        ${hasLimit ? "LIMIT $1" : ""}
      `,
      hasLimit ? [input?.limit] : [],
    );

    return result.rows.map((row) => ({
      chatId: row.chat_id,
      sessionId: row.session_id,
      title: row.title,
      provider: row.provider,
      model: row.model,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastMessageAt: row.last_message_at,
    }));
  }

  async createSession(
    input: CreateChatHistorySessionInput,
  ): Promise<ChatHistorySessionRecord> {
    const now = input.createdAt ?? new Date();
    const chatId = input.chatId ?? randomUUID();
    const sessionId = input.sessionId ?? chatId;

    const result = await this.pool.query<{
      chat_id: string;
      session_id: string;
      title: string;
      provider: string | null;
      model: string | null;
      created_at: Date;
      updated_at: Date;
      last_message_at: Date | null;
    }>(
      `
        INSERT INTO chat_sessions (
          chat_id,
          session_id,
          title,
          provider,
          model,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $6)
        ON CONFLICT (chat_id)
        DO UPDATE SET
          session_id = EXCLUDED.session_id,
          title = EXCLUDED.title,
          provider = COALESCE(EXCLUDED.provider, chat_sessions.provider),
          model = COALESCE(EXCLUDED.model, chat_sessions.model),
          updated_at = EXCLUDED.updated_at
        RETURNING
          chat_id,
          session_id,
          title,
          provider,
          model,
          created_at,
          updated_at,
          last_message_at
      `,
      [
        chatId,
        sessionId,
        input.title?.trim() || "新会话",
        input.provider ?? null,
        input.model ?? null,
        now,
      ],
    );

    const row = result.rows[0];
    return {
      chatId: row.chat_id,
      sessionId: row.session_id,
      title: row.title,
      provider: row.provider,
      model: row.model,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastMessageAt: row.last_message_at,
    };
  }

  async findSession(chatId: string): Promise<ChatHistorySessionRecord | null> {
    const result = await this.pool.query<{
      chat_id: string;
      session_id: string;
      title: string;
      provider: string | null;
      model: string | null;
      created_at: Date;
      updated_at: Date;
      last_message_at: Date | null;
    }>(
      `
        SELECT
          chat_id,
          session_id,
          title,
          provider,
          model,
          created_at,
          updated_at,
          last_message_at
        FROM chat_sessions
        WHERE chat_id = $1
      `,
      [chatId],
    );

    if ((result.rowCount ?? 0) === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      chatId: row.chat_id,
      sessionId: row.session_id,
      title: row.title,
      provider: row.provider,
      model: row.model,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastMessageAt: row.last_message_at,
    };
  }

  async listMessages(input: {
    chatId: string;
    limit?: number;
  }): Promise<readonly ChatHistoryMessageRecord[]> {
    const hasLimit = typeof input.limit === "number";
    const result = await this.pool.query<{
      id: string;
      chat_id: string;
      role: "system" | "user" | "assistant";
      content: string;
      created_at: Date;
    }>(
      `
        SELECT id::text, chat_id, role, content, created_at
        FROM chat_session_messages
        WHERE chat_id = $1
        ORDER BY seq ASC, id ASC
        ${hasLimit ? "LIMIT $2" : ""}
      `,
      hasLimit ? [input.chatId, input.limit] : [input.chatId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  async replaceMessages(input: ReplaceChatHistoryMessagesInput): Promise<void> {
    const now = input.updatedAt ?? new Date();

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const sessionResult = await client.query<{
        chat_id: string;
      }>(
        `
          SELECT chat_id
          FROM chat_sessions
          WHERE chat_id = $1
          FOR UPDATE
        `,
        [input.chatId],
      );

      if ((sessionResult.rowCount ?? 0) === 0) {
        throw new Error(`chat session not found: ${input.chatId}`);
      }

      await client.query(
        `
          DELETE FROM chat_session_messages
          WHERE chat_id = $1
        `,
        [input.chatId],
      );

      for (let i = 0; i < input.messages.length; i += 1) {
        const message = input.messages[i];
        await client.query(
          `
            INSERT INTO chat_session_messages (
              chat_id,
              seq,
              role,
              content,
              created_at
            )
            VALUES ($1, $2, $3, $4, $5)
          `,
          [
            input.chatId,
            i + 1,
            message.role,
            message.content,
            message.createdAt ?? now,
          ],
        );
      }

      const lastMessage = input.messages.at(-1);
      await client.query(
        `
          UPDATE chat_sessions
          SET
            title = COALESCE($2, title),
            provider = COALESCE($3, provider),
            model = COALESCE($4, model),
            updated_at = $5,
            last_message_at = $6
          WHERE chat_id = $1
        `,
        [
          input.chatId,
          input.title?.trim() || null,
          input.provider ?? null,
          input.model ?? null,
          now,
          lastMessage?.createdAt ?? null,
        ],
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
