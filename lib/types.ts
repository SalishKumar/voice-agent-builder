export type AgentStatus = "building" | "ready" | "failed";

export interface Agent {
  id: string;
  name: string;
  prompt: string;
  status: AgentStatus;
  error: string | null;
  /** Vapi's assistant id. Null under any other provider. */
  vapi_assistant_id: string | null;
  created_at: number; // Date.now()
}

export interface AgentFile {
  id: string;
  agent_id: string;
  filename: string;
  path: string;
  bytes: number;
}

export interface Chunk {
  id: string;
  agent_id: string;
  file_id: string;
  content: string;
  embedding: Float32Array;
}

export type CallDirection = "outbound" | "inbound";

/**
 * A phone call placed or received through a voice provider.
 *
 * `provider` is the vendor that carried it and `provider_call_id` their id for
 * it (Twilio's `CallSid`, Vapi's call id); the pair is how a webhook or media
 * stream finds the row again.
 *
 * `status` mirrors the vendor's own call status ("queued" | "ringing" |
 * "in-progress" | "completed" | "failed" for Twilio) and is stored as a plain
 * string so an unexpected value from a webhook is recorded rather than
 * rejected.
 */
export interface Call {
  id: string;
  agent_id: string;
  provider: string | null;
  provider_call_id: string | null;
  direction: CallDirection;
  phone_number: string | null;
  status: string;
  summary: string | null;
  transcript: string | null;
  recording_url: string | null;
  duration_seconds: number | null;
  created_at: number; // Date.now()
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  reply: string;
  sources: { file: string; score: number }[];
}
