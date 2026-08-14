import {
  ENDPOINTING_MS,
  MULAW_BYTES_PER_SECOND,
  UTTERANCE_END_MS,
  type SttHandlers,
  type SttStream,
  type TtsHandlers,
  type TtsStream,
  type VoiceProviders,
} from "../lib/deepgram";

/**
 * Offline stand-ins for Deepgram, enabled with `VOICE_FAKE_PROVIDERS=1`.
 *
 * These exist so the pipeline — turn taking, barge-in, mark bookkeeping, call
 * records, teardown — can be driven end to end without a Deepgram account, and
 * so those behaviours can be tested deterministically rather than against a
 * paid network service with its own timing.
 *
 * The recogniser is not a stub that fires transcripts on a timer. It decodes
 * the μ-law it is given and keys off actual audio energy, so a caller's speech
 * has to genuinely be present, and for long enough, before a transcript appears.
 * That is what makes the barge-in and false-trigger tests mean something: a
 * short noise burst produces a one-word interim and is correctly ignored, while
 * a couple of seconds of speech produces enough words to interrupt.
 */

export function fakeProvidersEnabled(): boolean {
  return process.env.VOICE_FAKE_PROVIDERS === "1";
}

// ---------------------------------------------------------------------------
// G.711 μ-law
// ---------------------------------------------------------------------------

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

/** Digital silence in μ-law. */
export const MULAW_SILENCE = 0xff;

export function linearToMulaw(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  const magnitude = Math.min(Math.abs(sample), MULAW_CLIP) + MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (magnitude & mask) === 0 && exponent > 0; exponent--) {
    mask >>= 1;
  }
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function mulawToLinear(byte: number): number {
  const inverted = ~byte & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  const magnitude = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
  return sign ? -magnitude : magnitude;
}

/** μ-law 8 kHz of a plain tone — stands in for a synthesised sentence. */
export function mulawTone(durationMs: number, hz = 220): Buffer {
  const samples = Math.max(1, Math.round((durationMs / 1000) * MULAW_BYTES_PER_SECOND));
  const buffer = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(
      8000 * Math.sin((2 * Math.PI * hz * i) / MULAW_BYTES_PER_SECOND)
    );
    buffer[i] = linearToMulaw(value);
  }
  return buffer;
}

export function mulawSilence(durationMs: number): Buffer {
  const samples = Math.max(1, Math.round((durationMs / 1000) * MULAW_BYTES_PER_SECOND));
  return Buffer.alloc(samples, MULAW_SILENCE);
}

// ---------------------------------------------------------------------------
// Recogniser
// ---------------------------------------------------------------------------

/** 20 ms of μ-law at 8 kHz, the size Twilio sends. */
const FRAME_BYTES = 160;
const FRAME_MS = (FRAME_BYTES / MULAW_BYTES_PER_SECOND) * 1000;

/** Mean absolute amplitude above which a frame counts as speech. */
const SPEECH_THRESHOLD = 800;

/** How much continuous speech each transcribed word is worth. */
const MS_PER_WORD = 200;

/** How often, in speech milliseconds, an interim result is emitted. */
const INTERIM_EVERY_MS = 100;

const DEFAULT_SCRIPT = ["I run a dental practice, what does this cost?"];

function script(): string[] {
  const raw = process.env.FAKE_STT_SCRIPT;
  if (!raw) return DEFAULT_SCRIPT;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
      return parsed as string[];
    }
  } catch {
    // Fall through to the default rather than failing a call over a test knob.
  }
  return DEFAULT_SCRIPT;
}

function openFakeStt(handlers: SttHandlers): Promise<SttStream> {
  const phrases = script();
  let phraseIndex = 0;

  let pending: Buffer = Buffer.alloc(0);
  let speechMs = 0;
  let silenceMs = 0;
  let lastInterimAt = 0;
  let utteranceEndSent = true;
  let closed = false;

  const phrase = () => phrases[Math.min(phraseIndex, phrases.length - 1)] ?? "";
  const wordsFor = (ms: number) => {
    const all = phrase().split(/\s+/).filter(Boolean);
    const count = Math.min(all.length, Math.floor(ms / MS_PER_WORD));
    return all.slice(0, count).join(" ");
  };

  const frameIsSpeech = (frame: Buffer) => {
    let total = 0;
    for (const byte of frame) total += Math.abs(mulawToLinear(byte));
    return total / frame.length > SPEECH_THRESHOLD;
  };

  const endUtterance = () => {
    const text = wordsFor(speechMs);
    speechMs = 0;
    if (!text) return;
    handlers.onTranscript({
      text,
      isFinal: true,
      speechFinal: true,
      confidence: 0.95,
    });
    phraseIndex += 1;
  };

  const consume = (frame: Buffer) => {
    if (frameIsSpeech(frame)) {
      if (silenceMs > 0 && speechMs === 0) utteranceEndSent = false;
      silenceMs = 0;
      speechMs += FRAME_MS;
      utteranceEndSent = false;

      if (speechMs - lastInterimAt >= INTERIM_EVERY_MS) {
        lastInterimAt = speechMs;
        const text = wordsFor(speechMs);
        if (text) {
          handlers.onTranscript({
            text,
            isFinal: false,
            speechFinal: false,
            confidence: 0.9,
          });
        }
      }
      return;
    }

    silenceMs += FRAME_MS;
    lastInterimAt = 0;

    if (speechMs > 0 && silenceMs >= ENDPOINTING_MS) endUtterance();
    if (!utteranceEndSent && silenceMs >= UTTERANCE_END_MS) {
      utteranceEndSent = true;
      handlers.onUtteranceEnd();
    }
  };

  const stream: SttStream = {
    send(audio) {
      if (closed) return;
      pending = pending.length === 0 ? audio : Buffer.concat([pending, audio]);
      while (pending.length >= FRAME_BYTES) {
        consume(pending.subarray(0, FRAME_BYTES));
        pending = pending.subarray(FRAME_BYTES);
      }
    },
    keepAlive() {},
    close() {
      if (closed) return;
      closed = true;
      handlers.onClose("fake stt closed");
    },
  };

  handlers.onOpen?.();
  return Promise.resolve(stream);
}

// ---------------------------------------------------------------------------
// Synthesiser
// ---------------------------------------------------------------------------

/** Speaking rate used to size the generated audio for a sentence. */
const CHARS_PER_SECOND = 15;

/** μ-law bytes emitted per tick — Aura streams faster than real time too. */
const CHUNK_BYTES = 1600;

function openFakeTts(handlers: TtsHandlers): Promise<TtsStream> {
  let buffered: string[] = [];
  let closed = false;
  const timers = new Set<NodeJS.Timeout>();

  const emit = (audio: Buffer, done: () => void) => {
    let offset = 0;
    const step = () => {
      if (closed) return;
      if (offset >= audio.length) {
        done();
        return;
      }
      handlers.onAudio(audio.subarray(offset, offset + CHUNK_BYTES));
      offset += CHUNK_BYTES;
      const timer = setTimeout(step, 1);
      timers.add(timer);
    };
    step();
  };

  const stream: TtsStream = {
    speak(text) {
      if (!closed) buffered.push(text);
    },
    flush() {
      if (closed) return;
      const text = buffered.join(" ");
      buffered = [];
      const durationMs = Math.max(
        200,
        (text.length / CHARS_PER_SECOND) * 1000
      );
      emit(mulawTone(durationMs), () => handlers.onFlushed());
    },
    clear() {
      buffered = [];
    },
    close() {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      handlers.onClose("fake tts closed");
    },
  };

  handlers.onOpen?.();
  return Promise.resolve(stream);
}

export const fakeProviders: VoiceProviders = {
  openStt: openFakeStt,
  openTts: openFakeTts,
};
