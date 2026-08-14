"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function DeleteAgentButton({ agentId }: { agentId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    if (deleting) return;
    setDeleting(true);
    setError(null);

    try {
      const res = await fetch(`/api/agents/${agentId}`, { method: "DELETE" });

      if (!res.ok) {
        let message = `Delete failed (HTTP ${res.status}).`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data?.error) message = data.error;
        } catch {
          // Keep the status-code fallback.
        }
        setError(message);
        setConfirming(false);
        return;
      }

      router.push("/");
      router.refresh();
    } catch {
      setError("Could not reach the server. Try again.");
      setConfirming(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      {confirming ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20"
          >
            {deleting ? "Deleting…" : "Really delete?"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={deleting}
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-600 transition-colors hover:border-red-300 hover:text-red-600 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-red-500/40 dark:hover:text-red-400"
        >
          Delete
        </button>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </p>
      )}
    </div>
  );
}
