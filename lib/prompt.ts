import { getAgent, getChunks, listFiles } from "./db";
import { embedOne } from "./embed";
import { topK, type Retrieved } from "./retrieve";

/**
 * How many knowledge-base chunks to put in front of the model.
 *
 * Three, not four: on a phone call the whole system prompt is re-sent every
 * turn, so a dropped chunk is paid back on every single turn of the call. The
 * fourth chunk was rarely the one that answered the question.
 */
export const TOP_K = 3;

const VOICE_STYLE =
  "Replies are spoken aloud, so keep them to two or three sentences of plain " +
  "conversational text. No markdown, no bullet points, no lists.";

const KB_PREAMBLE =
  "---\nYou have access to the following excerpts from the agent's knowledge base.\n" +
  "Use them when they are relevant. If the answer is not in them, say you don't\n" +
  "know rather than guessing.";

const EMPTY_KB =
  "The knowledge base is empty; answer from the agent's instructions alone.";

export interface RetrievalResult {
  system: string;
  sources: { file: string; score: number }[];
  retrieved: Retrieved[];
}

function buildSystemPrompt(
  prompt: string,
  retrieved: Retrieved[],
  filenameOf: (fileId: string) => string
): string {
  const sections = [prompt];

  if (retrieved.length > 0) {
    const excerpts = retrieved
      .map(
        (r, i) =>
          `[${i + 1}] (${filenameOf(r.chunk.file_id)})\n${r.chunk.content}`
      )
      .join("\n\n");
    sections.push(`${KB_PREAMBLE}\n\n${excerpts}`);
  } else {
    sections.push(EMPTY_KB);
  }

  sections.push(VOICE_STYLE);

  return sections.join("\n\n");
}

/** One entry per file, keeping that file's best-scoring chunk. */
function toSources(
  retrieved: Retrieved[],
  filenameOf: (fileId: string) => string
): RetrievalResult["sources"] {
  const best = new Map<string, number>();
  for (const r of retrieved) {
    const file = filenameOf(r.chunk.file_id);
    const prev = best.get(file);
    if (prev === undefined || r.score > prev) best.set(file, r.score);
  }
  return [...best].map(([file, score]) => ({ file, score }));
}

/**
 * Retrieve the chunks most relevant to `question` and assemble the system
 * prompt that grounds a reply in them.
 *
 * Shared by the browser chat route and the media-stream WebSocket server so the
 * two paths cannot drift. Throws MissingApiKeyError when OPENAI_API_KEY is unset.
 */
export async function buildGroundedPrompt(
  agentId: string,
  question: string,
  k = TOP_K
): Promise<RetrievalResult> {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  const files = listFiles(agentId);
  const filenames = new Map(files.map((f) => [f.id, f.filename]));
  const filenameOf = (fileId: string) => filenames.get(fileId) ?? "unknown";

  const queryVec = await embedOne(question);
  const retrieved = topK(queryVec, getChunks(agentId), k);

  return {
    system: buildSystemPrompt(agent.prompt, retrieved, filenameOf),
    sources: toSources(retrieved, filenameOf),
    retrieved,
  };
}
