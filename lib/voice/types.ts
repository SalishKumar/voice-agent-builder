import type { Agent } from "../types";

/**
 * The seam between the app and whichever telephony vendor is carrying calls.
 *
 * Everything above this file — routes, UI, the call history — talks about
 * "the provider". Only the modules next to this one (twilio.ts, vapi.ts) know
 * what a TwiML document or an assistant id is.
 */

export type ProviderName = "twilio" | "vapi";

/** Every provider that `getProvider()` will accept, in error messages. */
export const PROVIDER_NAMES: readonly ProviderName[] = ["twilio", "vapi"];

/** Human-facing name of a provider, for messages shown to the user. */
export function providerLabel(provider: ProviderName): string {
  return provider === "twilio" ? "Twilio" : "Vapi";
}

/**
 * The environment is missing something the provider needs. The message names
 * the exact variables: it is the single most useful thing to tell someone who
 * has not set the vendor up yet, and the UI string-matches it as a fallback
 * way to recognise "never configured" (see components/PhonePanel.tsx).
 */
export class MissingProviderConfigError extends Error {
  readonly provider: ProviderName;

  constructor(provider: ProviderName, message: string) {
    super(message);
    this.name = "MissingProviderConfigError";
    this.provider = provider;
  }
}

/** The vendor's API refused something. `body` is their diagnostic, verbatim. */
export class ProviderApiError extends Error {
  readonly provider: ProviderName;
  readonly status: number;
  readonly body: string;

  constructor(
    provider: ProviderName,
    status: number,
    body: string,
    context: string
  ) {
    super(`${providerLabel(provider)} ${context} failed with ${status}: ${body}`);
    this.name = "ProviderApiError";
    this.provider = provider;
    this.status = status;
    this.body = body;
  }
}

export interface InboundState {
  /** The number callers dial, or null when the provider has none configured. */
  number: string | null;
  /** Which agent currently answers it, or null if unassigned. */
  ownerAgentId: string | null;
}

export interface VoiceProvider {
  readonly name: ProviderName;

  /** True when every environment variable this provider needs is set. */
  isConfigured(): boolean;

  /** Throws MissingProviderConfigError naming the specific missing env vars. */
  assertConfigured(): void;

  placeOutboundCall(
    agent: Agent,
    toNumber: string
  ): Promise<{ providerCallId: string; status: string }>;

  getInbound(): Promise<InboundState>;

  /** Make the provider's number answer as `agent`. */
  enableInbound(agent: Agent): Promise<{ number: string }>;

  /** Stop the provider's number answering as `agent`. */
  disableInbound(agent: Agent): Promise<void>;
}
