import { getAgent } from "@/lib/db";
import {
  getProvider,
  MissingProviderConfigError,
  ProviderApiError,
  providerLabel,
} from "@/lib/voice";

// better-sqlite3 is a native module and cannot run on the edge runtime.
export const runtime = "nodejs";

/**
 * Inbound configuration for an agent.
 *
 * "Answer calls as this agent" means something different per vendor — pointing
 * a number's voice webhook at us (Twilio), or attaching an assistant to it
 * (Vapi) — so all of it lives behind the provider. This route only decides
 * which agent owns the one number the app has, and reports who owns it now.
 */

function bad(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/** Maps a provider failure onto a response, never leaking a stack trace. */
function providerFailure(err: unknown): Response {
  if (err instanceof MissingProviderConfigError) return bad(err.message, 500);
  if (err instanceof ProviderApiError) {
    return bad(
      `${providerLabel(err.provider)} rejected the request (${err.status}): ${err.body}`,
      502
    );
  }
  return bad(err instanceof Error ? err.message : String(err), 500);
}

/**
 * Which number, if any, currently answers as this agent.
 *
 * There is exactly one phone number in this setup, so inbound is effectively
 * exclusive: enabling it for one agent takes it away from whichever agent held
 * it. `enabled` therefore reports the true current owner rather than whether
 * this agent ever enabled it.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const agent = getAgent(id);
  if (!agent) return bad("Agent not found", 404);

  try {
    const provider = getProvider();
    const inbound = await provider.getInbound();

    return Response.json({
      number: inbound.number,
      enabled: inbound.ownerAgentId === agent.id,
      provider: provider.name,
    });
  } catch (err) {
    // Not an error the UI should have to handle: with no credentials yet there
    // is simply nothing configured, and the page must still render.
    if (err instanceof MissingProviderConfigError) {
      return Response.json({
        number: null,
        enabled: false,
        configured: false,
        provider: err.provider,
      });
    }
    return providerFailure(err);
  }
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

  const enabled =
    typeof body === "object" && body !== null
      ? (body as { enabled?: unknown }).enabled
      : undefined;

  if (typeof enabled !== "boolean") {
    return bad("enabled must be a boolean", 400);
  }

  try {
    const provider = getProvider();

    if (enabled) {
      const { number } = await provider.enableInbound(agent);
      return Response.json({ number: number === "" ? null : number });
    }

    await provider.disableInbound(agent);
    return Response.json({ number: null });
  } catch (err) {
    return providerFailure(err);
  }
}
