import { serve } from 'inngest/next';
import { functions } from '@/jobs';
import { inngest } from '@/lib/inngest';

export const runtime = 'nodejs';

export const { GET, POST, PUT } = serve({ client: inngest, functions });
