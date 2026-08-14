import { getAgent } from "@/lib/db";
import { CHAT_MODEL, getOpenAI, MissingApiKeyError } from "@/lib/openai";
import { buildGroundedPrompt } from "@/lib/prompt";
import type { ChatMessage, ChatResponse } from "@/lib/types";

// better-sqlite3 is a native module and cannot run on the edge runtime.
export const runtime = "nodejs";

/** How much conversation history to send back, to bound the payload. */
const MAX_HISTORY = 20;

function bad(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function parseMessages(body: unknown): ChatMessage[] | string {
  if (typeof body !== "object" || body === null) {
    return "Body must be a JSON object";
  }

  const { messages } = body as { messages?: unknown };
  if (!Array.isArray(messages) || messages.length === 0) {
    return "messages must be a non-empty array";
  }

  const out: ChatMessage[] = [];
  for (const raw of messages) {
    if (typeof raw !== "object" || raw === null) {
      return "Each message must be an object with role and content";
    }
    const { role, content } = raw as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") {
      return 'Each message role must be "user" or "assistant"';
    }
    if (typeof content !== "string" || content.trim() === "") {
      return "Each message content must be a non-empty string";
    }
    out.push({ role, content });
  }

  if (out[out.length - 1].role !== "user") {
    return 'The last message must have role "user"';
  }

  return out;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const agent = getAgent(id);
  if (!agent) return bad("Agent not found", 404);
  if (agent.status !== "ready") {
    return bad(`Agent is not ready (status: ${agent.status})`, 409);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("Invalid JSON body", 400);
  }

  const parsed = parseMessages(body);
  if (typeof parsed === "string") return bad(parsed, 400);

  const messages = parsed;
  const question = messages[messages.length - 1].content;

  let reply: string | null | undefined;
  let sources: ChatResponse["sources"];

  try {
    const grounded = await buildGroundedPrompt(id, question);
    const system = grounded.system;
    sources = grounded.sources;

    const completion = await getOpenAI().chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: system },
        ...messages.slice(-MAX_HISTORY),
      ],
    });

    reply = completion.choices[0]?.message?.content;
  } catch (err) {
    if (err instanceof MissingApiKeyError) return bad(err.message, 500);
    const message = err instanceof Error ? err.message : String(err);
    return bad(`Model request failed: ${message}`, 502);
  }

  if (typeof reply !== "string" || reply.trim() === "") {
    return bad("Model returned an empty response", 502);
  }

  const payload: ChatResponse = { reply, sources };
  return Response.json(payload);
}
