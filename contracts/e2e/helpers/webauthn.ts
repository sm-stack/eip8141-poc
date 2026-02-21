import { hexToBytes, bytesToHex, encodeAbiParameters, parseAbiParameters, type Hex } from "viem";
import { createHash } from "crypto";
import { p256 } from "@noble/curves/p256";

export function sha256(data: Hex | Uint8Array): Hex {
  const bytes = typeof data === "string" ? hexToBytes(data) : data;
  const hash = createHash("sha256").update(bytes).digest();
  return bytesToHex(hash);
}

/** Create mock WebAuthn authenticatorData (37 bytes). */
export function createAuthenticatorData(): Hex {
  const rpIdHash = new Uint8Array(32).fill(0xaa); // Mock rpIdHash
  const flags = new Uint8Array([0x05]); // UP=1, UV=1
  const signCount = new Uint8Array([0, 0, 0, 1]);

  const authData = new Uint8Array(37);
  authData.set(rpIdHash, 0);
  authData.set(flags, 32);
  authData.set(signCount, 33);

  return bytesToHex(authData);
}

/** Create mock WebAuthn clientDataJSON. */
export function createClientDataJSON(challenge: Hex): string {
  const challengeBytes = hexToBytes(challenge);
  const base64 = Buffer.from(challengeBytes).toString("base64url");
  return JSON.stringify({
    type: "webauthn.get",
    challenge: base64,
    origin: "https://example.com",
  });
}

/**
 * Sign a sigHash using WebAuthn P256 format.
 * Returns the encoded WebAuthnAuth struct suitable for CoinbaseSmartWallet8141.
 */
export function signWithWebAuthn(sigHash: Hex, p256PrivKey: Hex): Hex {
  const authenticatorData = createAuthenticatorData();
  const clientDataJSON = createClientDataJSON(sigHash);
  const clientDataJSONBytes = new TextEncoder().encode(clientDataJSON);

  const challengeIndex = clientDataJSON.indexOf('"challenge"');
  const typeIndex = clientDataJSON.indexOf('"type"');

  const clientDataHash = sha256(bytesToHex(clientDataJSONBytes));
  const messageToSign = sha256(
    bytesToHex(
      new Uint8Array([
        ...hexToBytes(authenticatorData),
        ...hexToBytes(clientDataHash),
      ])
    )
  );

  const sig = p256.sign(messageToSign.slice(2), p256PrivKey.slice(2));

  return encodeAbiParameters(
    parseAbiParameters("bytes, bytes, uint256, uint256, uint256, uint256"),
    [
      authenticatorData,
      bytesToHex(clientDataJSONBytes),
      BigInt(challengeIndex),
      BigInt(typeIndex),
      sig.r,
      sig.s,
    ]
  );
}
