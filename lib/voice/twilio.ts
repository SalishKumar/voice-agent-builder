import twilio from "twilio";
import type { Agent } from "../types";
import {
  MissingProviderConfigError,
  ProviderApiError,
  type InboundState,
  type ProviderName,
  type VoiceProvider,
} from "./types";

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
 * - https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource
 *   `VoiceUrl` / `VoiceMethod` on update, `voice_url` / `voice_method` on read,
 *   and the `PhoneNumber` filter on the list endpoint.
 *
 * The `VoiceProvider` implementation is at the bottom; the exported helpers
 * above it are used directly by the TwiML webhook, which is Twilio-shaped by
 * nature and does not go through the provider seam.
 */

const PROVIDER: ProviderName = "twilio";

/** Header Twilio signs every webhook request with. */
export const TWILIO_SIGNATURE_HEADER = "x-twilio-signature";

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  /** Public HTTPS origin Twilio fetches TwiML from. No trailing slash. */
  publicBaseUrl: string;
  /** Public wss:// origin of the media WebSocket server. No trailing slash. */
  publicWsUrl: string;
}

/** The environment variables Twilio needs, paired with their current values. */
function configEntries(): [string, string][] {
  return [
    ["TWILIO_ACCOUNT_SID", process.env.TWILIO_ACCOUNT_SID ?? ""],
    ["TWILIO_AUTH_TOKEN", process.env.TWILIO_AUTH_TOKEN ?? ""],
    ["TWILIO_FROM_NUMBER", process.env.TWILIO_FROM_NUMBER ?? ""],
    ["PUBLIC_BASE_URL", process.env.PUBLIC_BASE_URL ?? ""],
    ["PUBLIC_WS_URL", process.env.PUBLIC_WS_URL ?? ""],
  ];
}

function missingConfigVars(): string[] {
  return configEntries()
    .filter(([, value]) => value === "")
    .map(([name]) => name);
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
  const missing = missingConfigVars();

  if (missing.length > 0) {
    throw new MissingProviderConfigError(
      PROVIDER,
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. ` +
        "Copy .env.example to .env.local and add your Twilio settings."
    );
  }

  const [
    [, accountSid],
    [, authToken],
    [, fromNumber],
    [, publicBaseUrl],
    [, publicWsUrl],
  ] = configEntries();

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
    throw toProviderApiError(err, "outbound call");
  }
}

/** Normalises a thrown RestException into our own error type. */
function toProviderApiError(err: unknown, context: string): Error {
  if (err instanceof MissingProviderConfigError) return err;

  const candidate = err as { status?: unknown; message?: unknown } | null;
  const status =
    typeof candidate?.status === "number" ? candidate.status : 502;
  const body =
    typeof candidate?.message === "string" ? candidate.message : String(err);

  return new ProviderApiError(PROVIDER, status, body, context);
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

// -- inbound configuration ---------------------------------------------------

/**
 * Twilio has no assistant object to attach a number to. Instead a phone number
 * carries a *Voice webhook URL*, and ours selects the agent with an `agentId`
 * query parameter (see app/api/twilio/voice/route.ts). So "answer calls as this
 * agent" means pointing TWILIO_FROM_NUMBER's `VoiceUrl` at
 * `${PUBLIC_BASE_URL}/api/twilio/voice?agentId=<id>`.
 */

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
 * one that should stop the agent page rendering, so `getInbound` reports it as
 * "no number" and the enable/disable paths turn it into an actionable error.
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
    throw toProviderApiError(err, "phone number lookup");
  }
}

/** Like `findFromNumber`, but for the paths that cannot proceed without one. */
async function requireFromNumber(): Promise<IncomingNumber> {
  const found = await findFromNumber();
  if (found) return found;

  throw new ProviderApiError(
    PROVIDER,
    502,
    "TWILIO_FROM_NUMBER is not a phone number on this Twilio account, " +
      "so its voice webhook cannot be configured.",
    "phone number lookup"
  );
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
    throw toProviderApiError(err, "phone number update");
  }
}

// -- the provider ------------------------------------------------------------

export class TwilioProvider implements VoiceProvider {
  readonly name: ProviderName = PROVIDER;

  isConfigured(): boolean {
    return missingConfigVars().length === 0;
  }

  assertConfigured(): void {
    twilioConfig();
  }

  async placeOutboundCall(
    agent: Agent,
    toNumber: string
  ): Promise<{ providerCallId: string; status: string }> {
    const { callSid, status } = await placeOutboundCall(agent.id, toNumber);
    return { providerCallId: callSid, status };
  }

  /**
   * Which number, if any, exists and which agent currently answers it.
   *
   * There is exactly one phone number in this setup, so inbound is effectively
   * exclusive: enabling it for one agent takes it away from whichever agent
   * held it. The owner is read from the live webhook URL rather than from
   * anything stored locally.
   */
  async getInbound(): Promise<InboundState> {
    const found = await findFromNumber();
    if (!found) {
      console.warn(
        "[twilio] TWILIO_FROM_NUMBER is not an incoming number on this account"
      );
      return { number: null, ownerAgentId: null };
    }

    return {
      number: found.number === "" ? null : found.number,
      ownerAgentId: ownerAgentId(found.voiceUrl),
    };
  }

  async enableInbound(agent: Agent): Promise<{ number: string }> {
    const { publicBaseUrl } = twilioConfig();
    const found = await requireFromNumber();

    await setVoiceUrl(found.sid, voiceWebhookUrl(publicBaseUrl, agent.id));
    return { number: found.number };
  }

  async disableInbound(agent: Agent): Promise<void> {
    twilioConfig();
    const found = await requireFromNumber();

    // Only clear a webhook this agent actually owns; another agent may have
    // taken the number since the page was loaded.
    if (ownerAgentId(found.voiceUrl) === agent.id) {
      await setVoiceUrl(found.sid, "");
    }
  }
}

export function twilioProvider(): VoiceProvider {
  return new TwilioProvider();
}
