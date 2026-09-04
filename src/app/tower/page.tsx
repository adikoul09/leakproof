/**
 * /tower — the Control Tower.
 *
 * A server component so the console's shell renders on the server; the live
 * parts hydrate on top. The `?event=` parameter is read here and handed down,
 * which keeps the trace drawer URL-addressable and shareable without pulling
 * the whole page out of server rendering.
 */
import { TowerClient } from '@/components/tower/tower-client';

export const dynamic = 'force-dynamic';

export default async function TowerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.event;
  const eventId = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
  return <TowerClient initialEventId={eventId} />;
}
