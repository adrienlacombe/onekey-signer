/**
 * Privacy viewing key derivation — canonical implementation shared between the
 * node signer (src/signer.ts) and the web signer (web/src/lib/signer.ts).
 *
 * The pool's registered viewing key is immutable, so both bundles must produce
 * byte-identical challenges and byte-identical hash inputs. Keep this module
 * dependency-free (besides @noble/hashes) so the web bundle does not pull in
 * node-only code transitively.
 */
import { sha256 } from '@noble/hashes/sha2.js';

export const PRIVACY_KEY_DOMAIN = 'STARKNET_ONEKEY_PRIVACY_V1:';
const PRIVACY_KEY_DERIVATION_CONTEXT = 'privacy-key';

// Mirrors MAX_PRIVATE_KEY in src/constants.ts. Reproduced here to avoid dragging
// the env-reading constants module into the browser bundle.
const STARK_EC_ORDER =
  0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2fn;
const MAX_STARK_PRIVATE_KEY = STARK_EC_ORDER / 2n - 1n;

export interface PrivacyKeyChallengeInput {
  chainId: string;
  poolAddress: string;
  accountAddress: string;
  pubkeyHash: string;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-f]*$/i.test(h)) {
    throw new Error(`Invalid hex string: ${hex}`);
  }
  const padded = h.length % 2 === 0 ? h : '0' + h;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function feltToBytes32(value: string): Uint8Array {
  const felt = BigInt(value);
  if (felt < 0n || felt >= (1n << 256n)) {
    throw new Error(`Expected a non-negative 32-byte field value, got ${value}`);
  }
  return hexToBytes(felt.toString(16).padStart(64, '0'));
}

function scalarToBytes32(value: bigint): Uint8Array {
  return hexToBytes(value.toString(16).padStart(64, '0'));
}

export function buildPrivacyKeyChallenge(input: PrivacyKeyChallengeInput): Uint8Array {
  return concatBytes([
    utf8Bytes(PRIVACY_KEY_DOMAIN),
    feltToBytes32(input.chainId),
    feltToBytes32(input.poolAddress),
    feltToBytes32(input.accountAddress),
    feltToBytes32(input.pubkeyHash),
  ]);
}

export function privacySignatureBytes(signature: { v: number; r: bigint; s: bigint }): Uint8Array {
  return concatBytes([
    Uint8Array.of(signature.v & 0xff),
    scalarToBytes32(signature.r),
    scalarToBytes32(signature.s),
  ]);
}

export function derivePrivacyKeyFromSignature(
  signatureBytes: Uint8Array,
  challenge: Uint8Array,
): string {
  const digest = sha256(
    concatBytes([signatureBytes, challenge, utf8Bytes(PRIVACY_KEY_DERIVATION_CONTEXT)]),
  );
  const key = (BigInt('0x' + bytesToHex(digest)) % (MAX_STARK_PRIVATE_KEY - 1n)) + 1n;
  return '0x' + key.toString(16);
}
