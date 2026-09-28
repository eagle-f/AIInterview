export type SpeechSynthesizer = (
  text: string,
  signal: AbortSignal,
) => Promise<ArrayBuffer>;

export interface StreamingSpeechOptions {
  synthesize: SpeechSynthesizer;
  /** Maximum text length sent in one TTS request. Defaults to 48 characters. */
  maxChunkChars?: number;
}

/** Turn streamed text into ordered, automatically played speech chunks. */
export class StreamingSpeechPlayer {
  onError?: (error: Error) => void;

  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private controller: AbortController | null = null;
  private pendingText = "";
  private synthesisQueue: Promise<void> = Promise.resolve();
  private playbackQueue: Promise<void> = Promise.resolve();
  private generation = 0;
  private maxChunkChars: number;
  private options: StreamingSpeechOptions;

  constructor(options: StreamingSpeechOptions) {
    this.options = options;
    this.maxChunkChars = Math.max(12, options.maxChunkChars ?? 48);
  }

  /** Call synchronously inside a click or microphone-start gesture. */
  activate() {
    try {
      this.context ??= new AudioContext();
      void this.context.resume().catch((error: unknown) => this.report(error));
    } catch (error) {
      this.report(error);
    }
  }

  /** Begin a new response and stop any previous speech. */
  start() {
    this.cancel();
    this.controller = new AbortController();
    this.activate();
  }

  /** Add a text delta as soon as it arrives from the language model. */
  append(delta: string) {
    if (!delta) return;
    if (!this.controller) this.start();
    this.pendingText += delta;
    this.flushCompleteChunks();
  }

  /** Send the final incomplete sentence and resolve when all audio has played. */
  finish(): Promise<void> {
    this.enqueue(this.pendingText);
    this.pendingText = "";
    return this.playbackQueue;
  }

  /** Stop playback and cancel pending TTS requests. */
  cancel() {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.pendingText = "";
    if (this.source) {
      try { this.source.stop(); } catch { /* already stopped */ }
      this.source = null;
    }
    this.synthesisQueue = Promise.resolve();
    this.playbackQueue = Promise.resolve();
  }

  async dispose() {
    this.cancel();
    await this.context?.close();
    this.context = null;
  }

  private flushCompleteChunks() {
    while (this.pendingText) {
      const punctuation = this.pendingText.search(/[。！？!?；;\n]/);
      let end = -1;
      if (punctuation >= 0 && punctuation <= this.maxChunkChars) {
        end = punctuation + 1;
      } else if (this.pendingText.length >= this.maxChunkChars) {
        end = this.maxChunkChars;
        const prefix = this.pendingText.slice(0, end);
        const pause = Math.max(prefix.lastIndexOf("，"), prefix.lastIndexOf(","), prefix.lastIndexOf("、"));
        if (pause >= Math.floor(end / 2)) end = pause + 1;
      }
      if (end < 0) break;
      this.enqueue(this.pendingText.slice(0, end));
      this.pendingText = this.pendingText.slice(end);
    }
  }

  private enqueue(rawText: string) {
    const text = rawText.replace(/[*#_`~]/g, "").replace(/\s+/g, " ").trim();
    if (!text || !/[\p{L}\p{N}]/u.test(text) || !this.controller) return;
    const generation = this.generation;
    const signal = this.controller.signal;
    const request = this.synthesisQueue.then(async () => {
      if (generation !== this.generation) return { audio: null, error: null };
      try {
        return { audio: await this.options.synthesize(text, signal), error: null };
      } catch (error) {
        return { audio: null, error };
      }
    });
    this.synthesisQueue = request.then(() => {});
    this.playbackQueue = this.playbackQueue.then(async () => {
      const result = await request;
      if (generation !== this.generation) return;
      if (result.error) {
        if (!isAbortError(result.error)) this.report(result.error);
        return;
      }
      if (!result.audio) return;
      try {
        await this.play(result.audio, generation);
      } catch (error) {
        if (generation === this.generation && !isAbortError(error)) this.report(error);
      }
    });
  }

  private async play(audio: ArrayBuffer, generation: number) {
    this.activate();
    const context = this.context!;
    await context.resume();
    const buffer = await context.decodeAudioData(audio.slice(0));
    if (generation !== this.generation) return;
    await new Promise<void>((resolve, reject) => {
      const source = context.createBufferSource();
      this.source = source;
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        if (this.source === source) this.source = null;
        source.disconnect();
        resolve();
      };
      try {
        source.start();
      } catch (error) {
        this.source = null;
        reject(error);
      }
    });
  }

  private report(error: unknown) {
    this.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
