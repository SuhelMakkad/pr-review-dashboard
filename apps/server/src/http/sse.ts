import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { ServerEvent } from '@review-desk/shared/events';
import type { EventBus, StoredEvent } from '@/events.js';

export interface SseOptions {
  bus: EventBus;
  bootId: string;
  hello: () => ServerEvent;
  keepaliveMs?: number;
}

/** Parses `<bootId>:<sequence>`; ids from an earlier server boot cannot be replayed. */
export function parseEventId(value: unknown, bootId: string): number | null {
  if (typeof value !== 'string') return null;

  const [boot, sequence] = value.split(':');
  const parsed = Number(sequence);

  return boot === bootId && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** A long-lived stream: its lifetime is not a response time, so it is not timed. */
    stream?: boolean;
  }
}

export function registerEventStream(app: FastifyInstance, options: SseOptions): void {
  const streams = new Set<ServerResponse>();

  app.get('/api/events', { config: { stream: true } }, (request, reply) => {
    reply.hijack();

    const stream = reply.raw;

    // Hooks do not run on hijacked replies, so the security headers are set here explicitly.
    stream.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'X-Accel-Buffering': 'no',
    });
    stream.write('retry: 3000\n\n');

    const send = (stored: StoredEvent) => {
      stream.write(`id: ${options.bootId}:${stored.id}\ndata: ${JSON.stringify(stored.event)}\n\n`);
    };
    const sendUnbuffered = (event: ServerEvent) => {
      stream.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    sendUnbuffered(options.hello());

    const header = request.headers['last-event-id'];
    const lastId = parseEventId(header, options.bootId);

    if (header !== undefined) {
      const missed = lastId === null ? null : options.bus.since(lastId);

      if (missed === null) sendUnbuffered({ type: 'resync' });
      else for (const stored of missed) send(stored);
    }

    streams.add(stream);

    const unsubscribe = options.bus.subscribe(send);
    const keepalive = setInterval(() => {
      stream.write(': keepalive\n\n');
    }, options.keepaliveMs ?? 25_000);

    request.raw.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
      streams.delete(stream);
    });
  });

  app.addHook('preClose', async () => {
    for (const stream of streams) stream.end();

    streams.clear();
  });
}
