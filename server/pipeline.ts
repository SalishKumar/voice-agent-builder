import {
  createCall,
  getAgent,
  getCallByProviderId,
  updateCallByProviderId,
} from "../lib/db";
import { CHAT_MODEL, getOpenAI } from "../lib/openai";
import { buildGroundedPrompt } from "../lib/prompt";
import {
  MULAW_BYTES_PER_SECOND,
  deepgramProviders,
  type SttStream,
  type Transcript,
  type TtsStream,
  type VoiceProviders,
} from "../lib/deepgram";
import type { Agent } from "../lib/types";
import type { MediaSession, MediaSink, Pipeline } from "./ws-server";

/**
 * The voice pipeline: Deepgram speech-to-text in, OpenAI in the middle,
 * Deepgram Aura text-to-speech out, over one Twilio media stream.
 *
 * Everything here is arranged around one number — the gap between the caller
 * finishing a sentence and hearing the first syllable of the answer. The three
 * things that actually move it are: never transcoding audio (see lib/deepgram),
 * starting synthesis at the first sentence boundary rather than waiting for the
 * whole completion, and keeping the system prompt small.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Barge-in guards. A cough, a door closing, or one garbled interim must not cut
 * the agent off mid-sentence — but a real interruption has to land within a
 * couple of hundred milliseconds or the agent feels deaf. These thresholds are
 * the dial between those two failures and are expected to need tuning against
 * real calls, hence the env overrides.
 */
/**
 * The synthetic first "turn". The caller has said nothing yet; this tells the
 * model the line just opened so it produces its own opening line from the
 * agent's prompt rather than a hardcoded one.
 */
const CALL_CONNECTED =
  "[The phone call has just connected and the caller is listening. " +
  "Say your opening line now, in one or two sentences.]";

export const BARGE_IN_MIN_WORDS = Number(process.env.BARGE_IN_MIN_WORDS ?? 2);
export const BARGE_IN_MIN_CHARS = Number(process.env.BARGE_IN_MIN_CHARS ?? 5);
export const BARGE_IN_MIN_CONFIDENCE = Number(
  process.env.BARGE_IN_MIN_CONFIDENCE ?? 0.6
);

/** Conversation turns kept in front of the model, user and assistant combined. */
export const HISTORY_MAX_TURNS = 20;

/**
 * The first chunk of a reply goes to Aura as soon as there is a clause worth
 * speaking; later chunks wait for a fuller sentence, because by then the caller
 * is already listening and choppy phrasing costs more than the milliseconds do.
 */
export const FIRST_FLUSH_MIN_CHARS = 18;
export const FLUSH_MIN_CHARS = 45;

/** A model that never punctuates must not buy itself unbounded silence. */
export const MAX_CHUNK_CHARS = 240;

/** Deepgram closes an idle listen socket; Twilio can go quiet between frames. */
const KEEPALIVE_MS = 5_000;

const SENTENCE_BOUNDARY = /[.?!]["'”’)\]]?(?=\s|$)/;
const CLAUSE_BOUNDARY = /[,;:](?=\s)/;

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/** End index of the first match at or beyond `minChars`, or null. */
function boundaryAt(
  text: string,
  pattern: RegExp,
  minChars: number
): number | null {
  const re = new RegExp(pattern.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (end >= minChars) return end;
  }
  return null;
}

/**
 * Split the longest speakable prefix off the front of a partially streamed
 * reply, or return null if it is not worth speaking yet.
 *
 * Exported because these boundary rules are the whole latency trick and deserve
 * testing directly rather than through a socket.
 */
export function nextChunk(
  buffer: string,
  minChars: number,
  allowClause: boolean
): { chunk: string; rest: string } | null {
  const split = (at: number) => {
    const chunk = buffer.slice(0, at).trim();
    if (!chunk) return null;
    return { chunk, rest: buffer.slice(at).trimStart() };
  };

  const sentence = boundaryAt(buffer, SENTENCE_BOUNDARY, minChars);
  if (sentence !== null) return split(sentence);

  if (allowClause) {
    const clause = boundaryAt(buffer, CLAUSE_BOUNDARY, minChars);
    if (clause !== null) return split(clause);
  }

  if (buffer.length >= MAX_CHUNK_CHARS) {
    const space = buffer.lastIndexOf(" ", MAX_CHUNK_CHARS);
    if (space > 0) return split(space);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** One sentence handed to Aura, awaiting audio and then a played-back mark. */
interface SpokenChunk {
  turn: number;
  mark: string;
  text: string;
}

type State = "idle" | "listening" | "thinking" | "speaking";

class CallPipeline implements Pipeline {
  private readonly session: MediaSession;
  private readonly out: MediaSink;
  private readonly providers: VoiceProviders;

  private agent: Agent | null = null;
  private stt: SttStream | null = null;
  private tts: TtsStream | null = null;
  private keepAlive: NodeJS.Timeout | null = null;

  private state: State = "idle";
  private closed = false;

  private readonly history: HistoryMessage[] = [];
  private readonly transcriptLines: string[] = [];

  /** `is_final` transcripts accumulated for the utterance in progress. */
  private finals: string[] = [];

  /**
   * Monotonic turn counter. Every async continuation captures it and bails once
   * it no longer matches — that is how an interrupted turn stops producing
   * audio without having to unwind the OpenAI and Aura streams in lockstep.
   */
  private turn = 0;

  private abort: AbortController | null = null;

  /**
   * Sentences handed to Aura, in the order Aura will answer them.
   *
   * This queue is deliberately *never* emptied out of order, including on
   * barge-in. Aura reports completion with a `Flushed` message that does not
   * name the sentence it belongs to, so position in this queue is the only
   * thing tying a `Flushed` back to the text it synthesised. Dropping entries
   * early would slide every later `Flushed` onto the wrong sentence and start
   * marking audio as played before it had been sent. Abandoned entries are left
   * in place and identified by a stale `turn`, which costs a little wasted
   * synthesis and buys an alignment that cannot drift.
   */
  private ttsQueue: SpokenChunk[] = [];

  /** Marks sent to Twilio that have not been echoed back, i.e. not yet heard. */
  private pendingMarks = new Map<string, SpokenChunk>();
  /** Chunk text Twilio has confirmed finished playing, for the current turn. */
  private heard: string[] = [];
  /** Everything the model produced this turn, heard or not. */
  private attempted = "";
  private replyComplete = false;
  private chunkSeq = 0;

  /** Latency bookkeeping for the turn in progress. */
  private utteranceEndAt: number | null = null;
  private firstAudioAt: number | null = null;

  constructor(session: MediaSession, out: MediaSink, providers: VoiceProviders) {
    this.session = session;
    this.out = out;
    this.providers = providers;
  }

  // -- lifecycle ------------------------------------------------------------

  async onStart(start: { callSid: string }): Promise<void> {
    const agent = getAgent(this.session.agentId);
    if (!agent) {
      this.log(`no agent ${this.session.agentId}; dropping the call`);
      this.out.close();
      return;
    }
    this.agent = agent;

    // An outbound call already has a row, written by POST /api/agents/[id]/call
    // before it dialled. Creating another here recorded every outbound call
    // twice — once correctly, once mislabelled inbound — so adopt the existing
    // row when there is one and only create for genuinely inbound calls.
    //
    // This pipeline is fed by Twilio's media stream, so the provider is not in
    // doubt: `start.callSid` is a Twilio `CallSid`.
    const existing = getCallByProviderId("twilio", start.callSid);
    if (existing) {
      updateCallByProviderId("twilio", start.callSid, {
        status: "in-progress",
      });
    } else {
      createCall({
        agentId: agent.id,
        provider: "twilio",
        providerCallId: start.callSid,
        direction: "inbound",
        phoneNumber: null,
        status: "in-progress",
      });
    }

    await Promise.all([this.openStt(), this.openTts()]);
    if (this.closed) return;

    this.keepAlive = setInterval(() => this.stt?.keepAlive(), KEEPALIVE_MS);
    this.state = "listening";

    // The TwiML says nothing, so without this the caller hears dead air on
    // pickup and hangs up before the pipeline has done anything at all.
    this.greet();
  }

  onAudio(payload: string): void {
    // Straight through: Twilio's base64 decodes to exactly the μ-law bytes the
    // Deepgram socket was opened to expect. There is nothing to convert.
    this.stt?.send(Buffer.from(payload, "base64"));
  }

  onDtmf(digit: string): void {
    this.transcriptLines.push(`User: [pressed ${digit}]`);
  }

  onMark(name: string): void {
    const chunk = this.pendingMarks.get(name);
    if (!chunk) return;
    this.pendingMarks.delete(name);
    if (chunk.turn === this.turn) this.heard.push(chunk.text);
    this.settleTurn(chunk.turn);
  }

  onStop(): void {
    if (this.closed) return;
    this.closed = true;
    this.state = "idle";

    this.abort?.abort();
    this.abort = null;
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    this.ttsQueue = [];
    this.pendingMarks.clear();

    try {
      this.stt?.close();
    } catch (error) {
      this.log(`closing stt failed: ${text(error)}`);
    }
    try {
      this.tts?.close();
    } catch (error) {
      this.log(`closing tts failed: ${text(error)}`);
    }
    this.stt = null;
    this.tts = null;

    // A hangup mid-reply leaves a turn that will never settle, and everything
    // the agent had said would otherwise never reach the transcript.
    this.finishTurn(this.turn, true);
    this.persist("ended");
  }

  // -- providers ------------------------------------------------------------

  private async openStt(): Promise<void> {
    try {
      this.stt = await this.providers.openStt({
        onTranscript: (t) => this.onTranscript(t),
        onUtteranceEnd: () => this.onUtteranceEnd(),
        onClose: (reason) => {
          // A recogniser that dies quietly is indistinguishable from an agent
          // that has stopped listening, so say so loudly.
          if (!this.closed) this.log(`STT SOCKET CLOSED mid-call: ${reason}`);
        },
        onError: (error) => this.log(`STT ERROR: ${error.message}`),
      });
    } catch (error) {
      this.log(`STT UNAVAILABLE: ${text(error)}`);
    }
  }

  private async openTts(): Promise<void> {
    try {
      this.tts = await this.providers.openTts({
        onAudio: (audio) => this.onTtsAudio(audio),
        onFlushed: () => this.onTtsFlushed(),
        onClose: (reason) => {
          if (!this.closed) this.log(`TTS SOCKET CLOSED mid-call: ${reason}`);
        },
        onError: (error) => this.log(`TTS ERROR: ${error.message}`),
      });
    } catch (error) {
      this.log(`TTS UNAVAILABLE: ${text(error)}`);
    }
  }

  // -- turn detection -------------------------------------------------------

  /**
   * Deepgram signals the end of a turn two different ways and neither is
   * reliable alone: `speech_final` comes from the VAD and gets missed when a
   * caller trails off, `UtteranceEnd` comes from word-gap timing and arrives
   * later. Both are handled here, and emptying `finals` is what stops one
   * utterance firing a turn twice when both signals land.
   */
  private onTranscript(t: Transcript): void {
    if (this.closed) return;

    // Runs before the transcript is filed, but does not consume it: the words
    // that interrupt the agent are the start of the caller's next utterance,
    // and Deepgram will send them again as a final.
    this.maybeBargeIn(t);

    const line = t.text.trim();
    if (!line) return;

    if (t.isFinal) this.finals.push(line);
    if (t.speechFinal) this.finishUtterance();
  }

  private onUtteranceEnd(): void {
    if (this.closed) return;
    this.finishUtterance();
  }

  private finishUtterance(): void {
    const transcript = this.finals.join(" ").trim();
    this.finals = [];
    if (!transcript) return;
    if (this.state === "thinking" || this.state === "speaking") return;

    this.utteranceEndAt = Date.now();
    void this.runTurn(transcript);
  }

  // -- barge-in -------------------------------------------------------------

  /**
   * Cut the agent off when the caller genuinely starts talking over it.
   *
   * Interim results are the only signal fast enough to act on and also the
   * noisiest, so a candidate has to clear all three guards. Confidence is only
   * checked when Deepgram supplies a non-zero one: early interims legitimately
   * report 0, and rejecting those would stop barge-in ever firing.
   */
  private maybeBargeIn(t: Transcript): boolean {
    if (this.state !== "speaking" && this.state !== "thinking") return false;

    const candidate = t.text.trim();
    if (candidate.length < BARGE_IN_MIN_CHARS) return false;
    if (candidate.split(/\s+/).filter(Boolean).length < BARGE_IN_MIN_WORDS) {
      return false;
    }
    if (t.confidence > 0 && t.confidence < BARGE_IN_MIN_CONFIDENCE) return false;

    this.bargeIn(candidate);
    return true;
  }

  private bargeIn(candidate: string): void {
    const interrupted = this.turn;
    this.log(`barge-in on "${candidate}"`);

    // Order matters: flush Twilio's buffer first so the caller stops hearing
    // the agent immediately, then stop producing anything more.
    this.out.clear();
    this.abort?.abort();
    this.abort = null;

    // Everything still awaiting a mark was in Twilio's buffer, which has just
    // been discarded, so none of it was heard.
    this.pendingMarks.clear();

    this.finishTurn(interrupted, true);

    // Invalidates every in-flight continuation for the interrupted turn. Audio
    // Aura is still producing for it gets dropped in onTtsAudio.
    this.turn += 1;
    this.state = "listening";
  }

  // -- the brain ------------------------------------------------------------

  /**
   * Open the call in the agent's own voice.
   *
   * A hardcoded greeting here ("Hi, you've reached <name>") made the agent
   * introduce itself twice with two different identities: once as the record's
   * name, then again in-persona as soon as the caller spoke. The opening line
   * belongs to the prompt, so it is generated the same way every other turn is
   * — the caller's first "turn" is simply the fact that the call connected.
   */
  private greet(): void {
    void this.runTurn(CALL_CONNECTED, { record: false });
  }

  private beginTurn(): void {
    this.turn += 1;
    this.state = "thinking";
    this.heard = [];
    this.attempted = "";
    this.replyComplete = false;
    this.firstAudioAt = null;
  }

  /**
   * `record: false` drives a turn the caller never actually said — currently
   * only the call-connected nudge that produces the greeting. The model needs
   * something in `history` to answer, but writing it into the transcript would
   * put words in the caller's mouth.
   */
  private async runTurn(
    transcript: string,
    { record = true }: { record?: boolean } = {}
  ): Promise<void> {
    this.history.push({ role: "user", content: transcript });
    if (record) this.transcriptLines.push(`User: ${transcript}`);
    this.trimHistory();
    if (record) this.log(`heard: ${transcript}`);

    this.beginTurn();
    const turn = this.turn;

    const abort = new AbortController();
    this.abort = abort;

    try {
      const groundingStartedAt = Date.now();
      const { system } = await buildGroundedPrompt(
        this.session.agentId,
        transcript
      );
      if (this.turn !== turn || this.closed) return;
      // Retrieval is a full embeddings round trip before the model has even
      // been asked anything, so it is worth seeing separately from the total.
      this.log(
        `grounding: ${Date.now() - groundingStartedAt}ms, ` +
          `system prompt ${system.length} chars`
      );

      const stream = await getOpenAI().chat.completions.create(
        {
          model: CHAT_MODEL,
          stream: true,
          messages: [{ role: "system", content: system }, ...this.history],
        },
        { signal: abort.signal }
      );

      let buffer = "";
      let first = true;

      for await (const part of stream) {
        if (this.turn !== turn || this.closed) return;
        const delta = part.choices[0]?.delta?.content;
        if (!delta) continue;

        buffer += delta;
        this.attempted += delta;

        for (;;) {
          const found = nextChunk(
            buffer,
            first ? FIRST_FLUSH_MIN_CHARS : FLUSH_MIN_CHARS,
            first
          );
          if (!found) break;
          this.speak(turn, found.chunk);
          buffer = found.rest;
          first = false;
        }
      }

      if (this.turn !== turn || this.closed) return;
      if (buffer.trim()) this.speak(turn, buffer.trim());

      this.replyComplete = true;
      this.settleTurn(turn);
    } catch (error) {
      if (this.turn !== turn || this.closed) return;
      if (isAbort(error)) return;
      this.log(`turn failed: ${text(error)}`);
      this.replyComplete = true;
      this.settleTurn(turn);
      this.state = "listening";
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  private trimHistory(): void {
    while (this.history.length > HISTORY_MAX_TURNS) this.history.shift();
  }

  /**
   * Close the books on a turn.
   *
   * The transcript and the history deliberately disagree about an interrupted
   * turn, because they answer different questions. The transcript is a record
   * for a human to read afterwards, so it keeps everything the agent said with
   * a marker that the caller cut it short. History is what the *model* sees on
   * the next turn, so it may only contain what the caller actually heard —
   * otherwise the model spends the rest of the call referring back to things
   * nobody heard. Twilio's mark echoes are the only evidence of what played.
   */
  private finishTurn(turn: number, interrupted: boolean): void {
    if (turn !== this.turn) return;

    const attempted = this.attempted.trim();
    const heard = this.heard.join(" ").trim();

    if (attempted) {
      this.transcriptLines.push(`AI: ${attempted}${interrupted ? " —" : ""}`);
    }

    const remembered = interrupted ? heard : attempted;
    if (remembered) {
      this.history.push({
        role: "assistant",
        content: interrupted ? `${remembered} —` : remembered,
      });
      this.trimHistory();
    }

    this.attempted = "";
    this.heard = [];
    this.replyComplete = false;
  }

  /** A turn is over once the model has stopped and Twilio has played it all. */
  private settleTurn(turn: number): void {
    if (turn !== this.turn) return;
    if (!this.replyComplete) return;
    if (this.ttsQueue.some((chunk) => chunk.turn === turn)) return;
    if (this.pendingMarks.size > 0) return;

    this.finishTurn(turn, false);
    this.state = "listening";
  }

  // -- speech out -----------------------------------------------------------

  private speak(turn: number, sentence: string): void {
    if (!this.tts || turn !== this.turn) return;
    this.state = "speaking";
    this.chunkSeq += 1;
    const mark = `t${turn}-${this.chunkSeq}`;
    this.ttsQueue.push({ turn, mark, text: sentence });
    this.tts.speak(sentence);
    this.tts.flush();
  }

  private onTtsAudio(audio: Buffer): void {
    const head = this.ttsQueue[0];
    if (!head || this.closed) return;
    // Audio for a turn the caller interrupted, arriving after the fact.
    if (head.turn !== this.turn) return;

    if (this.firstAudioAt === null) {
      this.firstAudioAt = Date.now();
      if (this.utteranceEndAt !== null) {
        this.log(
          `turn latency: ${this.firstAudioAt - this.utteranceEndAt}ms ` +
            `(end of utterance to first outbound audio frame)`
        );
        this.utteranceEndAt = null;
      }
    }

    this.out.sendAudio(audio.toString("base64"));
  }

  private onTtsFlushed(): void {
    const head = this.ttsQueue.shift();
    if (!head || this.closed) return;
    if (head.turn !== this.turn) return;

    // Every byte of this sentence is now with Twilio; the mark comes back when
    // the caller has actually heard it.
    this.pendingMarks.set(head.mark, head);
    this.out.mark(head.mark);
    this.settleTurn(head.turn);
  }

  // -- persistence ----------------------------------------------------------

  private persist(status: string): void {
    const callSid = this.session.callSid;
    if (!callSid) return;
    try {
      updateCallByProviderId("twilio", callSid, {
        status,
        transcript: this.transcriptLines.join("\n") || null,
        durationSeconds: Math.round(
          (Date.now() - this.session.startedAt) / 1000
        ),
      });
    } catch (error) {
      this.log(`saving the call failed: ${text(error)}`);
    }
  }

  private log(message: string): void {
    const name = this.agent?.name ?? this.session.agentId;
    console.log(
      `[pipeline ${name} ${this.session.streamSid ?? "no-stream"}] ${message}`
    );
  }
}

// ---------------------------------------------------------------------------

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name;
  return name === "AbortError" || name === "APIUserAbortError";
}

/** Bytes of μ-law at 8 kHz to milliseconds of speech. */
export function mulawDurationMs(bytes: number): number {
  return (bytes / MULAW_BYTES_PER_SECOND) * 1000;
}

/**
 * Build the pipeline for one call. `providers` is injectable so the pipeline
 * can be driven without a Deepgram account.
 */
export function createCallPipeline(
  session: MediaSession,
  out: MediaSink,
  providers: VoiceProviders = deepgramProviders
): Pipeline {
  return new CallPipeline(session, out, providers);
}
