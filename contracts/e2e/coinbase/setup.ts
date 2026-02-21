import {
  encodeAbiParameters,
  parseAbiParameters,
  type Hex,
  type Address,
  formatEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { p256 } from "@noble/curves/p256";
import { OWNER2_KEY } from "../helpers/config.js";
import { createTestClients, fundAccount } from "../helpers/client.js";
import { loadBytecode, deployContract } from "../helpers/deploy.js";
import { walletAbi } from "../helpers/abis/coinbase.js";

export type CoinbaseTestContext = {
  publicClient: any;
  walletClient: any;
  devAddr: Address;
  owner2Addr: Address;
  walletAddr: Address;
  p256PrivKey: Hex;
  p256X: bigint;
  p256Y: bigint;
};

/** Deploy CoinbaseSmartWallet8141 with 3 owners (2 ECDSA + 1 P256) and fund with 10 ETH. */
export async function deployCoinbaseTestbed(): Promise<CoinbaseTestContext> {
  const { publicClient, walletClient, devAddr } = createTestClients();
  const owner2Account = privateKeyToAccount(OWNER2_KEY);
  const owner2Addr = owner2Account.address;

  // Mock P256 keypair for WebAuthn owner
  const p256PrivKey = ("0x" + "3".repeat(64)) as Hex;
  const p256PubKey = p256.getPublicKey(p256PrivKey.slice(2), false);
  const p256X = BigInt(
    "0x" + Buffer.from(p256PubKey.slice(1, 33)).toString("hex")
  );
  const p256Y = BigInt(
    "0x" + Buffer.from(p256PubKey.slice(33, 65)).toString("hex")
  );

  const balance = await publicClient.getBalance({ address: devAddr });
  console.log(`\n${"=".repeat(70)}`);
  console.log(`CoinbaseSmartWallet8141 E2E Test`);
  console.log(`${"=".repeat(70)}`);
  console.log(`Owner 1 (ECDSA): ${devAddr}`);
  console.log(`Owner 2 (ECDSA): ${owner2Addr}`);
  console.log(`Owner 3 (P256):  x=${p256X.toString(16).slice(0, 16)}...`);
  console.log(`Balance: ${formatEther(balance)} ETH\n`);

  // Deploy
  console.log("Deploying CoinbaseSmartWallet8141 with mixed owners...\n");

  const bytecode = loadBytecode("CoinbaseSmartWallet8141");
  const owners = [
    encodeAbiParameters(parseAbiParameters("address"), [devAddr]),
    encodeAbiParameters(parseAbiParameters("address"), [owner2Addr]),
    encodeAbiParameters(parseAbiParameters("uint256, uint256"), [p256X, p256Y]),
  ];
  const constructorArgs = encodeAbiParameters(parseAbiParameters("bytes[]"), [
    owners,
  ]);
  const deployData = (bytecode + constructorArgs.slice(2)) as Hex;

  const { address: walletAddr } = await deployContract(
    walletClient,
    publicClient,
    deployData,
    5_000_000n
  );

  // Verify owners
  console.log("\nVerifying owners...");
  const isOwner1 = await publicClient.readContract({
    address: walletAddr,
    abi: walletAbi,
    functionName: "isOwnerAddress",
    args: [devAddr],
  });
  const isOwner2 = await publicClient.readContract({
    address: walletAddr,
    abi: walletAbi,
    functionName: "isOwnerAddress",
    args: [owner2Addr],
  });
  const isOwner3 = await publicClient.readContract({
    address: walletAddr,
    abi: walletAbi,
    functionName: "isOwnerPublicKey",
    args: [p256X, p256Y],
  });
  const ownerCount = await publicClient.readContract({
    address: walletAddr,
    abi: walletAbi,
    functionName: "nextOwnerIndex",
  });

  console.log(`  Owner 1 (ECDSA - ${devAddr}): ${isOwner1}`);
  console.log(`  Owner 2 (ECDSA - ${owner2Addr}): ${isOwner2}`);
  console.log(`  Owner 3 (P256 WebAuthn): ${isOwner3}`);
  console.log(`  Total owners: ${ownerCount}`);

  if (!isOwner1 || !isOwner2 || !isOwner3) {
    throw new Error("Owner verification failed");
  }

  // Fund wallet
  console.log("Funding wallet with 10 ETH...");
  await fundAccount(walletClient, publicClient, walletAddr);
  console.log("  Funded\n");

  return {
    publicClient,
    walletClient,
    devAddr,
    owner2Addr,
    walletAddr,
    p256PrivKey,
    p256X,
    p256Y,
  };
}
