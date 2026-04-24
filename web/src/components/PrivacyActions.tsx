import { useCallback, useEffect, useState } from 'react';
import { Account, RpcProvider, hash, selector as selectorUtil, transaction } from 'starknet';
import { OneKeyHardwareSigner } from '../lib/signer';
import { TxStatus, type TxState } from './shared/TxStatus';
import {
  DISCOVERY_SERVICE_URL,
  PRIVACY_POOL_ADDRESS,
  PROVING_SERVICE_URL,
  STARKNET_RPC_URL,
  STRK_TOKEN_ADDRESS,
} from '../config/constants';
import {
  computeChannelKey,
  deriveStarkPublicKey,
  discoverPrivatePoolState,
  formatStrk,
  generateRandom120,
  getNextChannelIndex,
  getNextNoteIndex,
  normalizeHex,
  parseStrkInput,
  randomFelt,
  selectNotesForAmount,
  type PrivatePoolNote,
  type PrivatePoolState,
} from '../lib/privacyPool';

type BusyAction = 'set-viewing-key' | 'deposit' | 'withdraw' | null;

interface TxRecord {
  hash: string;
  label: string;
  status: TxState;
}

interface Props {
  address: string;
  signer: OneKeyHardwareSigner;
  account: Account;
  onRefreshBalance: () => void;
}

interface CompiledVariant {
  clientActions: string[];
  serverActions: string[];
}

interface PrivateBalanceSnapshot {
  balance: bigint;
  notes: PrivatePoolNote[];
  registered: boolean;
}

interface ProveContext {
  latestBlock: number;
  proveBlock: number;
}

const provider = new RpcProvider({ nodeUrl: STARKNET_RPC_URL });
const PROVER_BLOCK_LAG = 20;
const PROVER_FINALITY_MARGIN = 25;
const PROVER_POLL_INTERVAL_MS = 3000;
const PROVER_MAX_POLLS = 60;

function toHexStr(value: string | bigint): string {
  if (typeof value === 'string' && value.startsWith('0x')) return value;
  return '0x' + BigInt(value).toString(16);
}

function isZeroFelt(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = value.replace(/^0x/i, '').replace(/^0+/, '');
  return normalized.length === 0;
}

export function PrivacyActions({ address, signer, account, onRefreshBalance }: Props) {
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [txs, setTxs] = useState<TxRecord[]>([]);
  const [depositAmt, setDepositAmt] = useState('0.001');
  const [withdrawAmt, setWithdrawAmt] = useState('0.0005');
  const [withdrawTo, setWithdrawTo] = useState('');
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [viewingKeyRegistered, setViewingKeyRegistered] = useState(false);
  const [privateBalance, setPrivateBalance] = useState(0n);
  const [privateNotes, setPrivateNotes] = useState<PrivatePoolNote[]>([]);
  const [privateStateError, setPrivateStateError] = useState('');
  const [privateBalanceLoading, setPrivateBalanceLoading] = useState(false);

  const busy = busyAction !== null;
  const normalizedStrkAddress = normalizeHex(STRK_TOKEN_ADDRESS);

  const addTx = (txHash: string, label: string) => {
    setTxs((prev) => [{ hash: txHash, label, status: 'pending' }, ...prev]);
  };

  const updateTx = (txHash: string, txStatus: TxState) => {
    setTxs((prev) => prev.map((tx) => (tx.hash === txHash ? { ...tx, status: txStatus } : tx)));
  };

  const waitTx = async (txHash: string, label: string) => {
    addTx(txHash, label);
    const receipt = await provider.waitForTransaction(txHash);
    const ok = receipt.isSuccess();
    updateTx(txHash, ok ? 'accepted' : 'reverted');
    return ok;
  };

  const getProveContext = useCallback(async (): Promise<ProveContext> => {
    const latestBlock = await provider.getBlockNumber();
    return {
      latestBlock,
      proveBlock: Math.max(latestBlock - PROVER_BLOCK_LAG, 0),
    };
  }, []);

  const waitForProverVisibility = useCallback(
    async (targetBlock: number, reason: string): Promise<ProveContext> => {
      for (let attempt = 0; attempt < PROVER_MAX_POLLS; attempt += 1) {
        const context = await getProveContext();
        if (context.latestBlock >= targetBlock) {
          return context;
        }
        if (attempt === 0 || attempt % 5 === 0) {
          setStatus(
            `Waiting for the prover to catch up after the recent ${reason} (${context.latestBlock}/${targetBlock})...`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, PROVER_POLL_INTERVAL_MS));
      }

      throw new Error(
        `The proving service is still behind the recent ${reason}. Wait about a minute and try again.`,
      );
    },
    [getProveContext],
  );

  const isNoteVisibleAtBlock = useCallback(async (noteId: string, blockNumber: number): Promise<boolean> => {
    try {
      const note = await provider.callContract(
        {
          contractAddress: PRIVACY_POOL_ADDRESS,
          entrypoint: 'get_note',
          calldata: [noteId],
        },
        blockNumber as any,
      );
      return note[0] !== '0x0' && note[0] !== '0';
    } catch {
      return false;
    }
  }, []);

  const waitForNotesVisibleToProver = useCallback(
    async (notes: PrivatePoolNote[]): Promise<ProveContext> => {
      for (let attempt = 0; attempt < PROVER_MAX_POLLS; attempt += 1) {
        const context = await getProveContext();
        const visible = await Promise.all(notes.map((note) => isNoteVisibleAtBlock(note.id, context.proveBlock)));
        if (visible.every(Boolean)) {
          return context;
        }
        if (attempt === 0 || attempt % 5 === 0) {
          setStatus('Waiting for the prover to catch up to recent private notes...');
        }
        await new Promise((resolve) => setTimeout(resolve, PROVER_POLL_INTERVAL_MS));
      }

      throw new Error(
        'Recent private notes are not visible to the proving service yet. Wait about a minute and try again.',
      );
    },
    [getProveContext, isNoteVisibleAtBlock],
  );

  const isAccountVisibleAtBlock = useCallback(async (blockNumber: number): Promise<boolean> => {
    try {
      const classHash = await provider.getClassHashAt(address, blockNumber as any);
      return !isZeroFelt(classHash);
    } catch {
      return false;
    }
  }, [address]);

  const waitForAccountVisibleToProver = useCallback(async (): Promise<ProveContext> => {
    for (let attempt = 0; attempt < PROVER_MAX_POLLS; attempt += 1) {
      const context = await getProveContext();
      if (await isAccountVisibleAtBlock(context.proveBlock)) {
        return context;
      }
      if (attempt === 0 || attempt % 5 === 0) {
        setStatus('Waiting for the prover to catch up to this account deployment...');
      }
      await new Promise((resolve) => setTimeout(resolve, PROVER_POLL_INTERVAL_MS));
    }

    throw new Error(
      'The proving service is still behind this account deployment. Wait about a minute and try again.',
    );
  }, [getProveContext, isAccountVisibleAtBlock]);

  const getViewingKey = useCallback(async (): Promise<string> => {
    const result = await provider.callContract({
      contractAddress: PRIVACY_POOL_ADDRESS,
      entrypoint: 'get_public_key',
      calldata: [address],
    });
    return result[0] ?? '0x0';
  }, [address]);

  const getPrivacyKey = useCallback(async (): Promise<string> => {
    const chainId = await provider.getChainId();
    return signer.derivePrivacyKey({
      chainId: String(chainId),
      poolAddress: PRIVACY_POOL_ADDRESS,
      accountAddress: address,
    });
  }, [address, signer]);

  const assertViewingKeyMatches = useCallback(
    (publicViewingKey: string, privacyKey: string) => {
      const expectedPublicViewingKey = deriveStarkPublicKey(privacyKey);
      if (BigInt(publicViewingKey) !== BigInt(expectedPublicViewingKey)) {
        throw new Error(
          [
            'The on-chain viewing key for this address does not match the current OneKey-derived key.',
            'The pool does not support rotating an already registered viewing key, so this account cannot safely use the private pool with the current device/account.',
            `Expected ${normalizeHex(expectedPublicViewingKey)}, found ${normalizeHex(publicViewingKey)}.`,
          ].join(' '),
        );
      }
    },
    [],
  );

  const loadPrivatePoolState = useCallback(async (): Promise<{
    poolState: PrivatePoolState;
    privacyKey: string;
    publicViewingKey: string;
  }> => {
    if (!DISCOVERY_SERVICE_URL) {
      throw new Error('Discovery service URL is not configured.');
    }

    const publicViewingKey = await getViewingKey();
    if (isZeroFelt(publicViewingKey)) {
      throw new Error('Set the viewing key before using privacy actions.');
    }

    const privacyKey = await getPrivacyKey();
    assertViewingKeyMatches(publicViewingKey, privacyKey);
    const poolState = await discoverPrivatePoolState({
      address,
      apiUrl: DISCOVERY_SERVICE_URL,
      poolAddress: PRIVACY_POOL_ADDRESS,
      tokenAddress: STRK_TOKEN_ADDRESS,
      viewingKey: privacyKey,
    });

    return { poolState, privacyKey, publicViewingKey };
  }, [address, assertViewingKeyMatches, getPrivacyKey, getViewingKey]);

  const fetchPrivateBalanceSnapshot = useCallback(async (): Promise<PrivateBalanceSnapshot> => {
    const publicViewingKey = await getViewingKey();
    const registered = !isZeroFelt(publicViewingKey);

    if (!registered) {
      return { balance: 0n, notes: [], registered };
    }

    if (!DISCOVERY_SERVICE_URL) {
      throw new Error('Discovery service URL is not configured.');
    }

    const privacyKey = await getPrivacyKey();
    assertViewingKeyMatches(publicViewingKey, privacyKey);
    const poolState = await discoverPrivatePoolState({
      address,
      apiUrl: DISCOVERY_SERVICE_URL,
      poolAddress: PRIVACY_POOL_ADDRESS,
      tokenAddress: STRK_TOKEN_ADDRESS,
      viewingKey: privacyKey,
    });

    return {
      balance: poolState.notes.reduce((sum, note) => sum + note.amount, 0n),
      notes: poolState.notes,
      registered,
    };
  }, [address, assertViewingKeyMatches, getPrivacyKey, getViewingKey]);

  const refreshPrivateBalance = useCallback(
    async (silent: boolean = false) => {
      setPrivateBalanceLoading(true);
      if (!silent) setPrivateStateError('');

      try {
        const snapshot = await fetchPrivateBalanceSnapshot();
        setViewingKeyRegistered(snapshot.registered);
        setPrivateNotes(snapshot.notes);
        setPrivateBalance(snapshot.balance);
        return snapshot;
      } catch (e: any) {
        if (!silent) {
          setPrivateStateError(e.message || String(e));
        }
        return null;
      } finally {
        setPrivateBalanceLoading(false);
      }
    },
    [fetchPrivateBalanceSnapshot],
  );

  const waitForPrivateBalanceChange = useCallback(
    async (
      direction: 'increase' | 'decrease',
      baselineBalance: bigint,
    ): Promise<PrivateBalanceSnapshot | null> => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const snapshot = await refreshPrivateBalance(true);
        if (snapshot) {
          if (direction === 'increase' && snapshot.balance > baselineBalance) {
            setPrivateStateError('');
            return snapshot;
          }
          if (direction === 'decrease' && snapshot.balance < baselineBalance) {
            setPrivateStateError('');
            return snapshot;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      return refreshPrivateBalance(false);
    },
    [refreshPrivateBalance],
  );

  useEffect(() => {
    void refreshPrivateBalance(true);
  }, [refreshPrivateBalance]);

  const compileVariants = useCallback(
    async (
      privacyKey: string,
      variants: string[][][],
      blockIdentifier?: number,
    ): Promise<CompiledVariant> => {
      let lastError: unknown = null;

      for (const variant of variants) {
        const clientActions = [address, privacyKey, variant.length.toString(), ...variant.flat()];
        try {
          const serverActions = [
            ...(await provider.callContract({
              contractAddress: PRIVACY_POOL_ADDRESS,
              entrypoint: 'compile_actions',
              calldata: clientActions,
            }, blockIdentifier)),
          ];
          return { clientActions, serverActions };
        } catch (e) {
          lastError = e;
        }
      }

      throw lastError instanceof Error ? lastError : new Error('Failed to compile privacy actions.');
    },
    [address],
  );

  const setViewingKey = useCallback(async () => {
    setBusyAction('set-viewing-key');
    setError('');

    try {
      const existingViewingKey = await getViewingKey();
      if (!isZeroFelt(existingViewingKey)) {
        const privacyKey = await getPrivacyKey();
        assertViewingKeyMatches(existingViewingKey, privacyKey);
        setViewingKeyRegistered(true);
        setStatus('Viewing key already set on-chain for this address.');
        void refreshPrivateBalance(true);
        return;
      }

      setStatus('Deriving viewing key from OneKey...');
      const privacyKey = await getPrivacyKey();
      const { proveBlock } = await waitForAccountVisibleToProver();
      setStatus('Compiling viewing key action...');

      const clientActions = [address, privacyKey, '1', '0', randomFelt()];
      const serverActions = await provider.callContract(
        {
          contractAddress: PRIVACY_POOL_ADDRESS,
          entrypoint: 'compile_actions',
          calldata: clientActions,
        },
        proveBlock as any,
      );

      setStatus('Building proof (this takes ~30s)...');
      const txHash = await proveAndExecute(clientActions, [...serverActions], proveBlock);
      const ok = await waitTx(txHash, 'Set Viewing Key');

      if (ok) {
        setViewingKeyRegistered(true);
        setStatus('Viewing key set!');
        void refreshPrivateBalance(true);
      } else {
        setStatus('Viewing key failed (reverted)');
      }
    } catch (e: any) {
      setError(e.message || String(e));
      setStatus('');
    } finally {
      setBusyAction(null);
    }
  }, [address, assertViewingKeyMatches, getPrivacyKey, getViewingKey, refreshPrivateBalance, waitForAccountVisibleToProver]);

  const deposit = useCallback(async () => {
    setBusyAction('deposit');
    setError('');

    try {
      const privateBalanceBefore = privateBalance;
      const amount = parseStrkInput(depositAmt);
      const { privacyKey, publicViewingKey } = await loadPrivatePoolState();

      setStatus('Step 1/4: Approving STRK...');
      const block = (await provider.getBlockWithReceipts('latest')) as any;
      const l1Price = BigInt(block.l1_gas_price?.price_in_fri ?? '0x400000000000');
      const l1DataPrice = BigInt(block.l1_data_gas_price?.price_in_fri ?? '0x20000');
      const l2Price = BigInt(block.l2_gas_price?.price_in_fri ?? '0x4000000000');

      const approveTx = await account.execute(
        [
          {
            contractAddress: STRK_TOKEN_ADDRESS,
            entrypoint: 'approve',
            calldata: [PRIVACY_POOL_ADDRESS, amount.toString(), '0'],
          },
        ],
        {
          resourceBounds: {
            l1_gas: { max_amount: 0x200n, max_price_per_unit: l1Price * 2n },
            l2_gas: { max_amount: 0x2000000n, max_price_per_unit: l2Price * 2n },
            l1_data_gas: { max_amount: 0x200n, max_price_per_unit: l1DataPrice * 2n },
          },
        },
      );
      const approveOk = await waitTx(approveTx.transaction_hash, 'Approve STRK');
      if (!approveOk) {
        setStatus('Approve failed');
        return;
      }

      const approvalSeenAt = await provider.getBlockNumber();
      const { proveBlock } = await waitForProverVisibility(
        approvalSeenAt + PROVER_FINALITY_MARGIN,
        'approval',
      );

      setStatus('Step 2/4: Building private deposit...');
      const channelKey = computeChannelKey(address, privacyKey, address, publicViewingKey);
      const nextChannelIndex = await getNextChannelIndex(
        provider,
        PRIVACY_POOL_ADDRESS,
        address,
        privacyKey,
        proveBlock,
      );
      const nextNoteIndex = await getNextNoteIndex(
        provider,
        PRIVACY_POOL_ADDRESS,
        channelKey,
        normalizedStrkAddress,
        proveBlock,
      );
      const selfChannelExists = nextChannelIndex > 0;

      const openChannelAction = ['1', address, nextChannelIndex.toString(), randomFelt(), randomFelt()];
      const openSubchannelAction = [
        '2',
        address,
        publicViewingKey,
        channelKey,
        '0',
        normalizedStrkAddress,
        randomFelt(),
      ];
      const depositAction = ['5', normalizedStrkAddress, amount.toString()];
      const createSelfNoteAction = [
        '3',
        address,
        publicViewingKey,
        normalizedStrkAddress,
        amount.toString(),
        nextNoteIndex.toString(),
        generateRandom120(),
      ];

      const variants: string[][][] = selfChannelExists
        ? [
            [openSubchannelAction, depositAction, createSelfNoteAction],
            [depositAction, createSelfNoteAction],
          ]
        : [
            [openChannelAction, openSubchannelAction, depositAction, createSelfNoteAction],
            [openChannelAction, depositAction, createSelfNoteAction],
            [openSubchannelAction, depositAction, createSelfNoteAction],
            [depositAction, createSelfNoteAction],
          ];

      const { clientActions, serverActions } = await compileVariants(privacyKey, variants, proveBlock);

      setStatus('Step 3/4: Building proof and submitting...');
      const txHash = await proveAndExecute(clientActions, serverActions, proveBlock);
      setStatus('Step 4/4: Waiting for confirmation...');
      const ok = await waitTx(txHash, `Deposit ${depositAmt} STRK`);

      if (ok) {
        setStatus('Deposit confirmed, syncing private balance...');
        onRefreshBalance();
        await waitForPrivateBalanceChange('increase', privateBalanceBefore);
        setStatus('Deposit confirmed!');
      } else {
        setStatus('Deposit failed');
      }
    } catch (e: any) {
      setError(e.message || String(e));
      setStatus('');
    } finally {
      setBusyAction(null);
    }
  }, [
    account,
    address,
    compileVariants,
    depositAmt,
    loadPrivatePoolState,
    normalizedStrkAddress,
    onRefreshBalance,
    privateBalance,
    waitForPrivateBalanceChange,
    waitForProverVisibility,
  ]);

  const withdraw = useCallback(async () => {
    setBusyAction('withdraw');
    setError('');

    try {
      const privateBalanceBefore = privateBalance;
      const amount = parseStrkInput(withdrawAmt);
      const recipient = withdrawTo.trim() ? normalizeHex(withdrawTo.trim()) : address;
      const { poolState, privacyKey, publicViewingKey } = await loadPrivatePoolState();
      const { change, selected } = selectNotesForAmount(poolState.notes, amount);
      const { proveBlock } = await waitForNotesVisibleToProver(selected);

      setStatus('Step 1/3: Preparing private withdrawal...');
      const changeChannelKey = computeChannelKey(address, privacyKey, address, publicViewingKey);
      const nextChannelIndex = await getNextChannelIndex(
        provider,
        PRIVACY_POOL_ADDRESS,
        address,
        privacyKey,
        proveBlock,
      );
      const nextNoteIndex = await getNextNoteIndex(
        provider,
        PRIVACY_POOL_ADDRESS,
        changeChannelKey,
        normalizedStrkAddress,
        proveBlock,
      );
      const selfChannelExists = nextChannelIndex > 0;

      const useNoteActions = selected.map((note) => [
        '6',
        note.channelKey,
        normalizedStrkAddress,
        note.index.toString(),
      ]);
      const withdrawAction = ['7', recipient, normalizedStrkAddress, amount.toString(), randomFelt()];

      const variants: string[][][] = [];
      if (change > 0n) {
        const openChannelAction = [
          '1',
          address,
          nextChannelIndex.toString(),
          randomFelt(),
          randomFelt(),
        ];
        const openSubchannelAction = [
          '2',
          address,
          publicViewingKey,
          changeChannelKey,
          '0',
          normalizedStrkAddress,
          randomFelt(),
        ];
        const createChangeNoteAction = [
          '3',
          address,
          publicViewingKey,
          normalizedStrkAddress,
          change.toString(),
          nextNoteIndex.toString(),
          generateRandom120(),
        ];

        if (!selfChannelExists) {
          variants.push([
            openChannelAction,
            openSubchannelAction,
            ...useNoteActions,
            createChangeNoteAction,
            withdrawAction,
          ]);
          variants.push([openChannelAction, ...useNoteActions, createChangeNoteAction, withdrawAction]);
        }
        variants.push([openSubchannelAction, ...useNoteActions, createChangeNoteAction, withdrawAction]);
        variants.push([...useNoteActions, createChangeNoteAction, withdrawAction]);
      } else {
        variants.push([...useNoteActions, withdrawAction]);
      }

      const { clientActions, serverActions } = await compileVariants(privacyKey, variants, proveBlock);

      setStatus('Step 2/3: Building proof and submitting...');
      const txHash = await proveAndExecute(clientActions, serverActions, proveBlock);
      setStatus('Step 3/3: Waiting for confirmation...');
      const ok = await waitTx(txHash, `Withdraw ${withdrawAmt} STRK`);

      if (ok) {
        setStatus('Withdraw confirmed, syncing private balance...');
        onRefreshBalance();
        await waitForPrivateBalanceChange('decrease', privateBalanceBefore);
        setStatus('Withdraw confirmed!');
      } else {
        setStatus('Withdraw failed');
      }
    } catch (e: any) {
      setError(e.message || String(e));
      setStatus('');
    } finally {
      setBusyAction(null);
    }
  }, [
    address,
    compileVariants,
    loadPrivatePoolState,
    normalizedStrkAddress,
    onRefreshBalance,
    privateBalance,
    waitForPrivateBalanceChange,
    waitForNotesVisibleToProver,
    withdrawAmt,
    withdrawTo,
  ]);

  async function proveAndExecute(
    clientActions: string[],
    serverActions: string[],
    proveBlock: number,
  ): Promise<string> {
    const chainId = await provider.getChainId();
    const poolNonce = await provider.getNonceForAddress(PRIVACY_POOL_ADDRESS, proveBlock as any);
    const poolNonceHex = poolNonce.startsWith('0x') ? poolNonce : '0x' + BigInt(poolNonce).toString(16);
    const innerCalldata = clientActions.map(toHexStr);
    const clientCalldata = [
      '0x1',
      PRIVACY_POOL_ADDRESS,
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
            type: 'INVOKE',
            version: '0x3',
            sender_address: PRIVACY_POOL_ADDRESS,
            calldata: clientCalldata,
            signature: Array.isArray(signature) ? signature : [signature],
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
    const proveResult = await proveRes.json();
    if (proveResult.error) throw new Error(`Proving: ${JSON.stringify(proveResult.error)}`);

    const proofFacts = proveResult.result?.proof_facts || proveResult.result?.proofFacts || [];
    const proof = proveResult.result?.proof || '';

    const userNonce = await provider.getNonceForAddress(address);
    const userNonceHex = userNonce.startsWith('0x') ? userNonce : '0x' + BigInt(userNonce).toString(16);
    const block2 = (await provider.getBlockWithReceipts('latest')) as any;
    const l1P = BigInt(block2.l1_gas_price?.price_in_fri ?? '0x400000000000');
    const l1DP = BigInt(block2.l1_data_gas_price?.price_in_fri ?? '0x20000');
    const l2P = BigInt(block2.l2_gas_price?.price_in_fri ?? '0x4000000000');

    const applyCalldata = transaction
      .getExecuteCalldata(
        [{ contractAddress: PRIVACY_POOL_ADDRESS, entrypoint: 'apply_actions', calldata: serverActions }],
        '1',
      )
      .map(toHexStr);

    const rb = {
      l1_gas: { max_amount: 0x200n, max_price_per_unit: l1P * 2n },
      l2_gas: { max_amount: 0x8000000n, max_price_per_unit: l2P * 2n },
      l1_data_gas: { max_amount: 0x800n, max_price_per_unit: l1DP * 2n },
    };

    const onchainHash = hash.calculateInvokeTransactionHash({
      senderAddress: address,
      version: '0x3',
      compiledCalldata: applyCalldata,
      chainId,
      nonce: userNonceHex,
      accountDeploymentData: [],
      nonceDataAvailabilityMode: 0,
      feeDataAvailabilityMode: 0,
      paymasterData: [],
      resourceBounds: rb,
      tip: 0n,
      proofFacts: proofFacts.map((fact: string) => BigInt(fact)),
    });

    const onchainSig = await signer.signTransactionHash(onchainHash, String(chainId));

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
            sender_address: address,
            calldata: applyCalldata,
            signature: onchainSig,
            nonce: userNonceHex,
            resource_bounds: {
              l1_gas: {
                max_amount: toHexStr(rb.l1_gas.max_amount.toString()),
                max_price_per_unit: toHexStr(rb.l1_gas.max_price_per_unit.toString()),
              },
              l2_gas: {
                max_amount: toHexStr(rb.l2_gas.max_amount.toString()),
                max_price_per_unit: toHexStr(rb.l2_gas.max_price_per_unit.toString()),
              },
              l1_data_gas: {
                max_amount: toHexStr(rb.l1_data_gas.max_amount.toString()),
                max_price_per_unit: toHexStr(rb.l1_data_gas.max_price_per_unit.toString()),
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
    if (submitData.error) throw new Error(`Submit: ${JSON.stringify(submitData.error)}`);
    return submitData.result.transaction_hash;
  }

  return (
    <div className="max-w-2xl mx-auto mt-8 space-y-6">
      {status && (
        <div className="bg-indigo-900/30 border border-indigo-800 rounded-lg px-4 py-3 text-sm text-indigo-200">
          {status}
        </div>
      )}
      {error && (
        <div className="bg-red-900/30 border border-red-800 rounded-lg px-4 py-3 text-red-200 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs uppercase tracking-wide text-red-300/80">Error</span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(error);
              }}
              className="text-xs text-red-300 hover:text-red-100 underline underline-offset-2"
              title="Copy full error to clipboard"
            >
              Copy
            </button>
          </div>
          <pre className="text-xs font-mono whitespace-pre-wrap break-all max-h-96 overflow-auto">
            {error}
          </pre>
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold mb-2">Private Pool Balance</h3>
            <div className="text-2xl font-mono text-indigo-300">
              {privateBalanceLoading ? 'Refreshing...' : `${formatStrk(privateBalance)} STRK`}
            </div>
            <p className="text-gray-500 text-sm mt-1">
              {viewingKeyRegistered
                ? `${privateNotes.length} discoverable note${privateNotes.length === 1 ? '' : 's'}`
                : 'Set the viewing key to discover private notes.'}
            </p>
            {privateStateError && <p className="text-red-300 text-xs mt-2">{privateStateError}</p>}
          </div>
          <button
            onClick={() => void refreshPrivateBalance()}
            disabled={privateBalanceLoading || busy}
            className="text-indigo-400 hover:text-indigo-300 disabled:opacity-50 text-sm border border-indigo-800 hover:border-indigo-600 rounded-lg px-3 py-2"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="grid gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="font-semibold mb-2">1. Set Viewing Key</h3>
          <p className="text-gray-400 text-sm mb-3">
            Register your deterministic viewing key on the privacy pool before discovering or moving
            private notes.
          </p>
          <button
            onClick={setViewingKey}
            disabled={busy}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium"
          >
            {busyAction === 'set-viewing-key' ? 'Processing...' : 'Set Viewing Key'}
          </button>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h3 className="font-semibold mb-2">2. Deposit STRK</h3>
            <p className="text-gray-400 text-sm mb-3">
              Shield STRK into the pool and create a private note for this account.
            </p>
            <label className="text-xs text-gray-500 block mb-1">Amount (STRK)</label>
            <input
              type="text"
              value={depositAmt}
              onChange={(e) => setDepositAmt(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm w-full font-mono mb-3"
            />
            <button
              onClick={deposit}
              disabled={busy || !viewingKeyRegistered}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium w-full"
            >
              {!viewingKeyRegistered
                ? 'Set viewing key first'
                : busyAction === 'deposit'
                  ? 'Processing...'
                  : 'Deposit'}
            </button>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h3 className="font-semibold mb-2">3. Withdraw STRK</h3>
            <p className="text-gray-400 text-sm mb-3">
              Spend existing private notes and unshield STRK to a public Starknet address.
            </p>
            <label className="text-xs text-gray-500 block mb-1">Recipient</label>
            <input
              type="text"
              value={withdrawTo}
              onChange={(e) => setWithdrawTo(e.target.value)}
              placeholder="0x... or leave empty for self"
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm w-full font-mono mb-3"
            />
            <label className="text-xs text-gray-500 block mb-1">Amount (STRK)</label>
            <input
              type="text"
              value={withdrawAmt}
              onChange={(e) => setWithdrawAmt(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm w-full font-mono mb-3"
            />
            <button
              onClick={withdraw}
              disabled={busy || !viewingKeyRegistered || privateBalance === 0n}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium w-full"
            >
              {!viewingKeyRegistered
                ? 'Set viewing key first'
                : busyAction === 'withdraw'
                  ? 'Processing...'
                  : 'Withdraw'}
            </button>
          </div>
        </div>
      </div>

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
