/**
 * /policy — the Policy Studio.
 *
 * `?version=` is read here and handed down so a link to a specific version is
 * shareable without pulling the screen out of server rendering — the same
 * pattern the tower uses for `?event=`.
 */
import { PolicyClient } from '@/components/policy/policy-client';

export const dynamic = 'force-dynamic';

export default async function PolicyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.version;
  const version = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
  return <PolicyClient initialVersion={version} />;
}
