import { randomUUID } from "node:crypto";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { getAgent } from "@/lib/db";
import { CHAT_MODEL, getOpenAI, MissingApiKeyError } from "@/lib/openai";
import { buildGroundedPrompt } from "@/lib/prompt";
import { verifyVapiSecret } from "@/lib/voice/vapi";

// better-sqlite3 is a native module and cannot run on the edge runtime.
export const runtime = "nodejs";

/**
 * The brain behind a Vapi call: an OpenAI-compatible Chat Completions endpoint
 * that Vapi calls once per turn as its "custom LLM".
 *
 * Vapi is configured with `${PUBLIC_BASE_URL}/api/vapi/{agentId}` as an OpenAI
 * `baseURL` and appends `/chat/completions` itself — hence this path. The agent
 * id in the URL is how one endpoint serves every agent.
 *
 * What makes it more than a proxy is the system prompt: Vapi's own messages are
 * ignored in favour of one built here from the agent's instructions plus the
 * knowledge-base chunks retrieved for this turn's question.
 *
 * Streaming is not optional in practice. Vapi starts speaking on the first
 * token, so a non-streamed reply is several seconds of dead air on a live call;
 * `stream: false` is supported anyway because it makes the endpoint testable
 * with a plain curl.
 */

/** How much conversation history to send back, to bound the payload. */
const MAX_HISTORY = 20;

/**
 * Used when Vapi asks for a completion with no user turn in it — it opens some
 * calls that way. It must not be empty: an empty string makes the embeddings
 * API answer `400 "input cannot be an empty string"`, turning a dropped
 * greeting into a failed call.
 */
const FALLBACK_QUESTION = "hello";

interface Turn {
  role: "user" | "assistant";
  content: string;
}

function bad(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/**
 * Content may arrive as a plain string or as OpenAI's array of content parts;
 * anything else (an image part, a null) contributes nothing.
 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part !== "object" || part === null) return "";
      const { text } = part as { text?: unknown };
      return typeof text === "string" ? text : "";
    })
    .join("");
}

/**
 * The user/assistant turns of the conversation, oldest first.
 *
 * Vapi sends its own system prompt on every request. It is dropped rather than
 * merged: this app's system prompt is the grounded one built below, and a
 * second system message would be an unreviewed instruction — supplied over a
 * public endpoint — competing with it.
 */
function conversationTurns(messages: unknown): Turn[] {
  if (!Array.isArray(messages)) return [];

  const turns: Turn[] = [];
  for (const raw of messages) {
    if (typeof raw !== "object" || raw === null) continue;
    const { role, content } = raw as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") continue;

    const text = contentText(content);
    if (text.trim() === "") continue;

    turns.push({ role, content: text });
  }

  return turns.slice(-MAX_HISTORY);
}

/** The question to retrieve against: the most recent thing the caller said. */
function lastQuestion(turns: Turn[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "user") return turns[i].content;
  }
  return FALLBACK_QUESTION;
}

// -- SSE ---------------------------------------------------------------------

const encoder = new TextEncoder();

function sseFrame(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

const DONE_FRAME = encoder.encode("data: [DONE]\n\n");

/** A chunk of our own, shaped exactly like the ones the SDK hands back. */
function syntheticChunk(
  id: string,
  created: number,
  delta: ChatCompletionChunk.Choice.Delta,
  finishReason: "stop" | null
): ChatCompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model: CHAT_MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  };
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // First, before the body is read, before the database is touched and above
  // all before anything is spent at OpenAI: this endpoint is publicly
  // reachable, and an unguarded one is someone else's free model access.
  if (!verifyVapiSecret(request)) {
    console.warn("[vapi] rejected a chat request with a bad or missing secret");
    return bad("Invalid Vapi secret", 401);
  }

  const { id } = await params;

  const agent = getAgent(id);
  if (!agent) return bad("Agent not found", 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("Invalid JSON body", 400);
  }

  const { messages, stream } =
    typeof body === "object" && body !== null
      ? (body as { messages?: unknown; stream?: unknown })
      : {};

  const turns = conversationTurns(messages);
  const question = lastQuestion(turns);
  const wantsStream = stream !== false;

  try {
    const grounded = await buildGroundedPrompt(id, question);

    // One line per turn, and nothing from it: transcripts and secrets have no
    // business in a server log.
    console.log(
      `[vapi] chat agent=${id} turns=${turns.length} ` +
        `retrieved=${grounded.retrieved.length} stream=${wantsStream}`
    );

    const conversation: ChatCompletionMessageParam[] = [
      { role: "system", content: grounded.system },
      ...turns,
    ];

    const client = getOpenAI();

    if (!wantsStream) {
      const completion = await client.chat.completions.create(
        { model: CHAT_MODEL, messages: conversation },
        { signal: request.signal }
      );
      return Response.json(completion);
    }

    const upstream = await client.chat.completions.create(
      { model: CHAT_MODEL, messages: conversation, stream: true },
      { signal: request.signal }
    );

    // Everything below happens after the response headers are sent, so a
    // failure here can no longer become a status code: it ends the turn
    // cleanly and is reported in the log instead.
    const created = Math.floor(Date.now() / 1000);
    let frameId = `chatcmpl-${randomUUID()}`;

    const sse = new ReadableStream<Uint8Array>({
      async start(controller) {
        let opened = false;
        let finished = false;

        try {
          for await (const chunk of upstream) {
            if (!opened) {
              // The opening frame carries the role on its own, as OpenAI's
              // own streams do, so a client knows who is speaking before the
              // first token arrives.
              frameId = chunk.id || frameId;
              controller.enqueue(
                sseFrame(
                  syntheticChunk(frameId, created, { role: "assistant" }, null)
                )
              );
              opened = true;
            }

            if (chunk.choices?.[0]?.finish_reason) finished = true;

            // Passed through rather than rebuilt: whatever the model sends —
            // usage, refusals, fields added next month — reaches Vapi intact.
            controller.enqueue(sseFrame(chunk));
          }
        } catch (err) {
          // Including an abort: the caller hung up, and there is nothing left
          // to write to. Never a stack trace into the stream — the client
          // would speak it aloud.
          console.error(
            `[vapi] chat agent=${id} stream ended early: ` +
              (err instanceof Error ? err.message : String(err))
          );
        }

        try {
          if (!finished) {
            controller.enqueue(
              sseFrame(syntheticChunk(frameId, created, {}, "stop"))
            );
          }
          controller.enqueue(DONE_FRAME);
          controller.close();
        } catch {
          // The consumer is already gone; closing a dead stream is not news.
        }
      },

      cancel() {
        // Vapi dropped the connection mid-turn (a barge-in, or the call
        // ended). Stop generating rather than paying for tokens nobody hears.
        upstream.controller.abort();
      },
    });

    return sseResponse(sse);
  } catch (err) {
    if (err instanceof MissingApiKeyError) return bad(err.message, 500);
    const message = err instanceof Error ? err.message : String(err);
    return bad(`Model request failed: ${message}`, 502);
  }
}
