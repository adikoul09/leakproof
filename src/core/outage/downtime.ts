/**
 * Cross-checking a cohort against Razorpay's Payment Downtime API.
 *
 * Pure — no database, no network. Split out from `detect.ts` so it can be
 * tested without a connection string, and so it is obvious by construction that
 * nothing here can reach into the pipeline.
 *
 * ── The rule that makes this worth anything ──────────────────────────────
 *
 * Agreement is RECORDED, never consulted. It would be trivial, and much more
 * flattering, to feed the feed into the classifier — and then "we agree with
 * Razorpay's downtime data 94% of the time" would be a statement about a copy,
 * not a detector. The classifier runs on cohort evidence alone and this scores
 * it afterwards, like a marker against an exam already sat.
 */
import type { Downtime } from '@/core/rails/razorpay';

/**
 * Razorpay reports issuers as IFSC bank codes; we label them by common name.
 *
 * The live test-mode feed returns `{issuer: 'BKID'}`, `{issuer: 'PUNB'}`,
 * `{issuer: 'CNRB'}`, `{issuer: 'CITI'}` — Bank of India, Punjab National,
 * Canara, Citi. Our cohorts say `SBI`, `ICICI`, `AXIS`, `KOTAK`.
 *
 * Without this table the two vocabularies never meet, and the agreement
 * scorecard reports near-zero agreement for a reason that has nothing to do
 * with how good the detector is — a naming mismatch presented as a measurement.
 * Only HDFC and Citi happen to be spelled the same in both.
 */
const ISSUER_ALIASES: Record<string, string[]> = {
  HDFC: ['HDFC'],
  ICICI: ['ICIC'],
  SBI: ['SBIN'],
  AXIS: ['UTIB'],
  KOTAK: ['KKBK'],
  PNB: ['PUNB'],
  BOB: ['BARB'],
  IDFC: ['IDFB'],
  YES: ['YESB'],
  INDUSIND: ['INDB'],
  RBL: ['RATN'],
  CITI: ['CITI'],
  BOI: ['BKID'],
  CANARA: ['CNRB'],
  PAYTM: ['PYTM'],
};

/** Every code that could denote this issuer, ours and Razorpay's. */
export function issuerCodes(issuer: string): string[] {
  const key = issuer.toUpperCase();
  return [key, ...(ISSUER_ALIASES[key] ?? [])];
}

export type AgreementVerdict = { agrees: boolean | null; match: Downtime | null; why: string };

/**
 * Cross-check one cohort against the downtime feed. Three-valued on purpose.
 *
 *   null   the feed carries nothing for this METHOD, so it has no opinion here
 *   false  it covers the method and did not flag this issuer
 *   true   it flagged this issuer, or the method as a whole
 *
 * Collapsing null into false is what would let silence be reported as
 * contradiction, which understates agreement and makes the scorecard a
 * measure of the feed's coverage rather than of the detector.
 */
export function checkDowntime(
  downtimes: Downtime[],
  issuer: string | null,
  method: string | null,
): AgreementVerdict {
  if (downtimes.length === 0) {
    return { agrees: null, match: null, why: 'the downtime feed returned nothing' };
  }
  if (!method) {
    return { agrees: null, match: null, why: 'cohort has no method to match on' };
  }

  const m = method.toLowerCase();
  const candidates = downtimes.filter((d) => (d.method ?? '').toLowerCase() === m);
  if (candidates.length === 0) {
    return {
      agrees: null,
      match: null,
      why: `the feed carries no ${method} rows at all, so it has no opinion on this cohort`,
    };
  }

  // A method-wide downtime with no instrument detail covers every issuer on it.
  const methodWide = candidates.find((d) => Object.keys(d.instrument ?? {}).length === 0);
  if (!issuer) {
    return methodWide
      ? { agrees: true, match: methodWide, why: `feed reports ${method} degraded method-wide` }
      : { agrees: false, match: null, why: `feed covers ${method} but flagged no matching issuer` };
  }

  const wanted = new Set(issuerCodes(issuer));
  const byIssuer = candidates.find((d) =>
    Object.values(d.instrument ?? {}).some((v) => wanted.has(String(v).toUpperCase())),
  );
  if (byIssuer) {
    return { agrees: true, match: byIssuer, why: `feed flagged ${issuer} on ${method}` };
  }
  if (methodWide) {
    return { agrees: true, match: methodWide, why: `feed reports ${method} degraded method-wide` };
  }
  return {
    agrees: false,
    match: null,
    why: `feed covers ${method} (${candidates.length} row(s)) but did not flag ${issuer}`,
  };
}

/** Back-compat shim for callers that only want the matched row. */
export function matchDowntime(
  downtimes: Downtime[],
  issuer: string | null,
  method: string | null,
): Downtime | null {
  return checkDowntime(downtimes, issuer, method).match;
}
