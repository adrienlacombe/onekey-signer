export const ONEKEY_ACCOUNT_CLASS_HASH =
  '0x3dce7815393031793b8f728a628e069c7abb232d11639ab01a516b431e0246b';

export const PRIVACY_POOL_ADDRESS =
  '0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91';

export const STRK_TOKEN_ADDRESS =
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

export const STARKNET_RPC_URL = import.meta.env.VITE_STARKNET_RPC_URL || '';
export const AVNU_PAYMASTER_URL = import.meta.env.VITE_AVNU_PAYMASTER_URL || '';
export const AVNU_API_KEY = import.meta.env.VITE_AVNU_API_KEY || '';
export const PROVING_SERVICE_URL = import.meta.env.VITE_PROVING_SERVICE_URL || '';
export const DISCOVERY_SERVICE_URL = import.meta.env.VITE_DISCOVERY_SERVICE_URL || '';
export const ONEKEY_SIMULATOR_ENABLED = /^(1|true|yes|on)$/i.test(
  import.meta.env.VITE_ONEKEY_SIMULATOR || '',
);
export const ONEKEY_SIMULATOR_API_BASE =
  import.meta.env.VITE_ONEKEY_SIMULATOR_API_BASE || '/__onekey_simulator__';
export const ONEKEY_SIMULATOR_REVIEW_URL =
  import.meta.env.VITE_ONEKEY_SIMULATOR_REVIEW_URL || 'http://localhost:6088';
export const STARKNET_SEPOLIA_EXPLORER = 'https://sepolia.voyager.online';

export function getBtcDerivationPath(accountIndex: number): string {
  return `m/44'/0'/0'/0/${accountIndex}`;
}
