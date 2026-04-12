/**
 * OneKey Bitcoin signer for Starknet — simulates the OneKey / Trezor
 * legacy Bitcoin message signing format using a raw secp256k1 private key.
 *
 * Signing format (Path 1: Legacy, is_bip322_simple=False):
 *   digest = SHA256(SHA256(varint(24) || "Bitcoin Signed Message:\n" || varint(32) || hash))
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
 * On-chain signature format (5 felt252):
 *   [r_low, r_high, s_low, s_high, y_parity]
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

// ── secp256k1 curve constants ─────────────────────────────────────

const CURVE_ORDER = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);
const HALF_CURVE_ORDER = CURVE_ORDER / 2n;

// ── Bitcoin message prefix (raw bytes) ────────────────────────────

const BITCOIN_MSG_PREFIX = new Uint8Array([
  0x18, // varint(24) — length of header
  0x42, 0x69, 0x74, 0x63, 0x6f, 0x69, 0x6e, 0x20, // "Bitcoin "
  0x53, 0x69, 0x67, 0x6e, 0x65, 0x64, 0x20, // "Signed "
  0x4d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x3a, 0x0a, // "Message:\n"
]);

// ── Helpers ───────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
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

function splitU256(value: bigint): [string, string] {
  const mask = (1n << 128n) - 1n;
  return ['0x' + (value & mask).toString(16), '0x' + (value >> 128n).toString(16)];
}

function intDAM(dam: unknown): number {
  if (typeof dam === 'number') return dam;
  if (dam === 'L1' || dam === 0) return 0;
  if (dam === 'L2' || dam === 1) return 1;
  return 0;
}

// ── Bitcoin message hashing ───────────────────────────────────────

/**
 * Compute the double-SHA256 Bitcoin message digest for a 32-byte hash.
 * SHA256(SHA256(varint(24) || "Bitcoin Signed Message:\n" || varint(32) || hash))
 */
export function bitcoinMessageDigest(hash32: Uint8Array): Uint8Array {
  const msg = new Uint8Array(BITCOIN_MSG_PREFIX.length + 1 + 32);
  msg.set(BITCOIN_MSG_PREFIX, 0);
  msg[BITCOIN_MSG_PREFIX.length] = 0x20; // varint(32)
  msg.set(hash32, BITCOIN_MSG_PREFIX.length + 1);
  return sha256(sha256(msg));
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
 * 1. Wraps the hash: SHA256(SHA256(prefix || varint(32) || hash))
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
  const hex = publicKeyHex.startsWith('0x') ? publicKeyHex.slice(2) : publicKeyHex;
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
    return this.signHash(msgHash);
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
    return this.signHash(msgHash);
  }

  async signDeclareTransaction(
    _details: DeclareSignerDetails,
  ): Promise<Signature> {
    throw new Error('signDeclareTransaction not supported');
  }

  /**
   * Sign a Starknet tx hash using the OneKey/Trezor Bitcoin legacy format.
   *
   * 1. Applies Bitcoin message wrapping (double-SHA256)
   * 2. Signs with ECDSA on secp256k1
   * 3. Produces 65-byte compact signature (byte0 encodes script type)
   * 4. Returns on-chain format: [r_low, r_high, s_low, s_high, y_parity]
   */
  async signHash(txHash: string): Promise<Signature> {
    const hashHex = txHash.replace(/^0x/i, '').padStart(64, '0');

    const sig = await signBitcoinMessage(this.privateKeyHex, hashHex, this.scriptType);

    const [rLow, rHigh] = splitU256(sig.r);
    const [sLow, sHigh] = splitU256(sig.s);

    return [rLow, rHigh, sLow, sHigh, sig.yParity.toString()];
  }

  /**
   * Sign and return BOTH the 65-byte compact (for inspection/logging)
   * and the on-chain felt252 format.
   */
  async signHashFull(txHash: string): Promise<{
    compact65: Uint8Array;
    onChain: string[];
    byte0: number;
    scriptType: ScriptType;
  }> {
    const hashHex = txHash.replace(/^0x/i, '').padStart(64, '0');
    const sig = await signBitcoinMessage(this.privateKeyHex, hashHex, this.scriptType);
    const [rLow, rHigh] = splitU256(sig.r);
    const [sLow, sHigh] = splitU256(sig.s);

    return {
      compact65: sig.compact65,
      onChain: [rLow, rHigh, sLow, sHigh, sig.yParity.toString()],
      byte0: sig.byte0,
      scriptType: this.scriptType,
    };
  }
}
