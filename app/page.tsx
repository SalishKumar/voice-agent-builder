import Link from "next/link";
import { listAgents } from "@/lib/db";
import type { AgentStatus } from "@/lib/types";

// The agent list changes whenever an agent is built or deleted.
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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export default function Home() {
  const agents = listAgents();

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12 sm:py-16">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Voice Agent Builder
          </h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Build voice agents grounded in your own documents.
          </p>
        </div>
        <Link
          href="/agents/new"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 dark:focus-visible:outline-neutral-100"
        >
          New agent
        </Link>
      </header>

      <section className="mt-10">
        {agents.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-300 px-6 py-12 text-center dark:border-neutral-700">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              No agents yet.{" "}
              <Link
                href="/agents/new"
                className="font-medium text-neutral-900 underline underline-offset-4 dark:text-neutral-100"
              >
                Create your first agent
              </Link>{" "}
              to get started.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {agents.map((agent) => (
              <li key={agent.id}>
                <Link
                  href={`/agents/${agent.id}`}
                  className="block rounded-lg border border-neutral-200 px-5 py-4 transition-colors hover:border-neutral-400 hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:border-neutral-800 dark:hover:border-neutral-600 dark:hover:bg-neutral-900 dark:focus-visible:outline-neutral-100"
                >
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="truncate font-medium">{agent.name}</h2>
                    <StatusBadge status={agent.status} />
                  </div>
                  <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                    {plural(agent.fileCount, "file")} ·{" "}
                    {plural(agent.chunkCount, "chunk")} ·{" "}
                    {DATE_FORMAT.format(new Date(agent.created_at))}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
