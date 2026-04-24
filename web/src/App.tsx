import { useState } from 'react';
import { Header } from './components/layout/Header';
import { FundingPanel } from './components/FundingPanel';
import { PrivacyActions } from './components/PrivacyActions';
import { CopyableHash } from './components/shared/CopyableHash';
import { useOneKey } from './hooks/useOneKey';
import {
  STARKNET_SEPOLIA_EXPLORER,
  ONEKEY_ACCOUNT_CLASS_HASH,
  ONEKEY_SIMULATOR_ENABLED,
  ONEKEY_SIMULATOR_REVIEW_URL,
} from './config/constants';

function formatStrk(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
  return `${whole}.${frac}`;
}

export default function App() {
  const { state, connect, deploy, refreshBalance, disconnect } = useOneKey();
  const [accountIndexInput, setAccountIndexInput] = useState('0');
  const accountIndexValid = /^\d+$/.test(accountIndexInput);
  const selectedAccountIndex = accountIndexValid ? Number(accountIndexInput) : 0;

  const connectSelectedAccount = () => {
    if (!accountIndexValid || !Number.isSafeInteger(selectedAccountIndex)) return;
    void connect(selectedAccountIndex);
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Header
        connected={state.connected}
        address={state.starknetAddress}
        simulatorMode={ONEKEY_SIMULATOR_ENABLED}
        onConnect={connectSelectedAccount}
        onDisconnect={disconnect}
      />

      <main className="flex-1 px-6 py-8">
        {/* Loading overlay */}
        {state.loading && (
          <div className="max-w-lg mx-auto mb-6 bg-indigo-900/30 border border-indigo-800 rounded-lg px-4 py-3 text-sm text-indigo-200 text-center">
            {state.loading}
          </div>
        )}

        {/* Error */}
        {state.error && (
          <div className="max-w-lg mx-auto mb-6 bg-red-900/30 border border-red-800 rounded-lg px-4 py-3 text-sm text-red-200">
            {state.error}
          </div>
        )}

        {/* Phase: Connect */}
        {state.phase === 'connect' && !state.loading && (
          <div className="max-w-lg mx-auto mt-24 text-center">
            <div className="text-6xl mb-6">&#x1F511;</div>
            <h2 className="text-2xl font-semibold mb-3">
              {ONEKEY_SIMULATOR_ENABLED ? 'Connect The OneKey Simulator' : 'Connect Your OneKey'}
            </h2>
            <p className="text-gray-400 mb-8">
              {ONEKEY_SIMULATOR_ENABLED ? (
                <>
                  Start the local OneKey simulator, open the review window at{' '}
                  <a
                    className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2"
                    href={ONEKEY_SIMULATOR_REVIEW_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {ONEKEY_SIMULATOR_REVIEW_URL}
                  </a>
                  , and connect the emulator-backed Bitcoin signer.
                </>
              ) : (
                <>
                  Plug in your OneKey hardware wallet, unlock it, and open the Bitcoin app.
                  Your secp256k1 key will be used to derive a Starknet account.
                </>
              )}
            </p>
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-6 text-left">
              <label className="text-xs text-gray-500 block mb-2" htmlFor="account-index">
                Bitcoin account index
              </label>
              <div className="grid grid-cols-[44px_1fr_44px] gap-2">
                <button
                  type="button"
                  aria-label="Decrease account index"
                  onClick={() => setAccountIndexInput(String(Math.max(selectedAccountIndex - 1, 0)))}
                  className="bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-lg leading-none"
                >
                  -
                </button>
                <input
                  id="account-index"
                  type="number"
                  min="0"
                  step="1"
                  value={accountIndexInput}
                  onChange={(event) => setAccountIndexInput(event.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm w-full font-mono text-center"
                />
                <button
                  type="button"
                  aria-label="Increase account index"
                  onClick={() => setAccountIndexInput(String(selectedAccountIndex + 1))}
                  className="bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-lg leading-none"
                >
                  +
                </button>
              </div>
              <div className="text-xs text-gray-500 font-mono mt-2">
                m/44'/0'/0'/0/{accountIndexValid ? selectedAccountIndex : '?'}
              </div>
              {!accountIndexValid && (
                <div className="text-xs text-red-300 mt-2">Enter a non-negative integer.</div>
              )}
            </div>
            <button
              onClick={connectSelectedAccount}
              disabled={!accountIndexValid || !Number.isSafeInteger(selectedAccountIndex)}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-8 py-3 rounded-xl text-lg font-medium"
            >
              {ONEKEY_SIMULATOR_ENABLED ? 'Connect OneKey Simulator' : 'Connect OneKey Bitcoin'}
            </button>
            <p className="text-xs text-gray-600 mt-4">
              Class hash: {ONEKEY_ACCOUNT_CLASS_HASH.slice(0, 16)}...
            </p>
          </div>
        )}

        {/* Phase: Deploy */}
        {state.phase === 'deploy' && (
          <div className="max-w-lg mx-auto mt-12 p-6 bg-gray-900 rounded-xl border border-gray-800">
            <h2 className="text-xl font-semibold mb-4">Deploy Account</h2>
            <div className="bg-gray-800 rounded-lg p-4 mb-4">
              <div className="text-xs text-gray-500 mb-1">Derived Starknet Address</div>
              <CopyableHash
                hash={state.starknetAddress}
                explorer={`${STARKNET_SEPOLIA_EXPLORER}/contract/${state.starknetAddress}`}
              />
            </div>
            <div className="text-sm text-gray-400 mb-4">
              Balance: <span className="font-mono">{formatStrk(state.balance)} STRK</span>
            </div>
            <div className="text-sm text-gray-400 mb-4">
              Account index: <span className="font-mono">{state.accountIndex}</span>
            </div>
            {state.balance === 0n && (
              <p className="text-sm text-amber-400 mb-4">
                Send STRK to the address above first (needed for deployment gas), then click Deploy.
              </p>
            )}
            <div className="flex gap-3">
              <button
                onClick={deploy}
                disabled={!!state.loading}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-6 py-2.5 rounded-lg font-medium"
              >
                Deploy Account
              </button>
              <button
                onClick={refreshBalance}
                className="text-indigo-400 hover:text-indigo-300 px-4 py-2.5 rounded-lg border border-indigo-800 hover:border-indigo-600 text-sm"
              >
                Refresh Balance
              </button>
            </div>
          </div>
        )}

        {/* Phase: Fund */}
        {state.phase === 'fund' && (
          <FundingPanel
            address={state.starknetAddress}
            balance={state.balance}
            onRefresh={refreshBalance}
            onContinue={() => refreshBalance()}
          />
        )}

        {/* Phase: Interact */}
        {state.phase === 'interact' && state.signer && state.account && (
          <>
            <div className="max-w-2xl mx-auto mb-2">
              <div className="flex items-center justify-between text-sm text-gray-400">
                <span>
                  Balance: <span className="font-mono text-green-400">{formatStrk(state.balance)} STRK</span>
                </span>
                <span>
                  Account index: <span className="font-mono text-gray-300">{state.accountIndex}</span>
                </span>
                <button onClick={refreshBalance} className="text-indigo-400 hover:text-indigo-300 text-xs">
                  Refresh
                </button>
              </div>
            </div>
            <PrivacyActions
              address={state.starknetAddress}
              signer={state.signer}
              account={state.account}
              onRefreshBalance={refreshBalance}
            />
          </>
        )}
      </main>

      <footer className="border-t border-gray-800 px-6 py-3 text-center text-xs text-gray-600">
        SNIP-36 OneKey Bitcoin Signer &mdash; Sepolia Testnet
      </footer>
    </div>
  );
}
