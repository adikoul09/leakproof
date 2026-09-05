/**
 * /radar — the Outage Radar.
 *
 * A client shell: everything on it comes from one endpoint and the screen has
 * no server-only disclosure to render ahead of the data, unlike /lab.
 */
import { RadarClient } from '@/components/radar/radar-client';

export const dynamic = 'force-dynamic';

export default function RadarPage() {
  return <RadarClient />;
}
