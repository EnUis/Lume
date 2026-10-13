import {database} from '@/lib/server/db';
import {publicCollection} from '@/lib/server/collection';
import {AppError,sanitizeError} from '@/lib/server/security';
import {databaseUnavailableResponse} from '@/lib/server/database-errors';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  try{const ids=(new URL(request.url).searchParams.get('ids')||'').split(',').filter(Boolean);return Response.json({titles:await publicCollection(await database(),ids)},{headers:{'Cache-Control':'private, max-age=10'}});}
  catch(error){const unavailable=databaseUnavailableResponse(error);if(unavailable)return unavailable;if(!(error instanceof AppError))console.error(JSON.stringify({event:'collection.failed',error:sanitizeError(error)}));return Response.json({error:error instanceof AppError?error.message:'Could not load your collection'},{status:error instanceof AppError?error.status:500});}
}
