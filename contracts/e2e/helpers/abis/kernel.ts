export const kernelAbi = [
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
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "executeBatch",
    inputs: [
      { name: "targets", type: "address[]" },
      { name: "values", type: "uint256[]" },
      { name: "datas", type: "bytes[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "executeDelegate",
    inputs: [
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "executeTry",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [
      { name: "success", type: "bool" },
      { name: "returnData", type: "bytes" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "executeBatchTry",
    inputs: [
      { name: "targets", type: "address[]" },
      { name: "values", type: "uint256[]" },
      { name: "datas", type: "bytes[]" },
    ],
    outputs: [
      { name: "successes", type: "bool[]" },
      { name: "returnDatas", type: "bytes[]" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "installModule",
    inputs: [
      { name: "moduleType", type: "uint8" },
      { name: "module", type: "address" },
      { name: "config", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "uninstallModule",
    inputs: [
      { name: "moduleType", type: "uint8" },
      { name: "module", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "isValidatorInstalled",
    inputs: [{ name: "validator", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getInstalledModules",
    inputs: [{ name: "moduleType", type: "uint8" }],
    outputs: [{ name: "", type: "address[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "configureExecution",
    inputs: [
      { name: "selector", type: "bytes4" },
      { name: "executor", type: "address" },
      { name: "allowedFrameModes", type: "uint8" },
      { name: "validAfter", type: "uint48" },
      { name: "validUntil", type: "uint48" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "validateFromSenderFrame",
    inputs: [
      { name: "signature", type: "bytes" },
      { name: "scope", type: "uint8" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "validatedCall",
    inputs: [
      { name: "validator", type: "address" },
      { name: "innerCalldata", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes" }],
    stateMutability: "nonpayable",
  },
] as const;

export const erc1271Abi = [
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
] as const;

export const sessionKeyValidatorAbi = [
  {
    type: "function",
    name: "addSessionKey",
    inputs: [
      { name: "sessionKey", type: "address" },
      { name: "validAfter", type: "uint48" },
      { name: "validUntil", type: "uint48" },
      { name: "spendingLimit", type: "uint256" },
      { name: "allowedSelectors", type: "bytes4[]" },
      { name: "allowedTargets", type: "address[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;
