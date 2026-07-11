// Retained for malicious-validator fixtures that intentionally implement the old ABI.
export const SIMPLE_VALIDATE_SELECTOR = "0xf2d64fed";

export const simpleAccountAbi = [
  {
    type: "function",
    name: "validate",
    inputs: [{ name: "signatureIndex", type: "uint256" }],
    outputs: [],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "execute",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;
