import { useState, useCallback } from 'react';
import { RpcProvider, Account } from 'starknet';
import {
  connectOneKey,
  getBtcPublicKey,
  disconnectOneKey,
  isOneKeySimulatorModeEnabled,
} from '../lib/onekey';
import { OneKeyHardwareSigner, pubkeyToPoseidonHash, calculateAccountAddress } from '../lib/signer';
import {
  ONEKEY_ACCOUNT_CLASS_HASH,
  STRK_TOKEN_ADDRESS,
  STARKNET_RPC_URL,
  AVNU_PAYMASTER_URL,
  AVNU_API_KEY,
} from '../config/constants';

export type Phase = 'connect' | 'deploy' | 'fund' | 'interact';

export interface OneKeyState {
  phase: Phase;
  connected: boolean;
  accountIndex: number;
  publicKey: string;
  pubkeyHash: string;
  starknetAddress: string;
  deployed: boolean;
  balance: bigint;
  signer: OneKeyHardwareSigner | null;
  account: Account | null;
  error: string;
  loading: string;
}

function getProvider() {
  return new RpcProvider({ nodeUrl: STARKNET_RPC_URL });
}

function toHexStr(v: string): string {
  if (v.startsWith('0x')) return v;
  return '0x' + BigInt(v).toString(16);
}

export function useOneKey() {
  const [state, setState] = useState<OneKeyState>({
    phase: 'connect',
    connected: false,
    accountIndex: 0,
    publicKey: '',
    pubkeyHash: '',
    starknetAddress: '',
    deployed: false,
    balance: 0n,
    signer: null,
    account: null,
    error: '',
    loading: '',
  });

  const connect = useCallback(async (accountIndex: number = 0) => {
    setState((s) => ({
      ...s,
      loading: isOneKeySimulatorModeEnabled()
        ? 'Connecting to OneKey simulator...'
        : 'Connecting to OneKey...',
      error: '',
    }));
    try {
      await connectOneKey();
      const { publicKey } = await getBtcPublicKey(accountIndex);
      if (!publicKey) throw new Error('Failed to get public key from OneKey');

      const pubkeyHash = pubkeyToPoseidonHash(publicKey);
      const address = calculateAccountAddress(pubkeyHash, ONEKEY_ACCOUNT_CLASS_HASH);
      const signer = new OneKeyHardwareSigner(pubkeyHash, accountIndex);
      const provider = getProvider();
      const account = new Account({ provider, address, signer });

      // Check deployment
      let deployed = false;
      try {
        const ch = await provider.getClassHashAt(address);
        deployed = ch !== '0x0';
      } catch { /* not deployed */ }

      // Check balance
      let balance = 0n;
      try {
        const res = await provider.callContract({
          contractAddress: STRK_TOKEN_ADDRESS,
          entrypoint: 'balanceOf',
          calldata: [address],
        });
        balance = BigInt(res[0] ?? '0') + (BigInt(res[1] ?? '0') << 128n);
      } catch { /* no balance */ }

      const phase: Phase = !deployed ? 'deploy' : balance === 0n ? 'fund' : 'interact';
      setState({
        phase,
        connected: true,
        accountIndex,
        publicKey,
        pubkeyHash,
        starknetAddress: address,
        deployed,
        balance,
        signer,
        account,
        error: '',
        loading: '',
      });
    } catch (e: any) {
      setState((s) => ({ ...s, loading: '', error: e.message || String(e) }));
    }
  }, []);

  const deploy = useCallback(async () => {
    if (!state.starknetAddress || !state.pubkeyHash) return;
    setState((s) => ({ ...s, loading: 'Deploying account...', error: '' }));
    try {
      const provider = getProvider();

      // Try direct deploy if pre-funded
      if (state.balance > 0n && state.signer && state.account) {
        const block = await provider.getBlockWithReceipts('latest') as any;
        const l1Price = BigInt(block.l1_gas_price?.price_in_fri ?? '0x400000000000');
        const l1DataPrice = BigInt(block.l1_data_gas_price?.price_in_fri ?? '0x20000');
        const l2Price = BigInt(block.l2_gas_price?.price_in_fri ?? '0x4000000000');

        const result = await state.account.deployAccount(
          {
            classHash: ONEKEY_ACCOUNT_CLASS_HASH,
            constructorCalldata: [state.pubkeyHash],
            addressSalt: state.pubkeyHash,
          },
          {
            resourceBounds: {
              l1_gas: { max_amount: 0x200n, max_price_per_unit: l1Price * 2n },
              l2_gas: { max_amount: 0x2000000n, max_price_per_unit: l2Price * 2n },
              l1_data_gas: { max_amount: 0x200n, max_price_per_unit: l1DataPrice * 2n },
            },
          },
        );
        await provider.waitForTransaction(result.transaction_hash);
        setState((s) => ({ ...s, deployed: true, phase: s.balance > 0n ? 'interact' : 'fund', loading: '' }));
        return;
      }

      // Try AVNU paymaster
      if (AVNU_PAYMASTER_URL) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (AVNU_API_KEY) headers['x-paymaster-api-key'] = AVNU_API_KEY;

        const res = await fetch(AVNU_PAYMASTER_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'paymaster_executeTransaction',
            params: {
              transaction: {
                type: 'deploy',
                deployment: {
                  address: toHexStr(state.starknetAddress),
                  class_hash: ONEKEY_ACCOUNT_CLASS_HASH,
                  salt: toHexStr(state.pubkeyHash),
                  calldata: [toHexStr(state.pubkeyHash)],
                  version: 1,
                },
              },
              parameters: { version: '0x1', fee_mode: { mode: 'sponsored' } },
            },
            id: 1,
          }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        await provider.waitForTransaction(data.result.transaction_hash);
        setState((s) => ({ ...s, deployed: true, phase: 'fund', loading: '' }));
        return;
      }

      throw new Error('Account needs STRK to deploy (no paymaster configured). Send STRK to your address first.');
    } catch (e: any) {
      setState((s) => ({ ...s, loading: '', error: e.message || String(e) }));
    }
  }, [state.starknetAddress, state.pubkeyHash, state.balance, state.signer, state.account]);

  const refreshBalance = useCallback(async () => {
    if (!state.starknetAddress) return;
    try {
      const provider = getProvider();
      const res = await provider.callContract({
        contractAddress: STRK_TOKEN_ADDRESS,
        entrypoint: 'balanceOf',
        calldata: [state.starknetAddress],
      });
      const balance = BigInt(res[0] ?? '0') + (BigInt(res[1] ?? '0') << 128n);
      setState((s) => {
        const phase = !s.deployed ? 'deploy' : balance === 0n ? 'fund' : 'interact';
        return { ...s, balance, phase };
      });
    } catch { /* ignore */ }
  }, [state.starknetAddress, state.deployed]);

  const disconnect = useCallback(() => {
    disconnectOneKey();
    setState({
      phase: 'connect',
      connected: false,
      accountIndex: 0,
      publicKey: '',
      pubkeyHash: '',
      starknetAddress: '',
      deployed: false,
      balance: 0n,
      signer: null,
      account: null,
      error: '',
      loading: '',
    });
  }, []);

  return { state, connect, deploy, refreshBalance, disconnect };
}
