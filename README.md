# voice-agent-builder

Build a voice agent from your own documents, then talk to it — in the browser, or
by giving it a phone number.

Create an agent with a name, a system prompt and some files. The files are
chunked and embedded into SQLite, and every reply is grounded in them. Then test
it: hands-free in the browser, or by ringing it up.

### Watch it work

[![Demo: building an agent and calling it from a phone](https://cdn.loom.com/sessions/thumbnails/e55a526231854fbc84a520efecc7dca5-with-play.gif)](https://www.loom.com/share/e55a526231854fbc84a520efecc7dca5)

Five minutes: build an agent from a markdown file, then ring it from a mobile and
have a real conversation. A slice of that call —

> **Agent:** How many of those calls do you think go unanswered each week?
> **Caller:** Let's say 20 calls per day.
> **Agent:** Alright, so about 140 calls a week. If a new customer is worth, say,
> $200 — would you say around a third of those missed calls might have booked an
> appointment?
> **Caller:** Yeah, probably.
> **Agent:** So if we take 30 missed calls a week at $200, that's about $6,000 a
> month walking out the door. Does that sound right?

Nothing in that exchange is scripted. The pricing comes from the uploaded
document; the arithmetic is done live on the caller's own numbers.

---

The same agent runs on **two completely different phone stacks** behind one
interface — a managed platform (Vapi) or a self-hosted media pipeline (Twilio
Media Streams → Deepgram → OpenAI → Deepgram Aura). Switching is one environment
variable.

```bash
VOICE_PROVIDER=twilio   # self-hosted: you own the whole pipeline
VOICE_PROVIDER=vapi     # managed: they own telephony, transcription, voice
```

---

## Quick start — browser only

The browser test panel needs **one** API key and nothing else. No phone accounts,
no tunnels.

```bash
npm install
cp .env.example .env.local     # add OPENAI_API_KEY
npm run dev                    # http://localhost:3000
```

Create an agent, upload a `.md`, `.txt` or `.pdf`, hit **Build**, then **Test
agent**. Click **Start call** and just talk — the mic reopens by itself after
each reply.

> Voice input uses the Web Speech API, so the browser panel needs **Chrome or
> Edge**. There's a text box as a fallback everywhere else.

---

## Environment variables

Only `OPENAI_API_KEY` is always required. Everything else depends on how far you
want to go. `.env.example` documents every variable inline.

### Always

| Variable | What it's for |
|---|---|
| `OPENAI_API_KEY` | The brain, and the embeddings for retrieval |
| `OPENAI_MODEL` | Optional, defaults to `gpt-4o-mini` |
| `OPENAI_EMBED_MODEL` | Optional, defaults to `text-embedding-3-small` |

⚠️ Changing the embedding model invalidates existing agents — old vectors won't
be comparable to new queries, and retrieval silently returns nothing. Rebuild
every agent after switching.

### Phone calls, self-hosted (`VOICE_PROVIDER=twilio`)

| Variable | What it's for |
|---|---|
| `TWILIO_ACCOUNT_SID` | From console.twilio.com |
| `TWILIO_AUTH_TOKEN` | Also verifies the webhook signature — a wrong value makes every inbound call 403 |
| `TWILIO_FROM_NUMBER` | E.164, e.g. `+14155551234` |
| `DEEPGRAM_API_KEY` | Both halves: streaming transcription in, Aura voice out |
| `PUBLIC_BASE_URL` | Public HTTPS origin of the Next app (port 3000) |
| `PUBLIC_WS_URL` | Public **wss://** origin of the media server (port 3001) |

Tuning, all optional: `DEEPGRAM_STT_MODEL`, `DEEPGRAM_TTS_MODEL`,
`DEEPGRAM_ENDPOINTING_MS`, `DEEPGRAM_UTTERANCE_END_MS`, `BARGE_IN_MIN_WORDS`,
`BARGE_IN_MIN_CHARS`, `BARGE_IN_MIN_CONFIDENCE`, `WS_PORT`.

### Phone calls, managed (`VOICE_PROVIDER=vapi`)

| Variable | What it's for |
|---|---|
| `VAPI_API_KEY` | The **private** key, not the public web one |
| `VAPI_PHONE_NUMBER_ID` | An id, not a number — `GET https://api.vapi.ai/phone-number` lists them |
| `VAPI_SECRET` | Any long random string (`openssl rand -hex 32`); gates the two public callbacks |
| `PUBLIC_BASE_URL` | Where Vapi reaches this app |

Vapi runs the call itself, so `DEEPGRAM_API_KEY` and `PUBLIC_WS_URL` play no part
on this path.

---

## Running with a phone number

Both providers need this app reachable from the internet. In development that
means a tunnel.

**The self-hosted path needs two tunnels**, because a quick tunnel maps a single
port and there are two processes: Next on 3000 and the media WebSocket server on
3001. `./tunnels.sh` starts both and prints both URLs.

```bash
./tunnels.sh                       # prints the two public URLs
#   → PUBLIC_BASE_URL = https://….trycloudflare.com   (the 3000 one)
#   → PUBLIC_WS_URL   = wss://….trycloudflare.com     (the 3001 one)

npm run dev:all                    # Next + the media server together
```

Then point your Twilio number's **Voice webhook** at:

```
POST  {PUBLIC_BASE_URL}/api/twilio/voice?agentId=<agent-id>
```

Or use the **Phone** section on an agent's page to toggle inbound on and place
outbound calls.

> Tunnel URLs are ephemeral. If the tunnel restarts, update `PUBLIC_BASE_URL` /
> `PUBLIC_WS_URL` — and on the Vapi path, re-sync the assistant (toggling inbound
> does it), because Vapi stores the callback URL on its own copy of the agent.
> The symptom of getting this wrong is a call that connects and then sits in
> silence.

### Scripts

| | |
|---|---|
| `npm run dev` | Next only — enough for the browser panel |
| `npm run ws` | The media WebSocket server only |
| `npm run dev:all` | Both, for the self-hosted phone path |
| `npm run build` / `start` | Production |
| `npm run typecheck` / `lint` | Gates |

---

## How it works

```
  caller
    │
  Twilio ──webhook──> /api/twilio/voice  →  TwiML <Connect><Stream>
    │
    └──wss──> media server (port 3001)
                 ├─> Deepgram streaming STT      ← turn detection
                 ├─> retrieval over SQLite       ← cosine similarity
                 ├─> OpenAI (streamed)
                 └─> Deepgram Aura ──audio──> back to the caller
```

**No audio is ever transcoded.** Twilio speaks μ-law 8kHz, Deepgram's transcriber
accepts μ-law 8kHz, and Aura emits μ-law 8kHz. Bytes cross the whole pipeline
without a resample — which is why both halves are Deepgram rather than mixing
vendors.

**Retrieval has no vector database.** Embeddings are `Float32Array`s in SQLite
and similarity is computed in memory. At a few hundred chunks per agent that's
microseconds, and it removes a service from the diagram.

---

## What it cost and how fast it was

Measured on real phone calls, both stacks.

| Per minute | Managed | Self-hosted |
|---|---|---|
| Platform fee | $0.0503 | — |
| Voice | $0.0285 | $0.0080 |
| Transcription | $0.0100 | $0.0077 |
| Telephony | *(included)* | $0.0085 |
| LLM | $0.0015 | $0.0015 |
| **Total** | **$0.0903** | **$0.0257** |

**The LLM is 1.7% of the bill.** The platform fee is 56% and voice another 32%,
which inverts the obvious optimisation: switching models or trimming prompts
saves nothing worth having on cost.

| Turn latency | Managed | Self-hosted |
|---|---|---|
| | 2,346ms | **1,013–1,467ms** (median ~1,150ms) |

Prompt size mattered more than model choice — the system prompt is re-sent every
turn, so prefill dominated. Halving it beat every other latency change.

Self-hosting is ~3.5× cheaper per minute but adds a fixed server cost, so it only
breaks even above roughly 600 minutes a month — and isn't worth owning a
real-time media service until far beyond that.

---

## Two bugs only real calls could find

Worth reading if you're building something similar.

**Deepgram's Node SDK returns a listen socket that is already closed.**
`client.listen.v1.connect()` resolves with `readyState === 3`, its `open` event
never fires, and every `sendMedia()` throws `Socket is not open.` A raw
WebSocket with byte-identical query parameters works fine, so both halves talk to
Deepgram directly. Their TTS socket has a separate fault: it JSON-parses every
frame, including binary audio, and throws out of an event listener.

**Twilio streams audio before the transcriber is ready.** Media frames arrive the
instant the call connects, while the Deepgram socket is still handshaking — so
the caller's opening words vanished. Frames are now buffered until the socket
opens.

Neither was reachable with test doubles: fake providers open instantly.

---

## Status

- Both stacks have taken real phone calls; every number above is measured.
- **Barge-in is unconfirmed against real speech.** It works against synthetic
  audio (401ms from interruption to flushing Twilio's buffer). The thresholds are
  env vars because they're expected to need tuning.
- **Outbound on the self-hosted path is untested** — Twilio trial accounts refuse
  unverified destination numbers. Inbound is proven.
- `sales-agent/` and `buddy-agent/` are example prompts. The sales one references
  a **fictional** company with invented pricing — it is not a real price list.

## Not built

Voice cloning, call recording playback, warm transfer to a human, voicemail
detection, multi-number routing, and any consent or do-not-call management.

On that last point: automated outbound calling is regulated. In the US the FCC
treats AI-generated voices in calls to consumers as "artificial" under the TCPA,
requiring prior express consent, and several states require disclosing that the
caller is an AI. Testing against your own number is fine; anything beyond that
isn't a technical question.

---

## Stack

Next.js 16 · TypeScript · SQLite (better-sqlite3) · OpenAI · Deepgram ·
Twilio Media Streams · Vapi · Web Speech API
