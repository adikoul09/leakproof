/**
 * Policy persistence. The gate itself is pure; this is the part that knows
 * which policy is live and how a new version becomes live.
 */
import { desc, eq, ne, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { policies } from '@/db/schema';
import { type Policy, type PolicyIssue, parsePolicy } from './schema';

export interface StoredPolicy {
  version: string;
  yamlSource: string;
  status: string;
  publishedAt: Date | null;
  author: string | null;
  createdAt: Date;
  policy: Policy;
}

function hydrate(row: typeof policies.$inferSelect): StoredPolicy {
  const parsed = parsePolicy(row.yamlSource);
  if (!parsed.ok) {
    // A stored policy that no longer parses means the schema changed under a
    // live policy. Failing loudly here beats a gate quietly using defaults.
    throw new Error(
      `stored policy ${row.version} no longer parses: ${parsed.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    );
  }
  return {
    version: row.version,
    yamlSource: row.yamlSource,
    status: row.status,
    publishedAt: row.publishedAt,
    author: row.author,
    createdAt: row.createdAt,
    policy: parsed.policy,
  };
}

export async function getLivePolicy(): Promise<StoredPolicy | null> {
  const [row] = await db.select().from(policies).where(eq(policies.status, 'live')).limit(1);
  return row ? hydrate(row) : null;
}

export async function getPolicy(version: string): Promise<StoredPolicy | null> {
  const [row] = await db.select().from(policies).where(eq(policies.version, version)).limit(1);
  return row ? hydrate(row) : null;
}

export async function listPolicies() {
  return db
    .select({
      version: policies.version,
      status: policies.status,
      author: policies.author,
      publishedAt: policies.publishedAt,
      createdAt: policies.createdAt,
    })
    .from(policies)
    .orderBy(desc(policies.createdAt));
}

export type CreateResult =
  | { ok: true; version: string; status: string }
  | { ok: false; issues: PolicyIssue[] };

/** Validate and store a new draft. Version comes from the YAML itself. */
export async function createDraft(yamlSource: string, author: string): Promise<CreateResult> {
  const parsed = parsePolicy(yamlSource);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };

  const version = parsed.policy.policy_version;
  const existing = await getPolicy(version);
  if (existing) {
    return {
      ok: false,
      issues: [
        {
          path: 'policy_version',
          message: `version ${version} already exists with status '${existing.status}'; bump policy_version`,
        },
      ],
    };
  }

  await db.insert(policies).values({
    version,
    yamlSource,
    parsed: parsed.policy as unknown as Record<string, unknown>,
    status: 'draft',
    author,
  });

  return { ok: true, version, status: 'draft' };
}

/**
 * Make a version live and archive whatever was live before, in one
 * transaction — two live policies at once would make the gate's answer depend
 * on which row came back first.
 *
 * Existing ledger and policy_evaluation rows keep their original version.
 * A published policy applies to new evaluations, never retroactively.
 */
export async function publishPolicy(version: string): Promise<StoredPolicy> {
  const target = await getPolicy(version);
  if (!target) throw new Error(`policy ${version} not found`);

  await db.transaction(async (tx) => {
    await tx
      .update(policies)
      .set({ status: 'archived' })
      .where(and(eq(policies.status, 'live'), ne(policies.version, version)));
    await tx
      .update(policies)
      .set({ status: 'live', publishedAt: new Date() })
      .where(eq(policies.version, version));
  });

  const published = await getPolicy(version);
  if (!published) throw new Error(`policy ${version} vanished during publish`);
  return published;
}
