import { database } from '@/lib/server/db';
import { discovery } from '@/lib/server/discovery';
import { sanitizeError } from '@/lib/server/security';
import { databaseUnavailableResponse } from '@/lib/server/database-errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return Response.json(await discovery(await database()), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const unavailable = databaseUnavailableResponse(error); if (unavailable) return unavailable;
    console.error(JSON.stringify({ event: 'discovery.failed', error: sanitizeError(error) }));
    return Response.json({ error: 'The discovery feeds could not be loaded. Please try again.' }, {
      status: 500, headers: { 'Cache-Control': 'no-store' },
    });
  }
}
