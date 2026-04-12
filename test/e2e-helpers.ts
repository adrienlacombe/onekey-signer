/**
 * E2E test helpers for the OneKey Bitcoin signer.
 * Handles account deployment, funding, privacy pool interaction,
 * and the full prove-and-execute flow against Sepolia.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  RpcProvider,
  hash,
  CallData,
  typedData as starknetTypedData,
  selector as selectorUtil,
  Account,
  transaction,
  ec,
} from 'starknet';
import {
  OneKeyBitcoinSigner,
  pubkeyToPoseidonHash,
  getUncompressedPubKey,
  calculateAccountAddress,
  signBitcoinMessage,
} from '../src/signer.js';
import {
  ONEKEY_ACCOUNT_CLASS_HASH,
  PRIVACY_POOL_ADDRESS,
  STRK_TOKEN_ADDRESS,
  STARKNET_RPC_URL,
  AVNU_PAYMASTER_URL,
  AVNU_API_KEY,
  PROVING_SERVICE_URL,
  EC_ORDER,
  MAX_PRIVATE_KEY,
  ScriptType,
} from '../src/constants.js';

// ============================================================
// Provider
// ============================================================

export function getProvider(): RpcProvider {
  return new RpcProvider({ nodeUrl: STARKNET_RPC_URL });
}

// ============================================================
// Public Key Extraction
// ============================================================

export interface PubKeyCoords {
  xLow: string;
  xHigh: string;
  yLow: string;
  yHigh: string;
}

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

/**
 * Extract (x, y) coordinates as u256 (low, high) pairs from a private key.
 */
export function extractPubKeyCoords(privateKeyHex: string): PubKeyCoords {
  const privBytes = hexToBytes(privateKeyHex);
  const uncompressed = secp256k1.getPublicKey(privBytes, false);
  const xBytes = uncompressed.slice(1, 33);
  const yBytes = uncompressed.slice(33, 65);
  const xHex = bytesToHex(xBytes);
  const yHex = bytesToHex(yBytes);

  return {
    xHigh: '0x' + xHex.slice(0, 32),
    xLow: '0x' + xHex.slice(32, 64),
    yHigh: '0x' + yHex.slice(0, 32),
    yLow: '0x' + yHex.slice(32, 64),
  };
}

// ============================================================
// Starknet Address Computation
// ============================================================

export function computeStarknetAddress(privateKeyHex: string) {
  const pubHex = getUncompressedPubKey(privateKeyHex);
  const pubkeyHash = pubkeyToPoseidonHash(pubHex);
  const address = calculateAccountAddress(pubkeyHash, ONEKEY_ACCOUNT_CLASS_HASH);
  return { address, pubkeyHash };
}

// ============================================================
// AVNU Paymaster
// ============================================================

function toHexStr(value: string | bigint): string {
  if (typeof value === 'string' && value.startsWith('0x')) return value;
  return '0x' + BigInt(value).toString(16);
}

function paymasterHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: '*/*',
  };
  if (AVNU_API_KEY) {
    headers['x-paymaster-api-key'] = AVNU_API_KEY;
  }
  return headers;
}

export async function deployViaPaymaster(params: {
  address: string;
  pubkeyHash: string;
}): Promise<string> {
  const rpcBody = {
    jsonrpc: '2.0',
    method: 'paymaster_executeTransaction',
    params: {
      transaction: {
        type: 'deploy',
        deployment: {
          address: toHexStr(params.address),
          class_hash: ONEKEY_ACCOUNT_CLASS_HASH,
          salt: toHexStr(params.pubkeyHash),
          calldata: [toHexStr(params.pubkeyHash)],
          version: 1,
        },
      },
      parameters: {
        version: '0x1',
        fee_mode: { mode: 'sponsored' },
      },
    },
    id: 1,
  };

  const response = await fetch(AVNU_PAYMASTER_URL, {
    method: 'POST',
    headers: paymasterHeaders(),
    body: JSON.stringify(rpcBody),
  });

  const result = await response.json();
  if (result.error) {
    throw new Error(
      `Deploy error: ${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.data ?? '')}`,
    );
  }
  if (!result.result?.transaction_hash) {
    throw new Error(`No tx hash: ${JSON.stringify(result)}`);
  }
  return result.result.transaction_hash;
}

export async function buildInvokeTx(params: {
  userAddress: string;
  calls: Array<{
    contractAddress: string;
    entrypoint: string;
    calldata: string[];
  }>;
}): Promise<{ typedData: any }> {
  const rpcBody = {
    jsonrpc: '2.0',
    method: 'paymaster_buildTransaction',
    params: {
      transaction: {
        type: 'invoke',
        invoke: {
          user_address: toHexStr(params.userAddress),
          calls: params.calls.map((c) => ({
            to: toHexStr(c.contractAddress),
            selector: selectorUtil.getSelectorFromName(c.entrypoint),
            calldata: c.calldata.map(toHexStr),
          })),
        },
      },
      parameters: {
        version: '0x1',
        fee_mode: { mode: 'sponsored' },
      },
    },
    id: 1,
  };

  const response = await fetch(AVNU_PAYMASTER_URL, {
    method: 'POST',
    headers: paymasterHeaders(),
    body: JSON.stringify(rpcBody),
  });

  const result = await response.json();
  if (result.error) {
    throw new Error(
      `Build error: ${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.data ?? '')}`,
    );
  }
  return { typedData: result.result?.typed_data };
}

export async function executeInvokeTx(params: {
  userAddress: string;
  typedData: any;
  signature: string[];
}): Promise<string> {
  const rpcBody = {
    jsonrpc: '2.0',
    method: 'paymaster_executeTransaction',
    params: {
      transaction: {
        type: 'invoke',
        invoke: {
          user_address: toHexStr(params.userAddress),
          typed_data: params.typedData,
          signature: params.signature,
        },
      },
      parameters: {
        version: '0x1',
        fee_mode: { mode: 'sponsored' },
      },
    },
    id: 1,
  };

  const response = await fetch(AVNU_PAYMASTER_URL, {
    method: 'POST',
    headers: paymasterHeaders(),
    body: JSON.stringify(rpcBody),
  });

  const result = await response.json();
  if (result.error) {
    throw new Error(
      `Execute error: ${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.data ?? '')}`,
    );
  }
  if (!result.result?.transaction_hash) {
    throw new Error(`No tx hash: ${JSON.stringify(result)}`);
  }
  return result.result.transaction_hash;
}

// ============================================================
// Direct Deploy Account (account pays its own gas)
// ============================================================

export async function deployAccountDirect(params: {
  privateKeyHex: string;
  address: string;
  pubkeyHash: string;
}): Promise<string> {
  const provider = getProvider();
  const signer = new OneKeyBitcoinSigner(
    params.privateKeyHex,
    params.pubkeyHash,
  );
  const account = new Account({ provider, address: params.address, signer });

  const block = (await provider.getBlockWithReceipts('latest')) as any;
  const l1Price = BigInt(block.l1_gas_price?.price_in_fri ?? '0x400000000000');
  const l1DataPrice = BigInt(
    block.l1_data_gas_price?.price_in_fri ?? '0x20000',
  );
  const l2Price = BigInt(block.l2_gas_price?.price_in_fri ?? '0x4000000000');

  const result = await account.deployAccount(
    {
      classHash: ONEKEY_ACCOUNT_CLASS_HASH,
      constructorCalldata: [params.pubkeyHash],
      addressSalt: params.pubkeyHash,
    },
    {
      resourceBounds: {
        l1_gas: { max_amount: 0x200n, max_price_per_unit: l1Price * 2n },
        l2_gas: {
          max_amount: 0x2000000n,
          max_price_per_unit: l2Price * 2n,
        },
        l1_data_gas: {
          max_amount: 0x200n,
          max_price_per_unit: l1DataPrice * 2n,
        },
      },
    },
  );
  return result.transaction_hash;
}

// ============================================================
// OneKey Bitcoin Signing (for Starknet typed data)
// ============================================================

/**
 * Sign a Starknet typed data hash with the OneKey Bitcoin format.
 * Returns 5-felt signature: [r_low, r_high, s_low, s_high, y_parity]
 */
export async function signStarknetHash(
  privateKeyHex: string,
  messageHash: string,
  scriptType: ScriptType = ScriptType.NATIVE_SEGWIT,
): Promise<string[]> {
  const hashHex = messageHash.startsWith('0x')
    ? messageHash.slice(2)
    : messageHash;
  const padded = hashHex.padStart(64, '0');

  const sig = await signBitcoinMessage(privateKeyHex.replace(/^0x/, ''), padded, scriptType);

  const mask = (1n << 128n) - 1n;
  const rLow = '0x' + (sig.r & mask).toString(16);
  const rHigh = '0x' + (sig.r >> 128n).toString(16);
  const sLow = '0x' + (sig.s & mask).toString(16);
  const sHigh = '0x' + (sig.s >> 128n).toString(16);

  return [rLow, rHigh, sLow, sHigh, '0x' + sig.yParity.toString(16)];
}

/**
 * Build + sign + execute an invoke transaction via AVNU paymaster.
 */
export async function signAndExecuteInvoke(params: {
  privateKeyHex: string;
  starknetAddress: string;
  calls: Array<{
    contractAddress: string;
    entrypoint: string;
    calldata: string[];
  }>;
  scriptType?: ScriptType;
}): Promise<string> {
  const { typedData } = await buildInvokeTx({
    userAddress: params.starknetAddress,
    calls: params.calls,
  });

  const messageHash = starknetTypedData.getMessageHash(
    typedData,
    params.starknetAddress,
  );
  console.log('  Message hash:', messageHash);

  const signature = await signStarknetHash(
    params.privateKeyHex,
    messageHash,
    params.scriptType,
  );
  console.log('  Signature (5-felt):', signature);

  const txHash = await executeInvokeTx({
    userAddress: params.starknetAddress,
    typedData,
    signature,
  });
  return txHash;
}

// ============================================================
// Direct Invoke (bypasses AVNU, uses account's own gas)
// ============================================================

export async function directInvoke(params: {
  privateKeyHex: string;
  starknetAddress: string;
  pubkeyHash: string;
  calls: Array<{
    contractAddress: string;
    entrypoint: string;
    calldata: string[];
  }>;
}): Promise<string> {
  const provider = getProvider();
  const signer = new OneKeyBitcoinSigner(
    params.privateKeyHex,
    params.pubkeyHash,
  );
  const account = new Account({
    provider,
    address: params.starknetAddress,
    signer,
  });

  const block = (await provider.getBlockWithReceipts('latest')) as any;
  const l1Price = BigInt(block.l1_gas_price?.price_in_fri ?? '0x400000000000');
  const l1DataPrice = BigInt(
    block.l1_data_gas_price?.price_in_fri ?? '0x20000',
  );
  const l2Price = BigInt(block.l2_gas_price?.price_in_fri ?? '0x4000000000');

  const calls = params.calls.map((c) => ({
    contractAddress: c.contractAddress,
    entrypoint: c.entrypoint,
    calldata: c.calldata,
  }));

  const result = await account.execute(calls, {
    resourceBounds: {
      l1_gas: { max_amount: 0x200n, max_price_per_unit: l1Price * 2n },
      l2_gas: { max_amount: 0x2000000n, max_price_per_unit: l2Price * 2n },
      l1_data_gas: {
        max_amount: 0x400n,
        max_price_per_unit: l1DataPrice * 2n,
      },
    },
  });
  return result.transaction_hash;
}

// ============================================================
// Prove and Execute (full proving service flow)
// ============================================================

/**
 * Prove client actions via the privacy pool, then execute on-chain
 * with the returned proof_facts.
 */
export async function proveAndExecute(params: {
  privateKeyHex: string;
  starknetAddress: string;
  pubkeyHash: string;
  clientActions: string[];
  serverActions: string[];
  scriptType?: ScriptType;
}): Promise<string> {
  if (!PROVING_SERVICE_URL) throw new Error('PROVING_SERVICE_URL not set');

  const provider = getProvider();
  const chainId = await provider.getChainId();
  const latestBlock = await provider.getBlockNumber();
  const proveBlock = latestBlock - 20;
  console.log('  Prove block:', proveBlock, '(latest:', latestBlock, ')');

  const poolNonce = await provider.getNonceForAddress(PRIVACY_POOL_ADDRESS,
    proveBlock as any,
  );
  const poolNonceHex = poolNonce.startsWith('0x')
    ? poolNonce
    : '0x' + BigInt(poolNonce).toString(16);

  const innerCalldata = params.clientActions.map(toHexStr);
  const clientCalldata = [
    '0x1',
    PRIVACY_POOL_ADDRESS,
    selectorUtil.getSelectorFromName('compile_actions'),
    '0x' + innerCalldata.length.toString(16),
    ...innerCalldata,
  ];

  const proveResourceBounds = {
    l1_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
    l2_gas: { max_amount: 0x20000000n, max_price_per_unit: 0x0n },
    l1_data_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
  };

  const txHash = hash.calculateInvokeTransactionHash({
    senderAddress: PRIVACY_POOL_ADDRESS,
    version: '0x3',
    compiledCalldata: clientCalldata,
    chainId,
    nonce: poolNonceHex,
    accountDeploymentData: [],
    nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0,
    paymasterData: [],
    resourceBounds: proveResourceBounds,
    tip: 0n,
  });

  // Sign the tx hash (pool verifies via is_valid_signature on user account)
  console.log('  Signing for proving service...');
  const signature = await signStarknetHash(
    params.privateKeyHex,
    txHash,
    params.scriptType,
  );

  // Send to proving service
  console.log('  Calling proving service...');
  const proveResponse = await fetch(PROVING_SERVICE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'starknet_proveTransaction',
      params: {
        block_id: { block_number: proveBlock },
        transaction: {
          type: 'INVOKE',
          version: '0x3',
          sender_address: PRIVACY_POOL_ADDRESS,
          calldata: clientCalldata,
          signature: [...signature],
          nonce: poolNonceHex,
          resource_bounds: {
            l1_gas: { max_amount: '0x0', max_price_per_unit: '0x0' },
            l2_gas: { max_amount: '0x20000000', max_price_per_unit: '0x0' },
            l1_data_gas: { max_amount: '0x0', max_price_per_unit: '0x0' },
          },
          tip: '0x0',
          paymaster_data: [],
          account_deployment_data: [],
          nonce_data_availability_mode: 'L1',
          fee_data_availability_mode: 'L1',
        },
      },
      id: 1,
    }),
  });

  const proveResult = await proveResponse.json();
  if (proveResult.error) {
    throw new Error(
      `Proving failed: ${JSON.stringify(proveResult.error).slice(0, 500)}`,
    );
  }

  const proofFacts =
    proveResult.result?.proof_facts ||
    proveResult.result?.proofFacts ||
    [];
  const proof = proveResult.result?.proof || '';
  console.log(
    `  Proof obtained: ${proofFacts.length} proof_facts, ${proof.length} chars proof`,
  );

  // Build on-chain tx with proof_facts
  console.log('  Building on-chain tx with proof_facts...');
  const userNonce = await provider.getNonceForAddress(params.starknetAddress);
  const userNonceHex = userNonce.startsWith('0x')
    ? userNonce
    : '0x' + BigInt(userNonce).toString(16);

  const block = (await provider.getBlockWithReceipts('latest')) as any;
  const l1Price = BigInt(block.l1_gas_price?.price_in_fri ?? '0x400000000000');
  const l1DataPrice = BigInt(
    block.l1_data_gas_price?.price_in_fri ?? '0x20000',
  );
  const l2Price = BigInt(block.l2_gas_price?.price_in_fri ?? '0x4000000000');

  const applyCalldata = transaction
    .getExecuteCalldata(
      [
        {
          contractAddress: PRIVACY_POOL_ADDRESS,
          entrypoint: 'apply_actions',
          calldata: params.serverActions,
        },
      ],
      '1',
    )
    .map(toHexStr);

  const onchainRb = {
    l1_gas: { max_amount: 0x200n, max_price_per_unit: l1Price * 2n },
    l2_gas: { max_amount: 0x8000000n, max_price_per_unit: l2Price * 2n },
    l1_data_gas: {
      max_amount: 0x800n,
      max_price_per_unit: l1DataPrice * 2n,
    },
  };

  // Compute tx hash WITH proof_facts
  const onchainTxHash = hash.calculateInvokeTransactionHash({
    senderAddress: params.starknetAddress,
    version: '0x3',
    compiledCalldata: applyCalldata,
    chainId,
    nonce: userNonceHex,
    accountDeploymentData: [],
    nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0,
    paymasterData: [],
    resourceBounds: onchainRb,
    tip: 0n,
    proofFacts: proofFacts.map((f: string) => BigInt(f)),
  });
  console.log('  On-chain TX hash:', onchainTxHash);

  // Sign the on-chain hash
  const onchainSig = await signStarknetHash(
    params.privateKeyHex,
    onchainTxHash,
    params.scriptType,
  );

  // Submit via raw RPC with proof_facts + proof
  console.log('  Submitting on-chain...');
  const submitRes = await fetch(STARKNET_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'starknet_addInvokeTransaction',
      params: {
        invoke_transaction: {
          type: 'INVOKE',
          version: '0x3',
          sender_address: params.starknetAddress,
          calldata: applyCalldata,
          signature: onchainSig,
          nonce: userNonceHex,
          resource_bounds: {
            l1_gas: {
              max_amount: toHexStr(onchainRb.l1_gas.max_amount.toString()),
              max_price_per_unit: toHexStr(
                onchainRb.l1_gas.max_price_per_unit.toString(),
              ),
            },
            l2_gas: {
              max_amount: toHexStr(onchainRb.l2_gas.max_amount.toString()),
              max_price_per_unit: toHexStr(
                onchainRb.l2_gas.max_price_per_unit.toString(),
              ),
            },
            l1_data_gas: {
              max_amount: toHexStr(
                onchainRb.l1_data_gas.max_amount.toString(),
              ),
              max_price_per_unit: toHexStr(
                onchainRb.l1_data_gas.max_price_per_unit.toString(),
              ),
            },
          },
          tip: '0x0',
          paymaster_data: [],
          account_deployment_data: [],
          nonce_data_availability_mode: 'L1',
          fee_data_availability_mode: 'L1',
          proof_facts: proofFacts,
          proof,
        },
      },
      id: 1,
    }),
  });

  const submitData = await submitRes.json();
  if (submitData.error) {
    throw new Error(
      `On-chain submit failed: ${JSON.stringify(submitData.error).slice(0, 500)}`,
    );
  }

  return submitData.result.transaction_hash;
}

// ============================================================
// Privacy Key Derivation
// ============================================================

export function derivePrivacyKey(
  privateKeyHex: string,
  starknetAddress: string,
): string {
  // Deterministic: poseidon of the secp256k1 pubkey hash + address
  const pubHex = getUncompressedPubKey(privateKeyHex);
  const pubkeyHash = pubkeyToPoseidonHash(pubHex);
  const raw = ec.starkCurve.poseidonHashMany([
    BigInt(pubkeyHash),
    BigInt(starknetAddress),
  ]);
  const key = (BigInt('0x' + raw.toString(16)) % (MAX_PRIVATE_KEY - 1n)) + 1n;
  return '0x' + key.toString(16);
}

// ============================================================
// Privacy Pool Crypto Helpers
// ============================================================

function shortStringToFelt(str: string): bigint {
  let result = 0n;
  for (let i = 0; i < str.length; i++) {
    result = (result << 8n) | BigInt(str.charCodeAt(i));
  }
  return result;
}

export function deriveStarkPublicKey(privacyKey: string): string {
  const keyHex = privacyKey.startsWith('0x') ? privacyKey.slice(2) : privacyKey;
  const keyBytes = hexToBytes(keyHex.padStart(64, '0'));
  const pubKeyBytes = ec.starkCurve.getPublicKey(keyBytes);
  const xBytes = pubKeyBytes.slice(1, 33);
  return '0x' + bytesToHex(xBytes);
}

export function computeChannelKey(
  senderAddr: string,
  senderPrivKey: string,
  recipientAddr: string,
  recipientPubKey: string,
): string {
  const result = ec.starkCurve.poseidonHashMany([
    shortStringToFelt('CHANNEL_KEY_TAG:V1'),
    BigInt(senderAddr),
    BigInt(senderPrivKey),
    BigInt(recipientAddr),
    BigInt(recipientPubKey),
  ]);
  return '0x' + result.toString(16);
}

function computeOutgoingChannelId(
  senderAddr: string,
  senderPrivKey: string,
  index: number,
): string {
  const result = ec.starkCurve.poseidonHashMany([
    shortStringToFelt('OUTGOING_CHANNEL_ID_TAG:V1'),
    BigInt(senderAddr),
    BigInt(senderPrivKey),
    BigInt(index),
    0n,
  ]);
  return '0x' + result.toString(16);
}

export async function getNextChannelIndex(
  address: string,
  privacyKey: string,
): Promise<number> {
  const provider = getProvider();
  for (let i = 0; i < 1000; i++) {
    const id = computeOutgoingChannelId(address, privacyKey, i);
    try {
      const info = await provider.callContract({
        contractAddress: PRIVACY_POOL_ADDRESS,
        entrypoint: 'get_outgoing_channel_info',
        calldata: [id],
      });
      if (info[0] === '0x0' || info[0] === '0') return i;
    } catch {
      return i;
    }
  }
  throw new Error('No available channel index found');
}

function computeNoteId(
  channelKey: string,
  token: string,
  index: number,
): string {
  const result = ec.starkCurve.poseidonHashMany([
    shortStringToFelt('NOTE_ID_TAG:V1'),
    BigInt(channelKey),
    BigInt(token),
    BigInt(index),
    0n,
  ]);
  return '0x' + result.toString(16);
}

export async function getNextNoteIndex(
  channelKey: string,
  token: string,
): Promise<number> {
  const provider = getProvider();
  for (let i = 0; i < 1000; i++) {
    const noteId = computeNoteId(channelKey, token, i);
    try {
      const note = await provider.callContract({
        contractAddress: PRIVACY_POOL_ADDRESS,
        entrypoint: 'get_note',
        calldata: [noteId],
      });
      if (note[0] === '0x0' || note[0] === '0') return i;
    } catch {
      return i;
    }
  }
  throw new Error('No available note index found');
}

export function generateRandom120(): string {
  const bytes = new Uint8Array(15);
  crypto.getRandomValues(bytes);
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }
  if (result <= 1n) result = 2n;
  return '0x' + result.toString(16);
}

// ============================================================
// Starknet RPC Utilities
// ============================================================

export async function isDeployed(address: string): Promise<boolean> {
  try {
    const classHash = await getProvider().getClassHashAt(address);
    return classHash !== '0x0';
  } catch {
    return false;
  }
}

export async function getStrkBalance(address: string): Promise<bigint> {
  const result = await getProvider().callContract({
    contractAddress: STRK_TOKEN_ADDRESS,
    entrypoint: 'balanceOf',
    calldata: [address],
  });
  const low = BigInt(result[0] ?? '0');
  const high = BigInt(result[1] ?? '0');
  return low + (high << 128n);
}

export async function waitForTx(
  txHash: string,
): Promise<'accepted' | 'rejected'> {
  console.log(`  Waiting for tx ${txHash}...`);
  const receipt = await getProvider().waitForTransaction(txHash);
  if (receipt.isReverted()) {
    console.log('  TX REVERTED:', JSON.stringify(receipt.value, null, 2));
    return 'rejected';
  }
  if (receipt.isSuccess()) {
    console.log(
      '  TX accepted, block:',
      (receipt.value as any).block_number,
    );
    return 'accepted';
  }
  return 'rejected';
}

export function formatStrk(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = wei % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, '0').slice(0, 6);
  return `${whole}.${fracStr} STRK`;
}

// Re-exports
export {
  ONEKEY_ACCOUNT_CLASS_HASH,
  PRIVACY_POOL_ADDRESS,
  STRK_TOKEN_ADDRESS,
  AVNU_API_KEY,
  PROVING_SERVICE_URL,
  ScriptType,
};
