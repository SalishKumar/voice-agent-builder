import twilio from "twilio";

/**
 * Thin wrapper around the Twilio REST API and TwiML builders, so nothing else
 * in the app has to know Twilio's request shapes or its signing algorithm.
 *
 * Protocol details below are taken from Twilio's live documentation:
 * - https://www.twilio.com/docs/voice/twiml/stream
 *   "<Start><Stream> creates a unidirectional Stream. <Connect><Stream>
 *   creates a bidirectional Stream." and "wss is the only supported protocol."
 * - https://www.twilio.com/docs/voice/media-streams/websocket-messages
 * - https://www.twilio.com/docs/usage/security (X-Twilio-Signature)
 */

/** Header Twilio signs every webhook request with. */
export const TWILIO_SIGNATURE_HEADER = "x-twilio-signature";

export class MissingTwilioConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingTwilioConfigError";
  }
}

export class TwilioApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, context: string) {
    super(`Twilio ${context} failed with ${status}: ${body}`);
    this.name = "TwilioApiError";
    this.status = status;
    this.body = body;
  }
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  /** Public HTTPS origin Twilio fetches TwiML from. No trailing slash. */
  publicBaseUrl: string;
  /** Public wss:// origin of the media WebSocket server. No trailing slash. */
  publicWsUrl: string;
}

/**
 * Read Twilio configuration from the environment. Lazy — never at module
 * scope — so importing this file does not throw in an unconfigured
 * environment (Next collects route metadata at build time, when no .env.local
 * is necessarily present).
 *
 * `PUBLIC_BASE_URL` and `PUBLIC_WS_URL` are separate because a cloudflared
 * quick tunnel maps exactly one port: Next (3000) and the media WebSocket
 * server (3001) each need their own tunnel, and therefore their own hostname.
 */
export function twilioConfig(): TwilioConfig {
  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
  const fromNumber = process.env.TWILIO_FROM_NUMBER ?? "";
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "";
  const publicWsUrl = process.env.PUBLIC_WS_URL ?? "";

  const missing = [
    ["TWILIO_ACCOUNT_SID", accountSid],
    ["TWILIO_AUTH_TOKEN", authToken],
    ["TWILIO_FROM_NUMBER", fromNumber],
    ["PUBLIC_BASE_URL", publicBaseUrl],
    ["PUBLIC_WS_URL", publicWsUrl],
  ]
    .filter(([, value]) => value === "")
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new MissingTwilioConfigError(
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. ` +
        "Copy .env.example to .env.local and add your Twilio settings."
    );
  }

  return {
    accountSid,
    authToken,
    fromNumber,
    publicBaseUrl: trimSlash(publicBaseUrl),
    publicWsUrl: trimSlash(publicWsUrl),
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** WebSocket URL the media stream for an agent connects to. */
export function mediaStreamUrl(agentId: string): string {
  const { publicWsUrl } = twilioConfig();
  return `${publicWsUrl}/media/${encodeURIComponent(agentId)}`;
}

/**
 * TwiML that connects the call to our media-stream WebSocket.
 *
 * `<Connect><Stream>` (not `<Start><Stream>`) because only a bidirectional
 * Stream lets our server send audio *back* into the call, which is the whole
 * point. Two consequences documented by Twilio and relied on here:
 * - "Twilio doesn't execute subsequent TwiML instructions. Twilio executes the
 *   remaining TwiML instructions only after your server closes the WebSocket
 *   connection." So `<Connect>` must come last.
 * - "The only way you can stop a bidirectional Stream ... is to end the call."
 *
 * The optional `greeting` is spoken by Twilio's own TTS before the stream
 * opens, so the caller is not met with silence while the socket connects.
 *
 * `agentId` also travels as a `<Parameter>`, which Twilio echoes back in the
 * `start` message's `customParameters`. The WebSocket path is the primary
 * source of the id; this is a cheap cross-check.
 */
export function streamTwiml(agentId: string, greeting?: string): string {
  const response = new twilio.twiml.VoiceResponse();

  if (greeting) response.say(greeting);

  const stream = response.connect().stream({ url: mediaStreamUrl(agentId) });
  stream.parameter({ name: "agentId", value: agentId });

  return response.toString();
}

/**
 * Place an outbound call that runs the same pipeline as an inbound one.
 *
 * The TwiML is passed inline rather than as a `url` pointing back at
 * /api/twilio/voice: it is produced by the same `streamTwiml` the webhook
 * returns, so the two cannot diverge, and it removes a round-trip that would
 * otherwise make every outbound call depend on PUBLIC_BASE_URL being reachable
 * *and* on signature verification succeeding through the tunnel.
 */
export async function placeOutboundCall(
  agentId: string,
  toNumber: string
): Promise<{ callSid: string; status: string }> {
  const { accountSid, authToken, fromNumber } = twilioConfig();
  const client = twilio(accountSid, authToken);

  try {
    const call = await client.calls.create({
      to: toNumber,
      from: fromNumber,
      twiml: streamTwiml(agentId),
    });
    return { callSid: call.sid, status: call.status };
  } catch (err) {
    throw toTwilioApiError(err, "outbound call");
  }
}

/** Normalises a thrown RestException into our own error type. */
function toTwilioApiError(err: unknown, context: string): Error {
  if (err instanceof MissingTwilioConfigError) return err;

  const candidate = err as { status?: unknown; message?: unknown } | null;
  const status =
    typeof candidate?.status === "number" ? candidate.status : 502;
  const body =
    typeof candidate?.message === "string" ? candidate.message : String(err);

  return new TwilioApiError(status, body, context);
}

/**
 * Verify Twilio's webhook signature. Fails closed: a missing auth token, a
 * missing header or an unparseable body all return false.
 *
 * Twilio's algorithm (https://www.twilio.com/docs/usage/security): take the
 * full request URL including the query string, append each POST parameter's
 * name and value in case-sensitive alphabetical order with no delimiters,
 * HMAC-SHA1 it with the auth token and base64-encode the result. Implemented
 * by `twilio.validateRequest`, which compares in constant time.
 *
 * `url` is passed in rather than read off `request.url` on purpose. Behind a
 * tunnel the URL the server sees is http://localhost:3000/..., while Twilio
 * signed the public https:// URL. The caller reconstructs the signed URL from
 * PUBLIC_BASE_URL; getting it wrong is the usual cause of a webhook that 403s
 * with correct credentials.
 */
export function verifyTwilioSignature(
  request: Request,
  rawBody: string,
  url: string
): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
  if (authToken === "") return false;

  const signature = request.headers.get(TWILIO_SIGNATURE_HEADER);
  if (!signature) return false;

  let params: Record<string, string>;
  try {
    params = Object.fromEntries(new URLSearchParams(rawBody));
  } catch {
    return false;
  }

  return twilio.validateRequest(authToken, signature, url, params);
}
