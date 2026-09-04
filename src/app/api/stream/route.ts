/**
 * GET /api/stream?since=<iso> — Server-Sent Events for the live queue.
 *
 * SSE rather than WebSockets, per the blueprint: one-directional is all the
 * tower needs, it survives serverless without a socket server, and it
 * reconnects on its own. The client falls back to a 3-second poll on
 * /api/events if the stream drops.
 *
 * The stream polls Postgres rather than using LISTEN/NOTIFY. A pooled
 * connection cannot hold a LISTEN reliably — the pooler hands the session to
 * someone else — and a dedicated connection per viewer is not something Neon's
 * connection budget will thank you for at demo time.
 */
import { asc, gt } from 'drizzle-orm';
import { db } from '@/db/client';
import { paymentEvents } from '@/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POLL_MS = 2000;
/** Cap a single connection so a forgotten browser tab cannot hold a slot forever. */
const MAX_LIFETIME_MS = 10 * 60_000;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sinceParam = url.searchParams.get('since');
  let cursor = sinceParam ? new Date(sinceParam) : new Date();
  if (Number.isNaN(cursor.getTime())) cursor = new Date();

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed by the client disconnecting */
        }
      };

      req.signal.addEventListener('abort', close);
      send('open', { since: cursor.toISOString() });

      const tick = async () => {
        if (closed) return;
        if (Date.now() - startedAt > MAX_LIFETIME_MS) {
          send('bye', { reason: 'max_lifetime' });
          close();
          return;
        }
        try {
          const rows = await db
            .select({
              id: paymentEvents.id,
              createdAt: paymentEvents.createdAt,
              failedAt: paymentEvents.failedAt,
              amountPaise: paymentEvents.amountPaise,
              issuer: paymentEvents.issuer,
              method: paymentEvents.method,
              state: paymentEvents.state,
            })
            .from(paymentEvents)
            // Ordered by created_at, not failed_at: a late webhook carries an
            // old failure time and would otherwise never cross the cursor.
            .where(gt(paymentEvents.createdAt, cursor))
            .orderBy(asc(paymentEvents.createdAt))
            .limit(100);

          if (rows.length > 0) {
            cursor = rows[rows.length - 1].createdAt;
            send('events', {
              rows: rows.map((r) => ({
                id: r.id,
                failed_at: r.failedAt.toISOString(),
                amount_paise: r.amountPaise,
                issuer: r.issuer,
                method: r.method,
                state: r.state,
              })),
              cursor: cursor.toISOString(),
            });
          } else {
            // A comment line keeps proxies from timing the connection out.
            if (!closed) controller.enqueue(encoder.encode(': keepalive\n\n'));
          }
        } catch (err) {
          send('error', { message: (err as Error).message });
        }
      };

      const timer = setInterval(() => void tick(), POLL_MS);
      void tick();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
