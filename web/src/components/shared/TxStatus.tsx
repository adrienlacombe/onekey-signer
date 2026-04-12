import { STARKNET_SEPOLIA_EXPLORER } from '../../config/constants';

export type TxState = 'pending' | 'accepted' | 'reverted';

export function TxStatus({ txHash, status, label }: { txHash: string; status: TxState; label: string }) {
  const color = status === 'accepted' ? 'text-green-400' : status === 'reverted' ? 'text-red-400' : 'text-yellow-400';
  const icon = status === 'accepted' ? 'check' : status === 'reverted' ? 'x' : '...';
  const short = txHash.slice(0, 10) + '...' + txHash.slice(-4);

  return (
    <div className="flex items-center gap-2 text-sm py-1">
      <span className={`${color} font-bold w-4`}>{icon === 'check' ? '\u2713' : icon === 'x' ? '\u2717' : '\u2026'}</span>
      <span className="text-gray-300">{label}</span>
      <a
        href={`${STARKNET_SEPOLIA_EXPLORER}/tx/${txHash}`}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-indigo-400 hover:text-indigo-300"
      >
        {short}
      </a>
    </div>
  );
}
