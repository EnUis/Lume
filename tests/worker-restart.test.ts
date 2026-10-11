import { expect, it } from 'vitest';
import { workerRestart } from '../scripts/worker-restart.mjs';
it('backs off repeated worker crashes and resets after stable operation', () => {
 let failures=0; const delays=[];
 for(let index=0;index<8;index++){const next=workerRestart(failures,1000);failures=next.failures;delays.push(next.delayMs);}
 expect(delays).toEqual([5000,10000,20000,40000,60000,60000,60000,60000]);
 expect(workerRestart(failures,60000)).toEqual({failures:1,delayMs:5000});
});
