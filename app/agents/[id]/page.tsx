import Link from "next/link";
import { notFound } from "next/navigation";
import CallHistory from "@/components/CallHistory";
import DeleteAgentButton from "@/components/DeleteAgentButton";
import PhonePanel from "@/components/PhonePanel";
import TestPanel from "@/components/TestPanel";
import { countChunks, getAgent, listCalls, listFiles } from "@/lib/db";
import type { AgentStatus } from "@/lib/types";

// Status flips from building to ready/failed, so never serve a cached shell.
export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<AgentStatus, string> = {
  building:
    "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300",
  ready:
    "border-green-300 bg-green-50 text-green-800 dark:border-green-500/40 dark:bg-green-500/10 dark:text-green-300",
  failed:
    "border-red-300 bg-red-50 text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300",
};

function StatusBadge({ status }: { status: AgentStatus }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The clock is read once per request and handed to `CallHistory` as data, so
 * the relative call timestamps are not computed from inside a render. This
 * page is `force-dynamic`, so "once per request" is also once per render.
 */
function requestTime(): number {
  return Date.now();
}

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const agent = getAgent(id);
  if (!agent) notFound();

  const files = listFiles(id);
  const chunkCount = countChunks(id);
  const calls = listCalls(agent.id);
  const renderedAt = requestTime();

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-12 sm:py-16">
      <Link
        href="/"
        className="text-sm text-neutral-500 underline underline-offset-4 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
      >
        ← All agents
      </Link>

      <header className="mt-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
        <StatusBadge status={agent.status} />
      </header>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Created {DATE_FORMAT.format(new Date(agent.created_at))}
      </p>

      {agent.status === "failed" && (
        <div
          role="alert"
          className="mt-6 rounded-md border border-red-300 bg-red-50 px-4 py-3 dark:border-red-500/40 dark:bg-red-500/10"
        >
          <p className="text-sm font-medium text-red-800 dark:text-red-300">
            Build failed
          </p>
          <p className="mt-1 text-sm whitespace-pre-wrap text-red-700 dark:text-red-300">
            {agent.error ?? "No error detail was recorded."}
          </p>
        </div>
      )}

      {agent.status === "building" && (
        <p className="mt-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
          Still building — reload in a moment.
        </p>
      )}

      <section className="mt-10">
        <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
          Instructions
        </h2>
        <pre className="mt-2 rounded-lg border border-neutral-200 px-4 py-3 font-sans text-sm whitespace-pre-wrap dark:border-neutral-800">
          {agent.prompt}
        </pre>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
          Knowledge base
        </h2>
        {files.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
            No documents — this agent answers from its instructions alone.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {files.map((file) => (
              <li
                key={file.id}
                className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800"
              >
                <span className="truncate">{file.filename}</span>
                <span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
                  {formatBytes(file.bytes)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          {chunkCount} embedded chunk{chunkCount === 1 ? "" : "s"}
        </p>
      </section>

      <div className="mt-12 flex flex-wrap items-start justify-between gap-6 border-t border-neutral-200 pt-8 dark:border-neutral-800">
        <TestPanel
          agentId={agent.id}
          agentName={agent.name}
          disabled={agent.status !== "ready"}
        />
        <DeleteAgentButton agentId={agent.id} />
      </div>

      <section className="mt-12 border-t border-neutral-200 pt-8 dark:border-neutral-800">
        <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
          Phone
        </h2>
        <PhonePanel
          agentId={agent.id}
          agentName={agent.name}
          ready={agent.status === "ready"}
        />
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
          Call history
        </h2>
        <CallHistory calls={calls} now={renderedAt} />
      </section>
    </main>
  );
}
