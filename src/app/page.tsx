/**
 * `/` — the entry screen.
 *
 * This used to `redirect('/tower')`. It no longer does: a judge landing cold on
 * a dense polling grid has no idea what the columns mean or why the exercise is
 * hard, and the one thing this project needs understood — that the headline
 * number is measured against a control arm, not counted — was invisible until
 * they found the Arms panel. The tower is one click away and the entry screen
 * reads its numbers from the same live APIs.
 */
import { EntryScreen } from '@/components/entry/entry-screen';

export const dynamic = 'force-dynamic';

export default function Home() {
  return <EntryScreen />;
}
