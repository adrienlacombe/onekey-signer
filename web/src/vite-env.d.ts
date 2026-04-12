/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STARKNET_RPC_URL?: string;
  readonly VITE_AVNU_PAYMASTER_URL?: string;
  readonly VITE_AVNU_API_KEY?: string;
  readonly VITE_PROVING_SERVICE_URL?: string;
  readonly VITE_DISCOVERY_SERVICE_URL?: string;
  readonly VITE_ONEKEY_SIMULATOR?: string;
  readonly VITE_ONEKEY_SIMULATOR_API_BASE?: string;
  readonly VITE_ONEKEY_SIMULATOR_CONTAINER?: string;
  readonly VITE_ONEKEY_SIMULATOR_REVIEW_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
