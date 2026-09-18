import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, sign, verify } from 'node:crypto';
import { decodeFunctionData, hexToBytes, keccak256 } from 'viem';
import { serializeFrameTransaction, parseTransaction, type TransactionSerializableFrame } from 'viem/eip8141';
import { parseDerSignature, parseSpki, parseAssertion, validatePolicy, assertionChallenge, assertionDigest, signerAddress, buildTransaction, attachAssertion, accountAbi } from './sdk.js';
import { makeKey, makeAssertion, RP, ORIGIN } from './test-helpers.js';
const key=makeKey();
const tx=buildTransaction({chainId:1337,sender:'0x0000000000000000000000000000000000001234',nonceSeq:0n,executionData:'0x1234',maxFeePerGas:10n,maxPriorityFeePerGas:1n});
test('SPKI and DER interoperate with OpenSSL P256',()=>{
    assert.deepEqual(parseSpki(key.publicKey.export({format:'der',type:'spki'})),{x:key.x,y:key.y});
    for(let i=0;i<32;i++) {
        const data=Buffer.from(`message ${i}`), der=sign('sha256',data,key.privateKey), sig=parseDerSignature(der);
        const compact=Buffer.from(sig.r.toString(16).padStart(64,'0')+sig.s.toString(16).padStart(64,'0'),'hex');
        assert.ok(verify('sha256',data,{key:key.publicKey,dsaEncoding:'ieee-p1363'},compact));
    }
});
test('DER parser rejects truncated, trailing, negative, zero and nonminimal integers',()=>{
    for(const h of ['','300602010102010100','3006020180020101','3006020100020101','300702020001020101','3006020101020100','308106020101020101']) assert.throws(()=>parseDerSignature(Buffer.from(h,'hex')));
    const der=sign('sha256',Buffer.from('test'),key.privateKey);
    for(let i=0;i<der.length;i++) assert.throws(()=>parseDerSignature(der.subarray(0,i)));
    assert.throws(()=>parseSpki(new Uint8Array(91)));
});
test('challenge binds account, chain, key epoch, nonce, fees and execution; VERIFY bytes are excluded',()=>{
    const h=assertionChallenge(tx,0n);
    assert.notEqual(h,assertionChallenge(tx,1n));
    for(const mutation of [{...tx,chainId:1},{...tx,sender:'0x0000000000000000000000000000000000001235' as const},{...tx,nonceSeq:1n},{...tx,nonceKeys:[1n]},{...tx,maxFeePerGas:11n},{...tx,frames:[tx.frames[0],{...tx.frames[1],data:'0x1235' as const}]}]) assert.notEqual(h,assertionChallenge(mutation,0n));
    const signed=attachAssertion(tx,key,0n,makeAssertion(h,key.privateKey));
    assert.equal(assertionChallenge(tx,0n),assertionChallenge(signed,0n));
    assert.notEqual(h,assertionChallenge(tx,0n,1n));
});
test('RP/origin policy rejects unsafe and unrelated origins',()=>{
    validatePolicy(RP,ORIGIN); validatePolicy('example.com',ORIGIN);
    for(const origin of ['http://wallet.example.com','https://evil.com',`${ORIGIN}/`,`${ORIGIN}/path`,'https://wallet.example.com@evil.com']) assert.throws(()=>validatePolicy(RP,origin));
});
test('assertion adapter accepts supported JSON and rejects duplicate challenge and UV failure',()=>{
    const h=assertionChallenge(tx,0n), a=makeAssertion(h,key.privateKey);
    // DER value 1/1 is structurally valid; cryptographic verification is on-chain.
    const response={authenticatorData:hexToBytes(a.authenticatorData).buffer as ArrayBuffer,clientDataJSON:hexToBytes(a.clientDataJSON).buffer as ArrayBuffer,signature:Buffer.from('3006020101020101','hex').buffer};
    response.signature=Uint8Array.from(Buffer.from('3006020101020101','hex')).buffer;
    const credential={id:'AA',...key,rpId:RP,origin:ORIGIN};
    assert.equal(parseAssertion(response,h,credential).r,1n);
    const json=Buffer.from(a.clientDataJSON.slice(2),'hex').toString();
    response.clientDataJSON=new TextEncoder().encode(json.slice(0,-1)+',"challenge":"evil"}').buffer;
    assert.throws(()=>parseAssertion(response,h,credential));
    response.clientDataJSON=hexToBytes(a.clientDataJSON).buffer as ArrayBuffer;
    const auth=hexToBytes(a.authenticatorData); auth[32]=1;response.authenticatorData=auth.buffer as ArrayBuffer;
    assert.throws(()=>parseAssertion(response,h,credential));
});
test('assertion becomes a protocol-validated low-S P256 signature entry over the WebAuthn digest',()=>{
    const N=0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const h=assertionChallenge(tx,0n), word=(v:bigint)=>v.toString(16).padStart(64,'0');
    const expectedSigner=`0x${keccak256(`0x${word(key.x)}${word(key.y)}`).slice(26)}`;
    assert.equal(signerAddress(key).toLowerCase(),expectedSigner);
    for(let i=0;i<16;i++){
        const a=makeAssertion(h,key.privateKey);
        // Exercise both forms an authenticator may emit.
        const high=a.s>N/2n?a:{...a,s:N-a.s};
        for(const assertion of [a,high]){
            const signed=attachAssertion(tx,key,0n,assertion);
            assert.equal(signed.signatures.length,1);
            const entry=signed.signatures[0];
            assert.equal(entry.scheme,2);assert.equal(entry.signer.toLowerCase(),expectedSigner);
            const raw=Buffer.concat([Buffer.from(assertion.authenticatorData.slice(2),'hex'),createHash('sha256').update(Buffer.from(assertion.clientDataJSON.slice(2),'hex')).digest()]);
            assert.equal(entry.msg,`0x${createHash('sha256').update(raw).digest('hex')}`);assert.equal(entry.msg,assertionDigest(assertion));
            assert.equal((entry.signature.length-2)/2,128);
            const sWord=BigInt(`0x${entry.signature.slice(66,130)}`);
            assert.ok(sWord>0n&&sWord<=N/2n,'low-S');
            assert.equal(entry.signature.slice(130),`${word(key.x)}${word(key.y)}`);
            assert.ok(verify('sha256',raw,{key:key.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(entry.signature.slice(2,130),'hex')));
            // VERIFY calldata carries only the ceremony; no key or curve signature.
            const decoded=decodeFunctionData({abi:accountAbi,data:signed.frames[0].data});
            assert.equal(decoded.functionName,'validate');
            assert.deepEqual(decoded.args,[0n,10_000_000_000_000_000n,assertion.authenticatorData,assertion.clientDataJSON]);
            const roundTrip=parseTransaction(serializeFrameTransaction(signed)) as TransactionSerializableFrame;
            assert.equal(roundTrip.signatures[0].msg,entry.msg);assert.equal(roundTrip.signatures[0].signature,entry.signature);
        }
    }
    assert.throws(()=>attachAssertion(attachAssertion(tx,key,0n,makeAssertion(h,key.privateKey)),key,0n,makeAssertion(h,key.privateKey)));
});
