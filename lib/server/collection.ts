import type {DB} from './db';
import {accessibleTitleSQL,resolveTitleId,titleRecord} from './catalog';
import {AppError} from './security';
export async function publicCollection(db:DB,ids:string[]){
  if(ids.length>100||ids.some(id=>!/^[a-zA-Z0-9_-]{1,64}$/.test(id)))throw new AppError(400,'Provide up to 100 valid title IDs');
  if(!ids.length)return[];
  const canonical=await Promise.all(ids.map(id=>resolveTitleId(db,id)));
  const unique=[...new Set(canonical)];
  const rows=await db.all(`SELECT t.* FROM titles t WHERE t.id IN (${unique.map(()=>'?').join(',')}) AND ${accessibleTitleSQL}`,unique);
  const titles=new Map(rows.map(r=>[r.id,titleRecord(r)]));
  canonical.forEach((titleId,index)=>{const title=titles.get(titleId);if(title&&ids[index]!==titleId)title.alternateIds=[...new Set([...(title.alternateIds||[]),ids[index]])];});
  return unique.flatMap(id=>titles.has(id)?[titles.get(id)!]:[]);
}
