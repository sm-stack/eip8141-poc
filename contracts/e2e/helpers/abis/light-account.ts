export const walletAbi = [
  {
    type: "function",
    name: "initialize",
    inputs: [{ name: "owner_", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
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
      { name: "dest", type: "address" },
      { name: "value", type: "uint256" },
      { name: "func", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "executeBatch",
    inputs: [
      { name: "dest", type: "address[]" },
      { name: "func", type: "bytes[]" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "executeBatch",
    inputs: [
      { name: "dest", type: "address[]" },
      { name: "value", type: "uint256[]" },
      { name: "func", type: "bytes[]" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "performCreate",
    inputs: [
      { name: "value", type: "uint256" },
      { name: "initCode", type: "bytes" },
    ],
    outputs: [{ name: "createdAddr", type: "address" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "performCreate2",
    inputs: [
      { name: "value", type: "uint256" },
      { name: "initCode", type: "bytes" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "createdAddr", type: "address" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "transferOwnership",
    inputs: [{ name: "newOwner", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isValidSignature",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes4" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getMessageHash",
    inputs: [{ name: "message", type: "bytes" }],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "domainSeparator",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "implementation",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

export const factoryAbi = [
  {
    type: "function",
    name: "createAccount",
    inputs: [
      { name: "owner", type: "address" },
      { name: "salt", type: "uint256" },
    ],
    outputs: [{ name: "account", type: "address" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "getAddress",
    inputs: [
      { name: "owner", type: "address" },
      { name: "salt", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "initCodeHash",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "implementation",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;
