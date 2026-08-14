"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import type { ChatMessage, ChatResponse } from "@/lib/types";

interface Source {
  file: string;
  score: number;
}

interface Turn {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  sources?: Source[];
}

interface Notice {
  tone: "soft" | "error";
  text: string;
}

/**
 * The call is a strict state machine. The microphone is open in exactly one
 * phase — `listening` — and that phase is unreachable while audio is playing,
 * so the agent can never transcribe its own voice and talk to itself.
 *
 *   [idle] --start call--> [listening] --final transcript--> [thinking]
 *     ^                      ^     ^                             |
 *     |                      |     +---- silence / no-speech ----+
 *     |                 utterance ends                        reply
 *     |                      |                                   |
 *     +--- error/hangup --[speaking] <-------------------------- +
 */
type Phase = "idle" | "listening" | "thinking" | "speaking";

const UNSUPPORTED_NOTE =
  "Voice input needs Chrome or Edge (Web Speech API). Type below instead.";
const PERMISSION_NOTE =
  "Microphone permission denied — allow mic access and try again";
const SILENCE_NOTE = "Ended the call — I didn't hear anything.";
const CALL_HINT = "Just talk — I'll pick it up when you pause.";

/** `start()` throws if called while recognition is still winding down. */
const RESTART_DELAY_MS = 250;
/** `utterance.onend` is unreliable in Chrome, so poll `speaking` as well. */
const SPEECH_POLL_MS = 250;
/** Polls to wait for playback to begin before treating silence as "finished". */
const SPEECH_START_GRACE_TICKS = 4;
/** Consecutive silent turns before we hang up on a forgotten open tab. */
const MAX_SILENT_ROUNDS = 5;

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function speechRecognitionCtor(): SpeechRecognitionConstructor | undefined {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition;
}

/**
 * Support is a fixed property of the browser, so there is nothing to subscribe
 * to — but reading it has to happen after hydration, since `window` does not
 * exist during SSR.
 */
const subscribeToNothing = () => () => {};
const readVoiceSupport = () => Boolean(speechRecognitionCtor());
const readVoiceSupportOnServer = () => false;

/** The API only accepts user/assistant turns, so error bubbles are stripped. */
function toChatHistory(turns: Turn[]): ChatMessage[] {
  return turns
    .filter((t): t is Turn & { role: "user" | "assistant" } => t.role !== "error")
    .map((t) => ({ role: t.role, content: t.content }));
}

export default function TestPanel({
  agentId,
  agentName,
  disabled,
}: {
  agentId: string;
  agentName: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [interim, setInterim] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [inCall, setInCall] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const voiceSupported = useSyncExternalStore(
    subscribeToNothing,
    readVoiceSupport,
    readVoiceSupportOnServer
  );

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const sendingRef = useRef(false);
  const turnsRef = useRef<Turn[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The recognition handlers are wired up once, so they would close over stale
  // state — every one of them branches on these refs instead.
  const phaseRef = useRef<Phase>("idle");
  const inCallRef = useRef(false);
  const runningRef = useRef(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const speechGenRef = useRef(0);
  const noSpeechCountRef = useRef(0);

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  const enterPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current !== null) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const clearSpeechPoll = useCallback(() => {
    if (speechPollRef.current !== null) {
      clearInterval(speechPollRef.current);
      speechPollRef.current = null;
    }
  }, []);

  /** Stops audio and invalidates any in-flight end-of-speech signal. */
  const cancelSpeech = useCallback(() => {
    clearSpeechPoll();
    speechGenRef.current += 1;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }, [clearSpeechPoll]);

  const abortRecognition = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    try {
      recognition.abort();
    } catch {
      // Never started.
    }
  }, []);

  /**
   * The only place `start()` is called. Audio is killed first, so the mic can
   * never be opened on top of the agent's own voice.
   */
  const startListening = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    clearRestartTimer();
    cancelSpeech();

    if (runningRef.current) {
      enterPhase("listening");
      return;
    }
    try {
      recognition.start();
      enterPhase("listening");
    } catch {
      // InvalidStateError: it is already running after all — `onend` settles it.
      enterPhase(inCallRef.current ? "listening" : "idle");
    }
  }, [cancelSpeech, clearRestartTimer, enterPhase]);

  /** `start()` inside `onend` throws, so every restart goes through a timer. */
  const scheduleRestart = useCallback(() => {
    clearRestartTimer();
    restartTimerRef.current = setTimeout(() => {
      restartTimerRef.current = null;
      if (!inCallRef.current || phaseRef.current !== "listening") return;
      startListening();
    }, RESTART_DELAY_MS);
  }, [clearRestartTimer, startListening]);

  /** End of a turn: give the mic back if we are on a call, otherwise stop. */
  const handBack = useCallback(() => {
    if (inCallRef.current) {
      enterPhase("listening");
      scheduleRestart();
      return;
    }
    enterPhase("idle");
  }, [enterPhase, scheduleRestart]);

  /** Idempotent — `onend`, `onerror` and the poll all race to call it. */
  const finishSpeaking = useCallback(() => {
    if (phaseRef.current !== "speaking") return;
    cancelSpeech();
    handBack();
  }, [cancelSpeech, handBack]);

  const stopSpeaking = useCallback(() => {
    cancelSpeech();
    finishSpeaking();
  }, [cancelSpeech, finishSpeaking]);

  const speak = useCallback(
    (text: string) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        handBack();
        return;
      }
      const synth = window.speechSynthesis;
      cancelSpeech();
      speechGenRef.current += 1;
      const generation = speechGenRef.current;
      enterPhase("speaking");

      let sawAudio = false;
      const done = () => {
        if (generation !== speechGenRef.current) return;
        finishSpeaking();
      };

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      utterance.onstart = () => {
        sawAudio = true;
      };
      // Without these the UI can get stuck on "Speaking…" forever.
      utterance.onend = done;
      utterance.onerror = done;
      synth.speak(utterance);

      // `onend` is unreliable in Chrome for longer utterances, so poll too and
      // take whichever signal lands first.
      let ticks = 0;
      speechPollRef.current = setInterval(() => {
        if (generation !== speechGenRef.current || phaseRef.current !== "speaking") {
          clearSpeechPoll();
          return;
        }
        ticks += 1;
        if (synth.speaking) {
          sawAudio = true;
          return;
        }
        // Playback takes a moment to start, so silence only counts as "done"
        // once we have actually heard audio or the grace window has passed.
        if (sawAudio || ticks >= SPEECH_START_GRACE_TICKS) done();
      }, SPEECH_POLL_MS);
    },
    [cancelSpeech, clearSpeechPoll, enterPhase, finishSpeaking, handBack]
  );

  /** Full teardown: hangup, panel close and unmount all land here. */
  const endCall = useCallback(() => {
    inCallRef.current = false;
    setInCall(false);
    noSpeechCountRef.current = 0;
    clearRestartTimer();
    cancelSpeech();
    abortRecognition();
    enterPhase("idle");
    setInterim("");
  }, [abortRecognition, cancelSpeech, clearRestartTimer, enterPhase]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || sendingRef.current) return;

      sendingRef.current = true;
      setNotice(null);
      setInterim("");
      noSpeechCountRef.current = 0;

      const history: ChatMessage[] = [
        ...toChatHistory(turnsRef.current),
        { role: "user", content },
      ];
      setTurns((prev) => [...prev, { id: newId(), role: "user", content }]);
      enterPhase("thinking");

      try {
        const res = await fetch(`/api/agents/${agentId}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history }),
        });

        let data: (Partial<ChatResponse> & { error?: string }) | null = null;
        try {
          data = (await res.json()) as Partial<ChatResponse> & {
            error?: string;
          };
        } catch {
          data = null;
        }

        if (!res.ok || typeof data?.reply !== "string") {
          setTurns((prev) => [
            ...prev,
            {
              id: newId(),
              role: "error",
              content:
                data?.error ?? `Request failed (HTTP ${res.status}). Try again.`,
            },
          ]);
          // A failed turn still returns the mic rather than stalling.
          handBack();
          return;
        }

        const reply = data.reply;
        setTurns((prev) => [
          ...prev,
          {
            id: newId(),
            role: "assistant",
            content: reply,
            sources: data?.sources ?? [],
          },
        ]);
        speak(reply);
      } catch {
        setTurns((prev) => [
          ...prev,
          {
            id: newId(),
            role: "error",
            content: "Could not reach the server. Check the app is running.",
          },
        ]);
        handBack();
      } finally {
        sendingRef.current = false;
      }
    },
    [agentId, enterPhase, handBack, speak]
  );

  // Feature-detect and wire up recognition on the client only — `window` does
  // not exist during SSR.
  useEffect(() => {
    const Recognition = speechRecognitionCtor();
    if (!Recognition) return;

    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      runningRef.current = true;
      if (inCallRef.current) enterPhase("listening");
    };

    recognition.onresult = (event) => {
      // Anything heard outside `listening` is the agent's own voice leaking
      // back in through the speakers — drop it.
      if (phaseRef.current !== "listening") return;

      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) finalText += transcript;
        else interimText += transcript;
      }

      setInterim(interimText);
      if (finalText.trim()) {
        setInterim("");
        noSpeechCountRef.current = 0;
        void send(finalText);
      }
    };

    recognition.onerror = (event) => {
      switch (event.error) {
        case "not-allowed":
        case "service-not-allowed":
          setNotice({ tone: "error", text: PERMISSION_NOTE });
          // Never auto-retry — that produces a permission prompt loop.
          endCall();
          break;
        case "no-speech":
          noSpeechCountRef.current += 1;
          if (
            inCallRef.current &&
            noSpeechCountRef.current >= MAX_SILENT_ROUNDS
          ) {
            setNotice({ tone: "soft", text: SILENCE_NOTE });
            endCall();
          } else {
            setNotice({
              tone: "soft",
              text: inCallRef.current
                ? "Didn't catch that — still listening."
                : "Didn't catch that, try again",
            });
          }
          break;
        case "aborted":
          break;
        case "network":
          setNotice({ tone: "error", text: "Speech recognition network error" });
          // Restarting into a broken service would spin every 250ms.
          endCall();
          break;
        default:
          setNotice({
            tone: "error",
            text: `Speech recognition error: ${event.error}`,
          });
          endCall();
      }
    };

    // Always runs, so the UI can never be stuck on "Listening…". Chrome's
    // endpointing fires it after a natural pause, which is our turn boundary.
    recognition.onend = () => {
      runningRef.current = false;
      setInterim("");
      if (phaseRef.current !== "listening") return;
      // `thinking` and `speaking` own the mic-closed half of the cycle and
      // reopen it themselves, so only a listening turn hands back to listening.
      if (inCallRef.current) scheduleRestart();
      else enterPhase("idle");
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        // Already stopped.
      }
      runningRef.current = false;
      recognitionRef.current = null;
    };
  }, [enterPhase, endCall, scheduleRestart, send]);

  // Never leave audio, timers or a hot mic running behind us.
  useEffect(() => {
    return () => {
      clearRestartTimer();
      clearSpeechPoll();
      inCallRef.current = false;
      phaseRef.current = "idle";
      noSpeechCountRef.current = 0;
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, [clearRestartTimer, clearSpeechPoll]);

  const closePanel = useCallback(() => {
    endCall();
    setOpen(false);
  }, [endCall]);

  // Escape closes the panel.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closePanel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, closePanel]);

  // Keep the transcript pinned to the newest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, interim, phase, open]);

  function toggleCall() {
    if (inCallRef.current) {
      endCall();
      return;
    }
    if (!recognitionRef.current) return;
    setNotice(null);
    noSpeechCountRef.current = 0;
    inCallRef.current = true;
    setInCall(true);
    startListening();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sendingRef.current) return;
    setDraft("");
    // Close the listening gate before aborting, so the pending `onend` cannot
    // schedule a restart on top of the typed turn.
    clearRestartTimer();
    enterPhase("thinking");
    cancelSpeech();
    abortRecognition();
    void send(text);
  }

  function clearConversation() {
    stopSpeaking();
    setTurns([]);
    setInterim("");
    setNotice(null);
  }

  const status =
    phase === "listening"
      ? "Listening…"
      : phase === "thinking"
        ? "Thinking…"
        : phase === "speaking"
          ? "Speaking…"
          : "Ready";

  return (
    <>
      <div className="flex flex-col items-start gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          title={
            disabled
              ? "This agent isn't ready to talk to yet."
              : `Talk to ${agentName}`
          }
          className="rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300 disabled:text-neutral-500 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 dark:disabled:bg-neutral-800 dark:disabled:text-neutral-500"
        >
          Test agent
        </button>
        {disabled && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Available once the build finishes successfully.
          </p>
        )}
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={`Test ${agentName}`}
        >
          <div className="flex h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-t-xl border border-neutral-200 bg-white shadow-xl sm:h-[32rem] sm:rounded-xl dark:border-neutral-800 dark:bg-neutral-950">
            <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{agentName}</p>
                <p
                  aria-live="polite"
                  className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400"
                >
                  {phase === "listening" && (
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
                    </span>
                  )}
                  {status}
                </p>
              </div>
              <button
                type="button"
                onClick={closePanel}
                aria-label="Close test panel"
                className="rounded-md px-2 py-1 text-lg leading-none text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
              >
                ×
              </button>
            </header>

            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto px-5 py-4 [scrollbar-width:thin]"
            >
              {turns.length === 0 && !interim && (
                <p className="text-sm text-neutral-500 dark:text-neutral-400">
                  {voiceSupported
                    ? "Start a call and just talk, or type a message below."
                    : "Type a message below to start the conversation."}
                </p>
              )}

              <ul className="flex flex-col gap-3">
                {turns.map((turn) => (
                  <li
                    key={turn.id}
                    className={
                      turn.role === "user" ? "flex justify-end" : "flex justify-start"
                    }
                  >
                    <div className="max-w-[85%]">
                      <div
                        className={
                          turn.role === "user"
                            ? "rounded-2xl rounded-br-sm bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
                            : turn.role === "assistant"
                              ? "rounded-2xl rounded-bl-sm bg-neutral-100 px-4 py-2 text-sm text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100"
                              : "rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300"
                        }
                      >
                        {turn.content}
                      </div>
                      {turn.role === "assistant" &&
                        turn.sources &&
                        turn.sources.length > 0 && (
                          <ul className="mt-1.5 flex flex-wrap gap-1.5">
                            {turn.sources.map((source, index) => (
                              <li
                                key={`${turn.id}-${source.file}-${index}`}
                                className="rounded-full border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400"
                              >
                                {source.file}
                              </li>
                            ))}
                          </ul>
                        )}
                    </div>
                  </li>
                ))}

                {interim && (
                  <li className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-dashed border-neutral-300 px-4 py-2 text-sm text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
                      {interim}
                    </div>
                  </li>
                )}

                {phase === "thinking" && (
                  <li className="flex justify-start">
                    <div className="rounded-2xl rounded-bl-sm bg-neutral-100 px-4 py-2 text-sm text-neutral-400 dark:bg-neutral-900 dark:text-neutral-500">
                      Thinking…
                    </div>
                  </li>
                )}
              </ul>
            </div>

            <div className="border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">
              {notice && (
                <p
                  role="status"
                  className={
                    notice.tone === "error"
                      ? "mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300"
                      : "mb-3 text-xs text-neutral-500 dark:text-neutral-400"
                  }
                >
                  {notice.text}
                </p>
              )}

              {!voiceSupported && (
                <p className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
                  {UNSUPPORTED_NOTE}
                </p>
              )}

              {inCall && phase === "listening" && (
                <p className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
                  {CALL_HINT}
                </p>
              )}

              <div className="flex items-center gap-2">
                {voiceSupported && (
                  <button
                    type="button"
                    onClick={toggleCall}
                    aria-pressed={inCall}
                    className={
                      inCall
                        ? "shrink-0 rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
                        : "shrink-0 rounded-full border border-neutral-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
                    }
                  >
                    {inCall ? "End call" : "Start call"}
                  </button>
                )}

                <form onSubmit={handleSubmit} className="flex flex-1 gap-2">
                  <input
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Type a message…"
                    aria-label="Message"
                    className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:placeholder:text-neutral-600 dark:focus:border-neutral-300"
                  />
                  <button
                    type="submit"
                    disabled={phase === "thinking" || draft.trim().length === 0}
                    className="shrink-0 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
                  >
                    Send
                  </button>
                </form>
              </div>

              <div className="mt-2.5 flex items-center gap-4">
                <button
                  type="button"
                  onClick={stopSpeaking}
                  disabled={phase !== "speaking"}
                  className="text-xs text-neutral-500 underline underline-offset-4 transition-colors hover:text-neutral-900 disabled:cursor-not-allowed disabled:no-underline disabled:opacity-40 dark:text-neutral-400 dark:hover:text-neutral-100"
                >
                  Stop speaking / my turn
                </button>
                <button
                  type="button"
                  onClick={clearConversation}
                  disabled={turns.length === 0}
                  className="text-xs text-neutral-500 underline underline-offset-4 transition-colors hover:text-neutral-900 disabled:cursor-not-allowed disabled:no-underline disabled:opacity-40 dark:text-neutral-400 dark:hover:text-neutral-100"
                >
                  Clear conversation
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
