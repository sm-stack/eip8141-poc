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

export const FRAME_TX_TYPE = 0x06;
export const FRAME_MODE_DEFAULT = 0x00;
export const FRAME_MODE_VERIFY = 0x01;
export const FRAME_MODE_SENDER = 0x02;

export const CHAIN_DEF = {
  id: CHAIN_ID,
  name: "devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};
