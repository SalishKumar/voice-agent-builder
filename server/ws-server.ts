import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { createCallPipeline } from "./pipeline";
import { fakeProviders, fakeProvidersEnabled } from "./fake-providers";

/**
 * Standalone WebSocket server for Twilio Media Streams.
 *
 * It is a separate process on purpose: Next.js route handlers answer a request
 * and return, they cannot hold a socket open for the length of a phone call.
 *
 * Message shapes below are verbatim from Twilio's reference at
 * https://www.twilio.com/docs/voice/media-streams/websocket-messages —
 * every field name here was copied from that page, not remembered.
 *
 * The stream is bidirectional because the TwiML uses `<Connect><Stream>`
 * (see lib/twilio.ts). That is what makes the outbound `media` / `mark` /
 * `clear` messages below legal; a `<Start><Stream>` would be receive-only.
 */

// ---------------------------------------------------------------------------
// Twilio protocol
// ---------------------------------------------------------------------------

/** `{ "event": "connected", "protocol": "Call", "version": "1.0.0" }` */
interface ConnectedMessage {
  event: "connected";
  protocol: string;
  version: string;
}

/**
 * ```json
 * { "event": "start", "sequenceNumber": "1",
 *   "start": { "accountSid": "AC…", "streamSid": "MZ…", "callSid": "CA…",
 *              "tracks": ["inbound"],
 *              "mediaFormat": { "encoding": "audio/x-mulaw",
 *                               "sampleRate": 8000, "channels": 1 },
 *              "customParameters": {} },
 *   "streamSid": "MZ…" }
 * ```
 */
interface StartMessage {
  event: "start";
  sequenceNumber: string;
  streamSid: string;
  start: {
    accountSid: string;
    streamSid: string;
    callSid: string;
    tracks: string[];
    mediaFormat: { encoding: string; sampleRate: number; channels: number };
    customParameters?: Record<string, string>;
  };
}

/**
 * ```json
 * { "event": "media", "sequenceNumber": "3",
 *   "media": { "track": "inbound", "chunk": "1", "timestamp": "5",
 *              "payload": "base64_encoded_audio" },
 *   "streamSid": "MZ…" }
 * ```
 * `payload` is base64-encoded audio/x-mulaw at 8000 Hz, mono, with no file
 * header bytes.
 */
interface MediaMessage {
  event: "media";
  sequenceNumber: string;
  streamSid: string;
  media: { track: string; chunk: string; timestamp: string; payload: string };
}

/**
 * ```json
 * { "event": "stop", "sequenceNumber": "5",
 *   "stop": { "accountSid": "AC…", "callSid": "CA…" }, "streamSid": "MZ…" }
 * ```
 */
interface StopMessage {
  event: "stop";
  sequenceNumber: string;
  streamSid: string;
  stop: { accountSid: string; callSid: string };
}

/** Bidirectional streams only. `dtmf.track` is e.g. "inbound_track". */
interface DtmfMessage {
  event: "dtmf";
  sequenceNumber: string;
  streamSid: string;
  dtmf: { track: string; digit: string };
}

/**
 * Bidirectional streams only. Twilio sends this back with a matching `name`
 * when the audio we buffered has finished playing — the only reliable signal
 * that the agent has stopped speaking.
 */
interface MarkMessage {
  event: "mark";
  sequenceNumber?: string;
  streamSid: string;
  mark: { name: string };
}

type InboundMessage =
  | ConnectedMessage
  | StartMessage
  | MediaMessage
  | StopMessage
  | DtmfMessage
  | MarkMessage;

/** Audio the caller hears. `media.payload` only — no track, chunk or timestamp. */
function sendMedia(ws: WebSocket, streamSid: string, payload: string): void {
  send(ws, { event: "media", streamSid, media: { payload } });
}

/** Ask Twilio to tell us when everything buffered so far has played. */
function sendMark(ws: WebSocket, streamSid: string, name: string): void {
  send(ws, { event: "mark", streamSid, mark: { name } });
}

/** Drop everything buffered but not yet played — barge-in. */
function sendClear(ws: WebSocket, streamSid: string): void {
  send(ws, { event: "clear", streamSid });
}

function send(ws: WebSocket, message: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** Everything known about one call, from the socket opening to it closing. */
export interface MediaSession {
  /** From the URL path: /media/:agentId. */
  agentId: string;
  /** Twilio's stream id, `MZ…`. Null until the `start` message arrives. */
  streamSid: string | null;
  /** Twilio's call id, `CA…`. Null until the `start` message arrives. */
  callSid: string | null;
  startedAt: number;
  /** Inbound `media` frames seen so far, for logging. */
  mediaFrames: number;
}

/**
 * What a pipeline may do to the call. Everything it needs to talk *out* is
 * here, so a pipeline never touches the socket directly.
 */
export interface MediaSink {
  /** Play base64 μ-law 8 kHz audio to the caller. */
  sendAudio(payload: string): void;
  /** Mark a point in the outbound audio; echoed back when it finishes playing. */
  mark(name: string): void;
  /** Discard buffered outbound audio (barge-in). */
  clear(): void;
  /** End the call by closing the socket — the only way to stop a bidirectional stream. */
  close(): void;
}

/**
 * The extension point. Everything call-specific hangs off these hooks, so
 * adding STT/LLM/TTS means writing a new `createPipeline` and nothing else in
 * this file changes.
 *
 * Hooks may be async; rejections are caught and logged rather than crashing
 * the process (a failed turn must not take down other live calls).
 */
export interface Pipeline {
  onStart?(start: StartMessage["start"]): void | Promise<void>;
  /** `payload` is base64 μ-law 8 kHz from the caller. */
  onAudio?(payload: string): void | Promise<void>;
  onDtmf?(digit: string): void | Promise<void>;
  onMark?(name: string): void | Promise<void>;
  /** Release timers, sockets and upstream connections. Always called exactly once. */
  onStop?(): void | Promise<void>;
}

/** `ECHO_TEST=1` proves the socket is genuinely bidirectional. */
function echoEnabled(): boolean {
  return process.env.ECHO_TEST === "1";
}

/**
 * Build the pipeline for one call.
 *
 * Normally the real thing: Deepgram speech-to-text, OpenAI, Deepgram Aura back
 * out (server/pipeline.ts). `ECHO_TEST=1` still short-circuits to an echo,
 * which is the smallest thing that proves audio reaches Twilio and gets played.
 */
function createPipeline(session: MediaSession, out: MediaSink): Pipeline {
  if (echoEnabled()) {
    return {
      onStart() {
        log(session, "pipeline: echo mode");
      },
      onAudio(payload) {
        out.sendAudio(payload);
      },
      onStop() {
        log(session, "pipeline: echo stopped");
      },
    };
  }

  return createCallPipeline(
    session,
    out,
    fakeProvidersEnabled() ? fakeProviders : undefined
  );
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

/** Only /media/:agentId is served; everything else is refused at upgrade. */
const MEDIA_PATH = /^\/media\/([^/]+)\/?$/;

const PORT = Number(process.env.WS_PORT ?? 3001);

/** Log line cadence for media frames: 8 kHz μ-law arrives in ~20 ms chunks. */
const MEDIA_LOG_EVERY = 100;

/** Half-open sockets are invisible without this; Twilio never closes cleanly on a network drop. */
const HEARTBEAT_MS = 30_000;

interface Connection {
  ws: WebSocket;
  session: MediaSession;
  pipeline: Pipeline;
  alive: boolean;
  stopped: boolean;
}

const connections = new Set<Connection>();

function log(session: MediaSession, message: string): void {
  const id = session.streamSid ?? "no-stream";
  console.log(`[ws ${session.agentId} ${id}] ${message}`);
}

/** Hooks are best-effort: one failing turn must not kill the process. */
function run(
  session: MediaSession,
  name: string,
  fn: (() => void | Promise<void>) | undefined
): void {
  if (!fn) return;
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.catch((err) => log(session, `${name} failed: ${errorText(err)}`));
    }
  } catch (err) {
    log(session, `${name} failed: ${errorText(err)}`);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function handleConnection(ws: WebSocket, agentId: string): void {
  const session: MediaSession = {
    agentId,
    streamSid: null,
    callSid: null,
    startedAt: Date.now(),
    mediaFrames: 0,
  };

  const sink: MediaSink = {
    sendAudio(payload) {
      if (session.streamSid) sendMedia(ws, session.streamSid, payload);
    },
    mark(name) {
      if (session.streamSid) sendMark(ws, session.streamSid, name);
    },
    clear() {
      if (session.streamSid) sendClear(ws, session.streamSid);
    },
    close() {
      ws.close(1000, "call finished");
    },
  };

  const connection: Connection = {
    ws,
    session,
    pipeline: createPipeline(session, sink),
    alive: true,
    stopped: false,
  };
  connections.add(connection);

  log(session, "socket open");

  ws.on("pong", () => {
    connection.alive = true;
  });

  ws.on("message", (data) => {
    let message: InboundMessage;
    try {
      message = JSON.parse(data.toString()) as InboundMessage;
    } catch {
      log(session, "dropped a frame that was not JSON");
      return;
    }
    handleMessage(connection, message);
  });

  ws.on("error", (err) => {
    log(session, `socket error: ${errorText(err)}`);
  });

  ws.on("close", (code, reason) => {
    teardown(connection, `socket closed (${code} ${reason.toString() || "-"})`);
  });
}

function handleMessage(connection: Connection, message: InboundMessage): void {
  const { session, pipeline } = connection;

  switch (message.event) {
    case "connected":
      log(
        session,
        `connected: protocol=${message.protocol} version=${message.version}`
      );
      return;

    case "start": {
      session.streamSid = message.start.streamSid ?? message.streamSid;
      session.callSid = message.start.callSid;
      const { encoding, sampleRate, channels } = message.start.mediaFormat;
      log(
        session,
        `start: callSid=${session.callSid} tracks=${message.start.tracks.join(
          ","
        )} format=${encoding}/${sampleRate}/${channels}ch params=${JSON.stringify(
          message.start.customParameters ?? {}
        )}`
      );
      run(session, "onStart", () => pipeline.onStart?.(message.start));
      return;
    }

    case "media": {
      session.mediaFrames += 1;
      if (
        session.mediaFrames === 1 ||
        session.mediaFrames % MEDIA_LOG_EVERY === 0
      ) {
        log(
          session,
          `media: frame ${session.mediaFrames} track=${message.media.track} ` +
            `chunk=${message.media.chunk} bytes=${message.media.payload.length}`
        );
      }
      run(session, "onAudio", () => pipeline.onAudio?.(message.media.payload));
      return;
    }

    case "dtmf":
      log(session, `dtmf: ${message.dtmf.digit}`);
      run(session, "onDtmf", () => pipeline.onDtmf?.(message.dtmf.digit));
      return;

    case "mark":
      log(session, `mark played: ${message.mark.name}`);
      run(session, "onMark", () => pipeline.onMark?.(message.mark.name));
      return;

    case "stop":
      log(session, `stop: callSid=${message.stop.callSid}`);
      teardown(connection, "stop message");
      // Twilio closes the socket after `stop`, but not always promptly; and a
      // bidirectional stream cannot be stopped any other way than ending the
      // call, so we drop it ourselves.
      connection.ws.close(1000, "stream stopped");
      return;

    default: {
      const unknown = message as { event?: unknown };
      log(session, `ignoring unknown event ${String(unknown.event)}`);
    }
  }
}

/** Idempotent: `stop` and the socket closing both land here. */
function teardown(connection: Connection, reason: string): void {
  if (connection.stopped) return;
  connection.stopped = true;
  connections.delete(connection);

  const { session } = connection;
  const seconds = ((Date.now() - session.startedAt) / 1000).toFixed(1);
  log(
    session,
    `teardown (${reason}) after ${seconds}s, ${session.mediaFrames} media frames`
  );

  run(session, "onStop", () => connection.pipeline.onStop?.());
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const httpServer = createServer((_req, res) => {
  // Nothing here serves HTTP; a plain GET is almost always someone checking
  // the process is up.
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`media stream server: ${connections.size} open call(s)\n`);
});

const wss = new WebSocketServer({ noServer: true });

function refuse(socket: Duplex, status: number, text: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  );
  socket.destroy();
}

httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  const match = MEDIA_PATH.exec(pathname);

  if (!match) {
    console.warn(`[ws] refused upgrade for path ${pathname}`);
    refuse(socket, 404, "Not Found");
    return;
  }

  const agentId = decodeURIComponent(match[1]);
  wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, agentId));
});

const heartbeat = setInterval(() => {
  for (const connection of connections) {
    if (!connection.alive) {
      log(connection.session, "no pong; terminating half-open socket");
      connection.ws.terminate();
      teardown(connection, "heartbeat timeout");
      continue;
    }
    connection.alive = false;
    connection.ws.ping();
  }
}, HEARTBEAT_MS);

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(
    `[ws] ${signal}: closing ${connections.size} open call(s) and shutting down`
  );
  clearInterval(heartbeat);

  for (const connection of [...connections]) {
    teardown(connection, `server ${signal}`);
    connection.ws.close(1001, "server shutting down");
  }

  wss.close();
  httpServer.close(() => process.exit(0));

  // Anything still hanging on after this is not worth waiting for.
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

httpServer.listen(PORT, () => {
  console.log(
    `[ws] listening on ws://localhost:${PORT}/media/<agentId> ` +
      `(echo ${echoEnabled() ? "on" : "off"}, speech ${
        echoEnabled()
          ? "bypassed"
          : fakeProvidersEnabled()
            ? "FAKE (offline stand-ins)"
            : "deepgram"
      })`
  );
});
