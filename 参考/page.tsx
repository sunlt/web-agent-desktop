"use client";

import { ToolInvocationView } from "@/components/tool-invocation-view";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";

type AgentType = "build" | "plan";
type ChatSummary = {
  id: string;
  updatedAt: string;
  messageCount: number;
  preview?: string;
};

// 用户头像组件
function UserAvatar() {
  return (
    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center text-white text-sm font-medium shrink-0">
      U
    </div>
  );
}

// AI 头像组件
function AIAvatar() {
  return (
    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-teal-400 to-emerald-500 flex items-center justify-center shrink-0">
      <svg
        className="w-5 h-5 text-white"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
    </div>
  );
}

// 打字指示器
function TypingIndicator() {
  return (
    <div className="flex gap-1 items-center py-2">
      <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.3s]"></span>
      <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.15s]"></span>
      <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></span>
    </div>
  );
}

function getSourceLabel(url: string, title?: string) {
  if (title) return title;
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ChatThread({
  chatId,
  initialMessages,
  agentType,
  onRefreshHistory,
}: {
  chatId: string;
  initialMessages: UIMessage[];
  agentType: AgentType;
  onRefreshHistory: () => void;
}) {
  const [inputText, setInputText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `/api/chat-opencode`,
        body: { agent: agentType },
      }),
    [agentType],
  );

  const { messages, status, sendMessage, stop, regenerate, error } = useChat({
    id: chatId,
    messages: initialMessages,
    transport,
    onFinish: () => {
      onRefreshHistory();
    },
  });

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  // 自动调整 textarea 高度
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [inputText]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputText.trim() === "" || status !== "ready") return;
    sendMessage({ text: inputText });
    setInputText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-8">
          {messages.length === 0 ? (
            // 欢迎界面
            <div className="flex flex-col items-center justify-center h-[60vh] text-center">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-teal-400 to-emerald-500 flex items-center justify-center mb-6 shadow-lg shadow-emerald-500/25">
                <svg
                  className="w-10 h-10 text-white"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                </svg>
              </div>
              <h1 className="text-3xl font-semibold text-white mb-3">
                我可以帮你做什么？
              </h1>
              <p className="text-gray-400 max-w-md mb-8">
                使用 Deepseek V3.2 进行智能对话
              </p>

              {/* 快捷功能卡片 */}
              <div className="grid grid-cols-2 gap-3 w-full max-w-xl">
                <button
                  onClick={() => setInputText("帮我写一个 React 组件")}
                  className="p-4 rounded-xl bg-white/5 border border-white/10 text-left hover:bg-white/10 transition-colors group"
                >
                  <div className="text-white font-medium mb-1 group-hover:text-teal-400 transition-colors">
                    🛠️ 编写代码
                  </div>
                  <div className="text-gray-500 text-sm">
                    帮我写一个 React 组件
                  </div>
                </button>
                <button
                  onClick={() => setInputText("帮我设计一个系统架构")}
                  className="p-4 rounded-xl bg-white/5 border border-white/10 text-left hover:bg-white/10 transition-colors group"
                >
                  <div className="text-white font-medium mb-1 group-hover:text-teal-400 transition-colors">
                    📐 系统设计
                  </div>
                  <div className="text-gray-500 text-sm">
                    帮我设计一个系统架构
                  </div>
                </button>
                <button
                  onClick={() => setInputText("帮我分析这段代码的问题")}
                  className="p-4 rounded-xl bg-white/5 border border-white/10 text-left hover:bg-white/10 transition-colors group"
                >
                  <div className="text-white font-medium mb-1 group-hover:text-teal-400 transition-colors">
                    🔍 代码审查
                  </div>
                  <div className="text-gray-500 text-sm">
                    帮我分析这段代码的问题
                  </div>
                </button>
                <button
                  onClick={() => setInputText("解释一下这个概念")}
                  className="p-4 rounded-xl bg-white/5 border border-white/10 text-left hover:bg-white/10 transition-colors group"
                >
                  <div className="text-white font-medium mb-1 group-hover:text-teal-400 transition-colors">
                    💡 解释概念
                  </div>
                  <div className="text-gray-500 text-sm">解释一下这个概念</div>
                </button>
              </div>
            </div>
          ) : (
            // 消息列表
            <div className="space-y-6">
              {messages.map((message) => {
                let stepCount = 0;
                return (
                  <div
                    key={message.id}
                    className={`flex gap-4 ${
                      message.role === "user" ? "flex-row-reverse" : ""
                    }`}
                  >
                    {/* Avatar */}
                    {message.role === "user" ? <UserAvatar /> : <AIAvatar />}

                    {/* Message Content */}
                    <div
                      className={`flex-1 ${
                        message.role === "user" ? "flex justify-end" : "min-w-0"
                      }`}
                    >
                      <div
                        className={`${
                          message.role === "user"
                            ? "bg-[#2f2f2f] text-white rounded-2xl rounded-tr-md px-4 py-3 max-w-[85%]"
                            : "text-gray-100 max-w-full overflow-hidden"
                        }`}
                      >
                        {/* Message Parts */}
                        <div className="space-y-3">
                          {message.parts.map((part, idx) => {
                            if (part.type === "step-start") {
                              stepCount += 1;
                              return (
                                <div
                                  key={idx}
                                  className="flex items-center gap-3 text-xs text-gray-500 uppercase tracking-wider"
                                >
                                  <span className="h-px flex-1 bg-white/10" />
                                  <span>第 {stepCount} 步</span>
                                  <span className="h-px flex-1 bg-white/10" />
                                </div>
                              );
                            }

                            if (part.type === "text") {
                              return (
                                <div key={idx} className="markdown-content">
                                  <ReactMarkdown>
                                    {part.text || ""}
                                  </ReactMarkdown>
                                </div>
                              );
                            }

                            if (part.type === "reasoning") {
                              const isStreaming = part.state === "streaming";
                              return (
                                <details
                                  key={idx}
                                  className="group rounded-xl border border-white/10 bg-white/5 px-4 py-3"
                                  open={isStreaming ? true : undefined}
                                >
                                  <summary className="flex cursor-pointer list-none items-center justify-between text-sm text-gray-400">
                                    <span className="flex items-center gap-2">
                                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-black/30 text-amber-300">
                                        <svg
                                          className="h-3.5 w-3.5"
                                          viewBox="0 0 24 24"
                                          fill="none"
                                          stroke="currentColor"
                                          strokeWidth="2"
                                        >
                                          <path d="M9 18h6" />
                                          <path d="M10 22h4" />
                                          <path d="M12 2a7 7 0 0 0-4 12c.7.7 1 1.6 1 2.5V17h6v-.5c0-.9.3-1.8 1-2.5a7 7 0 0 0-4-12z" />
                                        </svg>
                                      </span>
                                      <span>思考过程</span>
                                      {isStreaming && (
                                        <span className="text-xs text-amber-300/80">
                                          实时
                                        </span>
                                      )}
                                    </span>
                                    <svg
                                      className="h-4 w-4 transition-transform duration-200 group-open:rotate-180"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                    >
                                      <path d="M6 9l6 6 6-6" />
                                    </svg>
                                  </summary>
                                  <div className="mt-3 text-sm text-gray-300">
                                    <div className="markdown-content">
                                      <ReactMarkdown>
                                        {part.text || ""}
                                      </ReactMarkdown>
                                    </div>
                                  </div>
                                </details>
                              );
                            }

                            if (part.type === "source-url") {
                              const label = getSourceLabel(
                                part.url,
                                part.title,
                              );
                              return (
                                <a
                                  key={idx}
                                  href={part.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="group flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-300 hover:bg-white/10"
                                >
                                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-black/30 text-cyan-300">
                                    <svg
                                      className="h-4 w-4"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                    >
                                      <path d="M10 13a5 5 0 0 1 0-7l1-1a5 5 0 0 1 7 7l-1 1" />
                                      <path d="M14 11a5 5 0 0 1 0 7l-1 1a5 5 0 0 1-7-7l1-1" />
                                    </svg>
                                  </span>
                                  <span className="min-w-0">
                                    <span className="block font-medium text-white group-hover:text-cyan-300">
                                      {label}
                                    </span>
                                    <span className="block truncate text-xs text-gray-500">
                                      {part.url}
                                    </span>
                                  </span>
                                  {part.sourceId && (
                                    <span className="ml-auto text-xs text-gray-600">
                                      #{part.sourceId}
                                    </span>
                                  )}
                                </a>
                              );
                            }

                            if (part.type === "source-document") {
                              const subtitle = [part.filename, part.mediaType]
                                .filter(Boolean)
                                .join(" · ");
                              return (
                                <div
                                  key={idx}
                                  className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-300"
                                >
                                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-black/30 text-indigo-300">
                                    <svg
                                      className="h-4 w-4"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                    >
                                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                      <path d="M14 2v6h6" />
                                    </svg>
                                  </span>
                                  <span className="min-w-0">
                                    <span className="block font-medium text-white">
                                      {part.title}
                                    </span>
                                    {subtitle && (
                                      <span className="block text-xs text-gray-500">
                                        {subtitle}
                                      </span>
                                    )}
                                  </span>
                                  {part.sourceId && (
                                    <span className="ml-auto text-xs text-gray-600">
                                      #{part.sourceId}
                                    </span>
                                  )}
                                </div>
                              );
                            }

                            if (part.type === "file") {
                              const isImage =
                                part.mediaType.startsWith("image/");
                              if (isImage) {
                                return (
                                  <div
                                    key={idx}
                                    className="rounded-xl border border-white/10 bg-white/5 p-2"
                                  >
                                    <img
                                      src={part.url}
                                      alt={part.filename || "image"}
                                      className="max-h-64 w-auto rounded-lg"
                                    />
                                    <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                                      <span className="truncate">
                                        {part.filename || "image"}
                                      </span>
                                      <span>{part.mediaType}</span>
                                    </div>
                                  </div>
                                );
                              }
                              return (
                                <a
                                  key={idx}
                                  href={part.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="group flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-300 hover:bg-white/10"
                                >
                                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-black/30 text-teal-300">
                                    <svg
                                      className="h-4 w-4"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                    >
                                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                      <path d="M14 2v6h6" />
                                    </svg>
                                  </span>
                                  <span className="min-w-0">
                                    <span className="block font-medium text-white group-hover:text-teal-300">
                                      {part.filename || "附件"}
                                    </span>
                                    <span className="block text-xs text-gray-500">
                                      {part.mediaType}
                                    </span>
                                  </span>
                                </a>
                              );
                            }

                            if (
                              typeof part.type === "string" &&
                              part.type.startsWith("data-") &&
                              "data" in part
                            ) {
                              const dataLabel = part.type.replace("data-", "");
                              return (
                                <div
                                  key={idx}
                                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-3"
                                >
                                  <div className="flex items-center gap-2 text-xs text-gray-500">
                                    <span className="uppercase tracking-wider">
                                      数据
                                    </span>
                                    <span className="text-gray-600">·</span>
                                    <span className="text-gray-300">
                                      {dataLabel || "data"}
                                    </span>
                                    {"id" in part && part.id && (
                                      <span className="ml-auto text-gray-600">
                                        #{part.id}
                                      </span>
                                    )}
                                  </div>
                                  <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-gray-200 scrollbar-thin">
                                    {safeStringify(
                                      (part as { data: unknown }).data,
                                    )}
                                  </pre>
                                </div>
                              );
                            }

                            if (
                              typeof part.type === "string" &&
                              (part.type.startsWith("tool-") ||
                                part.type === "dynamic-tool")
                            ) {
                              const toolName =
                                part.type === "dynamic-tool"
                                  ? (part as { toolName?: string }).toolName
                                  : part.type
                                      .replace("tool-", "")
                                      .replace(/_/g, "-");
                              return (
                                <ToolInvocationView
                                  key={idx}
                                  tool={{ ...part, toolName } as unknown as any}
                                />
                              );
                            }

                            return null;
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Loading/Streaming Status */}
              {(status === "submitted" || status === "streaming") && (
                <div className="flex gap-4">
                  <AIAvatar />
                  <div className="flex-1">
                    <TypingIndicator />
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="max-w-3xl mx-auto px-4 mb-4">
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-red-400">⚠️</span>
              <span className="text-red-300 text-sm">{error.message}</span>
            </div>
            <button
              onClick={() => regenerate()}
              className="px-3 py-1.5 bg-red-500 text-white rounded-lg text-sm hover:bg-red-600 transition-colors"
            >
              重试
            </button>
          </div>
        </div>
      )}

      {/* Input Area */}
      <div className="border-t border-white/10 bg-[#212121]">
        <div className="max-w-3xl mx-auto px-4 py-4">
          <form onSubmit={handleSubmit} className="relative">
            <div className="relative bg-[#2f2f2f] rounded-2xl border border-white/10 focus-within:border-white/20 transition-colors shadow-lg">
              <textarea
                ref={textareaRef}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="发送消息..."
                disabled={status !== "ready"}
                rows={1}
                className="w-full bg-transparent text-white placeholder-gray-500 px-4 py-4 pr-14 resize-none focus:outline-none max-h-[200px] scrollbar-thin"
              />

              {/* Submit / Stop Button */}
              <div className="absolute right-2 bottom-2">
                {status === "ready" ? (
                  <button
                    type="submit"
                    disabled={inputText.trim() === ""}
                    className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-200 ${
                      inputText.trim()
                        ? "bg-white text-black hover:bg-gray-200"
                        : "bg-white/10 text-gray-500 cursor-not-allowed"
                    }`}
                  >
                    <svg
                      className="w-5 h-5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M5 12h14M12 5l7 7-7 7" />
                    </svg>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={stop}
                    className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center hover:bg-white/20 transition-colors"
                  >
                    <div className="w-4 h-4 bg-white rounded-sm" />
                  </button>
                )}
              </div>
            </div>
          </form>

          <p className="text-center text-xs text-gray-500 mt-3">
            Deepseek V3.2 · {agentType === "build" ? "Build" : "Plan"} Agent
          </p>
        </div>
      </div>
    </div>
  );
}

export default function OpencodeChat() {
  const [agentType, setAgentType] = useState<AgentType>("build");
  const [history, setHistory] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [historyStatus, setHistoryStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");

  const refreshHistory = useCallback(async () => {
    setHistoryStatus("loading");
    try {
      const response = await fetch("/api/chat-opencode-history");
      if (!response.ok) {
        throw new Error("Failed to load history");
      }
      const data = (await response.json()) as { chats?: ChatSummary[] };
      const chats = data.chats ?? [];
      setHistory(chats);
      setHistoryStatus("idle");
      return chats;
    } catch (error) {
      setHistoryStatus("error");
      return [];
    }
  }, []);

  const loadChat = useCallback(async (chatId: string) => {
    setIsChatLoading(true);
    setActiveChatId(chatId);
    try {
      const response = await fetch(`/api/chat-opencode-history/${chatId}`);
      if (!response.ok) {
        throw new Error("Failed to load chat");
      }
      const data = (await response.json()) as {
        id: string;
        messages: UIMessage[];
      };
      setInitialMessages(data.messages ?? []);
    } catch (error) {
      setInitialMessages([]);
    } finally {
      setIsChatLoading(false);
    }
  }, []);

  const createNewChat = useCallback(async () => {
    try {
      const response = await fetch("/api/chat-opencode-history", {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error("Failed to create chat");
      }
      const data = (await response.json()) as { id: string };
      setInitialMessages([]);
      setActiveChatId(data.id);
      await refreshHistory();
    } catch (error) {
      setHistoryStatus("error");
    }
  }, [refreshHistory]);

  useEffect(() => {
    let isActive = true;
    const initialize = async () => {
      const chats = await refreshHistory();
      if (!isActive) return;
      if (chats.length > 0) {
        await loadChat(chats[0].id);
      } else {
        await createNewChat();
      }
    };

    initialize();
    return () => {
      isActive = false;
    };
  }, [createNewChat, loadChat, refreshHistory]);

  const handleSelectChat = async (chatId: string) => {
    await loadChat(chatId);
    setIsHistoryOpen(false);
  };

  const handleNewChat = async () => {
    await createNewChat();
    setIsHistoryOpen(false);
  };

  return (
    <div className="flex flex-col h-screen bg-[#212121]">
      {/* Sidebar Toggle & Agent Selection - 顶部导航 */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsHistoryOpen(true)}
            className="md:hidden inline-flex items-center justify-center rounded-full bg-white/10 px-3 py-1.5 text-xs text-gray-300 hover:bg-white/20 transition-colors"
          >
            历史
          </button>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-teal-400 to-emerald-500 flex items-center justify-center">
              <svg
                className="w-5 h-5 text-white"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
            </div>
            <span className="text-white font-semibold text-lg">Opencode</span>
          </div>
        </div>

        {/* Agent Type Toggle */}
        <div className="flex items-center bg-white/5 rounded-full p-1">
          <button
            onClick={() => setAgentType("build")}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200 ${
              agentType === "build"
                ? "bg-gradient-to-r from-violet-500 to-purple-600 text-white shadow-lg shadow-purple-500/25"
                : "text-gray-400 hover:text-white"
            }`}
          >
            Build
          </button>
          <button
            onClick={() => setAgentType("plan")}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200 ${
              agentType === "plan"
                ? "bg-gradient-to-r from-teal-400 to-emerald-500 text-white shadow-lg shadow-emerald-500/25"
                : "text-gray-400 hover:text-white"
            }`}
          >
            Plan
          </button>
        </div>

        {/* Placeholder for future actions */}
        <div className="w-8" />
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="hidden md:flex w-72 flex-col border-r border-white/10 bg-[#1b1b1b]">
          <div className="p-4">
            <button
              onClick={handleNewChat}
              className="w-full rounded-xl bg-white text-black px-4 py-2 text-sm font-medium hover:bg-gray-200 transition-colors"
            >
              + 新对话
            </button>
          </div>
          <div className="px-4 pb-2 text-xs uppercase tracking-wider text-gray-500">
            历史会话
          </div>
          <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-2 scrollbar-thin">
            {historyStatus === "loading" && (
              <div className="text-xs text-gray-500 px-2 py-2">加载中...</div>
            )}
            {historyStatus === "error" && (
              <div className="text-xs text-red-400 px-2 py-2">历史加载失败</div>
            )}
            {historyStatus === "idle" && history.length === 0 && (
              <div className="text-xs text-gray-500 px-2 py-2">
                暂无历史记录
              </div>
            )}
            {history.map((chat) => {
              const isActive = chat.id === activeChatId;
              return (
                <button
                  key={chat.id}
                  onClick={() => handleSelectChat(chat.id)}
                  className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                    isActive
                      ? "border-teal-400/60 bg-teal-500/10 text-white"
                      : "border-white/10 bg-white/5 text-gray-300 hover:bg-white/10"
                  }`}
                >
                  <div className="flex items-center justify-between text-xs text-gray-400">
                    <span className="font-medium text-gray-200">
                      会话 {chat.id.slice(0, 6)}
                    </span>
                    <span>{formatTimestamp(chat.updatedAt)}</span>
                  </div>
                  <div className="mt-2 text-sm text-gray-200 truncate">
                    {chat.preview || "暂无内容"}
                  </div>
                  <div className="mt-1 text-[11px] text-gray-500">
                    {chat.messageCount} 条消息
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <div className="flex flex-1 flex-col overflow-hidden">
          {isChatLoading && (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
              正在加载对话...
            </div>
          )}
          {!isChatLoading && activeChatId && (
            <ChatThread
              key={activeChatId}
              chatId={activeChatId}
              initialMessages={initialMessages}
              agentType={agentType}
              onRefreshHistory={refreshHistory}
            />
          )}
          {!isChatLoading && !activeChatId && (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
              正在初始化...
            </div>
          )}
        </div>
      </div>

      {isHistoryOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 md:hidden">
          <div className="absolute inset-y-0 left-0 w-72 bg-[#1b1b1b] border-r border-white/10 flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
              <span className="text-sm font-medium text-white">历史会话</span>
              <button
                onClick={() => setIsHistoryOpen(false)}
                className="text-gray-400 hover:text-white"
              >
                关闭
              </button>
            </div>
            <div className="p-4">
              <button
                onClick={handleNewChat}
                className="w-full rounded-xl bg-white text-black px-4 py-2 text-sm font-medium hover:bg-gray-200 transition-colors"
              >
                + 新对话
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-2 scrollbar-thin">
              {historyStatus === "loading" && (
                <div className="text-xs text-gray-500 px-2 py-2">加载中...</div>
              )}
              {historyStatus === "error" && (
                <div className="text-xs text-red-400 px-2 py-2">
                  历史加载失败
                </div>
              )}
              {historyStatus === "idle" && history.length === 0 && (
                <div className="text-xs text-gray-500 px-2 py-2">
                  暂无历史记录
                </div>
              )}
              {history.map((chat) => {
                const isActive = chat.id === activeChatId;
                return (
                  <button
                    key={chat.id}
                    onClick={() => handleSelectChat(chat.id)}
                    className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                      isActive
                        ? "border-teal-400/60 bg-teal-500/10 text-white"
                        : "border-white/10 bg-white/5 text-gray-300 hover:bg-white/10"
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs text-gray-400">
                      <span className="font-medium text-gray-200">
                        会话 {chat.id.slice(0, 6)}
                      </span>
                      <span>{formatTimestamp(chat.updatedAt)}</span>
                    </div>
                    <div className="mt-2 text-sm text-gray-200 truncate">
                      {chat.preview || "暂无内容"}
                    </div>
                    <div className="mt-1 text-[11px] text-gray-500">
                      {chat.messageCount} 条消息
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Global Styles for Markdown */}
      <style jsx global>{`
        .markdown-content {
          font-size: 0.95rem;
          line-height: 1.75;
        }
        .markdown-content p {
          margin-bottom: 1rem;
        }
        .markdown-content p:last-child {
          margin-bottom: 0;
        }
        .markdown-content pre {
          background-color: #1e1e1e;
          padding: 1rem;
          border-radius: 0.75rem;
          overflow-x: auto;
          margin: 1rem 0;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .markdown-content code {
          background-color: rgba(255, 255, 255, 0.1);
          padding: 0.2rem 0.5rem;
          border-radius: 0.375rem;
          font-family: "JetBrains Mono", ui-monospace, monospace;
          font-size: 0.85em;
        }
        .markdown-content pre code {
          background-color: transparent;
          padding: 0;
        }
        .markdown-content ul,
        .markdown-content ol {
          margin-bottom: 1rem;
          padding-left: 1.5rem;
        }
        .markdown-content ul {
          list-style-type: disc;
        }
        .markdown-content ol {
          list-style-type: decimal;
        }
        .markdown-content li {
          margin-bottom: 0.5rem;
        }
        .markdown-content h1,
        .markdown-content h2,
        .markdown-content h3 {
          font-weight: 600;
          margin: 1.5rem 0 0.75rem 0;
          color: white;
        }
        .markdown-content h1 {
          font-size: 1.5rem;
        }
        .markdown-content h2 {
          font-size: 1.25rem;
        }
        .markdown-content h3 {
          font-size: 1.125rem;
        }
        .markdown-content a {
          color: #22d3ee;
          text-decoration: underline;
          text-underline-offset: 2px;
        }
        .markdown-content a:hover {
          color: #67e8f9;
        }
        .markdown-content table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 1rem;
        }
        .markdown-content th,
        .markdown-content td {
          border: 1px solid rgba(255, 255, 255, 0.1);
          padding: 0.5rem 0.75rem;
          text-align: left;
        }
        .markdown-content th {
          background-color: rgba(255, 255, 255, 0.05);
          font-weight: 600;
        }
        .markdown-content blockquote {
          border-left: 3px solid rgba(255, 255, 255, 0.2);
          padding-left: 1rem;
          margin: 1rem 0;
          color: #9ca3af;
        }
        .markdown-content hr {
          border: none;
          border-top: 1px solid rgba(255, 255, 255, 0.1);
          margin: 1.5rem 0;
        }

        details summary::-webkit-details-marker {
          display: none;
        }
        details summary {
          list-style: none;
        }

        /* Scrollbar */
        .scrollbar-thin::-webkit-scrollbar {
          width: 6px;
        }
        .scrollbar-thin::-webkit-scrollbar-track {
          background: transparent;
        }
        .scrollbar-thin::-webkit-scrollbar-thumb {
          background-color: rgba(255, 255, 255, 0.2);
          border-radius: 3px;
        }
        .scrollbar-thin::-webkit-scrollbar-thumb:hover {
          background-color: rgba(255, 255, 255, 0.3);
        }
      `}</style>
    </div>
  );
}
