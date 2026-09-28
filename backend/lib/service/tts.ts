/** Options for boboBear's Volcengine unidirectional MP3 TTS endpoint. */
export interface SpeechSynthesisOptions {
  apiKey: string;
  resourceId: string;
  voiceName: string;
  endpoint?: string;
  uid?: string;
  sampleRate?: number;
  speechRate?: number;
  loudnessRate?: number;
  silenceDurationMs?: number;
  /** Injectable for tests or custom networking. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface TTSLine {
  code?: number;
  data?: string;
  message?: string;
}

const DEFAULT_ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";

/** Synthesize text as MP3 bytes. Keep the API key on the server. */
export async function synthesizeSpeech(
  text: string,
  options: SpeechSynthesisOptions,
  signal?: AbortSignal,
): Promise<Buffer> {
  const input = text.trim();
  if (!input) throw new Error("Speech text is empty");
  if (!options.apiKey || !options.resourceId || !options.voiceName) {
    throw new Error("TTS apiKey, resourceId and voiceName are required");
  }

  const response = await (options.fetchImpl ?? fetch)(options.endpoint ?? DEFAULT_ENDPOINT, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": options.apiKey,
      "X-Api-Resource-Id": options.resourceId,
    },
    body: JSON.stringify({
      user: { uid: options.uid ?? "bearbobo" },
      req_params: {
        text: input,
        speaker: options.voiceName,
        audio_params: {
          format: "mp3",
          sample_rate: options.sampleRate ?? 24000,
          speech_rate: options.speechRate ?? 0,
          loudness_rate: options.loudnessRate ?? 0,
        },
        additions: JSON.stringify({ silence_duration: options.silenceDurationMs ?? 125 }),
      },
    }),
  });

  if (!response.ok || !response.body) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`TTS HTTP ${response.status}: ${detail}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let base64Audio = "";
  let finished = false;

  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    let chunk: TTSLine;
    try {
      chunk = JSON.parse(line) as TTSLine;
    } catch {
      // boboBear's endpoint sends JSON lines; ignore non-JSON keepalive lines.
      return;
    }
    if (chunk.code && chunk.code !== 0 && chunk.code !== 20000000) {
      throw new Error(`TTS error ${chunk.code}: ${chunk.message ?? "unknown error"}`);
    }
    if (typeof chunk.data === "string") base64Audio += chunk.data;
    if (chunk.code === 20000000) finished = true;
  };

  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      consumeLine(pending.slice(0, newline).trim());
      pending = pending.slice(newline + 1);
      if (finished) break;
    }
  }
  if (!finished) {
    pending += decoder.decode();
    consumeLine(pending.trim());
  } else {
    try { await reader.cancel(); } catch { /* audio is already complete */ }
  }
  if (!base64Audio) throw new Error("TTS returned no audio");
  return Buffer.from(base64Audio, "base64");
}
