import { useState, useCallback } from 'react';
import {
  RpcProvider,
  Account,
  hash,
  transaction,
  ec,
  selector as selectorUtil,
} from 'starknet';
import { OneKeyHardwareSigner } from '../lib/signer';
import { TxStatus, type TxState } from './shared/TxStatus';
import {
  STARKNET_RPC_URL,
  PRIVACY_POOL_ADDRESS,
  STRK_TOKEN_ADDRESS,
  PROVING_SERVICE_URL,
} from '../config/constants';

function formatStrk(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
  return `${whole}.${frac}`;
}

function toHexStr(v: string | bigint): string {
  if (typeof v === 'string' && v.startsWith('0x')) return v;
  return '0x' + BigInt(v).toString(16);
}

const EC_ORDER = 0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2fn;
const MAX_PRIVATE_KEY = EC_ORDER / 2n - 1n;

interface TxRecord {
  hash: string;
  label: string;
  status: TxState;
}

interface Props {
  address: string;
  pubkeyHash: string;
  signer: OneKeyHardwareSigner;
  account: Account;
  onRefreshBalance: () => void;
}

export function PrivacyActions({ address, pubkeyHash, signer, account, onRefreshBalance }: Props) {
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [txs, setTxs] = useState<TxRecord[]>([]);
  const [depositAmt, setDepositAmt] = useState('0.001');
  const [busy, setBusy] = useState(false);

  const provider = new RpcProvider({ nodeUrl: STARKNET_RPC_URL });

  const addTx = (hash: string, label: string) => {
    setTxs((prev) => [{ hash, label, status: 'pending' }, ...prev]);
  };
  const updateTx = (hash: string, status: TxState) => {
    setTxs((prev) => prev.map((t) => (t.hash === hash ? { ...t, status } : t)));
  };

  const waitTx = async (txHash: string, label: string) => {
    addTx(txHash, label);
    const receipt = await provider.waitForTransaction(txHash);
    const ok = receipt.isSuccess();
    updateTx(txHash, ok ? 'accepted' : 'reverted');
    return ok;
  };

  const derivePrivacyKey = (): string => {
    const raw = ec.starkCurve.poseidonHashMany([BigInt(pubkeyHash), BigInt(address)]);
    const key = (BigInt('0x' + raw.toString(16)) % (MAX_PRIVATE_KEY - 1n)) + 1n;
    return '0x' + key.toString(16);
  };

  const randomFelt = () => {
    const bytes = new Uint8Array(31);
    crypto.getRandomValues(bytes);
    return '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  const generateRandom120 = (): string => {
    const bytes = new Uint8Array(15);
    crypto.getRandomValues(bytes);
    let result = 0n;
    for (const byte of bytes) result = (result << 8n) | BigInt(byte);
    if (result <= 1n) result = 2n;
    return '0x' + result.toString(16);
  };

  // ── Set Viewing Key ──────────────────────────────────────────
  const setViewingKey = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const privacyKey = derivePrivacyKey();
      setStatus('Compiling viewing key action...');
      const clientActions = [address, privacyKey, '1', '0', randomFelt()];
      const serverActions = await provider.callContract({
        contractAddress: PRIVACY_POOL_ADDRESS,
        entrypoint: 'compile_actions',
        calldata: clientActions,
      });

      setStatus('Building proof (this takes ~30s)...');
      const txHash = await proveAndExecute(clientActions, [...serverActions]);
      const ok = await waitTx(txHash, 'Set Viewing Key');
      setStatus(ok ? 'Viewing key set!' : 'Viewing key failed (reverted)');
    } catch (e: any) {
      setError(e.message?.slice(0, 200) || String(e));
      setStatus('');
    } finally {
      setBusy(false);
    }
  }, [address, pubkeyHash]);

  // ── Deposit ──────────────────────────────────────────────────
  const deposit = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const amount = BigInt(Math.round(parseFloat(depositAmt) * 1e18));
      const privacyKey = derivePrivacyKey();

      // Approve
      setStatus('Step 1/3: Approving STRK...');
      const block = await provider.getBlockWithReceipts('latest') as any;
      const l1Price = BigInt(block.l1_gas_price?.price_in_fri ?? '0x400000000000');
      const l1DataPrice = BigInt(block.l1_data_gas_price?.price_in_fri ?? '0x20000');
      const l2Price = BigInt(block.l2_gas_price?.price_in_fri ?? '0x4000000000');

      const approveTx = await account.execute(
        [{ contractAddress: STRK_TOKEN_ADDRESS, entrypoint: 'approve', calldata: [PRIVACY_POOL_ADDRESS, amount.toString(), '0'] }],
        { resourceBounds: {
          l1_gas: { max_amount: 0x200n, max_price_per_unit: l1Price * 2n },
          l2_gas: { max_amount: 0x2000000n, max_price_per_unit: l2Price * 2n },
          l1_data_gas: { max_amount: 0x200n, max_price_per_unit: l1DataPrice * 2n },
        }},
      );
      await waitTx(approveTx.transaction_hash, 'Approve STRK');

      // Build deposit+withdraw actions (first-run pattern)
      setStatus('Step 2/3: Building proof...');
      const clientActions = [
        address, privacyKey, '3',
        '1', address, '0', randomFelt(), randomFelt(),
        '5', STRK_TOKEN_ADDRESS, amount.toString(),
        '7', address, STRK_TOKEN_ADDRESS, amount.toString(), randomFelt(),
      ];
      const serverActions = await provider.callContract({
        contractAddress: PRIVACY_POOL_ADDRESS,
        entrypoint: 'compile_actions',
        calldata: clientActions,
      });

      setStatus('Step 3/3: Proving and submitting...');
      const txHash = await proveAndExecute(clientActions, [...serverActions]);
      const ok = await waitTx(txHash, `Deposit ${depositAmt} STRK`);
      setStatus(ok ? 'Deposit confirmed!' : 'Deposit failed');
      onRefreshBalance();
    } catch (e: any) {
      setError(e.message?.slice(0, 200) || String(e));
      setStatus('');
    } finally {
      setBusy(false);
    }
  }, [address, pubkeyHash, depositAmt, account]);

  // ── Prove and Execute ────────────────────────────────────────
  async function proveAndExecute(clientActions: string[], serverActions: string[]): Promise<string> {
    const chainId = await provider.getChainId();
    const latestBlock = await provider.getBlockNumber();
    const proveBlock = latestBlock - 20;
    const poolNonce = await provider.getNonceForAddress(PRIVACY_POOL_ADDRESS, proveBlock as any);
    const poolNonceHex = poolNonce.startsWith('0x') ? poolNonce : '0x' + BigInt(poolNonce).toString(16);
    const innerCalldata = clientActions.map(toHexStr);
    const clientCalldata = [
      '0x1', PRIVACY_POOL_ADDRESS,
      selectorUtil.getSelectorFromName('compile_actions'),
      '0x' + innerCalldata.length.toString(16),
      ...innerCalldata,
    ];

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
      resourceBounds: {
        l1_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
        l2_gas: { max_amount: 0x20000000n, max_price_per_unit: 0x0n },
        l1_data_gas: { max_amount: 0x0n, max_price_per_unit: 0x0n },
      },
      tip: 0n,
    });

    const signature = await signer.signHash(txHash);

    const proveRes = await fetch(PROVING_SERVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'starknet_proveTransaction',
        params: {
          block_id: { block_number: proveBlock },
          transaction: {
            type: 'INVOKE', version: '0x3',
            sender_address: PRIVACY_POOL_ADDRESS,
            calldata: clientCalldata,
            signature: Array.isArray(signature) ? signature : [signature],
            nonce: poolNonceHex,
            resource_bounds: {
              l1_gas: { max_amount: '0x0', max_price_per_unit: '0x0' },
              l2_gas: { max_amount: '0x20000000', max_price_per_unit: '0x0' },
              l1_data_gas: { max_amount: '0x0', max_price_per_unit: '0x0' },
            },
            tip: '0x0', paymaster_data: [], account_deployment_data: [],
            nonce_data_availability_mode: 'L1', fee_data_availability_mode: 'L1',
          },
        },
        id: 1,
      }),
    });
    const proveResult = await proveRes.json();
    if (proveResult.error) throw new Error(`Proving: ${JSON.stringify(proveResult.error).slice(0, 300)}`);

    const proofFacts = proveResult.result?.proof_facts || proveResult.result?.proofFacts || [];
    const proof = proveResult.result?.proof || '';

    const userNonce = await provider.getNonceForAddress(address);
    const userNonceHex = userNonce.startsWith('0x') ? userNonce : '0x' + BigInt(userNonce).toString(16);
    const block2 = await provider.getBlockWithReceipts('latest') as any;
    const l1P = BigInt(block2.l1_gas_price?.price_in_fri ?? '0x400000000000');
    const l1DP = BigInt(block2.l1_data_gas_price?.price_in_fri ?? '0x20000');
    const l2P = BigInt(block2.l2_gas_price?.price_in_fri ?? '0x4000000000');

    const applyCalldata = transaction
      .getExecuteCalldata([{ contractAddress: PRIVACY_POOL_ADDRESS, entrypoint: 'apply_actions', calldata: serverActions }], '1')
      .map(toHexStr);

    const rb = {
      l1_gas: { max_amount: 0x200n, max_price_per_unit: l1P * 2n },
      l2_gas: { max_amount: 0x8000000n, max_price_per_unit: l2P * 2n },
      l1_data_gas: { max_amount: 0x800n, max_price_per_unit: l1DP * 2n },
    };

    const onchainHash = hash.calculateInvokeTransactionHash({
      senderAddress: address, version: '0x3', compiledCalldata: applyCalldata, chainId,
      nonce: userNonceHex, accountDeploymentData: [], nonceDataAvailabilityMode: 0,
      feeDataAvailabilityMode: 0, paymasterData: [], resourceBounds: rb, tip: 0n,
      proofFacts: proofFacts.map((f: string) => BigInt(f)),
    });

    const onchainSig = await signer.signHash(onchainHash);

    const submitRes = await fetch(STARKNET_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'starknet_addInvokeTransaction',
        params: {
          invoke_transaction: {
            type: 'INVOKE', version: '0x3', sender_address: address,
            calldata: applyCalldata, signature: onchainSig, nonce: userNonceHex,
            resource_bounds: {
              l1_gas: { max_amount: toHexStr(rb.l1_gas.max_amount.toString()), max_price_per_unit: toHexStr(rb.l1_gas.max_price_per_unit.toString()) },
              l2_gas: { max_amount: toHexStr(rb.l2_gas.max_amount.toString()), max_price_per_unit: toHexStr(rb.l2_gas.max_price_per_unit.toString()) },
              l1_data_gas: { max_amount: toHexStr(rb.l1_data_gas.max_amount.toString()), max_price_per_unit: toHexStr(rb.l1_data_gas.max_price_per_unit.toString()) },
            },
            tip: '0x0', paymaster_data: [], account_deployment_data: [],
            nonce_data_availability_mode: 'L1', fee_data_availability_mode: 'L1',
            proof_facts: proofFacts, proof,
          },
        },
        id: 1,
      }),
    });
    const submitData = await submitRes.json();
    if (submitData.error) throw new Error(`Submit: ${JSON.stringify(submitData.error).slice(0, 300)}`);
    return submitData.result.transaction_hash;
  }

  return (
    <div className="max-w-2xl mx-auto mt-8 space-y-6">
      {/* Status / Error banners */}
      {status && (
        <div className="bg-indigo-900/30 border border-indigo-800 rounded-lg px-4 py-3 text-sm text-indigo-200">
          {status}
        </div>
      )}
      {error && (
        <div className="bg-red-900/30 border border-red-800 rounded-lg px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {/* Action cards */}
      <div className="grid gap-4">
        {/* Set Viewing Key */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="font-semibold mb-2">1. Set Viewing Key</h3>
          <p className="text-gray-400 text-sm mb-3">Register your deterministic viewing key on the privacy pool.</p>
          <button
            onClick={setViewingKey}
            disabled={busy}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium"
          >
            {busy ? 'Processing...' : 'Set Viewing Key'}
          </button>
        </div>

        {/* Deposit */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="font-semibold mb-2">2. Deposit + Withdraw</h3>
          <p className="text-gray-400 text-sm mb-3">Deposit STRK into the privacy pool and withdraw back (proves the full pipeline).</p>
          <div className="flex gap-3 items-end">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Amount (STRK)</label>
              <input
                type="text"
                value={depositAmt}
                onChange={(e) => setDepositAmt(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm w-32 font-mono"
              />
            </div>
            <button
              onClick={deposit}
              disabled={busy}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium"
            >
              {busy ? 'Processing...' : 'Deposit + Withdraw'}
            </button>
          </div>
        </div>
      </div>

      {/* TX History */}
      {txs.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="font-semibold mb-3">Transaction History</h3>
          <div className="space-y-1">
            {txs.map((tx) => (
              <TxStatus key={tx.hash} txHash={tx.hash} status={tx.status} label={tx.label} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
