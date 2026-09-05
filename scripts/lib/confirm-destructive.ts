/**
 * A typed confirmation in front of the two scripts that destroy data.
 *
 * This project has exactly one Neon database. `.env.local` points at it, and
 * so does the deployed app — there is no separate development target to fall
 * back to, which means `db:reset` and `ledger:tamper` have always been one
 * fat-fingered command away from wiping what the judges are looking at.
 *
 * A `y/N` prompt would not fix that; `y` is muscle memory. The operator has to
 * type the database's own endpoint id, which cannot be answered from habit and
 * forces them to read the host they are actually pointed at. The password is
 * never parsed into anything printable.
 */
import { createInterface } from 'node:readline/promises';

export interface Target {
  host: string;
  endpointId: string;
  database: string;
  user: string;
}

/** Pull the identifying parts out of a connection string. Never the password. */
export function describeTarget(url: string): Target {
  const u = new URL(url);
  return {
    host: u.hostname,
    // Neon hosts look like ep-floral-wave-b3gr9a5a.c-4.ap-southeast-1.aws.neon.tech
    endpointId: u.hostname.split('.')[0] ?? u.hostname,
    database: u.pathname.replace(/^\//, '').split('?')[0] || '(default)',
    user: u.username || '(none)',
  };
}

export interface ConfirmOptions {
  /** What is about to happen, in the imperative: "delete every row in 19 tables". */
  action: string;
  url: string;
  argv?: string[];
  /** Escape hatch for non-interactive use. Must be passed deliberately. */
  forceFlag?: string;
}

/**
 * Resolves only if the operator confirms. Exits the process otherwise — a
 * destructive script that continues past an unanswered prompt is the bug this
 * exists to prevent.
 */
export async function confirmDestructive(opts: ConfirmOptions): Promise<void> {
  const argv = opts.argv ?? process.argv;
  const force = opts.forceFlag ? argv.includes(opts.forceFlag) : false;
  const t = describeTarget(opts.url);

  const rule = '─'.repeat(66);
  console.error(`\n\x1b[31m${rule}\x1b[0m`);
  console.error('\x1b[31m  DESTRUCTIVE — this is the live database the deployed app reads\x1b[0m');
  console.error(`\x1b[31m${rule}\x1b[0m`);
  console.error(`  action    ${opts.action}`);
  console.error(`  host      ${t.host}`);
  console.error(`  database  ${t.database}`);
  console.error(`  user      ${t.user}`);
  console.error(`\x1b[31m${rule}\x1b[0m\n`);

  if (force) {
    console.error(`  ${opts.forceFlag} passed — proceeding without a prompt.\n`);
    return;
  }

  if (!process.stdin.isTTY) {
    console.error(
      `  Refusing to run: no terminal to confirm at.\n` +
        `  If you really mean it non-interactively, pass ${opts.forceFlag ?? '--force'}.\n`,
    );
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`  Type the endpoint id to proceed (\x1b[1m${t.endpointId}\x1b[0m): `);
    if (answer.trim() !== t.endpointId) {
      console.error('\n  Did not match. Nothing was changed.\n');
      process.exit(1);
    }
  } finally {
    rl.close();
  }
  console.error('');
}
