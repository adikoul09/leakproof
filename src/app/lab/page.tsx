/**
 * /lab — the Incrementality Lab.
 *
 * A server component shell, for one reason beyond the usual: the corpus
 * provenance is read here and handed down. Whether the events on this screen
 * are synthetic, and whether any message was actually delivered, cannot be
 * inferred from `/api/metrics/summary` — it reports the same clean lift either
 * way. Fetching it on the server means the disclosure renders with the page
 * rather than arriving after the headline number has already been read.
 */
import { LabClient } from '@/components/lab/lab-client';
import { corpusProvenance } from '@/core/experiment/provenance';

export const dynamic = 'force-dynamic';

export default async function LabPage() {
  const provenance = await corpusProvenance();
  return <LabClient provenance={provenance} />;
}
