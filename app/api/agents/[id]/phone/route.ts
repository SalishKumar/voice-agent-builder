import twilio from "twilio";
import { getAgent } from "@/lib/db";
import {
  MissingTwilioConfigError,
  TwilioApiError,
  twilioConfig,
} from "@/lib/twilio";

// better-sqlite3 is a native module and cannot run on the edge runtime.
export const runtime = "nodejs";

/**
 * Inbound configuration for an agent.
 *
 * Twilio has no assistant object to attach a number to. Instead a phone number
 * carries a *Voice webhook URL*, and ours selects the agent with an `agentId`
 * query parameter (see app/api/twilio/voice/route.ts). So "answer calls as this
 * agent" means pointing TWILIO_FROM_NUMBER's `VoiceUrl` at
 * `${PUBLIC_BASE_URL}/api/twilio/voice?agentId=<id>`.
 *
 * Field names confirmed against Twilio's live documentation:
 * - https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource
 *   `VoiceUrl` / `VoiceMethod` on update, `voice_url` / `voice_method` on read,
 *   and the `PhoneNumber` filter on the list endpoint.
 */

function bad(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/** Maps a Twilio failure onto a response, never leaking a stack trace. */
function twilioFailure(err: unknown): Response {
  if (err instanceof MissingTwilioConfigError) return bad(err.message, 500);
  if (err instanceof TwilioApiError) {
    return bad(`Twilio rejected the request (${err.status}): ${err.body}`, 502);
  }
  return bad(err instanceof Error ? err.message : String(err), 500);
}

/** Normalises a thrown RestException into our own error type. */
function toTwilioApiError(err: unknown, context: string): Error {
  if (err instanceof MissingTwilioConfigError) return err;

  const candidate = err as { status?: unknown; message?: unknown } | null;
  const status = typeof candidate?.status === "number" ? candidate.status : 502;
  const body =
    typeof candidate?.message === "string" ? candidate.message : String(err);

  return new TwilioApiError(status, body, context);
}

/** The webhook URL that makes TWILIO_FROM_NUMBER answer as `agentId`. */
function voiceWebhookUrl(publicBaseUrl: string, agentId: string): string {
  return `${publicBaseUrl}/api/twilio/voice?agentId=${encodeURIComponent(agentId)}`;
}

/**
 * Which agent a number's current voice URL points at, or null if it points
 * somewhere else (or nowhere). Parsed rather than substring-matched so a URL
 * that merely contains the id somewhere else does not count as ownership.
 */
function ownerAgentId(voiceUrl: string): string | null {
  if (!voiceUrl) return null;
  try {
    return new URL(voiceUrl).searchParams.get("agentId");
  } catch {
    return null;
  }
}

interface IncomingNumber {
  sid: string;
  number: string;
  voiceUrl: string;
}

/**
 * Look up the IncomingPhoneNumber record for TWILIO_FROM_NUMBER.
 *
 * Null when the account has no such number — a real misconfiguration, but not
 * one that should stop the agent page rendering, so GET reports it as "no
 * number" and POST turns it into an actionable error.
 */
async function findFromNumber(): Promise<IncomingNumber | null> {
  const { accountSid, authToken, fromNumber } = twilioConfig();
  const client = twilio(accountSid, authToken);

  try {
    const [found] = await client.incomingPhoneNumbers.list({
      phoneNumber: fromNumber,
      limit: 1,
    });
    if (!found) return null;
    return {
      sid: found.sid,
      number: found.phoneNumber,
      voiceUrl: found.voiceUrl ?? "",
    };
  } catch (err) {
    throw toTwilioApiError(err, "phone number lookup");
  }
}

/** Point the number's voice webhook somewhere; "" clears it. */
async function setVoiceUrl(sid: string, url: string): Promise<void> {
  const { accountSid, authToken } = twilioConfig();
  const client = twilio(accountSid, authToken);

  try {
    await client.incomingPhoneNumbers(sid).update({
      voiceUrl: url,
      // Our webhook reads a form-encoded POST body and verifies the signature
      // over it, so the method must not drift to GET.
      voiceMethod: "POST",
    });
  } catch (err) {
    throw toTwilioApiError(err, "phone number update");
  }
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
    const found = await findFromNumber();
    if (!found) {
      console.warn(
        "[twilio] TWILIO_FROM_NUMBER is not an incoming number on this account"
      );
      return Response.json({ number: null, enabled: false });
    }

    return Response.json({
      number: found.number === "" ? null : found.number,
      enabled: ownerAgentId(found.voiceUrl) === agent.id,
    });
  } catch (err) {
    // Not an error the UI should have to handle: with no Twilio credentials
    // yet there is simply nothing configured, and the page must still render.
    if (err instanceof MissingTwilioConfigError) {
      return Response.json({ number: null, enabled: false, configured: false });
    }
    return twilioFailure(err);
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
    const { publicBaseUrl } = twilioConfig();
    const found = await findFromNumber();

    if (!found) {
      return bad(
        "TWILIO_FROM_NUMBER is not a phone number on this Twilio account, " +
          "so its voice webhook cannot be configured.",
        502
      );
    }

    if (enabled) {
      await setVoiceUrl(found.sid, voiceWebhookUrl(publicBaseUrl, agent.id));
      return Response.json({ number: found.number === "" ? null : found.number });
    }

    // Only clear a webhook this agent actually owns; another agent may have
    // taken the number since the page was loaded.
    if (ownerAgentId(found.voiceUrl) === agent.id) {
      await setVoiceUrl(found.sid, "");
    }
    return Response.json({ number: null });
  } catch (err) {
    return twilioFailure(err);
  }
}
