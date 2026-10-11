import { handleApi } from '@/lib/server/api';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => handleApi(request);
export const HEAD = (request: Request) => handleApi(request);
export const POST = (request: Request) => handleApi(request);
export const PATCH = (request: Request) => handleApi(request);
export const DELETE = (request: Request) => handleApi(request);
