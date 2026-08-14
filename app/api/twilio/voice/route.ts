import twilio from "twilio";
import { getAgent } from "@/lib/db";
import {
  MissingTwilioConfigError,
  streamTwiml,
  twilioConfig,
  verifyTwilioSignature,
} from "@/lib/twilio";

// better-sqlite3 is a native module and cannot run on the edge runtime.
export const runtime = "nodejs";

/**
 * The TwiML webhook. Twilio POSTs here (form-encoded, never JSON) when a call
 * arrives, and answers with whatever TwiML we return.
 *
 * Two rules govern the responses here:
 * - Verify the X-Twilio-Signature before anything else. This endpoint is
 *   publicly reachable and, unguarded, would let anyone point our number at an
 *   arbitrary WebSocket.
 * - Answer with valid TwiML even when something is wrong. A 404 makes the
 *   caller hear Twilio's own "an application error has occurred" recording,
 *   which tells them nothing; a `<Say>` + `<Hangup>` at least apologises.
 *
 * The agent is chosen by the `agentId` query parameter, so one webhook URL
 * (configured once on the Twilio number) can serve every agent.
 */

function xml(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

/** TwiML for a call we cannot route: apologise, then hang up. */
function apologyTwiml(): string {
  const response = new twilio.twiml.VoiceResponse();
  response.say(
    "Sorry, this number is not connected to an assistant right now. Goodbye."
  );
  response.hangup();
  return response.toString();
}

export async function POST(request: Request) {
  let publicBaseUrl: string;
  try {
    ({ publicBaseUrl } = twilioConfig());
  } catch (err) {
    if (err instanceof MissingTwilioConfigError) {
      console.error(`[twilio] ${err.message}`);
      return xml(apologyTwiml(), 500);
    }
    throw err;
  }

  const rawBody = await request.text();

  // Twilio signed the *public* URL, which is not the URL this process sees
  // behind a tunnel. Rebuild it from PUBLIC_BASE_URL, keeping the path and
  // query string (the query string is part of the signed string).
  const incoming = new URL(request.url);
  const signedUrl = `${publicBaseUrl}${incoming.pathname}${incoming.search}`;

  if (!verifyTwilioSignature(request, rawBody, signedUrl)) {
    console.warn(`[twilio] rejected unsigned request for ${signedUrl}`);
    return new Response("Invalid Twilio signature", { status: 403 });
  }

  const agentId = incoming.searchParams.get("agentId") ?? "";
  const agent = agentId ? getAgent(agentId) : null;

  if (!agent) {
    console.warn(`[twilio] no agent for id ${agentId || "(missing)"}`);
    return xml(apologyTwiml());
  }

  // No greeting argument: the media-stream pipeline speaks the first turn, so
  // adding a <Say> here would talk over it.
  return xml(streamTwiml(agent.id));
}
