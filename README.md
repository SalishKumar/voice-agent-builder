# Voice agent builder — managed vs self-hosted, measured

Upload a document, get a phone number that answers questions about it.

The same agent runs on two completely different stacks behind one interface: a
**managed platform** (Vapi) and a **self-hosted media pipeline** (Twilio Media
Streams → Deepgram → OpenAI → Deepgram Aura). Switching between them is one
environment variable.

That was the actual point of the project — not to build a voice agent, but to
build the same one twice and find out what the managed layer is really costing
in money and milliseconds.

```bash
VOICE_PROVIDER=vapi     # managed: they own telephony, STT, TTS, barge-in
VOICE_PROVIDER=twilio   # self-hosted: you own all of it
```

---

## What it does

1. Create an agent — a name, a system prompt, and some documents
2. Files are chunked (~800 chars, 100 overlap, on paragraph boundaries) and
   embedded into SQLite
3. Test it in the browser with continuous voice, or give it a phone number
4. Every call is transcribed and stored

Retrieval is cosine similarity over `Float32Array` embeddings held in SQLite —
no vector database. At a few hundred chunks per agent that's microseconds and
costs nothing, and it removes a service from the diagram.

---

## What I measured

Real numbers from real calls on the managed stack, and from an instrumented
pipeline on the self-hosted one.

### Cost per minute

| | Managed (Vapi) | Self-hosted |
|---|---|---|
| Platform fee | $0.0503 | — |
| Voice (TTS) | $0.0285 | $0.0080 |
| Transcription | $0.0100 | $0.0077 |
| Telephony | *(included)* | $0.0085 |
| LLM | $0.0015 | $0.0015 |
| **Total** | **$0.0903** | **$0.0257** |

**The LLM is 1.7% of the bill.** That surprised me, and it inverts the obvious
optimisation: switching to a cheaper model or trimming the prompt saves nothing
worth having. The platform fee is 56%, and voice is another 32%.

Self-hosting is ~3.5× cheaper per minute but adds a fixed server cost, so it
only breaks even above **~600 minutes/month** — and realistically isn't worth
owning a real-time media service until roughly 10,000.

### Latency per turn

| Stage | Managed | Self-hosted |
|---|---|---|
| Endpointing | 143ms | ~300ms (tunable) |
| Transcription | 156ms | ~100ms |
| **LLM** | **1,461ms** | **~500ms** |
| Voice | 558ms | ~150ms |
| Transport | 40ms | ~40ms |
| **Total** | **2,346ms** | **~1,220ms** |

The LLM stage was 62% of the managed number — and it turned out to be mostly
*prefill*, not inference. The system prompt was 2,246 tokens re-sent on every
turn. Cutting it in half was worth more than any model change.

For reference: humans leave ~300ms between turns. Under 800ms feels natural,
past 1.5s people start repeating themselves.

---

## The engineering worth reading

**Zero audio transcoding.** Twilio speaks μ-law 8kHz, Deepgram's STT accepts
μ-law 8kHz, and Deepgram Aura *emits* μ-law 8kHz. Bytes flow from the phone
network to the transcriber and back without a single resample. That's why both
halves are Deepgram — mixing vendors would have put a resampler in the hot path.

**Barge-in.** Interrupting the agent mid-sentence means tracking what the caller
has actually *heard*, not what you've sent — Twilio buffers audio ahead, so
"stop sending" is far too late. The pipeline uses Twilio's `mark` events to
track playback and `clear` to flush the buffer, and requires a minimum
transcript length before treating speech as an interruption so background noise
doesn't cut the agent off.

**The echo trap.** In the browser, leaving the microphone open while the agent
speaks means it transcribes its own voice, replies to itself, and loops forever.
Prevented with a state machine where the mic is reachable in exactly one state.

**Provider abstraction.** Both vendors implement one `VoiceProvider` interface,
so the retrieval and prompt logic never learned which one is live. Replacing the
entire telephony layer touched no part of the brain.

---

## Stack

Next.js 16 · TypeScript · SQLite (better-sqlite3) · OpenAI · Deepgram ·
Twilio Media Streams · Vapi · Web Speech API

---

## Running it

```bash
npm install
cp .env.example .env.local     # add OPENAI_API_KEY at minimum
npm run dev
```

The browser test panel works with just an OpenAI key. Phone calls need either
Vapi credentials or Twilio + Deepgram, plus a public URL (the app has to be
reachable from the internet — a tunnel works for development).

```bash
npm run dev:all   # Next + the WebSocket media server, for the self-hosted path
```

---

## Honest status

Worth stating plainly, because benchmark posts usually don't:

- **The managed path has taken real phone calls.** The 2,346ms and $0.0903/min
  are measured from a real call, not modelled.
- **The self-hosted pipeline has not yet taken a real call.** It's verified end
  to end against synthetic μ-law audio with instrumented fake providers —
  greeting, transcription, retrieval, streamed reply, barge-in at 401ms,
  teardown. But no audio has crossed a phone network. Its ~1,220ms figure also
  excludes real TTS time-to-first-byte, so expect ~1.3–1.5s in practice.
- **Barge-in thresholds were tuned against synthetic audio** and will need
  adjusting against real speech.
- `sales-agent/` contains a **fictional** company with invented pricing, used as
  demo knowledge-base content. It is not a real product or a real price list.

---

## Not built

Voice cloning, call recording playback, warm transfer to a human, voicemail
detection, multi-number routing, and any consent or do-not-call management.

On that last one: automated outbound calling is regulated. In the US the FCC
treats AI-generated voices in calls to consumers as "artificial" under the TCPA,
which requires prior express consent, and several states additionally require
disclosing that the caller is an AI. Testing against your own number is fine;
anything beyond that isn't a technical question.
