import type { Call } from "@/lib/types";

/**
 * Server-rendered: the rows come straight from the database and the only
 * interaction is a native `<details>`, so nothing here needs the client.
 */

const CALL_STATUS_STYLES: Record<string, string> = {
  queued:
    "border-neutral-300 bg-neutral-50 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400",
  ringing:
    "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300",
  "in-progress":
    "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300",
  ended:
    "border-green-300 bg-green-50 text-green-800 dark:border-green-500/40 dark:bg-green-500/10 dark:text-green-300",
  failed:
    "border-red-300 bg-red-50 text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300",
};

const FALLBACK_STATUS_STYLE =
  "border-neutral-300 bg-neutral-50 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400";

const STAMP_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function CallStatusBadge({ status }: { status: string }) {
  const style = CALL_STATUS_STYLES[status] ?? FALLBACK_STATUS_STYLE;
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${style}`}
    >
      {status}
    </span>
  );
}

/** `m:ss`, or null when the call never recorded a duration. */
function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Rendered once on the server, so it ages until the page is reloaded. */
function relativeTime(timestamp: number, now: number): string {
  const diffMs = now - timestamp;
  if (diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return STAMP_FORMAT.format(new Date(timestamp));
}

export default function CallHistory({
  calls,
  now,
}: {
  calls: Call[];
  /** Read once per request by the page — the clock stays out of render. */
  now: number;
}) {
  if (calls.length === 0) {
    return (
      <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
        No calls yet.
      </p>
    );
  }

  return (
    <ul className="mt-2 flex flex-col gap-2">
      {calls.map((call) => {
        const duration = formatDuration(call.duration_seconds);
        const hasDetail = Boolean(call.transcript ?? call.summary);

        const header = (
          <>
            <span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
              {call.direction === "outbound" ? "↗ Outbound" : "↘ Inbound"}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-sm">
              {call.phone_number ?? "unknown number"}
            </span>
            <CallStatusBadge status={call.status} />
            {duration && (
              <span className="shrink-0 text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
                {duration}
              </span>
            )}
            <span
              className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400"
              title={STAMP_FORMAT.format(new Date(call.created_at))}
            >
              {relativeTime(call.created_at, now)}
            </span>
          </>
        );

        return (
          <li
            key={call.id}
            className="rounded-md border border-neutral-200 dark:border-neutral-800"
          >
            {hasDetail ? (
              <details className="group">
                <summary className="flex cursor-pointer flex-wrap items-center gap-3 px-3 py-2 marker:content-none [&::-webkit-details-marker]:hidden">
                  {header}
                  <span className="shrink-0 text-xs text-neutral-500 underline underline-offset-4 dark:text-neutral-400">
                    {call.transcript ? "Transcript" : "Summary"}
                  </span>
                </summary>
                <div className="border-t border-neutral-200 px-3 py-3 dark:border-neutral-800">
                  {call.summary && (
                    <p className="text-sm whitespace-pre-wrap">{call.summary}</p>
                  )}
                  {call.transcript && (
                    <pre
                      className={`overflow-x-auto rounded-md bg-neutral-50 px-3 py-2 font-sans text-sm whitespace-pre-wrap text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 ${
                        call.summary ? "mt-3" : ""
                      }`}
                    >
                      {call.transcript}
                    </pre>
                  )}
                  {call.recording_url && (
                    <a
                      href={call.recording_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-block text-xs text-neutral-500 underline underline-offset-4 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
                    >
                      Recording
                    </a>
                  )}
                </div>
              </details>
            ) : (
              <div className="flex flex-wrap items-center gap-3 px-3 py-2">
                {header}
                {call.recording_url && (
                  <a
                    href={call.recording_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-xs text-neutral-500 underline underline-offset-4 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
                  >
                    Recording
                  </a>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
