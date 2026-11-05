import type { ServerEvent } from '../shared/events.js';

export interface StoredEvent {
  id: number;
  event: ServerEvent;
}

type Listener = (stored: StoredEvent) => void;

/**
 * In-process publish/subscribe for server events. A bounded ring buffer lets reconnecting SSE
 * clients replay what they missed via Last-Event-ID; older gaps require a full resync.
 */
export class EventBus {
  private sequence = 0;
  private readonly buffer: StoredEvent[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(private readonly capacity = 500) {}

  emit(event: ServerEvent): void {
    const stored = { id: ++this.sequence, event };

    this.buffer.push(stored);

    if (this.buffer.length > this.capacity) this.buffer.shift();

    for (const listener of this.listeners) {
      try {
        listener(stored);
      } catch {
        // A broken subscriber must never block other subscribers or the emitter.
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Events after `lastId`, or null when that point has left the buffer and a resync is needed. */
  since(lastId: number): StoredEvent[] | null {
    if (lastId >= this.sequence) return [];

    const oldest = this.buffer[0]?.id ?? this.sequence + 1;

    if (lastId < oldest - 1) return null;

    return this.buffer.filter((stored) => stored.id > lastId);
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}
