import { database } from '@/lib/server/db';
import { discovery } from '@/lib/server/discovery';
import { sanitizeError } from '@/lib/server/security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return Response.json(await discovery(await database()), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'discovery.failed', error: sanitizeError(error) }));
    return Response.json({ error: 'The discovery feeds could not be loaded. Please try again.' }, {
      status: 500, headers: { 'Cache-Control': 'no-store' },
    });
  }
}
