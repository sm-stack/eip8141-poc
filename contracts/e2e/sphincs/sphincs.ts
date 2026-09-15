import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {encodeAbiParameters,encodeFunctionData,parseAbiParameters,parseEther,type Hex} from 'viem';
import {serializeFrameTransaction,type TransactionSerializableFrame} from 'viem/eip8141';
import {createTestClients,fundAccount,waitForReceipt} from '../helpers/client.js';
import {deployContract} from '../helpers/deploy.js';
import {accountAbi,signatureChallenge,attachSignature,buildTransaction,type KeyedFrame} from '../../sphincs/sdk.js';
import {makeKey,sign} from '../../sphincs/test-helpers.js';
const {publicClient,walletClient}=createTestClients(process.env.RPC_URL);
const report:any={developmentOnly:true,revalidationCap:process.env.FRAMEPOOL_MAX_REVALIDATION_GAS,runs:[],rejections:[]};
async function main(){
 assert.equal(await publicClient.getChainId(),1337);
 const key=makeKey('owner'),next=makeKey('next');
 const ctor=encodeAbiParameters(parseAbiParameters('bytes32,bytes32'),[key.seed,key.root]);
 const {address:account}=await deployContract(walletClient,publicClient,`${(JSON.parse(readFileSync('out-sphincs/C13Account8141.sol/C13Account8141.json','utf8')).bytecode.object as Hex)}${ctor.slice(2)}` as Hex,8_000_000n,'C13Account8141');
 await fundAccount(walletClient,publicClient,account,'3');
 const recipient='0x000000000000000000000000000000000000ca13';
 const unsigned=async(data:Hex,nonceKey=0n,seq?:bigint)=>{
  const b=await publicClient.getBlock();
  return buildTransaction({chainId:1337,sender:account,nonceKey,nonceSeq:seq??BigInt(await publicClient.getTransactionCount({address:account})),executionData:data,maxFeePerGas:(b.baseFeePerGas??1n)*2n+1n,maxPriorityFeePerGas:1n});
 };
 const signed=(tx:KeyedFrame,k=key,epoch=0n)=>attachSignature(tx,k,epoch,sign(signatureChallenge(tx,epoch),k));
 const send=async(tx:KeyedFrame,label:string,success=true)=>{
  const hash=await publicClient.request({method:'eth_sendRawTransaction',params:[serializeFrameTransaction(tx)]});
  const receipt=await waitForReceipt(publicClient,hash);
  assert.equal(receipt.frameReceipts[0].status,'0x1');assert.equal(receipt.frameReceipts[1].status,success?'0x1':'0x0');
  assert.equal(receipt.payer.toLowerCase(),account.toLowerCase());
  const gas=BigInt(receipt.frameReceipts[0].gasUsed.execution);assert.ok(gas<100000n);
  if(label==='C13 transfer'){
   const trace:any=await publicClient.request({method:'debug_traceTransaction',params:[hash,{disableStorage:true}]} as any);
   writeFileSync('../.context/sphincs/verify-trace.json',JSON.stringify(trace));
  }
  report.runs.push({label,hash,verifyExecutionGas:gas.toString(),declaredVerifyGas:tx.frames[0].gasLimit.toString(),nativeCredit:'0',revalidationBudget:tx.frames[0].gasLimit.toString()});
  console.log(`PASS ${label}: VERIFY=${gas}`);
 };
 const reject=async(tx:TransactionSerializableFrame,label:string)=>{
  await assert.rejects(()=>publicClient.request({method:'eth_sendRawTransaction',params:[serializeFrameTransaction(tx)]}),/validation|revert|verify|nonce|already known|gas/i,label);
  report.rejections.push(label);
 };
 const pay=encodeFunctionData({abi:accountAbi,functionName:'execute',args:[recipient,parseEther('0.001'),'0x']});
 const tx=await unsigned(pay),valid=signed(tx);
 await reject(signed(tx,next),'valid signature from unregistered key');
 await reject(signed(tx,key,1n),'wrong epoch');
 const changes=[{...valid,nonceSeq:valid.nonceSeq+1n},{...valid,nonceKeys:[123n]},
  {...valid,maxFeePerGas:valid.maxFeePerGas!+1n},
  {...valid,frames:[valid.frames[0],{...valid.frames[1],data:'0xffffffff' as Hex}]},
  {...valid,frames:[{...valid.frames[0],gasLimit:99998n},valid.frames[1]]},
  {...valid,frames:[valid.frames[0],{...valid.frames[1],stateGasLimit:999999n}]},
  {...valid,frames:[valid.frames[0],{...valid.frames[1],mode:'default' as const}]},
  {...valid,frames:[{...valid.frames[0],data:`${valid.frames[0].data}00` as Hex},valid.frames[1]]}];
 for(let i=0;i<changes.length;i++)await reject(changes[i],`envelope mutation ${i}`);
 const mutateData=(byte:number,value:string)=>{const data=valid.frames[0].data;return {...valid,frames:[{...valid.frames[0],data:`${data.slice(0,2+byte*2)}${value}${data.slice(4+byte*2)}` as Hex},valid.frames[1]]};};
 await reject(mutateData(3907,'01'),'nonzero ABI padding');
 await reject(mutateData(163,'c0'),'noncanonical dynamic offset');
 await reject(mutateData(196,(parseInt(valid.frames[0].data.slice(394,396),16)^1).toString(16).padStart(2,'0')),'tampered signature R');
 await reject({...valid,frames:[{...valid.frames[0],data:valid.frames[0].data.slice(0,-64) as Hex},valid.frames[1]]},'truncated signature calldata');

 await reject(attachSignature(tx,key,0n,sign(signatureChallenge(tx,0n,1n),key),1n),'insufficient signed fee ceiling');
 await send(valid,'C13 transfer');
 assert.equal(await publicClient.getBalance({address:recipient}),parseEther('0.001'));
 await reject(valid,'included replay');
 await send(signed(await unsigned(pay,123n,0n)),'first keyed nonce');
 await send(signed(await unsigned(pay,123n,1n)),'reused keyed nonce');
 const failing=encodeFunctionData({abi:accountAbi,functionName:'execute',args:[account,0n,'0xffffffff']});
 await send(signed(await unsigned(failing)),'included execution failure',false);
 await send(signed(await unsigned(pay)),'fresh nonce after failure');
 const rotate=encodeFunctionData({abi:accountAbi,functionName:'rotateOwner',args:[next.seed,next.root]});
 await send(signed(await unsigned(rotate)),'rotate owner');
 assert.equal(await publicClient.readContract({address:account,abi:accountAbi,functionName:'ownerEpoch'}),1n);
 const rotated=await unsigned(pay);
 await reject(signed(rotated,key,0n),'old epoch');await reject(signed(rotated,key,1n),'old key with new epoch');
 await send(signed(rotated,next,1n),'new owner');
 const large=encodeFunctionData({abi:accountAbi,functionName:'execute',args:[recipient,0n,`0x${'ff'.repeat(16224)}`]});
 await send(signed(await unsigned(large),next,1n),'near-limit calldata');
 await send(signed(await unsigned(large,456n,0n),next,1n),'near-limit calldata and first keyed nonce');
 report.account=account;
 writeFileSync('../.context/sphincs/e2e-report.json',JSON.stringify(report,null,2));
 console.log(`PASS ${report.rejections.length} rejections`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
