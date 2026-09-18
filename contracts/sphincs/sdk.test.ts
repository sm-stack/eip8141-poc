import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData,type Hex} from 'viem';
import {serializeFrameTransaction} from 'viem/eip8141';
import {signatureChallenge,buildTransaction,attachSignature,accountAbi} from './sdk.js';
const sender='0x000000000000000000000000000000000000c013';
const zero=`0x${'00'.repeat(32)}` as Hex;
const one=`0x${'00'.repeat(31)}01` as Hex;
const args={chainId:1337,sender,key:{seed:zero,root:zero},epoch:0n,nonceSeq:3n,executionData:'0x1234' as Hex,maxFeePerGas:100n,maxPriorityFeePerGas:1n} as const;
const tx=buildTransaction(args);
test('canonical signature hash binds every signed transaction field',()=>{
 const original=signatureChallenge(tx);
 const mutations=[{...tx,chainId:1},{...tx,nonceSeq:4n},{...tx,nonceKeys:[1n]},
  {...tx,sender:'0x000000000000000000000000000000000000c014' as const,frames:tx.frames},
  {...tx,maxFeePerGas:101n},{...tx,maxPriorityFeePerGas:2n},
  {...tx,frames:[{...tx.frames[0],gasLimit:99898n},tx.frames[1]]},
  {...tx,frames:[{...tx.frames[0],stateGasLimit:100001n},tx.frames[1]]},
  {...tx,frames:[tx.frames[0],{...tx.frames[1],gasLimit:300001n}]},
  {...tx,frames:[tx.frames[0],{...tx.frames[1],stateGasLimit:1000001n}]},
  {...tx,frames:[tx.frames[0],{...tx.frames[1],data:'0x1235' as Hex}]}];
 for(const t of mutations)assert.notEqual(signatureChallenge(t),original);
 // The key and epoch live in VERIFY calldata, which the hash covers.
 assert.notEqual(signatureChallenge(buildTransaction({...args,epoch:1n})),original);
 assert.notEqual(signatureChallenge(buildTransaction({...args,key:{seed:one,root:zero}})),original);
});
test('witness is an elided ARBITRARY signature entry',()=>{
 const sig=`0x${'ab'.repeat(3688)}` as Hex;
 const signed=attachSignature(tx,sig);
 assert.equal((signed.frames[0].data.length-2)/2,100);
 assert.deepEqual(signed.frames,tx.frames);
 assert.equal(signed.signatures.length,1);
 assert.equal(signed.signatures[0].scheme,0);assert.equal(signed.signatures[0].msg,'0x');assert.equal(signed.signatures[0].signature,sig);
 assert.equal(signatureChallenge(signed),signatureChallenge(tx));
 assert.equal(decodeFunctionData({abi:accountAbi,data:signed.frames[0].data}).functionName,'validate');
 assert.equal(signed.frames[0].gasLimit,99899n);
 assert.ok(serializeFrameTransaction(signed).length>serializeFrameTransaction(tx).length);
 assert.throws(()=>attachSignature(tx,'0x'));
});
test('unsupported envelopes fail before signing',()=>{
 assert.throws(()=>signatureChallenge({...tx,nonceKeys:[0n,1n]}));
 assert.throws(()=>signatureChallenge({...tx,signatures:[]}));
 assert.throws(()=>signatureChallenge({...tx,signatures:[{...tx.signatures[0],msg:one}]}));
 assert.throws(()=>signatureChallenge({...tx,signatures:[tx.signatures[0],tx.signatures[0]]}));
 assert.throws(()=>signatureChallenge({...tx,frames:[tx.frames[0]]}));
 assert.throws(()=>signatureChallenge({...tx,frames:[tx.frames[0],{...tx.frames[1],value:1n}]}));
 assert.throws(()=>signatureChallenge({...tx,frames:[{...tx.frames[0],data:`${tx.frames[0].data}00` as Hex},tx.frames[1]]}));
 assert.throws(()=>signatureChallenge({...tx,frames:[tx.frames[0],{...tx.frames[1],data:`0x${'01'.repeat(16385)}`}]}));
});
