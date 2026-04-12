/**
 * OneKey Bitcoin signer for Starknet — uses the actual OneKey hardware wallet.
 * Implements starknet.js SignerInterface for use with Account.
 *
 * On-chain signature format: [r_low, r_high, s_low, s_high, y_parity]
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
import { signWithOneKey } from './onekey';

const CURVE_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const HALF_CURVE_ORDER = CURVE_ORDER / 2n;

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

/**
 * Compute Poseidon pubkey_hash from uncompressed secp256k1 public key hex.
 */
export function pubkeyToPoseidonHash(publicKeyHex: string): string {
  const hex = publicKeyHex.startsWith('0x') ? publicKeyHex.slice(2) : publicKeyHex;
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
  private accountIndex: number;

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
    return this.signHash(msgHash);
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
    return this.signHash(msgHash);
  }

  async signDeclareTransaction(_details: DeclareSignerDetails): Promise<Signature> {
    throw new Error('signDeclareTransaction not supported');
  }

  /**
   * Sign a tx hash via OneKey hardware Bitcoin app.
   * The device applies the Bitcoin message wrapping internally:
   *   SHA256(SHA256("\x18Bitcoin Signed Message:\n" + varint(32) + hash))
   * Returns on-chain format: [r_low, r_high, s_low, s_high, y_parity]
   */
  async signHash(txHash: string): Promise<Signature> {
    const messageHex = txHash.replace(/^0x/i, '').padStart(64, '0');
    const rawSig = await signWithOneKey(messageHex, this.accountIndex);

    let r = BigInt('0x' + rawSig.r);
    let s = BigInt('0x' + rawSig.s);
    let v = rawSig.v;

    // Low-s normalization
    if (s > HALF_CURVE_ORDER) {
      s = CURVE_ORDER - s;
      v = v ^ 1;
    }

    const [rLow, rHigh] = splitU256(r);
    const [sLow, sHigh] = splitU256(s);

    return [rLow, rHigh, sLow, sHigh, v.toString()];
  }
}
