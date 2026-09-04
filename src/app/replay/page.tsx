/**
 * /replay — Replay & What-If.
 *
 * A server component shell so the console renders without waiting for JS; the
 * configuration form and results hydrate on top.
 */
import { ReplayClient } from '@/components/replay/replay-client';

export const dynamic = 'force-dynamic';

export default function ReplayPage() {
  return <ReplayClient />;
}
