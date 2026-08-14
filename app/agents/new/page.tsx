"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

const ACCEPT = ".txt,.md,.markdown,.pdf";

const PROMPT_PLACEHOLDER =
  "You are a friendly support agent for Acme. Answer only from the knowledge base.";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface CreateResponse {
  id?: string;
  status?: string;
  chunkCount?: number;
  skipped?: string[];
  error?: string;
}

export default function NewAgentPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (redirectTimer.current !== null) clearTimeout(redirectTimer.current);
    };
  }, []);

  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const picked = Array.from(list);
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...picked.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
    // Let the same file be re-picked after it has been removed.
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function goToAgent(id: string) {
    router.push(`/agents/${id}`);
    router.refresh();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (building) return;

    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName || !trimmedPrompt) {
      setError("Name and instructions are both required.");
      return;
    }

    setError(null);
    setNotice(null);
    setBuilding(true);

    try {
      const body = new FormData();
      body.append("name", trimmedName);
      body.append("prompt", trimmedPrompt);
      for (const file of files) body.append("files", file);

      const res = await fetch("/api/agents", { method: "POST", body });

      let data: CreateResponse | null = null;
      try {
        data = (await res.json()) as CreateResponse;
      } catch {
        data = null;
      }

      if (!res.ok || !data?.id) {
        setError(
          data?.error ??
            `Build failed (HTTP ${res.status}). Check the server logs and try again.`
        );
        return;
      }

      const id = data.id;
      const skipped = data.skipped ?? [];
      if (skipped.length > 0) {
        setNotice(
          `Skipped ${skipped.length} unsupported file${
            skipped.length === 1 ? "" : "s"
          }: ${skipped.join(", ")}. Opening the agent…`
        );
        redirectTimer.current = setTimeout(() => goToAgent(id), 1800);
        return;
      }

      goToAgent(id);
    } catch {
      setError(
        "Could not reach the server. Check that the app is running and try again."
      );
    } finally {
      setBuilding(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-12 sm:py-16">
      <Link
        href="/"
        className="text-sm text-neutral-500 underline underline-offset-4 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
      >
        ← All agents
      </Link>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight">New agent</h1>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Give the agent a persona and, optionally, documents to ground its
        answers in.
      </p>

      <form onSubmit={handleSubmit} className="mt-10 flex flex-col gap-8">
        <div className="flex flex-col gap-2">
          <label htmlFor="name" className="text-sm font-medium">
            Name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Support"
            className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:placeholder:text-neutral-600 dark:focus:border-neutral-300"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="prompt" className="text-sm font-medium">
            Instructions
          </label>
          <textarea
            id="prompt"
            name="prompt"
            required
            rows={6}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={PROMPT_PLACEHOLDER}
            className="resize-y rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:placeholder:text-neutral-600 dark:focus:border-neutral-300"
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            This becomes the agent&rsquo;s system prompt.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="files" className="text-sm font-medium">
            Knowledge base{" "}
            <span className="font-normal text-neutral-500 dark:text-neutral-400">
              (optional)
            </span>
          </label>
          <input
            ref={fileInputRef}
            id="files"
            name="files"
            type="file"
            multiple
            accept={ACCEPT}
            onChange={(e) => addFiles(e.target.files)}
            className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-neutral-900 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white dark:border-neutral-700 dark:file:bg-neutral-100 dark:file:text-neutral-900"
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            .txt, .md, .markdown and .pdf. Anything else is skipped.
          </p>

          {files.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {files.map((file, index) => (
                <li
                  key={`${file.name}-${file.size}-${index}`}
                  className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800"
                >
                  <span className="truncate">{file.name}</span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">
                      {formatBytes(file.size)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeFile(index)}
                      className="text-xs font-medium text-neutral-500 underline underline-offset-4 hover:text-red-600 dark:text-neutral-400 dark:hover:text-red-400"
                    >
                      Remove
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300"
          >
            {error}
          </p>
        )}

        {notice && (
          <p
            role="status"
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
          >
            {notice}
          </p>
        )}

        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={building}
            className="rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            {building ? "Building…" : "Build"}
          </button>
          {building && (
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Reading documents and embedding them — this can take a few
              seconds.
            </span>
          )}
        </div>
      </form>
    </main>
  );
}
