/**
 * Hard network kill-switch for the whole suite.
 *
 * Every test that would otherwise talk to OpenAI mocks `@/lib/embed` and/or
 * `@/lib/openai`. This setup file is the backstop: if a mock is ever removed or
 * mis-registered, the real client's `fetch` call blows up loudly here instead of
 * silently billing a real API key.
 */
const blocked = (input: unknown): never => {
  const target =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : "an unknown host";
  throw new Error(
    `Network access is blocked in tests (attempted fetch to ${target}). ` +
      "Mock the module boundary instead."
  );
};

globalThis.fetch = blocked as unknown as typeof fetch;
