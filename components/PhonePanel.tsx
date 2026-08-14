"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { providerLabel, type ProviderName } from "@/lib/voice/types";

interface PhoneConfig {
  number: string | null;
  enabled: boolean;
  /** false means the user has not set the provider up at all yet. */
  configured: boolean;
  /** Which vendor is carrying calls right now. */
  provider: ProviderName;
}

type Notice =
  | { kind: "success"; text: string }
  | { kind: "error"; text: string }
  /**
   * The missing-env-var 500 — `text` keeps the raw message for the details,
   * `provider` decides which vendor's variables the hint lists.
   */
  | { kind: "setup"; text: string; provider: ProviderName };

/** `VOICE_PROVIDER` picks the vendor; the UI never assumes one. */
const DEFAULT_PROVIDER: ProviderName = "twilio";

/**
 * What each provider needs in `.env.local`, in the order the hint lists it.
 *
 * Vapi has no `PUBLIC_WS_URL` on purpose: it hosts the media pipeline itself,
 * so only the Next app has to be publicly reachable.
 */
const SETUP_VARS: Record<ProviderName, readonly (readonly [string, string])[]> =
  {
    twilio: [
      ["TWILIO_ACCOUNT_SID", "from the Twilio console"],
      ["TWILIO_AUTH_TOKEN", "from the Twilio console"],
      ["TWILIO_FROM_NUMBER", "your Twilio number, E.164"],
      ["PUBLIC_BASE_URL", "public https origin of this app"],
      ["PUBLIC_WS_URL", "public wss origin of the media server"],
    ],
    vapi: [
      ["VAPI_API_KEY", "private key from the Vapi dashboard"],
      ["VAPI_PHONE_NUMBER_ID", "id of your number in Vapi"],
      ["VAPI_SECRET", "shared secret Vapi sends webhooks with"],
      ["PUBLIC_BASE_URL", "public https origin of this app"],
    ],
  };

/**
 * `GET /phone` reports `configured: false` outright, but the other endpoints
 * can only fail with the 500 whose message names the missing variables. Seeing
 * one of those names is the fallback way to tell "you never set the provider
 * up" apart from a genuine server fault, so the first run gets a setup hint
 * instead of an env-var dump.
 */
const ENV_VARS: Record<ProviderName, readonly string[]> = {
  twilio: SETUP_VARS.twilio.map(([name]) => name),
  vapi: SETUP_VARS.vapi.map(([name]) => name),
};

/** Names belonging to exactly one vendor — `PUBLIC_BASE_URL` is shared. */
const TWILIO_ONLY = ENV_VARS.twilio.filter(
  (name) => !ENV_VARS.vapi.includes(name)
);
const VAPI_ONLY = ENV_VARS.vapi.filter(
  (name) => !ENV_VARS.twilio.includes(name)
);

const NOT_READY_NOTE = "Available once the build finishes successfully.";
const E164_HINT = "E.164 format — country code, no spaces or dashes.";

function isNotConfigured(status: number, message: string): boolean {
  return (
    status === 500 &&
    (ENV_VARS.twilio.some((name) => message.includes(name)) ||
      ENV_VARS.vapi.some((name) => message.includes(name)))
  );
}

/**
 * Which vendor a missing-env-var message is about. `PUBLIC_BASE_URL` is shared,
 * so only the vendor-specific names count; `fallback` is what the last known
 * config said, and the default provider when nothing is known.
 */
function providerFromMessage(
  message: string,
  fallback: ProviderName
): ProviderName {
  if (VAPI_ONLY.some((name) => message.includes(name))) return "vapi";
  if (TWILIO_ONLY.some((name) => message.includes(name))) return "twilio";
  return fallback;
}

/** The server sends `"twilio" | "vapi"`; anything else means "assume default". */
function readProvider(value: unknown): ProviderName {
  return value === "vapi" || value === "twilio" ? value : DEFAULT_PROVIDER;
}

/** Reads `{ error }` off a response, falling back to the status code. */
async function readError(res: Response, fallbackVerb: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (typeof data?.error === "string" && data.error.trim()) return data.error;
  } catch {
    // Keep the status-code fallback.
  }
  return `${fallbackVerb} failed (HTTP ${res.status}).`;
}

function SetupHint({
  detail,
  provider,
}: {
  detail: string;
  provider: ProviderName;
}) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
      <p className="font-medium">Phone calling isn&rsquo;t set up yet.</p>
      <p className="mt-1">
        Real calls need a {providerLabel(provider)} account. In{" "}
        <span className="font-mono">.env.local</span> set:
      </p>
      <ul className="mt-1.5 flex flex-col gap-0.5 font-mono text-xs">
        {SETUP_VARS[provider].map(([name, note]) => (
          <li key={name}>
            {name} — {note}
          </li>
        ))}
      </ul>
      {provider === "twilio" ? (
        <p className="mt-1.5 text-xs">
          The last two need a tunnel each — this app and the media server listen
          on different ports. Run{" "}
          <span className="font-mono">./tunnels.sh</span> to start both and
          print the URLs, then restart the dev server.
        </p>
      ) : (
        <p className="mt-1.5 text-xs">
          Vapi runs the media pipeline itself, so only this app has to be
          reachable — one tunnel, no{" "}
          <span className="font-mono">PUBLIC_WS_URL</span>. Restart the dev
          server after editing.
        </p>
      )}
      <p className="mt-1.5 text-xs">
        Currently on {providerLabel(provider)}. Switch vendors with{" "}
        <span className="font-mono">VOICE_PROVIDER=twilio</span> or{" "}
        <span className="font-mono">VOICE_PROVIDER=vapi</span> in the same file.
      </p>
      <details className="mt-1.5">
        <summary className="cursor-pointer text-xs underline underline-offset-4">
          Server message
        </summary>
        <p className="mt-1 text-xs break-words">{detail}</p>
      </details>
    </div>
  );
}

function ErrorNote({ text }: { text: string }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300"
    >
      {text}
    </p>
  );
}

export default function PhonePanel({
  agentId,
  agentName,
  ready,
}: {
  agentId: string;
  agentName: string;
  ready: boolean;
}) {
  const router = useRouter();

  const [phoneNumber, setPhoneNumber] = useState("");
  const [calling, setCalling] = useState(false);
  const [callNotice, setCallNotice] = useState<Notice | null>(null);

  const [config, setConfig] = useState<PhoneConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [inboundNotice, setInboundNotice] = useState<Notice | null>(null);
  const [toggling, setToggling] = useState(false);

  // Which vendor is carrying calls. Only known once the config lands, so hints
  // raised before then fall back to the default rather than guessing wrong.
  const activeProvider = config?.provider ?? DEFAULT_PROVIDER;

  /** Deliberately does not flip `configLoading` on — that starts true, and
   *  touching state synchronously from an effect is not allowed. */
  const loadConfig = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(`/api/agents/${agentId}/phone`, { signal });
        if (signal?.aborted) return;

        if (!res.ok) {
          const message = await readError(res, "Loading the phone number");
          if (signal?.aborted) return;
          // A missing-env-var 500 says the same thing as `configured: false`,
          // so show the calm "not set up" state rather than shouting.
          if (isNotConfigured(res.status, message)) {
            setConfig({
              number: null,
              enabled: false,
              configured: false,
              provider: providerFromMessage(message, DEFAULT_PROVIDER),
            });
            setInboundNotice(null);
            return;
          }
          setConfig(null);
          setInboundNotice({ kind: "error", text: message });
          return;
        }

        const data = (await res.json()) as Partial<PhoneConfig> | null;
        if (signal?.aborted) return;
        setConfig({
          number: typeof data?.number === "string" ? data.number : null,
          enabled: data?.enabled === true,
          // Absent `configured` means the route got far enough to reach the
          // provider — only an explicit `false` is "never set up".
          configured: data?.configured !== false,
          provider: readProvider(data?.provider),
        });
        setInboundNotice(null);
      } catch {
        if (signal?.aborted) return;
        setInboundNotice({
          kind: "error",
          text: "Could not reach the server. Check the app is running.",
        });
      } finally {
        if (!signal?.aborted) setConfigLoading(false);
      }
    },
    [agentId]
  );

  // The load is kicked off from a task rather than the effect body: the lint
  // rules reject a setState the compiler can reach synchronously from an
  // effect, even one behind an `await`.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void loadConfig(controller.signal);
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [loadConfig]);

  function retryConfig() {
    if (configLoading) return;
    setConfigLoading(true);
    setInboundNotice(null);
    void loadConfig();
  }

  async function placeCall(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = phoneNumber.trim();
    if (!target || calling || !ready) return;

    setCalling(true);
    setCallNotice(null);

    try {
      const res = await fetch(`/api/agents/${agentId}/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: target }),
      });

      if (!res.ok) {
        const message = await readError(res, "The call");
        setCallNotice(
          isNotConfigured(res.status, message)
            ? {
                kind: "setup",
                text: message,
                provider: providerFromMessage(message, activeProvider),
              }
            : { kind: "error", text: message }
        );
        return;
      }

      setCallNotice({
        kind: "success",
        text: `Calling ${target}… your phone should ring shortly.`,
      });
      // The call row exists now — pull it into the server-rendered history.
      router.refresh();
    } catch {
      setCallNotice({
        kind: "error",
        text: "Could not reach the server. Check the app is running.",
      });
    } finally {
      setCalling(false);
    }
  }

  async function toggleInbound() {
    if (toggling || !config) return;
    const next = !config.enabled;

    setToggling(true);
    setInboundNotice(null);

    try {
      const res = await fetch(`/api/agents/${agentId}/phone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });

      if (!res.ok) {
        const message = await readError(res, "The update");
        setInboundNotice(
          isNotConfigured(res.status, message)
            ? {
                kind: "setup",
                text: message,
                provider: providerFromMessage(message, config.provider),
              }
            : { kind: "error", text: message }
        );
        return;
      }

      const data = (await res.json()) as { number?: unknown } | null;
      setConfig({
        number: typeof data?.number === "string" ? data.number : null,
        enabled: next,
        configured: true,
        provider: config.provider,
      });
    } catch {
      setInboundNotice({
        kind: "error",
        text: "Could not reach the server. Check the app is running.",
      });
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-6">
      {/* --- Outbound ------------------------------------------------- */}
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <h3 className="text-sm font-medium">Call me</h3>
          {config && (
            <span
              className="text-xs text-neutral-500 dark:text-neutral-400"
              title={`Calls on this app go through ${providerLabel(config.provider)} (VOICE_PROVIDER=${config.provider}).`}
            >
              via {providerLabel(config.provider)}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {agentName} rings your phone and picks up the conversation there.
        </p>

        <form onSubmit={placeCall} className="mt-3 flex flex-wrap gap-2">
          <input
            type="tel"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="+14155551234"
            aria-label="Your phone number"
            autoComplete="tel"
            className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-transparent px-3 py-2 font-mono text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:placeholder:text-neutral-600 dark:focus:border-neutral-300"
          />
          <button
            type="submit"
            disabled={calling || !ready || phoneNumber.trim().length === 0}
            title={ready ? `Have ${agentName} call you` : NOT_READY_NOTE}
            className="shrink-0 rounded-md bg-neutral-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300 disabled:text-neutral-500 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 dark:disabled:bg-neutral-800 dark:disabled:text-neutral-500"
          >
            {calling ? "Dialling…" : "Call me"}
          </button>
        </form>

        <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          {E164_HINT}
        </p>
        {!ready && (
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {NOT_READY_NOTE}
          </p>
        )}

        {callNotice && (
          <div className="mt-3">
            {callNotice.kind === "setup" ? (
              <SetupHint
                detail={callNotice.text}
                provider={callNotice.provider}
              />
            ) : callNotice.kind === "error" ? (
              <ErrorNote text={callNotice.text} />
            ) : (
              <p
                role="status"
                className="rounded-md border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-500/40 dark:bg-green-500/10 dark:text-green-300"
              >
                {callNotice.text}
              </p>
            )}
          </div>
        )}
      </div>

      {/* --- Inbound -------------------------------------------------- */}
      <div className="border-t border-neutral-200 pt-6 dark:border-neutral-800">
        <h3 className="text-sm font-medium">Incoming calls</h3>

        {configLoading ? (
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Checking the phone number…
          </p>
        ) : config === null ? (
          <div className="mt-2 flex flex-col items-start gap-2">
            <ErrorNote
              text={inboundNotice?.text ?? "Could not load the phone number."}
            />
            <button
              type="button"
              onClick={retryConfig}
              className="text-xs text-neutral-500 underline underline-offset-4 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
            >
              Try again
            </button>
          </div>
        ) : !config.configured ? (
          <div className="mt-1">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Not set up yet — no phone number is connected to this app.
            </p>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              Add your {providerLabel(config.provider)} credentials and{" "}
              {config.provider === "twilio"
                ? "the two public URLs"
                : "the public URL"}{" "}
              to <span className="font-mono">.env.local</span> to answer real
              calls.
            </p>
          </div>
        ) : (
          <div className="mt-1 flex flex-col items-start gap-3">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              There is one phone number in this app, and exactly one agent
              answers it.
            </p>

            {config.enabled ? (
              <div>
                <p className="font-mono text-lg tracking-tight">
                  {config.number ?? "number unavailable"}
                </p>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  Calling this number reaches {agentName}.
                </p>
              </div>
            ) : config.number ? (
              <div>
                <p className="font-mono text-sm text-neutral-500 dark:text-neutral-400">
                  {config.number}
                </p>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  Currently answering as a different agent. Turning this on
                  takes the number from that agent.
                </p>
              </div>
            ) : (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                Not answering calls yet.
              </p>
            )}

            <button
              type="button"
              onClick={toggleInbound}
              disabled={toggling}
              aria-pressed={config.enabled}
              className={
                config.enabled
                  ? "rounded-md border border-neutral-300 px-3 py-2 text-sm transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                  : "rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
              }
            >
              {toggling
                ? "Saving…"
                : config.enabled
                  ? "Stop answering calls"
                  : `Answer calls as ${agentName}`}
            </button>

            {inboundNotice &&
              (inboundNotice.kind === "setup" ? (
                <SetupHint
                  detail={inboundNotice.text}
                  provider={inboundNotice.provider}
                />
              ) : (
                <ErrorNote text={inboundNotice.text} />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
