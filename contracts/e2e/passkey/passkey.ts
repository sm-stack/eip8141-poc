import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { encodeAbiParameters, encodeFunctionData, parseAbiParameters, parseEther, type Hex } from 'viem';
import { serializeFrameTransaction, type TransactionSerializableFrame } from 'viem/eip8141';
import { createTestClients, fundAccount, waitForReceipt } from '../helpers/client.js';
import { deployContract, loadBytecode } from '../helpers/deploy.js';
import { accountAbi, assertionChallenge, attachAssertion, buildTransaction, VERIFY_GAS, KEYED_VERIFY_GAS, MAX_GAS_CHARGE, type KeyedFrame } from '../../passkey/sdk.js';
import { makeKey, makeAssertion, ORIGIN, rpHash } from '../../passkey/test-helpers.js';

const {publicClient, walletClient, devAddr}=createTestClients(process.env.RPC_URL);
const recipient='0x000000000000000000000000000000000000ba11';
const report: any={developmentOnly:true,verifyGas:VERIFY_GAS.toString(),keyedVerifyGas:KEYED_VERIFY_GAS.toString(),revalidationCap:process.env.FRAMEPOOL_MAX_REVALIDATION_GAS,runs:[],rejections:[]};
async function main(){
    assert.equal(await publicClient.getChainId(),1337);
    const key=makeKey(), next=makeKey();
    const constructor=encodeAbiParameters(parseAbiParameters('uint256,uint256,bytes32,string,address,uint256'),[key.x,key.y,rpHash,ORIGIN,devAddr,172800n]);
    const {address:account}=await deployContract(walletClient,publicClient,`${loadBytecode('PasskeyAccount8141')}${constructor.slice(2)}`,8_000_000n,'PasskeyAccount8141');
    await fundAccount(walletClient,publicClient,account,'3');
    const read=(name:any)=>publicClient.readContract({address:account,abi:accountAbi,functionName:name} as any) as Promise<any>;
    const unsigned=async(data:Hex,nonceKey=0n,seq?:bigint)=>{
        const nonce=seq??BigInt(await publicClient.getTransactionCount({address:account}));
        const b=await publicClient.getBlock();
        return buildTransaction({chainId:1337,sender:account,nonceSeq:nonce,nonceKey,executionData:data,maxFeePerGas:(b.baseFeePerGas??1n)*2n+1n,maxPriorityFeePerGas:1n});
    };
    const signed=(tx:KeyedFrame,k=key,epoch=0n,opts={})=>attachAssertion(tx,k,epoch,makeAssertion(assertionChallenge(tx,epoch),k.privateKey,opts));
    const send=async(tx:TransactionSerializableFrame,label:string,success=true)=>{
        const hash=await publicClient.request({method:'eth_sendRawTransaction',params:[serializeFrameTransaction(tx)]});
        const receipt=await waitForReceipt(publicClient,hash);
        if (label === 'WebAuthn transfer') {
            const trace: any = await publicClient.request({method:'debug_traceTransaction',params:[hash,{disableStorage:true}]} as any);
            const logs = trace.structLogs.slice(0, trace.structLogs.findIndex((l:any)=>l.op==='APPROVE')+1);
            // The curve signature is a protocol-validated signature entry: the
            // VERIFY frame never calls P256VERIFY and reads storage exactly once.
            const p256=logs.findIndex((l:any)=>l.op==='STATICCALL' && BigInt(l.stack.at(-2).startsWith('0x') ? l.stack.at(-2) : `0x${l.stack.at(-2)}`)===256n);
            assert.equal(p256,-1,'no in-frame P256VERIFY');
            assert.equal(logs.filter((l:any)=>l.op==='SLOAD').length,1);
            report.trace={inFrameP256Verify:false,storageReads:1};
            writeFileSync('../.context/passkey/verify-trace.json',JSON.stringify(trace));
        }
        assert.equal(receipt.frameReceipts[0].status,'0x1');
        assert.equal(receipt.frameReceipts[1].status,success?'0x1':'0x0');
        assert.equal(receipt.payer.toLowerCase(),account.toLowerCase());
        const gas=BigInt(receipt.frameReceipts[0].gasUsed.execution);
        report.runs.push({label,declaredVerifyGas:tx.frames[0].gasLimit.toString(),protocolSignatureGas:'6700',nativeCredit:'0',revalidationBudget:tx.frames[0].gasLimit.toString(),verifyExecutionGas:gas.toString(),hash});console.log(`PASS ${label}: VERIFY=${gas}`);
        return hash;
    };
    const reject=async(tx:TransactionSerializableFrame,label:string)=>{
        const raw=serializeFrameTransaction(tx);
        await assert.rejects(()=>publicClient.request({method:'eth_sendRawTransaction',params:[raw]}),/validation|revert|verify|nonce|already known|invalid signature/i,label);
        report.rejections.push(label);
    };
    const pay=encodeFunctionData({abi:accountAbi,functionName:'execute',args:[recipient,parseEther('0.001'),'0x']});
    const tx=await unsigned(pay), valid=signed(tx);
    const before=await publicClient.getBalance({address:account});
    for(const [label,opts] of [['missing UV',{flags:1}],['missing UP',{flags:4}],['wrong RP',{rp:'evil.com'}],['cross origin',{crossOrigin:true}]] as const) await reject(signed(tx,key,0n,opts),label);
    await reject(signed(tx,next),'unregistered valid P256 key');
    await reject(signed(tx,key,1n),'wrong key epoch');
    const a=makeAssertion(assertionChallenge(tx,0n),key.privateKey);
    await reject(attachAssertion(tx,key,0n,{...a,r:0n}),'invalid curve signature');
    // Protocol-level signature entry rules.
    const N=0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const entry=valid.signatures[0], word=(v:bigint)=>v.toString(16).padStart(64,'0');
    const withEntry=(e:typeof entry[])=>({...valid,signatures:e});
    const highS=`${entry.signature.slice(0,66)}${word(N-BigInt(`0x${entry.signature.slice(66,130)}`))}${entry.signature.slice(130)}` as Hex;
    await reject(withEntry([{...entry,signature:highS}]),'high-S protocol signature');
    await reject(withEntry([{...entry,msg:`0x${'11'.repeat(32)}` as Hex}]),'explicit message not signed');
    await reject(withEntry([{...entry,signer:devAddr}]),'signer is not the key address');
    await reject(withEntry([]),'missing signature entry');
    await reject(withEntry([entry,entry]),'duplicate signature entry');
    await reject(withEntry([{scheme:0,signer:'0x0000000000000000000000000000000000000000',msg:'0x',signature:entry.signature}]),'ARBITRARY entry instead of P256');
    // A different, validly signed ceremony does not authorize this envelope.
    const other=attachAssertion(tx,key,0n,makeAssertion(assertionChallenge({...tx,nonceSeq:tx.nonceSeq+7n},0n),key.privateKey));
    await reject(other,'ceremony for another envelope');
    // Ceremony data swapped under a valid entry: digest no longer matches msg.
    await reject({...valid,frames:[other.frames[0],valid.frames[1]]},'ceremony data does not match signed digest');
    const changes=[{...valid,nonceSeq:valid.nonceSeq+1n},{...valid,nonceKeys:[123n]},
        {...valid,maxFeePerGas:valid.maxFeePerGas!+1n},
        {...valid,frames:[valid.frames[0],{...valid.frames[1],data:encodeFunctionData({abi:accountAbi,functionName:'execute',args:[devAddr,1n,'0x']})}]},
        {...valid,frames:[{...valid.frames[0],gasLimit:VERIFY_GAS-1n},valid.frames[1]]},
        {...valid,frames:[valid.frames[0],{...valid.frames[1],stateGasLimit:999_999n}]},
        {...valid,frames:[valid.frames[0],{...valid.frames[1],mode:'default' as const}]},
        {...valid,frames:[{...valid.frames[0],data:`${valid.frames[0].data}00` as Hex},valid.frames[1]]}];
    for(let i=0;i<changes.length;i++) await reject(changes[i],`transaction mutation ${i}`);
    await reject(attachAssertion(tx,key,0n,makeAssertion(assertionChallenge(tx,0n,1n),key.privateKey),1n),'signed cap cannot cover reservation');
    assert.equal(await publicClient.getBalance({address:account}),before);
    await send(valid,'WebAuthn transfer');
    assert.equal(await publicClient.getBalance({address:recipient}),parseEther('0.001'));
    await reject(valid,'replay after inclusion');
    await send(signed(await unsigned(pay,123n,0n)),'first keyed nonce');
    await send(signed(await unsigned(pay,123n,1n)),'reused keyed nonce');
    // A recipient callback cannot gain self-authority. This call to the wallet's
    // validate function fails in SENDER mode but consumes the included nonce.
    const failing=encodeFunctionData({abi:accountAbi,functionName:'execute',args:[account,0n,'0xffffffff']});
    await send(signed(await unsigned(failing)),'included execution failure',false);
    await send(signed(await unsigned(pay)),'fresh nonce after execution failure');
    const rotate=encodeFunctionData({abi:accountAbi,functionName:'rotateOwner',args:[next.x,next.y]});
    await send(signed(await unsigned(rotate)),'rotate owner'); assert.equal(await read('ownerEpoch'),1n);
    const afterRotate=await unsigned(pay);
    await reject(signed(afterRotate,key,0n),'old epoch after rotation');
    await reject(signed(afterRotate,key,1n),'old key with current epoch');
    await send(signed(afterRotate,next,1n),'new key after rotation');
    const schedule=await walletClient.writeContract({address:account,abi:accountAbi,functionName:'scheduleRecovery',args:[key.x,key.y]});
    assert.equal((await waitForReceipt(publicClient,schedule)).status,'0x1');
    await assert.rejects(()=>publicClient.simulateContract({address:account,abi:accountAbi,functionName:'finalizeRecovery',args:[key.x,key.y]}));
    await send(signed(await unsigned(encodeFunctionData({abi:accountAbi,functionName:'cancelRecovery'})),next,1n),'owner cancels recovery');
    assert.equal(await read('pendingRecovery'),`0x${'00'.repeat(32)}`);
    const again=await walletClient.writeContract({address:account,abi:accountAbi,functionName:'scheduleRecovery',args:[key.x,key.y]});
    await waitForReceipt(publicClient,again);
    await publicClient.request({method:'dev_advanceTime',params:['0x2a301']} as any);
    const final=await walletClient.writeContract({address:account,abi:accountAbi,functionName:'finalizeRecovery',args:[key.x,key.y]});
    assert.equal((await waitForReceipt(publicClient,final)).status,'0x1'); assert.equal(await read('ownerEpoch'),2n);
    const recovered=await unsigned(pay);
    await reject(signed(recovered,key,0n),'restored key cannot use old epoch');
    await reject(signed(recovered,next,2n),'replaced key cannot use recovered epoch');
    await send(signed(recovered,key,2n),'recovered owner');
    const largeData = encodeFunctionData({abi:accountAbi,functionName:'execute',args:[recipient,0n,`0x${'ff'.repeat(16224)}`]});
    assert.ok((largeData.length-2)/2 <= 16384);
    await send(signed(await unsigned(largeData),key,2n),'near-limit execution calldata');
    await send(signed(await unsigned(largeData,456n,0n),key,2n),'near-limit calldata and first keyed nonce');
    report.maxGasCharge=MAX_GAS_CHARGE.toString();report.account=account;
    writeFileSync('../.context/passkey/e2e-report.json',JSON.stringify(report,null,2));
    console.log(`PASS ${report.rejections.length} rejections, key rotation, delayed recovery and replay protection`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
