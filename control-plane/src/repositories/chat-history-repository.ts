export type ChatHistoryRole = "system" | "user" | "assistant";

export interface ChatHistorySessionRecord {
  readonly chatId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastMessageAt: Date | null;
}

export interface ChatHistoryMessageRecord {
  readonly id: string;
  readonly chatId: string;
  readonly role: ChatHistoryRole;
  readonly content: string;
  readonly createdAt: Date;
}

export interface CreateChatHistorySessionInput {
  readonly chatId?: string;
  readonly sessionId?: string;
  readonly title?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly createdAt?: Date;
}

export interface ReplaceChatHistoryMessagesInput {
  readonly chatId: string;
  readonly title?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly updatedAt?: Date;
  readonly messages: readonly {
    role: ChatHistoryRole;
    content: string;
    createdAt?: Date;
  }[];
}

export interface ChatHistoryRepository {
  listSessions(input?: {
    limit?: number;
  }): Promise<readonly ChatHistorySessionRecord[]>;
  createSession(
    input: CreateChatHistorySessionInput,
  ): Promise<ChatHistorySessionRecord>;
  findSession(chatId: string): Promise<ChatHistorySessionRecord | null>;
  listMessages(input: {
    chatId: string;
    limit?: number;
  }): Promise<readonly ChatHistoryMessageRecord[]>;
  replaceMessages(input: ReplaceChatHistoryMessagesInput): Promise<void>;
}
