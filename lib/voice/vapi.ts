import { timingSafeEqual } from "node:crypto";
import { listAgents, setVapiAssistantId } from "../db";
import { CHAT_MODEL } from "../openai";
import type { Agent } from "../types";
import {
  MissingProviderConfigError,
  ProviderApiError,
  type InboundState,
  type ProviderName,
  type VoiceProvider,
} from "./types";

/**
 * Thin wrapper around Vapi's REST API, so nothing else in the app has to know
 * what an assistant object looks like or how a phone number is patched.
 *
 * Vapi is the inverse of Twilio: instead of streaming us the audio and letting
 * this app run the whole pipeline, Vapi runs the pipeline itself (transcriber,
 * turn-taking, TTS) and calls *us* for the thinking. Two endpoints in this app
 * make that work, both configured onto the assistant below:
 *
 * - `${PUBLIC_BASE_URL}/api/vapi/{agentId}` — the custom LLM. Vapi treats this
 *   as an OpenAI-compatible `baseURL` and appends `/chat/completions` itself,
 *   which is why the route file lives at .../chat/completions/route.ts while
 *   the configured URL stops short of it. Putting the suffix in the config
 *   yields `/chat/completions/chat/completions` and a 404 on every turn.
 * - `${PUBLIC_BASE_URL}/api/vapi/events` — the webhook carrying status updates
 *   and the end-of-call report.
 *
 * Both are publicly reachable, so both carry `VAPI_SECRET` in a header that
 * `verifyVapiSecret` checks. The current API has no `server.secret` field: the
 * shared secret rides in `server.headers` and `model.headers`.
 */

const PROVIDER: ProviderName = "vapi";

const API_BASE = "https://api.vapi.ai";

/** Header the shared secret rides in on both of our endpoints. */
export const VAPI_SECRET_HEADER = "x-vapi-secret";

/**
 * Vapi's own transcriber is plan-gated and answers
 * `400 "Vapi transcriber is not available for your organization."` on this
 * account, so the assistant asks for Deepgram explicitly.
 */
const TRANSCRIBER = {
  provider: "deepgram",
  model: "nova-2",
  language: "en",
} as const;

const VOICE = { provider: "vapi", voiceId: "Elliot" } as const;

/** Which webhook events we want; everything else is noise on this app. */
const SERVER_MESSAGES = ["status-update", "end-of-call-report"] as const;

export interface VapiConfig {
  apiKey: string;
  /** The Vapi phone number this app owns, by id (not the number itself). */
  phoneNumberId: string;
  /** Shared secret Vapi sends back to our two endpoints. */
  secret: string;
  /** Public HTTPS origin Vapi reaches this app on. No trailing slash. */
  publicBaseUrl: string;
}

/** The environment variables Vapi needs, paired with their current values. */
function configEntries(): [string, string][] {
  return [
    ["VAPI_API_KEY", process.env.VAPI_API_KEY ?? ""],
    ["VAPI_PHONE_NUMBER_ID", process.env.VAPI_PHONE_NUMBER_ID ?? ""],
    ["VAPI_SECRET", process.env.VAPI_SECRET ?? ""],
    ["PUBLIC_BASE_URL", process.env.PUBLIC_BASE_URL ?? ""],
  ];
}

function missingConfigVars(): string[] {
  return configEntries()
    .filter(([, value]) => value === "")
    .map(([name]) => name);
}

/**
 * Read Vapi configuration from the environment. Lazy — never at module scope —
 * so importing this file does not throw in an unconfigured environment (Next
 * collects route metadata at build time, when no .env.local is necessarily
 * present).
 */
export function vapiConfig(): VapiConfig {
  const missing = missingConfigVars();

  if (missing.length > 0) {
    throw new MissingProviderConfigError(
      PROVIDER,
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. ` +
        "Copy .env.example to .env.local and add your Vapi settings."
    );
  }

  const [[, apiKey], [, phoneNumberId], [, secret], [, publicBaseUrl]] =
    configEntries();

  return {
    apiKey,
    phoneNumberId,
    secret,
    publicBaseUrl: trimSlash(publicBaseUrl),
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// -- HTTP --------------------------------------------------------------------

/**
 * One API call. Returns the raw Response — callers that want to branch on a
 * status (the 404-means-the-assistant-is-gone path) need it before the body is
 * turned into an error.
 */
async function vapiRequest(
  method: string,
  path: string,
  body: unknown,
  context: string
): Promise<Response> {
  const { apiKey } = vapiConfig();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  try {
    return await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // DNS failure, TLS failure, no route to host: never reached the API, so
    // there is no status of theirs to report.
    throw new ProviderApiError(
      PROVIDER,
      502,
      err instanceof Error ? err.message : String(err),
      context
    );
  }
}

/**
 * A non-2xx always becomes a ProviderApiError carrying their body verbatim.
 * That body is the only diagnostic when Vapi refuses something — swallowing it
 * is how a plan-gated transcriber stays a mystery for an afternoon.
 */
async function readJson<T>(response: Response, context: string): Promise<T> {
  const text = await response.text();

  if (!response.ok) {
    throw new ProviderApiError(PROVIDER, response.status, text, context);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderApiError(
      PROVIDER,
      response.status,
      `expected JSON, got: ${text}`,
      context
    );
  }
}

async function vapiJson<T>(
  method: string,
  path: string,
  body: unknown,
  context: string
): Promise<T> {
  return readJson<T>(await vapiRequest(method, path, body, context), context);
}

// -- assistants --------------------------------------------------------------

interface VapiAssistant {
  id: string;
}

/**
 * The assistant that mirrors one of our agents.
 *
 * Deliberately *not* carrying the agent's prompt: the prompt is grounded in
 * retrieved knowledge-base chunks per turn, which only the custom LLM endpoint
 * can do. Vapi's copy of the agent is just routing — a URL, a voice and a
 * transcriber.
 */
function assistantPayload(agent: Agent): Record<string, unknown> {
  const { publicBaseUrl, secret } = vapiConfig();

  return {
    name: agent.name,
    firstMessage: `Hi, you're through to ${agent.name}. How can I help?`,
    model: {
      provider: "custom-llm",
      // No /chat/completions suffix: Vapi uses this as an OpenAI baseURL and
      // appends the suffix itself. See the file header.
      url: `${publicBaseUrl}/api/vapi/${encodeURIComponent(agent.id)}`,
      model: CHAT_MODEL,
      headers: { [VAPI_SECRET_HEADER]: secret },
    },
    voice: VOICE,
    transcriber: TRANSCRIBER,
    server: {
      url: `${publicBaseUrl}/api/vapi/events`,
      headers: { [VAPI_SECRET_HEADER]: secret },
    },
    serverMessages: [...SERVER_MESSAGES],
  };
}

/**
 * Make Vapi's copy of this agent match ours, and return its id.
 *
 * Create when we have no id, PATCH when we do, and fall back to creating when
 * the PATCH 404s: an assistant deleted in Vapi's dashboard would otherwise
 * wedge the agent forever behind an id that can never succeed again.
 *
 * The id is persisted here rather than by the caller — every path that needs an
 * assistant goes through this function, so making callers remember to save it
 * is a bug waiting to happen.
 */
async function upsertAssistant(agent: Agent): Promise<string> {
  const payload = assistantPayload(agent);

  if (agent.vapi_assistant_id) {
    const response = await vapiRequest(
      "PATCH",
      `/assistant/${encodeURIComponent(agent.vapi_assistant_id)}`,
      payload,
      "assistant update"
    );

    if (response.status !== 404) {
      const updated = await readJson<VapiAssistant>(
        response,
        "assistant update"
      );
      setVapiAssistantId(agent.id, updated.id);
      return updated.id;
    }

    // Drain the body so the connection can be reused, then start over.
    await response.text();
    console.warn(
      `[vapi] assistant ${agent.vapi_assistant_id} is gone; recreating it`
    );
  }

  const created = await vapiJson<VapiAssistant>(
    "POST",
    "/assistant",
    payload,
    "assistant create"
  );

  setVapiAssistantId(agent.id, created.id);
  return created.id;
}

// -- phone numbers -----------------------------------------------------------

interface VapiPhoneNumber {
  id: string;
  /** The E.164 number. Absent on number types that have none. */
  number?: string | null;
  /** Discriminator of the PATCH body's oneOf union: "twilio", "vapi", … */
  provider?: string;
  /** The assistant used for incoming calls to this number. */
  assistantId?: string | null;
}

/**
 * The record for VAPI_PHONE_NUMBER_ID, or null when the account has no such
 * number — a real misconfiguration, but not one that should stop the agent page
 * rendering, so `getInbound` reports it as "no number" and the enable/disable
 * paths turn it into an actionable error.
 */
async function findPhoneNumber(): Promise<VapiPhoneNumber | null> {
  const { phoneNumberId } = vapiConfig();

  const numbers = await vapiJson<VapiPhoneNumber[]>(
    "GET",
    "/phone-number",
    undefined,
    "phone number lookup"
  );

  return numbers.find((n) => n.id === phoneNumberId) ?? null;
}

/** Like `findPhoneNumber`, but for the paths that cannot proceed without one. */
async function requirePhoneNumber(): Promise<VapiPhoneNumber> {
  const found = await findPhoneNumber();
  if (found) return found;

  const { phoneNumberId } = vapiConfig();
  throw new ProviderApiError(
    PROVIDER,
    502,
    `VAPI_PHONE_NUMBER_ID="${phoneNumberId}" is not a phone number on this ` +
      "Vapi account, so no assistant can be attached to it.",
    "phone number lookup"
  );
}

/**
 * Attach an assistant to the number, or detach with null.
 *
 * PATCH /phone-number/{id} takes a oneOf union discriminated on `provider`, so
 * the number's current provider is read back and echoed with the patch; sending
 * the patch alone leaves Vapi unable to pick a branch of the union.
 *
 * UNVERIFIED: `assistantId: null` as the way to detach is the only plausible
 * mechanism the schema offers, but it is not documented. If detaching turns out
 * to be a no-op, this is the line to revisit.
 */
async function setNumberAssistant(
  number: VapiPhoneNumber,
  assistantId: string | null
): Promise<VapiPhoneNumber> {
  const body: Record<string, unknown> = { assistantId };
  if (number.provider) body.provider = number.provider;

  return vapiJson<VapiPhoneNumber>(
    "PATCH",
    `/phone-number/${encodeURIComponent(number.id)}`,
    body,
    "phone number update"
  );
}

/**
 * Which of our agents owns an assistant id, or null for none.
 *
 * A scan of every agent rather than an indexed lookup: there are a handful of
 * agents in this app, and a `vapi_assistant_id` query in lib/db.ts would exist
 * for this one caller.
 */
export function agentIdForAssistant(
  assistantId: string | null | undefined
): string | null {
  if (!assistantId) return null;
  const owner = listAgents().find((a) => a.vapi_assistant_id === assistantId);
  return owner?.id ?? null;
}

// -- webhook authentication --------------------------------------------------

/**
 * Verify the shared secret on a request from Vapi. Fails closed: an unset
 * VAPI_SECRET or a missing header both return false.
 *
 * Both `x-vapi-secret` (what the assistant's `headers` set) and an
 * `Authorization: Bearer` are accepted, since the two are interchangeable ways
 * of configuring the same thing and a header set by hand during debugging
 * should not be a silent 401.
 */
export function verifyVapiSecret(request: Request): boolean {
  const secret = process.env.VAPI_SECRET ?? "";
  if (secret === "") return false;

  const presented =
    request.headers.get(VAPI_SECRET_HEADER) ??
    bearerToken(request.headers.get("authorization"));

  if (presented === null) return false;

  return constantTimeEquals(presented, secret);
}

function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * timingSafeEqual throws on buffers of different lengths, so the lengths are
 * compared first. That leaks the secret's length and nothing else, which is the
 * standard trade — the alternative is comparing with `===` and leaking the
 * common prefix one byte at a time.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// -- the provider ------------------------------------------------------------

interface VapiCall {
  id: string;
  status?: string;
}

export class VapiProvider implements VoiceProvider {
  readonly name: ProviderName = PROVIDER;

  isConfigured(): boolean {
    return missingConfigVars().length === 0;
  }

  assertConfigured(): void {
    vapiConfig();
  }

  /**
   * The assistant is upserted on every outbound call rather than once at
   * creation: an agent renamed, or a PUBLIC_BASE_URL that moved with a new
   * tunnel, would otherwise keep dialling out through a stale assistant until
   * someone remembered to re-sync it.
   */
  async placeOutboundCall(
    agent: Agent,
    toNumber: string
  ): Promise<{ providerCallId: string; status: string }> {
    const { phoneNumberId } = vapiConfig();
    const assistantId = await upsertAssistant(agent);

    const call = await vapiJson<VapiCall>(
      "POST",
      "/call",
      { assistantId, phoneNumberId, customer: { number: toNumber } },
      "outbound call"
    );

    return { providerCallId: call.id, status: call.status ?? "queued" };
  }

  /**
   * Which number, if any, exists and which agent currently answers it.
   *
   * There is exactly one phone number in this setup, so inbound is effectively
   * exclusive: enabling it for one agent takes it away from whichever agent
   * held it. The owner is read from the assistant live on the number rather
   * than from anything stored locally.
   */
  async getInbound(): Promise<InboundState> {
    const found = await findPhoneNumber();
    if (!found) {
      console.warn(
        "[vapi] VAPI_PHONE_NUMBER_ID is not a phone number on this account"
      );
      return { number: null, ownerAgentId: null };
    }

    return {
      number: found.number ? found.number : null,
      ownerAgentId: agentIdForAssistant(found.assistantId),
    };
  }

  async enableInbound(agent: Agent): Promise<{ number: string }> {
    const found = await requirePhoneNumber();
    const assistantId = await upsertAssistant(agent);
    const updated = await setNumberAssistant(found, assistantId);

    return { number: updated.number ?? found.number ?? "" };
  }

  async disableInbound(agent: Agent): Promise<void> {
    const found = await requirePhoneNumber();

    // Only detach an assistant this agent actually owns; another agent may have
    // taken the number since the page was loaded.
    if (agentIdForAssistant(found.assistantId) === agent.id) {
      await setNumberAssistant(found, null);
    }
  }
}

export function vapiProvider(): VoiceProvider {
  return new VapiProvider();
}
