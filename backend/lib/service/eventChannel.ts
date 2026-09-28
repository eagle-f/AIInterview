import type { AImanage } from "../AImanage";

const eventChannels = new Map<string, EventChannel>();

export function getEventChannel(id: string) { return eventChannels.get(id); }

export function createEventChannel(aiManager: AImanage) {
  const channel = new EventChannel(aiManager);
  eventChannels.set(channel.id, channel);
  return { message: "success", code: 201, channel: channel.id };
}

class EventChannel {
  readonly id = crypto.randomUUID();
  private events: string[] = [];
  private subscribers = new Set<() => void>();
  private finished = false;

  constructor(aiManager: AImanage) {
    void this.read(aiManager);
  }

  private async read(aiManager: AImanage) {
    const reader = aiManager.stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.events.push(value);
        for (const flush of this.subscribers) flush();
      }
    } catch {
      // Closing subscribers also lets their EventSource surface interrupted streams.
    } finally {
      reader.releaseLock();
      this.finished = true;
      for (const flush of this.subscribers) flush();
      // Retain a short reconnect window, including responses completed before GET /event.
      setTimeout(() => eventChannels.delete(this.id), 60_000).unref();
    }
  }

  getStream(lastEventId?: string): { stream: ReadableStream<string> } {
    let index = 0;
    if (lastEventId) {
      const previous = this.events.findIndex((event) => event.includes(`id: ${lastEventId}\n`));
      if (previous >= 0) index = previous + 1;
    }
    let flush: () => void = () => {};
    let closed = false;
    const stream = new ReadableStream<string>({
      start: (controller) => {
        flush = () => {
          if (closed) return;
          try {
            while (index < this.events.length) controller.enqueue(this.events[index++]!);
            if (!this.finished) return;
            controller.close();
          } catch {
            // The HTTP reader may have disconnected while the model is still working.
          }
          closed = true;
          this.subscribers.delete(flush);
        };
        this.subscribers.add(flush);
        flush();
      },
      cancel: () => {
        closed = true;
        this.subscribers.delete(flush);
      },
    });
    return { stream };
  }
}
