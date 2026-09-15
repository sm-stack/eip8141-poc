// Public deterministic development fixtures; never fund the corresponding keys.
import {writeFileSync} from 'node:fs';
import {keccak256,toHex} from 'viem';
import {makeKey,sign} from './test-helpers.js';
for(let i=0;i<4;i++){
 const key=makeKey(`vector-${Math.floor(i/2)}`),message=keccak256(toHex(`C13 differential fixture ${i}`));
 writeFileSync(`sphincs/fixtures/vector-${i}.json`,JSON.stringify({seed:key.seed,root:key.root,message,signature:sign(message,key)},null,2)+'\n');
}
