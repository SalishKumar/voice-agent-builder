import { WebSocket } from "ws";

/**
 * Deepgram clients for the phone pipeline: streaming speech-to-text in,
 * streaming Aura text-to-speech out.
 *
 * The one thing to understand about this file is that **nothing here transcodes
 * audio**. Twilio hands us base64 μ-law at 8 kHz; Deepgram's listen socket is
 * opened with `encoding=mulaw&sample_rate=8000`, so the decoded bytes go
 * straight up the wire. Aura is asked for `encoding=mulaw&sample_rate=8000`, so
 * its bytes go straight back down to Twilio. A resampler anywhere in this path
 * would be a bug, not an optimisation.
 *
 * Parameters below were taken from Deepgram's reference, not from memory:
 *   listen: https://developers.deepgram.com/reference/speech-to-text-api/listen-streaming
 *   endpointing / utterance_end_ms:
 *           https://developers.deepgram.com/docs/understanding-end-of-speech-detection
 *   speak:  https://developers.deepgram.com/reference/text-to-speech-api/speak-streaming
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Deepgram's reference lists `nova-2` and `nova-3` as current streaming models.
 * `nova-3` is the current flagship and handles 8 kHz telephony audio, so it is
 * the default; `nova-2-phonecall` is the fallback worth trying if accuracy on
 * real calls disappoints.
 */
export const STT_MODEL = process.env.DEEPGRAM_STT_MODEL ?? "nova-3";

/** Aura voice. Deepgram's own Node example uses `aura-2-thalia-en`. */
export const TTS_MODEL = process.env.DEEPGRAM_TTS_MODEL ?? "aura-2-thalia-en";

/**
 * Silence (per Deepgram's VAD) after which a transcript comes back with
 * `speech_final: true`. Low, because on a phone call a held pause reads as
 * "your turn" and every extra millisecond here is dead air.
 */
export const ENDPOINTING_MS = Number(process.env.DEEPGRAM_ENDPOINTING_MS ?? 300);

/**
 * Gap between word timings after which Deepgram sends a separate `UtteranceEnd`
 * event. Deepgram documents 1000 ms as the recommended minimum. This is the
 * safety net for when the VAD never fires `speech_final` — see the pipeline's
 * turn detection, which listens for both.
 */
export const UTTERANCE_END_MS = Number(
  process.env.DEEPGRAM_UTTERANCE_END_MS ?? 1000
);

/** μ-law at 8 kHz is exactly one byte per sample. */
export const MULAW_BYTES_PER_SECOND = 8000;

const DEEPGRAM_WS_BASE = "wss://api.deepgram.com";

export class MissingDeepgramKeyError extends Error {}

export function getDeepgramKey(): string {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    throw new MissingDeepgramKeyError(
      "DEEPGRAM_API_KEY is not set. Copy .env.example to .env.local and add your key."
    );
  }
  return key;
}

export function hasDeepgramKey(): boolean {
  return Boolean(process.env.DEEPGRAM_API_KEY);
}

// ---------------------------------------------------------------------------
// Provider interfaces
// ---------------------------------------------------------------------------

/** One transcript update from the recogniser. */
export interface Transcript {
  text: string;
  /** Deepgram will not revise this text further. */
  isFinal: boolean;
  /** Deepgram's VAD saw the speaker stop. End of turn. */
  speechFinal: boolean;
  confidence: number;
}

export interface SttHandlers {
  onTranscript(transcript: Transcript): void;
  /** The separate `UtteranceEnd` event; fires on word-gap timing, not the VAD. */
  onUtteranceEnd(): void;
  onOpen?(): void;
  onClose(reason: string): void;
  onError(error: Error): void;
}

export interface SttStream {
  /** Raw μ-law 8 kHz bytes, exactly as they arrived from Twilio. */
  send(audio: Buffer): void;
  /** Deepgram drops an idle listen socket; this keeps it up through silence. */
  keepAlive(): void;
  close(): void;
}

export interface TtsHandlers {
  /** Raw μ-law 8 kHz bytes, ready to base64 and hand to Twilio. */
  onAudio(audio: Buffer): void;
  /** Everything sent before the matching `flush()` has now been synthesised. */
  onFlushed(): void;
  onOpen?(): void;
  onClose(reason: string): void;
  onError(error: Error): void;
}

export interface TtsStream {
  speak(text: string): void;
  /** Tell Aura to synthesise what it has buffered rather than wait for more. */
  flush(): void;
  /**
   * Ask Aura to drop what it has buffered.
   *
   * Part of Aura's vocabulary, but the pipeline deliberately does not use it on
   * barge-in: `Flushed` messages carry no sentence identity, so a cancellation
   * that silently skips one would slide every later `Flushed` onto the wrong
   * sentence. See the queue comment in server/pipeline.ts.
   */
  clear(): void;
  close(): void;
}

/** Both providers, so the pipeline can be handed test doubles. */
export interface VoiceProviders {
  openStt(handlers: SttHandlers): Promise<SttStream>;
  openTts(handlers: TtsHandlers): Promise<TtsStream>;
}

// ---------------------------------------------------------------------------
// Speech to text
// ---------------------------------------------------------------------------

/**
 * Open a live transcription socket for one call.
 *
 * `interim_results` is on because barge-in detection cannot wait for a final,
 * and because Deepgram requires it for `utterance_end_ms` to work at all.
 */
export async function openDeepgramStt(
  handlers: SttHandlers
): Promise<SttStream> {
  // Deliberately NOT the @deepgram/sdk listen socket. As of v5.8.0
  // `client.listen.v1.connect()` resolves with a socket whose readyState is
  // already 3 (CLOSED): its "open" event never fires and every sendMedia()
  // throws "Socket is not open.". Verified against the live API — a raw
  // WebSocket with identical query parameters connects and streams transcripts
  // fine. The TTS side avoids the same SDK for its own reasons (it JSON-parses
  // binary frames and throws out of an event listener), so both halves here
  // talk to Deepgram directly.
  const query = new URLSearchParams({
    model: STT_MODEL,
    language: "en-US",
    encoding: "mulaw",
    sample_rate: "8000",
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
    endpointing: String(ENDPOINTING_MS),
    utterance_end_ms: String(UTTERANCE_END_MS),
    vad_events: "true",
  });

  const socket = new WebSocket(`${DEEPGRAM_WS_BASE}/v1/listen?${query}`, {
    headers: { Authorization: `Token ${getDeepgramKey()}` },
  });

  let closed = false;

  // Twilio streams audio the instant the call connects, but this socket needs
  // a moment to finish its handshake. Without buffering, the caller's opening
  // words are dropped — which sounds exactly like the agent ignoring them.
  // Frames are 20ms, so the cap is roughly four seconds of speech.
  const MAX_PENDING_FRAMES = 200;
  let ready = false;
  let pending: Buffer[] = [];

  socket.on("open", () => {
    ready = true;
    const queued = pending;
    pending = [];
    for (const frame of queued) {
      if (socket.readyState !== WebSocket.OPEN) break;
      socket.send(frame);
    }
    handlers.onOpen?.();
  });

  socket.on("message", (raw: WebSocket.RawData) => {
    let message: DeepgramSttMessage;
    try {
      message = JSON.parse(raw.toString()) as DeepgramSttMessage;
    } catch {
      return;
    }

    if (message.type === "Results") {
      const alternative = message.channel?.alternatives?.[0];
      if (!alternative) return;
      handlers.onTranscript({
        text: alternative.transcript ?? "",
        isFinal: message.is_final === true,
        speechFinal: message.speech_final === true,
        confidence: alternative.confidence ?? 0,
      });
      return;
    }

    if (message.type === "UtteranceEnd") handlers.onUtteranceEnd();
  });

  socket.on("error", (error: Error) => handlers.onError(error));
  socket.on("close", (code: number, reason: Buffer) =>
    handlers.onClose(`code=${code} reason=${reason.toString() || "-"}`)
  );

  return {
    send(audio) {
      if (closed) return;
      if (!ready) {
        pending.push(audio);
        if (pending.length > MAX_PENDING_FRAMES) pending.shift();
        return;
      }
      if (socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(audio);
      } catch (error) {
        handlers.onError(toError(error));
      }
    },
    keepAlive() {
      if (closed || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(JSON.stringify({ type: "KeepAlive" }));
      } catch {
        // Best effort; a dead socket surfaces through onClose instead.
      }
    },
    close() {
      if (closed) return;
      closed = true;
      pending = [];
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "CloseStream" }));
        }
      } catch {
        // Already gone; closing is what matters.
      }
      socket.close();
    },
  };
}

/** Shape of the Deepgram listen messages we care about. */
interface DeepgramSttMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string; confidence?: number }[] };
}

// ---------------------------------------------------------------------------
// Text to speech
// ---------------------------------------------------------------------------

/**
 * Aura streaming, over a raw `ws` socket rather than the SDK's `speak.v1`
 * helper.
 *
 * That is a deliberate workaround, not a preference. The SDK's speak socket
 * runs every inbound frame through `JSON.parse`, and Aura's audio arrives as
 * binary frames — verified against the installed @deepgram/sdk 5.8.0 by feeding
 * its `V1Socket` a binary frame from a local server, which throws
 * `SyntaxError: Unexpected token 'o', "[object Blob]" is not valid JSON` out of
 * an event listener, i.e. an uncaught exception that kills the process mid-call.
 * Since the audio path is the entire point of this socket, we own it directly.
 *
 * The message vocabulary is Deepgram's, unchanged: `Speak`, `Flush`, `Clear`,
 * `Close` out; binary audio plus `Metadata` / `Flushed` / `Cleared` / `Warning`
 * back.
 */
export async function openDeepgramTts(
  handlers: TtsHandlers
): Promise<TtsStream> {
  const key = getDeepgramKey();
  const url = new URL("/v1/speak", DEEPGRAM_WS_BASE);
  url.searchParams.set("model", TTS_MODEL);
  url.searchParams.set("encoding", "mulaw");
  url.searchParams.set("sample_rate", "8000");

  const socket = new WebSocket(url, {
    headers: { Authorization: `Token ${key}` },
  });

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      handlers.onAudio(toBuffer(data));
      return;
    }
    let message: { type?: string; description?: string; code?: string };
    try {
      message = JSON.parse(toBuffer(data).toString("utf8"));
    } catch {
      return;
    }
    if (message.type === "Flushed") handlers.onFlushed();
    else if (message.type === "Warning") {
      handlers.onError(
        new Error(`Aura warning ${message.code}: ${message.description}`)
      );
    }
  });

  socket.on("error", (error) => handlers.onError(toError(error)));
  socket.on("close", (code, reason) =>
    handlers.onClose(`code=${code} reason=${reason.toString() || "-"}`)
  );

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      handlers.onOpen?.();
      resolve();
    });
    socket.once("error", reject);
  });

  const sendJson = (payload: unknown) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  };

  return {
    speak(text) {
      sendJson({ type: "Speak", text });
    },
    flush() {
      sendJson({ type: "Flush" });
    },
    clear() {
      sendJson({ type: "Clear" });
    },
    close() {
      sendJson({ type: "Close" });
      socket.close();
    },
  };
}

export const deepgramProviders: VoiceProviders = {
  openStt: openDeepgramStt,
  openTts: openDeepgramTts,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
