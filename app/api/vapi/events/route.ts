import {
  createCall,
  getCallByProviderId,
  updateCallByProviderId,
  type CallPatch,
} from "@/lib/db";
import { agentIdForAssistant, verifyVapiSecret } from "@/lib/voice/vapi";

// better-sqlite3 is a native module and cannot run on the edge runtime.
export const runtime = "nodejs";

/**
 * Vapi's server webhook: what happened on a call it carried.
 *
 * Two rules govern the responses here:
 * - Verify the shared secret before anything else. Unguarded, this endpoint
 *   would let anyone rewrite any call's transcript.
 * - Answer 200 to everything we accept, including event types we do nothing
 *   with. Vapi retries a non-2xx, so a 404 for "we don't handle that one" turns
 *   an unremarkable event into a permanent retry loop.
 *
 * Only "status-update" and "end-of-call-report" are subscribed to (see
 * `serverMessages` in lib/voice/vapi.ts), but the assistant's configuration can
 * be changed from Vapi's dashboard, so everything else is tolerated rather than
 * assumed impossible.
 */

const PROVIDER = "vapi";

interface VapiEventMessage {
  type?: unknown;
  status?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  endedReason?: unknown;
  analysis?: { summary?: unknown } | null;
  artifact?: { transcript?: unknown; recordingUrl?: unknown } | null;
  call?: {
    id?: unknown;
    assistantId?: unknown;
    customer?: { number?: unknown } | null;
  } | null;
}

function ok(): Response {
  return Response.json({ received: true });
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * How long the call lasted.
 *
 * Vapi's report carries no duration field, only ISO 8601 timestamps, so it is
 * derived. Anything unparseable — or a pair that runs backwards — is left null
 * rather than stored as a nonsense number.
 */
function durationSeconds(startedAt: unknown, endedAt: unknown): number | null {
  const start = Date.parse(str(startedAt) ?? "");
  const end = Date.parse(str(endedAt) ?? "");
  if (Number.isNaN(start) || Number.isNaN(end)) return null;

  const seconds = Math.round((end - start) / 1000);
  return seconds >= 0 ? seconds : null;
}

/**
 * Make sure there is a row for this call, and report whether there is one now.
 *
 * Outbound calls already have a row, written when the call was placed. Inbound
 * ones do not: nothing in this app knows about them until Vapi says so, so the
 * first event creates the row. The agent is recovered from the assistant that
 * answered — the only link back to us the payload carries.
 *
 * An unresolvable assistant is logged and swallowed. It means a call answered
 * by an assistant this app did not create (or created before the database was
 * reset), which is not something a retry will fix.
 */
function ensureCall(callId: string, message: VapiEventMessage): boolean {
  if (getCallByProviderId(PROVIDER, callId)) return true;

  const assistantId = str(message.call?.assistantId);
  const agentId = agentIdForAssistant(assistantId);

  if (!agentId) {
    console.warn(
      `[vapi] event for unknown call ${callId} ` +
        `(assistant ${assistantId ?? "none"}); ignoring it`
    );
    return false;
  }

  createCall({
    agentId,
    provider: PROVIDER,
    providerCallId: callId,
    direction: "inbound",
    phoneNumber: str(message.call?.customer?.number),
    status: str(message.status) ?? "in-progress",
  });

  return true;
}

function applyPatch(
  callId: string,
  message: VapiEventMessage,
  patch: Partial<CallPatch>
): Response {
  if (!ensureCall(callId, message)) return ok();
  updateCallByProviderId(PROVIDER, callId, patch);
  return ok();
}

export async function POST(request: Request) {
  if (!verifyVapiSecret(request)) {
    console.warn("[vapi] rejected an event with a bad or missing secret");
    return Response.json({ error: "Invalid Vapi secret" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const message =
    typeof body === "object" && body !== null
      ? ((body as { message?: unknown }).message as VapiEventMessage | undefined)
      : undefined;

  if (typeof message !== "object" || message === null) return ok();

  const type = str(message.type);
  const callId = str(message.call?.id);

  // Every handled event identifies its call; one that does not is nothing we
  // can act on, and retrying will not add an id.
  if (!callId) {
    if (type === "status-update" || type === "end-of-call-report") {
      console.warn(`[vapi] ${type} arrived with no call id; ignoring it`);
    }
    return ok();
  }

  switch (type) {
    case "status-update": {
      const status = str(message.status);
      if (!status) return ok();
      return applyPatch(callId, message, { status });
    }

    case "end-of-call-report": {
      return applyPatch(callId, message, {
        // The report only exists because the call is over. The vendor's own
        // vocabulary for that is "ended", which is what the status updates use
        // and what the call history renders.
        status: "ended",
        summary: str(message.analysis?.summary),
        transcript: str(message.artifact?.transcript),
        // Null unless artifactPlan.recordingEnabled is set on the assistant,
        // which it is not: recording a caller has consent implications this app
        // has not dealt with.
        recordingUrl: str(message.artifact?.recordingUrl),
        durationSeconds: durationSeconds(message.startedAt, message.endedAt),
      });
    }

    default:
      // "speech-update", "conversation-update", "hang", "tool-calls", … —
      // accepted and dropped, so Vapi stops resending them.
      return ok();
  }
}
