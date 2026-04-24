/**
 * OneKey Bitcoin signer for Starknet — uses the actual OneKey hardware wallet.
 * Implements starknet.js SignerInterface for use with Account.
 *
 * Off-chain signature format: [r_low, r_high, s_low, s_high, y_parity]
 * On-chain tx signature format: [r_low, r_high, s_low, s_high, y_parity, tx_domain_tag]
 */
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
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { signWithOneKey } from './onekey';

const CURVE_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const HALF_CURVE_ORDER = CURVE_ORDER / 2n;
const STARK_EC_ORDER = 0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2fn;
const MAX_STARK_PRIVATE_KEY = STARK_EC_ORDER / 2n - 1n;
export const TX_SIGNATURE_DOMAIN_TAG = '0x4f4e454b45595f54585f415554485f5631';
export const OFFCHAIN_SIGNATURE_DOMAIN_TAG = '0x4f4e454b45595f4f4646434841494e5f5631';
export const PRIVACY_KEY_DOMAIN = 'STARKNET_ONEKEY_PRIVACY_V1:';
const PRIVACY_KEY_DERIVATION_CONTEXT = 'privacy-key';

/**
 * Starknet-scoped prefix ("STARKNET_ONEKEY_V1:") handed to the OneKey before every
 * `btcSignMessage` call. The device wraps the full payload as a standard Bitcoin
 * signed message; the Cairo verifier in `bitcoin_signer.cairo` reconstructs the
 * same 19-byte prefix, so only payloads produced through this app validate on-chain.
 * Any plain BIP-137/BIP-322-simple signing request on the same key produces a
 * different (no-prefix) payload and cannot be replayed as Starknet auth.
 */
export const STARKNET_AUTH_PREFIX_HEX = '535441524b4e45545f4f4e454b45595f56313a';

function splitU256(value: bigint): [string, string] {
  const mask = (1n << 128n) - 1n;
  return ['0x' + (value & mask).toString(16), '0x' + (value >> 128n).toString(16)];
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, '');
  if (!/^[0-9a-f]*$/i.test(clean)) {
    throw new Error(`Invalid hex string: ${hex}`);
  }
  const padded = clean.length % 2 === 0 ? clean : '0' + clean;
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

function normalizeHashHex(hashHex: string): `0x${string}` {
  return ('0x' + hashHex.replace(/^0x/i, '').padStart(64, '0')) as `0x${string}`;
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

function normalizeScalarHex(value: string, label: 'r' | 's'): string {
  const clean = value.replace(/^0x/i, '').toLowerCase();
  if (!clean || !/^[0-9a-f]+$/.test(clean)) {
    throw new Error(`OneKey returned an invalid ${label} value while signing.`);
  }
  return clean;
}

function normalizeOneKeySignature(rawSig: { v: number; r: string; s: string }): {
  v: number;
  r: bigint;
  s: bigint;
} {
  const r = BigInt('0x' + normalizeScalarHex(rawSig.r, 'r'));
  let s = BigInt('0x' + normalizeScalarHex(rawSig.s, 's'));
  let v = rawSig.v;

  if (s > HALF_CURVE_ORDER) {
    s = CURVE_ORDER - s;
    v = v ^ 1;
  }

  return { v, r, s };
}

interface PrivacyKeyChallengeInput {
  chainId: string;
  poolAddress: string;
  accountAddress: string;
  pubkeyHash: string;
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

export function buildPrivacyKeyChallengeHex(input: PrivacyKeyChallengeInput): string {
  return bytesToHex(buildPrivacyKeyChallenge(input));
}

function privacySignatureBytes(signature: { v: number; r: bigint; s: bigint }): Uint8Array {
  return concatBytes([
    Uint8Array.of(signature.v & 0xff),
    scalarToBytes32(signature.r),
    scalarToBytes32(signature.s),
  ]);
}

function derivePrivacyKeyFromSignature(signatureBytes: Uint8Array, challenge: Uint8Array): string {
  const digest = sha256(
    concatBytes([signatureBytes, challenge, utf8Bytes(PRIVACY_KEY_DERIVATION_CONTEXT)]),
  );
  const key = (BigInt('0x' + bytesToHex(digest)) % (MAX_STARK_PRIVATE_KEY - 1n)) + 1n;
  return '0x' + key.toString(16);
}

/**
 * Compute Poseidon pubkey_hash from uncompressed secp256k1 public key hex.
 */
export function pubkeyToPoseidonHash(publicKeyHex: string): string {
  const hex = normalizeSecpPublicKeyHex(publicKeyHex);
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
 * Compute Starknet address for a OneKey Bitcoin signer account.
 */
export function calculateAccountAddress(pubkeyHash: string, classHash: string): string {
  const addr = hash.calculateContractAddressFromHash(pubkeyHash, classHash, [pubkeyHash], 0);
  return '0x' + addr.replace(/^0x/, '').padStart(64, '0');
}

export class OneKeyHardwareSigner implements SignerInterface {
  public readonly pubkeyHash: string;
  private readonly accountIndex: number;
  private readonly privacyKeyCache = new Map<string, Promise<string>>();

  constructor(pubkeyHash: string, accountIndex: number = 0) {
    this.pubkeyHash = pubkeyHash;
    this.accountIndex = accountIndex;
  }

  async getPubKey(): Promise<string> {
    return this.pubkeyHash;
  }

  async signMessage(typedData: TypedData, accountAddress: string): Promise<Signature> {
    const msgHash = starknetTypedData.getMessageHash(typedData, accountAddress);
    return this.signHash(msgHash);
  }

  async signTransaction(transactions: Call[], details: InvocationsSignerDetails): Promise<Signature> {
    const compiledCalldata = transaction.getExecuteCalldata(transactions, details.cairoVersion || '1');
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

  async signDeployAccountTransaction(details: DeployAccountSignerDetails): Promise<Signature> {
    const compiledConstructorCalldata = CallData.compile(details.constructorCalldata);
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

  async signDeclareTransaction(details: DeclareSignerDetails): Promise<Signature> {
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
    const cacheKey = [
      String(args.chainId),
      args.poolAddress.toLowerCase(),
      args.accountAddress.toLowerCase(),
      this.pubkeyHash.toLowerCase(),
      this.accountIndex,
    ].join(':');
    const cached = this.privacyKeyCache.get(cacheKey);
    if (cached) return cached;

    const promise = this.derivePrivacyKeyUncached(args).catch((error) => {
      this.privacyKeyCache.delete(cacheKey);
      throw error;
    });
    this.privacyKeyCache.set(cacheKey, promise);
    return promise;
  }

  private async derivePrivacyKeyUncached(args: {
    chainId: string;
    poolAddress: string;
    accountAddress: string;
  }): Promise<string> {
    const challenge = buildPrivacyKeyChallenge({
      ...args,
      pubkeyHash: this.pubkeyHash,
    });
    const rawSig = await signWithOneKey(bytesToHex(challenge), this.accountIndex);
    const normalized = normalizeOneKeySignature(rawSig);
    return derivePrivacyKeyFromSignature(privacySignatureBytes(normalized), challenge);
  }

  private async signRawHash(hashHex: string): Promise<Signature> {
    const hashBody = normalizeHashHex(hashHex).slice(2);
    // The device wraps these bytes as `varint(len) || "Bitcoin Signed Message:\n" || …`
    // — prepending the Starknet prefix domain-separates the produced signature.
    const messageHex = STARKNET_AUTH_PREFIX_HEX + hashBody;
    const rawSig = await signWithOneKey(messageHex, this.accountIndex);
    const { r, s, v } = normalizeOneKeySignature(rawSig);

    const [rLow, rHigh] = splitU256(r);
    const [sLow, sHigh] = splitU256(s);

    return [rLow, rHigh, sLow, sHigh, '0x' + v.toString(16)];
  }
}
