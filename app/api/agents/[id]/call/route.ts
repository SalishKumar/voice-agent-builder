import { createCall, getAgent } from "@/lib/db";
import {
  getProvider,
  MissingProviderConfigError,
  ProviderApiError,
  providerLabel,
} from "@/lib/voice";

// better-sqlite3 is a native module and cannot run on the edge runtime.
export const runtime = "nodejs";

/**
 * E.164: a leading "+", a non-zero country digit, then 7–14 more digits.
 *
 * Checked here rather than left to the provider: their rejection of a
 * malformed number is an opaque 400, so the caller would have no idea what was
 * wrong with it.
 */
const E164 = /^\+[1-9]\d{7,14}$/;

function bad(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/** Maps a provider failure onto a response, never leaking a stack trace. */
function providerFailure(err: unknown): Response {
  // The message names exactly which env vars are missing — the single most
  // useful thing to tell someone who has not configured the provider yet.
  if (err instanceof MissingProviderConfigError) return bad(err.message, 500);
  if (err instanceof ProviderApiError) {
    // Their response body is the only diagnostic available when the API
    // refuses something, so it is passed through verbatim.
    return bad(
      `${providerLabel(err.provider)} rejected the call (${err.status}): ${err.body}`,
      502
    );
  }
  return bad(err instanceof Error ? err.message : String(err), 500);
}

/**
 * Place an outbound call.
 *
 * There is no assistant to sync first under Twilio: the TwiML it sends points
 * straight at our media-stream WebSocket, and the agent is identified by the id
 * embedded in that URL. Providers that do need an assistant deal with it behind
 * `placeOutboundCall`.
 */
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

  const phoneNumber =
    typeof body === "object" && body !== null
      ? (body as { phoneNumber?: unknown }).phoneNumber
      : undefined;

  if (typeof phoneNumber !== "string" || !E164.test(phoneNumber)) {
    return bad(
      "Phone number must be in E.164 format, e.g. +14155551234",
      400
    );
  }

  try {
    const provider = getProvider();
    const { providerCallId, status } = await provider.placeOutboundCall(
      agent,
      phoneNumber
    );

    const call = createCall({
      agentId: agent.id,
      provider: provider.name,
      providerCallId,
      direction: "outbound",
      phoneNumber,
      status,
    });

    return Response.json({ callId: call.id }, { status: 201 });
  } catch (err) {
    return providerFailure(err);
  }
}
