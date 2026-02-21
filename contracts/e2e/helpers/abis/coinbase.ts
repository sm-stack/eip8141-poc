export const walletAbi = [
  {
    type: "function",
    name: "validate",
    inputs: [
      { name: "signature", type: "bytes" },
      { name: "scope", type: "uint8" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
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
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "isOwnerAddress",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nextOwnerIndex",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isOwnerPublicKey",
    inputs: [
      { name: "x", type: "uint256" },
      { name: "y", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "addOwnerPublicKey",
    inputs: [
      { name: "x", type: "uint256" },
      { name: "y", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "ownerAtIndex",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [{ name: "", type: "bytes" }],
    stateMutability: "view",
  },
] as const;
