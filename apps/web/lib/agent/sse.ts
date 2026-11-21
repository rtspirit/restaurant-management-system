// Server-sent events, read by hand from a fetch body. Not `EventSource`: it cannot send the
// Authorization header, and a token never goes in a URL (contracts, EVENT_STREAM).

export type SseMessage = {
  /** The `id:` line, when the message had one. Stored agent events carry their `seq` here. */
  id: string | null;
  event: string;
  data: string;
};

/**
 * Feed it text as it arrives, in pieces of any size. It gives back each finished message.
 * Comment lines (`: keep-alive`) are skipped. A message with no `data:` line is dropped.
 */
export function createSseParser(): { push: (chunk: string) => SseMessage[] } {
  let buffer = "";
  let id: string | null = null;
  let event = "message";
  let data: string[] = [];

  const takeLine = (line: string, out: SseMessage[]) => {
    if (line === "") {
      if (data.length > 0) out.push({ id, event, data: data.join("\n") });
      id = null;
      event = "message";
      data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  };

  return {
    push(chunk) {
      const out: SseMessage[] = [];
      buffer += chunk;
      for (;;) {
        const at = buffer.search(/\r\n|\n|\r/);
        if (at === -1) break;
        // A lone "\r" at the very end may be the first half of "\r\n": wait for the next piece.
        if (buffer[at] === "\r" && at === buffer.length - 1) break;
        const width = buffer.startsWith("\r\n", at) ? 2 : 1;
        takeLine(buffer.slice(0, at), out);
        buffer = buffer.slice(at + width);
      }
      return out;
    },
  };
}

/** Every message in a response body, as they arrive. Ends when the body ends. Throws if the connection breaks. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseMessage> {
  const parser = createSseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  // Stopping lets go of the connection at once, even if the other end never says another word.
  const letGo = () => void reader.cancel().catch(() => undefined);
  if (signal?.aborted) letGo();
  signal?.addEventListener("abort", letGo, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const message of parser.push(decoder.decode(value, { stream: true }))) yield message;
    }
  } finally {
    signal?.removeEventListener("abort", letGo);
    reader.releaseLock();
  }
}
