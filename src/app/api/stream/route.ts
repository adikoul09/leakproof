/**
 * GET /api/stream?since=<cursor> — Server-Sent Events for the live queue.
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
import { asc, sql as dsql } from 'drizzle-orm';
import { db } from '@/db/client';
import { paymentEvents } from '@/db/schema';
import { encodeStreamCursor, parseStreamCursor } from '@/core/tower/stream-cursor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POLL_MS = 2000;
/** Cap a single connection so a forgotten browser tab cannot hold a slot forever. */
const MAX_LIFETIME_MS = 10 * 60_000;

export async function GET(req: Request) {
  const url = new URL(req.url);
  /**
   * Keyset over (created_at, id), the timestamp kept as Postgres' own text.
   * Both halves matter and both are load-bearing — see the codec's own note,
   * and FAILURES.md #37.
   */
  const parsed = parseStreamCursor(url.searchParams.get('since'));
  let cursorTs = parsed.ts;
  let cursorId = parsed.id;

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
      send('open', { since: encodeStreamCursor(cursorTs, cursorId) });

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
              createdAtRaw: dsql<string>`${paymentEvents.createdAt}::text`,
              failedAt: paymentEvents.failedAt,
              amountPaise: paymentEvents.amountPaise,
              issuer: paymentEvents.issuer,
              method: paymentEvents.method,
              state: paymentEvents.state,
            })
            .from(paymentEvents)
            // Ordered by created_at, not failed_at: a late webhook carries an
            // old failure time and would otherwise never cross the cursor.
            .where(
              cursorId === null
                ? dsql`${paymentEvents.createdAt} > ${cursorTs}::timestamptz`
                : dsql`(${paymentEvents.createdAt}, ${paymentEvents.id}) > (${cursorTs}::timestamptz, ${cursorId})`,
            )
            .orderBy(asc(paymentEvents.createdAt), asc(paymentEvents.id))
            .limit(100);

          if (rows.length > 0) {
            const last = rows[rows.length - 1];
            cursorTs = last.createdAtRaw;
            cursorId = last.id;
            send('events', {
              rows: rows.map((r) => ({
                id: r.id,
                failed_at: r.failedAt.toISOString(),
                amount_paise: r.amountPaise,
                issuer: r.issuer,
                method: r.method,
                state: r.state,
              })),
              cursor: encodeStreamCursor(cursorTs, cursorId),
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
