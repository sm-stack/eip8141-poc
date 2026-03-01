// DEVNET ONLY -- never use these keys on mainnet
import type { Address } from "viem";

export const RPC_URL = "http://localhost:18545";
export const CHAIN_ID = 1337;

export const DEV_KEY =
  "0xb71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291" as const;
export const SECOND_OWNER_KEY =
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6" as const;
export const OWNER2_KEY =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;

export const DEAD_ADDR =
  "0x000000000000000000000000000000000000dEaD" as Address;

/** Sentinel: hook slot is installed but no real hook contract (preCheck/postCheck skipped). */
export const HOOK_INSTALLED =
  "0x0000000000000000000000000000000000000001" as Address;
