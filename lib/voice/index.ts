import { twilioProvider } from "./twilio";
import { vapiProvider } from "./vapi";
import {
  PROVIDER_NAMES,
  type ProviderName,
  type VoiceProvider,
} from "./types";

export {
  MissingProviderConfigError,
  PROVIDER_NAMES,
  ProviderApiError,
  providerLabel,
  type InboundState,
  type ProviderName,
  type VoiceProvider,
} from "./types";

/**
 * Which vendor carries calls, chosen by `VOICE_PROVIDER`.
 *
 * A registry keyed by name, holding factories rather than instances: a vendor
 * whose module has not landed yet is simply absent from the map and fails with
 * a clear message when selected, instead of being a missing import that breaks
 * the build for everyone.
 *
 * ADDING A PROVIDER: one line here, next to `twilio`, plus its import above.
 *
 *   vapi: () => vapiProvider(),
 *
 * That is the whole registration — nothing below this map is vendor-specific.
 */
const REGISTRY: Partial<Record<ProviderName, () => VoiceProvider>> = {
  twilio: () => twilioProvider(),
  vapi: () => vapiProvider(),
};

/** Used when `VOICE_PROVIDER` is unset or empty. */
const DEFAULT_PROVIDER: ProviderName = "twilio";

/**
 * The configured provider's name, without constructing anything.
 *
 * A typo throws rather than falling back to the default: silently placing real
 * calls through the wrong vendor is far worse than refusing to start.
 */
export function providerName(): ProviderName {
  // An empty value is "not chosen", the same as an absent one: a bare
  // `VOICE_PROVIDER=` line in .env should not be an error.
  const raw = (process.env.VOICE_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "") return DEFAULT_PROVIDER;

  const known = PROVIDER_NAMES.find((name) => name === raw);

  if (!known) {
    throw new Error(
      `VOICE_PROVIDER="${process.env.VOICE_PROVIDER}" is not a known voice provider. ` +
        `Valid options are: ${PROVIDER_NAMES.join(", ")}.`
    );
  }

  return known;
}

/** The configured provider. Cheap to call: providers hold no state. */
export function getProvider(): VoiceProvider {
  const name = providerName();
  const create = REGISTRY[name];

  if (!create) {
    throw new Error(
      `VOICE_PROVIDER="${name}" is a known provider but is not available in ` +
        `this build: no lib/voice/${name}.ts is registered in lib/voice/index.ts. ` +
        `Available now: ${Object.keys(REGISTRY).join(", ")}.`
    );
  }

  return create();
}
