/**
 * OneKey Bitcoin signer for Starknet — simulates the OneKey / Trezor
 * legacy Bitcoin message signing format using a raw secp256k1 private key.
 *
 * Signing format (Path 1: Legacy, is_bip322_simple=False) with a Starknet-specific
 * domain prefix embedded inside the signed bytes. The prefix is what prevents cross-
 * domain replay: a normal Bitcoin-signed-message request to the same key cannot
 * produce the same payload because length + prefix won't match.
 *   inner  = "STARKNET_ONEKEY_V1:" || hash_32B                          (51 bytes)
 *   digest = SHA256(SHA256(varint(24) || "Bitcoin Signed Message:\n" || varint(51) || inner))
 *   signature = ECDSA_sign(privkey, digest)
 *
 * 65-byte compact recoverable signature:
 *   byte 0:    27 + recovery_id + 4 (compressed) + script_type_offset
 *   bytes 1–32:  r (big-endian)
 *   bytes 33–64: s (big-endian)
 *
 * Script type offsets:
 *   P2PKH:       +0  (byte0 = 31..34)
 *   P2SH-segwit: +4  (byte0 = 35..38)
 *   Native segwit: +8  (byte0 = 39..42)
 *
 * Off-chain signature format (5 felt252):
 *   [r_low, r_high, s_low, s_high, y_parity]
 *
 * On-chain transaction signature format (6 felt252):
 *   [r_low, r_high, s_low, s_high, y_parity, tx_domain_tag]
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { privateKeyToAccount } from 'viem/accounts';
import {
  type SignerInterface,
  type Signature,
  type Call,
  type DeclareSignerDetails,
  type DeployAccountSignerDetails,
  type InvocationsSignerDetails,
  type TypedData,
  hash,
  transaction,
  CallData,
  ec,
  typedData as starknetTypedData,
} from 'starknet';
import { ScriptType } from './constants.js';
import {
  PRIVACY_KEY_DOMAIN,
  type PrivacyKeyChallengeInput,
  buildPrivacyKeyChallenge,
  derivePrivacyKeyFromSignature,
  privacySignatureBytes,
} from './privacyKey.js';

export {
  PRIVACY_KEY_DOMAIN,
  type PrivacyKeyChallengeInput,
  buildPrivacyKeyChallenge,
  derivePrivacyKeyFromSignature,
  privacySignatureBytes,
};

// ── secp256k1 curve constants ─────────────────────────────────────

const CURVE_ORDER = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);
const HALF_CURVE_ORDER = CURVE_ORDER / 2n;
export const TX_SIGNATURE_DOMAIN_TAG = '0x4f4e454b45595f54585f415554485f5631';
export const OFFCHAIN_SIGNATURE_DOMAIN_TAG = '0x4f4e454b45595f4f4646434841494e5f5631';

// ── Bitcoin message prefix (raw bytes) ────────────────────────────

const BITCOIN_MSG_PREFIX = new Uint8Array([
  0x18, // varint(24) — length of header
  0x42, 0x69, 0x74, 0x63, 0x6f, 0x69, 0x6e, 0x20, // "Bitcoin "
  0x53, 0x69, 0x67, 0x6e, 0x65, 0x64, 0x20, // "Signed "
  0x4d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x3a, 0x0a, // "Message:\n"
]);

/**
 * Starknet domain prefix baked into every message we hand to the Bitcoin signer.
 * Prepending this to the 32-byte hash makes the signed payload impossible to produce
 * via a plain "Bitcoin Signed Message" request on the same key, closing cross-domain
 * replay on BIP-137 / BIP-322-simple tooling.
 */
export const STARKNET_AUTH_PREFIX = new Uint8Array([
  0x53, 0x54, 0x41, 0x52, 0x4b, 0x4e, 0x45, 0x54, // "STARKNET"
  0x5f,                                           // "_"
  0x4f, 0x4e, 0x45, 0x4b, 0x45, 0x59,             // "ONEKEY"
  0x5f,                                           // "_"
  0x56, 0x31,                                     // "V1"
  0x3a,                                           // ":"
]);
export const STARKNET_AUTH_PREFIX_HEX = '535441524b4e45545f4f4e454b45595f56313a';

// ── Helpers ───────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-f]*$/i.test(h)) {
    throw new Error(`Invalid hex string: ${hex}`);
  }
  const padded = h.length % 2 === 0 ? h : '0' + h;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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

function encodeBitcoinVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid Bitcoin varint length: ${value}`);
  }
  if (value < 0xfd) return Uint8Array.of(value);
  if (value <= 0xffff) return Uint8Array.of(0xfd, value & 0xff, (value >> 8) & 0xff);
  if (value <= 0xffffffff) {
    return Uint8Array.of(
      0xfe,
      value & 0xff,
      (value >> 8) & 0xff,
      (value >> 16) & 0xff,
      (value >> 24) & 0xff,
    );
  }
  throw new Error(`Bitcoin message is too large: ${value} bytes.`);
}

function splitU256(value: bigint): [string, string] {
  const mask = (1n << 128n) - 1n;
  return ['0x' + (value & mask).toString(16), '0x' + (value >> 128n).toString(16)];
}

function normalizeHashHex(hashHex: string): `0x${string}` {
  return ('0x' + hashHex.replace(/^0x/i, '').padStart(64, '0')) as `0x${string}`;
}

function normalizeSignatureScalar(value: string | bigint, label: 'r' | 's'): bigint {
  if (typeof value === 'bigint') return value;
  const clean = value.replace(/^0x/i, '').toLowerCase();
  if (!clean || !/^[0-9a-f]+$/.test(clean)) {
    throw new Error(`OneKey returned an invalid ${label} value while signing.`);
  }
  return BigInt('0x' + clean);
}

export function normalizeOneKeySignatureComponents(rawSig: {
  v: number;
  r: string | bigint;
  s: string | bigint;
}): { v: number; r: bigint; s: bigint } {
  const r = normalizeSignatureScalar(rawSig.r, 'r');
  let s = normalizeSignatureScalar(rawSig.s, 's');
  let v = rawSig.v;

  if (s > HALF_CURVE_ORDER) {
    s = CURVE_ORDER - s;
    v = v ^ 1;
  }

  return { v, r, s };
}

export function getTransactionSignatureHash(txHash: string, chainId: string): string {
  const domainHash = ec.starkCurve.poseidonHashMany([
    BigInt(TX_SIGNATURE_DOMAIN_TAG),
    BigInt(chainId),
    BigInt(normalizeHashHex(txHash)),
  ]);
  return '0x' + domainHash.toString(16);
}

export function getOffchainSignatureHash(messageHash: string): string {
  const domainHash = ec.starkCurve.poseidonHashMany([
    BigInt(OFFCHAIN_SIGNATURE_DOMAIN_TAG),
    BigInt(normalizeHashHex(messageHash)),
  ]);
  return '0x' + domainHash.toString(16);
}

function withTransactionSignatureMarker(signature: Signature): Signature {
  return [...(signature as string[]), TX_SIGNATURE_DOMAIN_TAG];
}

function intDAM(dam: unknown): number {
  if (typeof dam === 'number') return dam;
  if (dam === 'L1' || dam === 0) return 0;
  if (dam === 'L2' || dam === 1) return 1;
  return 0;
}

function normalizeSecpPublicKeyHex(publicKeyHex: string): string {
  const clean = publicKeyHex.replace(/^0x/i, '').toLowerCase();
  if (!clean || !/^[0-9a-f]+$/.test(clean)) {
    throw new Error('OneKey returned an invalid secp256k1 public key.');
  }
  if (clean.length === 66) {
    return secp256k1.Point.fromHex(clean).toHex(false);
  }
  if (clean.length === 128) {
    return '04' + clean;
  }
  if (clean.length === 130) {
    return clean;
  }
  throw new Error(
    `Unsupported secp256k1 public key length from OneKey: expected 33-byte or 65-byte key, got ${clean.length / 2} bytes.`,
  );
}

// ── Bitcoin message hashing ───────────────────────────────────────

/**
 * Compute the double-SHA256 Bitcoin message digest for a 32-byte hash, using the
 * Starknet-scoped inner payload (19-byte prefix + 32-byte hash = 51 bytes).
 * SHA256(SHA256(
 *   varint(24) || "Bitcoin Signed Message:\n"
 *   || varint(51) || "STARKNET_ONEKEY_V1:" || hash
 * ))
 */
export function bitcoinMessageDigest(hash32: Uint8Array): Uint8Array {
  return bitcoinMessagePayloadDigest(concatBytes([STARKNET_AUTH_PREFIX, hash32]));
}

export function bitcoinMessagePayloadDigest(message: Uint8Array): Uint8Array {
  return sha256(sha256(concatBytes([BITCOIN_MSG_PREFIX, encodeBitcoinVarint(message.length), message])));
}

// ── OneKey compact signature ──────────────────────────────────────

export interface OnekeyCompactSignature {
  /** 65-byte compact recoverable signature (OneKey/Trezor format) */
  compact65: Uint8Array;
  /** Raw r value */
  r: bigint;
  /** Raw s value (low-s normalized) */
  s: bigint;
  /** Recovery parameter (0 or 1) */
  yParity: number;
  /** The byte 0 value: 27 + recovery_id + 4(compressed) + scriptTypeOffset */
  byte0: number;
}

/**
 * Sign a 32-byte hash using the OneKey/Trezor Bitcoin legacy signing format.
 *
 * 1. Wraps the hash: SHA256(SHA256(prefix || varint(51) || "STARKNET_ONEKEY_V1:" || hash))
 * 2. Signs with ECDSA on secp256k1 (via viem, which gives recovery)
 * 3. Produces 65-byte compact: [byte0, r[32], s[32]]
 *    where byte0 = 27 + recovery_id + 4(compressed) + script_type_offset
 */
export async function signBitcoinMessage(
  privateKeyHex: string,
  hash32Hex: string,
  scriptType: ScriptType = ScriptType.NATIVE_SEGWIT,
): Promise<OnekeyCompactSignature> {
  const hashBytes = hexToBytes(hash32Hex.padStart(64, '0'));
  const digest = bitcoinMessageDigest(hashBytes);
  return signBitcoinMessageDigest(privateKeyHex, digest, scriptType);
}

async function signBitcoinPayloadMessage(
  privateKeyHex: string,
  message: Uint8Array,
  scriptType: ScriptType = ScriptType.NATIVE_SEGWIT,
): Promise<OnekeyCompactSignature> {
  const digest = bitcoinMessagePayloadDigest(message);
  return signBitcoinMessageDigest(privateKeyHex, digest, scriptType);
}

async function signBitcoinMessageDigest(
  privateKeyHex: string,
  digest: Uint8Array,
  scriptType: ScriptType,
): Promise<OnekeyCompactSignature> {
  const digestHex = ('0x' + bytesToHex(digest)) as `0x${string}`;

  // Sign using viem (raw ECDSA, no Ethereum prefix) — returns 0x + r[64] + s[64] + v[2]
  const prefixedKey = (
    privateKeyHex.startsWith('0x') ? privateKeyHex : '0x' + privateKeyHex
  ) as `0x${string}`;
  const viemAccount = privateKeyToAccount(prefixedKey);
  const ethSig = await viemAccount.sign({ hash: digestHex });

  // Parse viem signature: 0x || r[64hex] || s[64hex] || v[2hex]
  const sigHex = ethSig.slice(2);
  const rHex = sigHex.slice(0, 64);
  const sHex = sigHex.slice(64, 128);
  const vByte = parseInt(sigHex.slice(128, 130), 16);

  let r = BigInt('0x' + rHex);
  let s = BigInt('0x' + sHex);
  let recovery = vByte >= 27 ? vByte - 27 : vByte;

  // Low-s normalization
  if (s > HALF_CURVE_ORDER) {
    s = CURVE_ORDER - s;
    recovery = recovery ^ 1;
  }

  // Build 65-byte compact format per OneKey/Trezor spec
  const byte0 = 27 + recovery + 4 + scriptType; // 4 = compressed pubkey flag
  const compact65 = new Uint8Array(65);
  compact65[0] = byte0;
  compact65.set(hexToBytes(r.toString(16).padStart(64, '0')), 1);
  compact65.set(hexToBytes(s.toString(16).padStart(64, '0')), 33);

  return { compact65, r, s, yParity: recovery, byte0 };
}

/**
 * Decode a 65-byte compact signature back to (r, s, yParity).
 * Handles all three script types.
 */
export function decodeCompactSignature(compact65: Uint8Array): {
  r: bigint;
  s: bigint;
  yParity: number;
  scriptType: ScriptType;
} {
  const byte0 = compact65[0];
  // byte0 = 27 + recovery + 4 + scriptTypeOffset
  // So: recovery + scriptTypeOffset = byte0 - 31
  const base = byte0 - 31; // recovery + scriptTypeOffset

  let scriptType: ScriptType;
  let yParity: number;

  if (base >= 8) {
    // Native segwit: offset 8
    scriptType = ScriptType.NATIVE_SEGWIT;
    yParity = base - 8;
  } else if (base >= 4) {
    // P2SH-segwit: offset 4
    scriptType = ScriptType.P2SH_SEGWIT;
    yParity = base - 4;
  } else {
    // P2PKH: offset 0
    scriptType = ScriptType.P2PKH;
    yParity = base;
  }

  const rHex = bytesToHex(compact65.slice(1, 33));
  const sHex = bytesToHex(compact65.slice(33, 65));

  return {
    r: BigInt('0x' + rHex),
    s: BigInt('0x' + sHex),
    yParity,
    scriptType,
  };
}

// ── Poseidon pubkey hash ──────────────────────────────────────────

/**
 * Compute Poseidon hash of uncompressed secp256k1 public key coordinates.
 * poseidon(x_low, x_high, y_low, y_high)
 *
 * @param publicKeyHex Uncompressed key (65 bytes hex, with or without 0x prefix)
 */
export function pubkeyToPoseidonHash(publicKeyHex: string): string {
  const hex = normalizeSecpPublicKeyHex(publicKeyHex);
  // Skip 04 prefix if present
  const start = hex.startsWith('04') ? 2 : 0;
  const xHex = hex.slice(start, start + 64);
  const yHex = hex.slice(start + 64, start + 128);

  const xLow = BigInt('0x' + xHex.slice(32, 64));
  const xHigh = BigInt('0x' + xHex.slice(0, 32));
  const yLow = BigInt('0x' + yHex.slice(32, 64));
  const yHigh = BigInt('0x' + yHex.slice(0, 32));

  const h = ec.starkCurve.poseidonHashMany([xLow, xHigh, yLow, yHigh]);
  return '0x' + h.toString(16);
}

/**
 * Get uncompressed public key hex from a private key.
 */
export function getUncompressedPubKey(privateKeyHex: string): string {
  const privBytes = hexToBytes(privateKeyHex.replace(/^0x/, ''));
  const pubBytes = secp256k1.getPublicKey(privBytes, false); // uncompressed
  return bytesToHex(pubBytes);
}

// ── Starknet address computation ──────────────────────────────────

/**
 * Compute the deterministic Starknet address for a OneKey Bitcoin signer account.
 * salt = pubkey_hash, constructorCalldata = [pubkey_hash]
 */
export function calculateAccountAddress(
  pubkeyHash: string,
  classHash: string,
): string {
  const constructorCalldata = [pubkeyHash];
  const addr = hash.calculateContractAddressFromHash(
    pubkeyHash,
    classHash,
    constructorCalldata,
    0,
  );
  return '0x' + addr.replace(/^0x/, '').padStart(64, '0');
}

// ── OneKeyBitcoinSigner (implements starknet.js SignerInterface) ──

export class OneKeyBitcoinSigner implements SignerInterface {
  public readonly pubkeyHash: string;
  private readonly privateKeyHex: string;
  private readonly scriptType: ScriptType;

  constructor(
    privateKeyHex: string,
    pubkeyHash: string,
    scriptType: ScriptType = ScriptType.NATIVE_SEGWIT,
  ) {
    this.privateKeyHex = privateKeyHex.replace(/^0x/, '');
    this.pubkeyHash = pubkeyHash;
    this.scriptType = scriptType;
  }

  async getPubKey(): Promise<string> {
    return this.pubkeyHash;
  }

  async signMessage(
    typedData: TypedData,
    accountAddress: string,
  ): Promise<Signature> {
    const msgHash = starknetTypedData.getMessageHash(typedData, accountAddress);
    return this.signHash(msgHash);
  }

  async signTransaction(
    transactions: Call[],
    details: InvocationsSignerDetails,
  ): Promise<Signature> {
    const compiledCalldata = transaction.getExecuteCalldata(
      transactions,
      details.cairoVersion || '1',
    );
    const det = details as Record<string, unknown>;
    const { proofFacts: _pf, proof: _pr, ...cleanDet } = det;
    const msgHash = hash.calculateInvokeTransactionHash({
      ...cleanDet,
      senderAddress: det.walletAddress || det.senderAddress,
      compiledCalldata,
      version: det.version,
      paymasterData: det.paymasterData || [],
      accountDeploymentData: det.accountDeploymentData || [],
      nonceDataAvailabilityMode: intDAM(det.nonceDataAvailabilityMode),
      feeDataAvailabilityMode: intDAM(det.feeDataAvailabilityMode),
      tip: det.tip ?? 0,
    } as any);
    return this.signTransactionHash(msgHash, String(details.chainId));
  }

  async signDeployAccountTransaction(
    details: DeployAccountSignerDetails,
  ): Promise<Signature> {
    const compiledConstructorCalldata = CallData.compile(
      details.constructorCalldata,
    );
    const det = details as Record<string, unknown>;
    const msgHash = hash.calculateDeployAccountTransactionHash({
      ...det,
      salt: det.addressSalt,
      compiledConstructorCalldata,
      version: det.version,
      paymasterData: det.paymasterData || [],
      accountDeploymentData: det.accountDeploymentData || [],
      nonceDataAvailabilityMode: intDAM(det.nonceDataAvailabilityMode),
      feeDataAvailabilityMode: intDAM(det.feeDataAvailabilityMode),
      tip: det.tip ?? 0,
    } as any);
    return this.signTransactionHash(msgHash, String(details.chainId));
  }

  async signDeclareTransaction(
    details: DeclareSignerDetails,
  ): Promise<Signature> {
    const det = details as Record<string, unknown>;
    const msgHash = hash.calculateDeclareTransactionHash({
      ...det,
      classHash: det.classHash,
      compiledClassHash: det.compiledClassHash,
      senderAddress: det.senderAddress,
      version: det.version,
      paymasterData: det.paymasterData || [],
      accountDeploymentData: det.accountDeploymentData || [],
      nonceDataAvailabilityMode: intDAM(det.nonceDataAvailabilityMode),
      feeDataAvailabilityMode: intDAM(det.feeDataAvailabilityMode),
      tip: det.tip ?? 0,
    } as any);
    return this.signTransactionHash(msgHash, String(details.chainId));
  }

  /**
   * Sign an arbitrary 32-byte off-chain hash under the OFFCHAIN domain.
   * Verifiers must apply the same domain hash before calling `is_valid_signature`.
   */
  async signHash(offchainHash: string): Promise<Signature> {
    return this.signRawHash(getOffchainSignatureHash(offchainHash));
  }

  async signTransactionHash(txHash: string, chainId: string): Promise<Signature> {
    return withTransactionSignatureMarker(
      await this.signRawHash(getTransactionSignatureHash(txHash, chainId)),
    );
  }

  async derivePrivacyKey(args: {
    chainId: string;
    poolAddress: string;
    accountAddress: string;
  }): Promise<string> {
    const challenge = buildPrivacyKeyChallenge({
      ...args,
      pubkeyHash: this.pubkeyHash,
    });
    const sig = await signBitcoinPayloadMessage(this.privateKeyHex, challenge, this.scriptType);
    return derivePrivacyKeyFromSignature(
      privacySignatureBytes({ v: sig.yParity, r: sig.r, s: sig.s }),
      challenge,
    );
  }

  private async signRawHash(hashHex: string): Promise<Signature> {
    const sig = await signBitcoinMessage(
      this.privateKeyHex,
      normalizeHashHex(hashHex).slice(2),
      this.scriptType,
    );
    const [rLow, rHigh] = splitU256(sig.r);
    const [sLow, sHigh] = splitU256(sig.s);

    return [rLow, rHigh, sLow, sHigh, '0x' + sig.yParity.toString(16)];
  }

  /**
   * Sign and return BOTH the 65-byte compact (for inspection/logging)
   * and the 5-felt off-chain signature format used by `is_valid_signature`.
   */
  async signHashFull(offchainHash: string): Promise<{
    compact65: Uint8Array;
    // Historical name kept for compatibility; this is the 5-felt OFFCHAIN signature.
    onChain: string[];
    byte0: number;
    scriptType: ScriptType;
  }> {
    const sig = await signBitcoinMessage(
      this.privateKeyHex,
      normalizeHashHex(getOffchainSignatureHash(offchainHash)).slice(2),
      this.scriptType,
    );
    const [rLow, rHigh] = splitU256(sig.r);
    const [sLow, sHigh] = splitU256(sig.s);

    return {
      compact65: sig.compact65,
      onChain: [rLow, rHigh, sLow, sHigh, '0x' + sig.yParity.toString(16)],
      byte0: sig.byte0,
      scriptType: this.scriptType,
    };
  }
}
