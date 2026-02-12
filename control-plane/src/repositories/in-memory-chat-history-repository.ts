import { randomUUID } from "node:crypto";
import type {
  ChatHistoryMessageRecord,
  ChatHistoryRepository,
  ChatHistorySessionRecord,
  CreateChatHistorySessionInput,
  ReplaceChatHistoryMessagesInput,
} from "./chat-history-repository.js";

interface InMemorySession extends ChatHistorySessionRecord {}

interface InMemoryMessage extends ChatHistoryMessageRecord {}

export class InMemoryChatHistoryRepository implements ChatHistoryRepository {
  private readonly sessions = new Map<string, InMemorySession>();
  private readonly messages = new Map<string, InMemoryMessage[]>();

  async listSessions(input?: {
    limit?: number;
  }): Promise<readonly ChatHistorySessionRecord[]> {
    const limit = input?.limit ?? Number.MAX_SAFE_INTEGER;
    const sorted = Array.from(this.sessions.values())
      .sort((a, b) => {
        const aTime = (a.lastMessageAt ?? a.updatedAt).getTime();
        const bTime = (b.lastMessageAt ?? b.updatedAt).getTime();
        return bTime - aTime;
      })
      .slice(0, limit);

    return sorted.map((session) => ({ ...session }));
  }

  async createSession(
    input: CreateChatHistorySessionInput,
  ): Promise<ChatHistorySessionRecord> {
    const now = input.createdAt ?? new Date();
    const chatId = input.chatId ?? randomUUID();
    const sessionId = input.sessionId ?? chatId;
    const existing = this.sessions.get(chatId);

    if (existing) {
      const merged: InMemorySession = {
        ...existing,
        sessionId,
        title: input.title?.trim() || existing.title,
        provider: input.provider ?? existing.provider,
        model: input.model ?? existing.model,
        updatedAt: now,
      };
      this.sessions.set(chatId, merged);
      return { ...merged };
    }

    const created: InMemorySession = {
      chatId,
      sessionId,
      title: input.title?.trim() || "新会话",
      provider: input.provider ?? null,
      model: input.model ?? null,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
    };

    this.sessions.set(chatId, created);
    this.messages.set(chatId, []);

    return { ...created };
  }

  async findSession(chatId: string): Promise<ChatHistorySessionRecord | null> {
    const existing = this.sessions.get(chatId);
    return existing ? { ...existing } : null;
  }

  async listMessages(input: {
    chatId: string;
    limit?: number;
  }): Promise<readonly ChatHistoryMessageRecord[]> {
    const all = this.messages.get(input.chatId) ?? [];
    const limit = input.limit ?? all.length;
    return all.slice(0, limit).map((message) => ({ ...message }));
  }

  async replaceMessages(input: ReplaceChatHistoryMessagesInput): Promise<void> {
    const now = input.updatedAt ?? new Date();
    const session = this.sessions.get(input.chatId);
    if (!session) {
      throw new Error(`chat session not found: ${input.chatId}`);
    }

    const nextMessages: InMemoryMessage[] = input.messages.map((message, index) => ({
      id: `${input.chatId}:${index + 1}`,
      chatId: input.chatId,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt ?? now,
    }));

    this.messages.set(input.chatId, nextMessages);

    const lastMessage = nextMessages.at(-1);
    const nextSession: InMemorySession = {
      ...session,
      title: input.title?.trim() || session.title,
      provider: input.provider ?? session.provider,
      model: input.model ?? session.model,
      updatedAt: now,
      lastMessageAt: lastMessage?.createdAt ?? null,
    };

    this.sessions.set(input.chatId, nextSession);
  }
}
