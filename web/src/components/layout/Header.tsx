import { CopyableHash } from '../shared/CopyableHash';
import { STARKNET_SEPOLIA_EXPLORER } from '../../config/constants';

interface HeaderProps {
  connected: boolean;
  address: string;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function Header({ connected, address, onConnect, onDisconnect }: HeaderProps) {
  return (
    <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">SNIP-36 Privacy Pool</h1>
        <span className="text-xs px-2 py-0.5 rounded bg-indigo-900/50 text-indigo-300">Sepolia</span>
        <span className="text-xs px-2 py-0.5 rounded bg-amber-900/50 text-amber-300">OneKey</span>
      </div>
      <div className="flex items-center gap-3">
        {connected ? (
          <>
            <span className="flex items-center gap-1.5 text-sm text-green-400">
              <span className="w-2 h-2 rounded-full bg-green-400" />
              OneKey
            </span>
            <CopyableHash
              hash={address}
              explorer={`${STARKNET_SEPOLIA_EXPLORER}/contract/${address}`}
            />
            <button
              onClick={onDisconnect}
              className="text-sm text-gray-400 hover:text-gray-200 px-2 py-1 rounded hover:bg-gray-800"
            >
              Disconnect
            </button>
          </>
        ) : (
          <button
            onClick={onConnect}
            className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-medium"
          >
            Connect OneKey
          </button>
        )}
      </div>
    </header>
  );
}
