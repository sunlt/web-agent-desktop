import { createOpencode } from "ai-sdk-provider-opencode-sdk";
import { saveChat } from "@util/chat-store";
import { convertToModelMessages, streamText, UIMessage } from "ai";

export const maxDuration = 60;

// 创建 Opencode provider 实例
const opencode = createOpencode({
  hostname: "127.0.0.1",
  port: 4096,
  autoStartServer: true,
  serverTimeout: 10000,
});

export async function POST(req: Request) {
  try {
    const body: {
      messages: UIMessage[];
      id?: string;
      chatId?: string;
      agent?: "build" | "plan";
    } = await req.json();

    const chatId = body.chatId ?? body.id;
    const { messages, agent = "build" } = body;

    const result = streamText({
      model: opencode("r2ai/deepseek-v3.2", {
        agent: agent,
        sessionTitle: `${agent.charAt(0).toUpperCase() + agent.slice(1)} Agent Session`,
        tools: {
          question: false,
        },
        verbose: true,
      }),
      messages: await convertToModelMessages(messages),
      onStepFinish: ({ request, response }) => {
        console.log(
          `[${agent.charAt(0).toUpperCase() + agent.slice(1)} Agent] Step finished`,
        );
        console.dir(request.body, { depth: 2 });
      },
    });

    return result.toUIMessageStreamResponse({
      originalMessages: messages,
      onFinish: ({ messages }) => {
        if (chatId) {
          saveChat({ chatId, messages });
        }
      },
    });
  } catch (error) {
    console.error("[Opencode Agent API] Error:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
