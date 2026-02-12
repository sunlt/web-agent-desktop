import { generateId, UIMessage } from 'ai';
import { existsSync, mkdirSync } from 'fs';
import { readFile, readdir, stat, writeFile } from 'fs/promises';
import path from 'path';

// example implementation for demo purposes
// in a real app, you would save the chat to a database
// and use the id from the database entry

export async function createChat(): Promise<string> {
  const id = generateId();
  await writeFile(getChatFile(id), '[]');
  return id;
}

export async function saveChat({
  chatId,
  messages,
}: {
  chatId: string;
  messages: UIMessage[];
}): Promise<void> {
  await writeFile(getChatFile(chatId), JSON.stringify(messages, null, 2));
}

export async function appendMessageToChat({
  chatId,
  message,
}: {
  chatId: string;
  message: UIMessage;
}): Promise<void> {
  const file = getChatFile(chatId);
  const messages = await loadChat(chatId);
  messages.push(message);
  await writeFile(file, JSON.stringify(messages, null, 2));
}

export async function loadChat(id: string): Promise<UIMessage[]> {
  return JSON.parse(await readFile(getChatFile(id), 'utf8'));
}

export async function listChats(): Promise<
  Array<{
    id: string;
    updatedAt: string;
    messageCount: number;
    preview?: string;
  }>
> {
  const chatDir = path.join(process.cwd(), '.chats');

  if (!existsSync(chatDir)) {
    return [];
  }

  const entries = await readdir(chatDir, { withFileTypes: true });
  const summaries = await Promise.all(
    entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(async entry => {
        const id = entry.name.replace(/\.json$/, '');
        const filePath = path.join(chatDir, entry.name);
        const metadata = await stat(filePath);
        let messages: UIMessage[] = [];

        try {
          messages = JSON.parse(await readFile(filePath, 'utf8'));
        } catch {
          messages = [];
        }

        return {
          id,
          updatedAt: metadata.mtime.toISOString(),
          messageCount: messages.length,
          preview: getMessagePreview(messages),
        };
      }),
  );

  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function getChatFile(id: string): string {
  const chatDir = path.join(process.cwd(), '.chats');

  if (!existsSync(chatDir)) mkdirSync(chatDir, { recursive: true });

  const chatFile = path.join(chatDir, `${id}.json`);

  if (!existsSync(chatFile)) {
    writeFile(chatFile, '[]');
  }

  return chatFile;
}

function getMessagePreview(messages: UIMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    for (const part of message.parts) {
      if (part.type === 'text') {
        const text = part.text.trim();
        if (text) {
          return text.length > 120 ? `${text.slice(0, 120)}...` : text;
        }
      }
    }
  }

  return undefined;
}

export async function appendStreamId({
  chatId,
  streamId,
}: {
  chatId: string;
  streamId: string;
}) {
  const file = getStreamsFile(chatId);
  const streams = await loadStreams(chatId);
  streams.push(streamId);
  await writeFile(file, JSON.stringify(streams, null, 2));
}

export async function loadStreams(chatId: string): Promise<string[]> {
  const file = getStreamsFile(chatId);
  if (!existsSync(file)) return [];
  return JSON.parse(await readFile(file, 'utf8'));
}

function getStreamsFile(chatId: string): string {
  const chatDir = path.join(process.cwd(), '.streams');
  if (!existsSync(chatDir)) mkdirSync(chatDir, { recursive: true });
  return path.join(chatDir, `${chatId}.json`);
}
