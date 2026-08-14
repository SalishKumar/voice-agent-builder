import OpenAI from "openai";

export const CHAT_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
export const EMBED_MODEL =
  process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small";

export class MissingApiKeyError extends Error {}

export function getOpenAI(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new MissingApiKeyError(
      "OPENAI_API_KEY is not set. Copy .env.example to .env.local and add your key."
    );
  }
  return new OpenAI({ apiKey });
}
