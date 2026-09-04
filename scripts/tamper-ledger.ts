/**
 * Prove the hash chain does what it claims.
 *
 *   npm run ledger:tamper
 *
 * Appends a short chain, verifies it, then edits a row *behind the
 * append-only trigger's back* — disabling the trigger first, exactly as an
 * attacker with database access would — and verifies again. A chain that only
 * survives attacks nobody attempts is decoration.
 *
 * ⚠️ Destructive to the audit_ledger table. Development only.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

async function main() {
  const { sql } = await import('../src/db/client');
  const { appendLedger } = await import('../src/core/ledger/append');
  const { verifyChain } = await import('../src/core/ledger/verify');

  const line = (s: string) => console.log(`  ${s}`);

  console.log('\n── building a chain ' + '─'.repeat(46));
  await sql`alter table audit_ledger disable trigger audit_ledger_no_update`;
  await sql`truncate audit_ledger restart identity`;
  await sql`alter table audit_ledger enable trigger audit_ledger_no_update`;

  for (const [i, action] of ['classified', 'arm_assigned', 'planned', 'action_sent', 'recovered'].entries()) {
    const row = await appendLedger({
      eventId: `pay_LEDGER${i}`,
      action,
      costPaise: i * 10,
      detail: { step: i, rail: 'upi_payment_link', note: 'nested detail must be hashed too' },
    });
    line(`seq ${row.seq}  ${action.padEnd(13)} ${row.hash.slice(0, 16)}…`);
  }

  let v = await verifyChain();
  console.log(`\n  verify → intact=${v.intact} records=${v.records} in ${v.verifiedInMs}ms`);
  line(`genesis ${v.genesisHash?.slice(0, 16)}…   head ${v.headHash?.slice(0, 16)}…`);

  console.log('\n── attack 1: the append-only trigger ' + '─'.repeat(29));
  try {
    await sql`update audit_ledger set cost_paise = 999999 where seq = 3`;
    line('✗ UPDATE was allowed — the trigger is not protecting the table');
  } catch (e) {
    line(`✓ UPDATE refused by the database: ${String((e as Error).message).split('\n')[0]}`);
  }

  console.log('\n── attack 2: edit a nested detail field with the trigger disabled ' + '─'.repeat(1));
  line('(this is the case the blueprint\'s canonical() one-liner would have missed)');
  await sql`alter table audit_ledger disable trigger audit_ledger_no_update`;
  await sql`update audit_ledger set detail = jsonb_set(detail, '{rail}', '"human_escalation"') where seq = 3`;
  await sql`alter table audit_ledger enable trigger audit_ledger_no_update`;

  v = await verifyChain();
  line(`verify → intact=${v.intact}` + (v.break ? ` broken at seq ${v.brokenAtSeq} (${v.break.kind})` : ''));
  if (v.break) line(`         ${v.break.explanation}`);
  const detectedNested = !v.intact && v.break?.kind === 'content_edit';

  console.log('\n── attack 3: delete a row from the middle ' + '─'.repeat(24));
  await sql`alter table audit_ledger disable trigger audit_ledger_no_update`;
  await sql`update audit_ledger set detail = jsonb_set(detail, '{rail}', '"upi_payment_link"') where seq = 3`;
  await sql`delete from audit_ledger where seq = 3`;
  await sql`alter table audit_ledger enable trigger audit_ledger_no_update`;

  v = await verifyChain();
  line(`verify → intact=${v.intact}` + (v.break ? ` broken at seq ${v.brokenAtSeq} (${v.break.kind})` : ''));
  if (v.break) line(`         ${v.break.explanation}`);
  const detectedDelete = !v.intact && v.break?.kind === 'broken_link';

  console.log('\n── result ' + '─'.repeat(55));
  line(`nested detail edit detected : ${detectedNested ? 'YES ✓' : 'NO ✗'}`);
  line(`mid-chain deletion detected : ${detectedDelete ? 'YES ✓' : 'NO ✗'}`);

  await sql`alter table audit_ledger disable trigger audit_ledger_no_update`;
  await sql`truncate audit_ledger restart identity`;
  await sql`alter table audit_ledger enable trigger audit_ledger_no_update`;
  line('ledger cleaned up\n');

  await sql.end();
  if (!detectedNested || !detectedDelete) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
