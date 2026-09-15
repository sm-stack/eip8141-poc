import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData,type Hex} from 'viem';
import {signatureChallenge,buildTransaction,attachSignature,accountAbi} from './sdk.js';
const sender='0x000000000000000000000000000000000000c013';
const tx=buildTransaction({chainId:1337,sender,nonceSeq:3n,executionData:'0x1234',maxFeePerGas:100n,maxPriorityFeePerGas:1n});
const zero=`0x${'00'.repeat(32)}` as Hex;
test('signature envelope binds replay and fee fields',()=>{
 const original=signatureChallenge(tx,0n);
 const mutations=[{...tx,chainId:1},{...tx,nonceSeq:4n},{...tx,nonceKeys:[1n]},
  {...tx,maxFeePerGas:101n},{...tx,maxPriorityFeePerGas:2n},
  {...tx,frames:[{...tx.frames[0],gasLimit:99998n},tx.frames[1]]},
  {...tx,frames:[{...tx.frames[0],stateGasLimit:100001n},tx.frames[1]]},
  {...tx,frames:[tx.frames[0],{...tx.frames[1],gasLimit:300001n}]},
  {...tx,frames:[tx.frames[0],{...tx.frames[1],stateGasLimit:1000001n}]},
  {...tx,frames:[tx.frames[0],{...tx.frames[1],data:'0x1235' as Hex}]}];
 for(const t of mutations)assert.notEqual(signatureChallenge(t,0n),original);
 assert.notEqual(signatureChallenge(tx,1n),original);assert.notEqual(signatureChallenge(tx,0n,1n),original);
});
test('signature attachment is canonical and does not change challenge',()=>{
 const sig=`0x${'ab'.repeat(3688)}` as Hex;
 const signed=attachSignature(tx,{seed:zero,root:zero},0n,sig);
 assert.equal((signed.frames[0].data.length-2)/2,3908);
 assert.equal(signatureChallenge(signed,0n),signatureChallenge(tx,0n));
 assert.equal(decodeFunctionData({abi:accountAbi,data:signed.frames[0].data}).functionName,'validate');
 assert.equal(signed.frames[0].gasLimit,99999n);
 assert.throws(()=>attachSignature(tx,{seed:zero,root:zero},0n,'0x'));
});
test('unsupported envelopes fail before signing',()=>{
 assert.throws(()=>signatureChallenge({...tx,nonceKeys:[0n,1n]},0n));
 assert.throws(()=>signatureChallenge({...tx,frames:[tx.frames[0]]},0n));
 assert.throws(()=>signatureChallenge({...tx,frames:[tx.frames[0],{...tx.frames[1],value:1n}]},0n));
 assert.throws(()=>signatureChallenge({...tx,frames:[tx.frames[0],{...tx.frames[1],data:`0x${'01'.repeat(16385)}`}]},0n));
});
