import HardwareSDKModule from '@onekeyfe/hd-common-connect-sdk';
import { spawn } from 'node:child_process';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
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
  typedData as starknetTypedData,
} from 'starknet';
import { ONEKEY_ACCOUNT_CLASS_HASH } from '../src/constants.js';
import {
  OneKeyBitcoinSigner,
  STARKNET_AUTH_PREFIX_HEX,
  calculateAccountAddress,
  getOffchainSignatureHash,
  getTransactionSignatureHash,
  getUncompressedPubKey,
  pubkeyToPoseidonHash,
  TX_SIGNATURE_DOMAIN_TAG,
} from '../src/signer.js';

const HardwareSDK = ((HardwareSDKModule as any)?.default ?? HardwareSDKModule) as any;

const BOOL_TRUE_RE = /^(1|true|yes|on)$/i;
const CURVE_ORDER = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);
const HALF_CURVE_ORDER = CURVE_ORDER / 2n;

export const ONEKEY_EMULATOR_BRIDGE_URL = 'http://localhost:21333';
export const ONEKEY_EMULATOR_REVIEW_URL = 'http://localhost:6088';
const ONEKEY_EMULATOR_DEFAULT_CONTAINER = 'onekey-emu-1s';
const ONEKEY_EMULATOR_PYTHONPATH = '/home/firmware-classic1s/python/src';
const ONEKEY_EMULATOR_UDP_ENDPOINT = '127.0.0.1:54935';

type EmulatorSlot = 'A' | 'B';
type EmulatorTransportMode = 'auto' | 'bridge' | 'debuglink';

interface DeviceHandle {
  connectId: string;
  deviceId: string;
}

export interface ConfiguredTestWallet {
  label: string;
  mode: 'local' | 'emulator';
  accountIndex: number | null;
  privateKeyHex: string;
  pubkeyHash: string;
  address: string;
  signer: SignerInterface;
  signHash: (messageHash: string) => Promise<string[]>;
  signTransactionHash: (messageHash: string, chainId: string) => Promise<string[]>;
}

let sdkInitialized = false;
let deviceHandlePromise: Promise<DeviceHandle> | null = null;
const verifiedAccounts = new Set<number>();

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const padded = clean.length % 2 === 0 ? clean : '0' + clean;
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

function normalizeHashHex(hashHex: string): `0x${string}` {
  return ('0x' + hashHex.replace(/^0x/i, '').padStart(64, '0')) as `0x${string}`;
}

function intDAM(dam: unknown): number {
  if (typeof dam === 'number') return dam;
  if (dam === 'L1' || dam === 0) return 0;
  if (dam === 'L2' || dam === 1) return 1;
  return 0;
}

function normalizeHex(hex: string): string {
  return hex.replace(/^0x/i, '').toLowerCase();
}

function getMnemonic(): string {
  const mnemonic = process.env.ONEKEY_EMULATOR_MNEMONIC?.trim() || '';
  if (!mnemonic) {
    throw new Error(
      'ONEKEY_EMULATOR=1 requires ONEKEY_EMULATOR_MNEMONIC to derive wallet keys that match the simulator.',
    );
  }
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('ONEKEY_EMULATOR_MNEMONIC is not a valid BIP-39 mnemonic.');
  }
  return mnemonic;
}

function getBtcDerivationPath(accountIndex: number): string {
  return `m/44'/0'/0'/0/${accountIndex}`;
}

function getBtcDerivationPathArray(accountIndex: number): number[] {
  return [
    0x8000002c,
    0x80000000,
    0x80000000,
    0,
    accountIndex,
  ];
}

function getEmulatorTransportMode(): EmulatorTransportMode {
  const raw = process.env.ONEKEY_EMULATOR_TRANSPORT?.trim().toLowerCase();
  if (!raw || raw === 'auto') return 'auto';
  if (raw === 'bridge' || raw === 'debuglink') return raw;
  throw new Error("ONEKEY_EMULATOR_TRANSPORT must be 'auto', 'bridge', or 'debuglink'.");
}

function getEmulatorContainerName(): string {
  return process.env.ONEKEY_EMULATOR_CONTAINER?.trim() || ONEKEY_EMULATOR_DEFAULT_CONTAINER;
}

function getEmulatorPythonBootstrap(): string {
  return [
    'import base64',
    'import json',
    'import os',
    'from trezorlib import btc, messages',
    'from trezorlib.debuglink import TrezorClientDebugLink',
    'from trezorlib.transport import udp',
    `transport = udp.UdpTransport("${ONEKEY_EMULATOR_UDP_ENDPOINT}")`,
    'client = TrezorClientDebugLink(transport)',
    'client.init_device()',
    'path = json.loads(os.environ["ONEKEY_PATH_JSON"])',
    'try:',
  ].join('\n');
}

async function runEmulatorPython(
  scriptBody: string,
  env: Record<string, string>,
): Promise<Record<string, unknown>> {
  const script = `${getEmulatorPythonBootstrap()}\n${scriptBody}\nfinally:\n    client.close()\n`;
  const child = spawn(
    'docker',
    [
      'exec',
      '-i',
      ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      getEmulatorContainerName(),
      'bash',
      '-lc',
      `cd / && PYTHONUNBUFFERED=1 PYTHONPATH=${ONEKEY_EMULATOR_PYTHONPATH} poetry run python -u -`,
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';

  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Direct emulator transport failed with exit code ${code}: ${(stderr || stdout).trim() || 'no output'}`,
          ),
        );
        return;
      }

      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const lastLine = lines.at(-1);
      if (!lastLine) {
        reject(new Error(`Direct emulator transport returned no output. Stderr: ${stderr.trim() || 'empty'}`));
        return;
      }

      try {
        resolve(JSON.parse(lastLine) as Record<string, unknown>);
      } catch (error) {
        reject(
          new Error(
            `Direct emulator transport returned invalid JSON: ${String(error)}. Output: ${stdout.trim() || 'empty'}`,
          ),
        );
      }
    });
  });

  child.stdin.write(script);
  child.stdin.end();

  return result;
}

function getEmulatorAccountIndex(slot: EmulatorSlot): number {
  const fallback = slot === 'A' ? 0 : 1;
  const raw = process.env[`ONEKEY_EMULATOR_ACCOUNT_${slot}`]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`ONEKEY_EMULATOR_ACCOUNT_${slot} must be a non-negative integer.`);
  }
  return parsed;
}

function deriveBip44PrivateKey(mnemonic: string, accountIndex: number): string {
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(getBtcDerivationPath(accountIndex));
  if (!child.privateKey) {
    throw new Error(`Could not derive a private key for ${getBtcDerivationPath(accountIndex)}.`);
  }
  return bytesToHex(child.privateKey);
}

function getCompressedPubKey(privateKeyHex: string): string {
  return bytesToHex(secp256k1.getPublicKey(hexToBytes(privateKeyHex), true));
}

function toOnChainSignature(rawSig: { v: number; r: string; s: string }): Signature {
  let r = BigInt('0x' + normalizeHex(rawSig.r));
  let s = BigInt('0x' + normalizeHex(rawSig.s));
  let v = rawSig.v;

  if (s > HALF_CURVE_ORDER) {
    s = CURVE_ORDER - s;
    v = v ^ 1;
  }

  const [rLow, rHigh] = splitU256(r);
  const [sLow, sHigh] = splitU256(s);
  return [rLow, rHigh, sLow, sHigh, '0x' + v.toString(16)];
}

export function isOneKeyEmulatorEnabled(): boolean {
  return BOOL_TRUE_RE.test(process.env.ONEKEY_EMULATOR || '');
}

async function initOneKeyEmulatorSdk(): Promise<void> {
  if (sdkInitialized) return;
  const ok = await HardwareSDK.init({
    debug: false,
    env: 'emulator',
  });
  if (!ok) {
    throw new Error(
      `Failed to initialize the OneKey emulator SDK. Make sure the bridge is reachable on ${ONEKEY_EMULATOR_BRIDGE_URL}.`,
    );
  }
  sdkInitialized = true;
}

async function getDeviceHandle(): Promise<DeviceHandle> {
  if (deviceHandlePromise) return deviceHandlePromise;

  deviceHandlePromise = (async () => {
    await initOneKeyEmulatorSdk();
    const result = await HardwareSDK.searchDevices();
    if (!result?.success || !Array.isArray(result.payload) || result.payload.length === 0) {
      throw new Error(
        `No OneKey emulator found on ${ONEKEY_EMULATOR_BRIDGE_URL}. Start it first and review prompts at ${ONEKEY_EMULATOR_REVIEW_URL}.`,
      );
    }

    const device = result.payload[0] as Record<string, unknown>;
    const connectId = String(device.connectId ?? '');
    const deviceId = String(device.deviceId ?? device.id ?? '');
    if (!deviceId) {
      throw new Error('OneKey emulator search returned a device without a deviceId.');
    }

    return { connectId, deviceId };
  })().catch((error) => {
    deviceHandlePromise = null;
    throw error;
  });

  return deviceHandlePromise;
}

async function getEmulatorPublicKey(accountIndex: number): Promise<string> {
  const transportMode = getEmulatorTransportMode();

  if (transportMode === 'debuglink') {
    const payload = await runEmulatorPython(
      [
        '    response = btc.get_public_node(',
        '        client,',
        '        path,',
        '        coin_name="Bitcoin",',
        '        script_type=messages.InputScriptType.SPENDADDRESS,',
        '    )',
        '    print(json.dumps({"publicKey": response.node.public_key.hex()}))',
      ].join('\n'),
      {
        ONEKEY_PATH_JSON: JSON.stringify(getBtcDerivationPathArray(accountIndex)),
      },
    );

    return String(payload.publicKey || '');
  }

  try {
    const { connectId, deviceId } = await getDeviceHandle();
    const result = await HardwareSDK.btcGetPublicKey(connectId, deviceId, {
      path: getBtcDerivationPath(accountIndex),
      showOnOneKey: false,
      coin: 'btc',
    });

    if (!result?.success) {
      throw new Error(
        `btcGetPublicKey failed for ${getBtcDerivationPath(accountIndex)}: ${String((result as any)?.payload?.error || 'unknown error')}`,
      );
    }

    const payload = (result as any).payload ?? {};
    return String(payload.node?.public_key || payload.publicKey || payload.public_key || '');
  } catch (error) {
    if (transportMode !== 'auto') {
      throw error;
    }

    const payload = await runEmulatorPython(
      [
        '    response = btc.get_public_node(',
        '        client,',
        '        path,',
        '        coin_name="Bitcoin",',
        '        script_type=messages.InputScriptType.SPENDADDRESS,',
        '    )',
        '    print(json.dumps({"publicKey": response.node.public_key.hex()}))',
      ].join('\n'),
      {
        ONEKEY_PATH_JSON: JSON.stringify(getBtcDerivationPathArray(accountIndex)),
      },
    );

    return String(payload.publicKey || '');
  }
}

async function signWithOneKeyDebugLink(accountIndex: number, messageHex: string) {
  const payload = await runEmulatorPython(
    [
      '    response = btc.sign_message(',
      '        client,',
      '        "Bitcoin",',
      '        path,',
      '        bytes.fromhex(os.environ["ONEKEY_MESSAGE_HEX"]),',
      '        script_type=messages.InputScriptType.SPENDADDRESS,',
      '        no_script_type=False,',
      '    )',
      '    print(json.dumps({"signature": base64.b64encode(response.signature).decode("ascii")}))',
    ].join('\n'),
    {
      ONEKEY_MESSAGE_HEX: messageHex,
      ONEKEY_PATH_JSON: JSON.stringify(getBtcDerivationPathArray(accountIndex)),
    },
  );

  const signatureBase64 = String(payload.signature || '');
  const sigBytes = Buffer.from(signatureBase64, 'base64');
  const byte0 = sigBytes[0] ?? 0;
  const recovery = (byte0 - 27 - 4) % 4;

  return {
    v: recovery >= 0 ? recovery : 0,
    r: bytesToHex(sigBytes.slice(1, 33)),
    s: bytesToHex(sigBytes.slice(33, 65)),
  };
}

async function ensureExpectedAccount(accountIndex: number, expectedCompressedPubKeyHex: string) {
  if (verifiedAccounts.has(accountIndex)) return;
  const actualPubKey = await getEmulatorPublicKey(accountIndex);
  if (!actualPubKey) {
    throw new Error(`The emulator returned an empty public key for ${getBtcDerivationPath(accountIndex)}.`);
  }
  if (normalizeHex(actualPubKey) !== normalizeHex(expectedCompressedPubKeyHex)) {
    throw new Error(
      `The emulator public key at ${getBtcDerivationPath(accountIndex)} does not match ONEKEY_EMULATOR_MNEMONIC. Initialize the emulator with the same mnemonic or adjust ONEKEY_EMULATOR_ACCOUNT_A/B.`,
    );
  }
  verifiedAccounts.add(accountIndex);
}

async function signWithOneKeyEmulator(
  messageHex: string,
  accountIndex: number,
  expectedCompressedPubKeyHex: string,
): Promise<{ v: number; r: string; s: string }> {
  await ensureExpectedAccount(accountIndex, expectedCompressedPubKeyHex);

  const transportMode = getEmulatorTransportMode();
  if (transportMode === 'debuglink') {
    return signWithOneKeyDebugLink(accountIndex, messageHex);
  }

  try {
    const { connectId, deviceId } = await getDeviceHandle();
    const result = await HardwareSDK.btcSignMessage(connectId, deviceId, {
      path: getBtcDerivationPath(accountIndex),
      messageHex,
      coin: 'btc',
    });

    if (!result?.success) {
      throw new Error(
        `btcSignMessage failed for ${getBtcDerivationPath(accountIndex)}: ${String((result as any)?.payload?.error || 'unknown error')}`,
      );
    }

    const signatureBase64 = String((result as any).payload?.signature || '');
    const sigBytes = Buffer.from(signatureBase64, 'base64');
    const byte0 = sigBytes[0] ?? 0;
    const recovery = (byte0 - 27 - 4) % 4;

    return {
      v: recovery >= 0 ? recovery : 0,
      r: bytesToHex(sigBytes.slice(1, 33)),
      s: bytesToHex(sigBytes.slice(33, 65)),
    };
  } catch (error) {
    if (transportMode !== 'auto') {
      throw error;
    }
    return signWithOneKeyDebugLink(accountIndex, messageHex);
  }
}

class OneKeyEmulatorSigner implements SignerInterface {
  public readonly pubkeyHash: string;
  private readonly accountIndex: number;
  private readonly expectedCompressedPubKeyHex: string;

  constructor(pubkeyHash: string, accountIndex: number, expectedCompressedPubKeyHex: string) {
    this.pubkeyHash = pubkeyHash;
    this.accountIndex = accountIndex;
    this.expectedCompressedPubKeyHex = expectedCompressedPubKeyHex;
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

  async signHash(messageHash: string): Promise<Signature> {
    return this.signRawHash(getOffchainSignatureHash(messageHash));
  }

  async signTransactionHash(txHash: string, chainId: string): Promise<Signature> {
    return [
      ...((await this.signRawHash(getTransactionSignatureHash(txHash, chainId))) as string[]),
      TX_SIGNATURE_DOMAIN_TAG,
    ];
  }

  private async signRawHash(hashHex: string): Promise<Signature> {
    const hashBody = normalizeHashHex(hashHex).slice(2);
    // Match the Cairo verifier's inner payload: "STARKNET_ONEKEY_V1:" || hash_32B
    // (the emulator applies the Bitcoin-signed-message wrap around this for us).
    const messageHex = STARKNET_AUTH_PREFIX_HEX + hashBody;
    const rawSig = await signWithOneKeyEmulator(
      messageHex,
      this.accountIndex,
      this.expectedCompressedPubKeyHex,
    );
    return toOnChainSignature(rawSig);
  }
}

export function createConfiguredTestWallet(params: {
  label: string;
  fallbackPrivateKeyHex: string;
  emulatorSlot: EmulatorSlot;
}): ConfiguredTestWallet {
  if (!isOneKeyEmulatorEnabled()) {
    const privateKeyHex = params.fallbackPrivateKeyHex.replace(/^0x/, '');
    const pubkeyHash = pubkeyToPoseidonHash(getUncompressedPubKey(privateKeyHex));
    const address = calculateAccountAddress(pubkeyHash, ONEKEY_ACCOUNT_CLASS_HASH);
    const signer = new OneKeyBitcoinSigner(privateKeyHex, pubkeyHash);

    return {
      label: params.label,
      mode: 'local',
      accountIndex: null,
      privateKeyHex,
      pubkeyHash,
      address,
      signer,
      signHash: async (messageHash: string) => (await signer.signHash(messageHash)) as string[],
      signTransactionHash: async (messageHash: string, chainId: string) =>
        (await signer.signTransactionHash(messageHash, chainId)) as string[],
    };
  }

  const accountIndex = getEmulatorAccountIndex(params.emulatorSlot);
  const privateKeyHex = deriveBip44PrivateKey(getMnemonic(), accountIndex);
  const pubkeyHash = pubkeyToPoseidonHash(getUncompressedPubKey(privateKeyHex));
  const address = calculateAccountAddress(pubkeyHash, ONEKEY_ACCOUNT_CLASS_HASH);
  const expectedCompressedPubKeyHex = getCompressedPubKey(privateKeyHex);
  const signer = new OneKeyEmulatorSigner(pubkeyHash, accountIndex, expectedCompressedPubKeyHex);

  return {
    label: params.label,
    mode: 'emulator',
    accountIndex,
    privateKeyHex,
    pubkeyHash,
    address,
    signer,
    signHash: async (messageHash: string) => (await signer.signHash(messageHash)) as string[],
    signTransactionHash: async (messageHash: string, chainId: string) =>
      (await signer.signTransactionHash(messageHash, chainId)) as string[],
  };
}
