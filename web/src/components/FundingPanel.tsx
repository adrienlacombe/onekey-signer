import { CopyableHash } from './shared/CopyableHash';
import { STARKNET_SEPOLIA_EXPLORER } from '../config/constants';

function formatStrk(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
  return `${whole}.${frac}`;
}

interface FundingPanelProps {
  address: string;
  balance: bigint;
  onRefresh: () => void;
  onContinue: () => void;
}

export function FundingPanel({ address, balance, onRefresh, onContinue }: FundingPanelProps) {
  return (
    <div className="max-w-lg mx-auto mt-12 p-6 bg-gray-900 rounded-xl border border-gray-800">
      <h2 className="text-xl font-semibold mb-4">Fund Your Account</h2>
      <p className="text-gray-400 text-sm mb-4">
        Send STRK tokens to your account address to start using the privacy pool.
      </p>
      <div className="bg-gray-800 rounded-lg p-4 mb-4">
        <div className="text-xs text-gray-500 mb-1">Your Starknet Address</div>
        <CopyableHash hash={address} explorer={`${STARKNET_SEPOLIA_EXPLORER}/contract/${address}`} />
      </div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="text-xs text-gray-500">STRK Balance</div>
          <div className={`text-lg font-mono ${balance > 0n ? 'text-green-400' : 'text-gray-500'}`}>
            {formatStrk(balance)} STRK
          </div>
        </div>
        <button
          onClick={onRefresh}
          className="text-sm text-indigo-400 hover:text-indigo-300 px-3 py-1.5 rounded-lg border border-indigo-800 hover:border-indigo-600"
        >
          Refresh
        </button>
      </div>
      {balance > 0n ? (
        <button
          onClick={onContinue}
          className="w-full bg-indigo-600 hover:bg-indigo-500 text-white py-2.5 rounded-lg font-medium"
        >
          Continue to Privacy Pool
        </button>
      ) : (
        <div className="text-center text-gray-500 text-sm py-2">Waiting for funds...</div>
      )}
    </div>
  );
}
