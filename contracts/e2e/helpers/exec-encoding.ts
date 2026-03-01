import {
  encodeAbiParameters,
  padHex,
  type Hex,
  type Address,
} from "viem";

// ── ExecMode encoding ────────────────────────────────────────────────
// ExecMode (bytes32) = [1B callType][1B execType][4B selector][22B payload]

export function encodeExecMode(callType: Hex, execType: Hex): Hex {
  return padHex(
    `0x${callType.slice(2)}${execType.slice(2)}` as Hex,
    { size: 32, dir: "right" },
  );
}

// ── Execution calldata encoding ──────────────────────────────────────
// Single: abi.encodePacked(target(20B), value(32B), calldata)

export function encodeSingleExec(target: Address, value: bigint, data: Hex = "0x"): Hex {
  const targetHex = target.slice(2).toLowerCase().padStart(40, "0");
  const valueHex = value.toString(16).padStart(64, "0");
  const dataHex = data.slice(2);
  return `0x${targetHex}${valueHex}${dataHex}` as Hex;
}

// Batch: abi.encode(Execution[]) where Execution = (address, uint256, bytes)

export function encodeBatchExec(executions: { target: Address; value: bigint; data: Hex }[]): Hex {
  return encodeAbiParameters(
    [{ type: "tuple[]", components: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "callData", type: "bytes" },
    ]}],
    [executions.map(e => ({ target: e.target, value: e.value, callData: e.data }))],
  );
}
