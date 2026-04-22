/**
 * Contract addresses and configuration for the OneKey Bitcoin signer.
 */

type HexString = `0x${string}`;

// ── Account contract ──────────────────────────────────────────────
// Replace after running `scarb build` + `sncast declare`.
// Composed defenses: chain_id mixing in the Poseidon preimage (cross-chain
// replay) + "STARKNET_ONEKEY_V1:" prefix inside the Bitcoin-signed-message
// wrap (cross-domain replay against BIP-137/BIP-322-simple key reuse).
export const ONEKEY_ACCOUNT_CLASS_HASH: HexString =
  '0x3fd1bc69954e31b8e0f8c934c530f13510716619f5d080b619563d9615e7eec';

// ── Privacy pool (Sepolia) ────────────────────────────────────────
export const PRIVACY_POOL_ADDRESS: HexString =
  '0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91';

// ── Tokens ────────────────────────────────────────────────────────
export const STRK_TOKEN_ADDRESS: HexString =
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

// ── Environment ───────────────────────────────────────────────────
export const STARKNET_RPC_URL = process.env.STARKNET_RPC_URL || '';
export const AVNU_PAYMASTER_URL = process.env.AVNU_PAYMASTER_URL || '';
export const AVNU_API_KEY = process.env.AVNU_API_KEY || '';
export const PROVING_SERVICE_URL = process.env.PROVING_SERVICE_URL || '';

// ── Starknet constants ────────────────────────────────────────────
export const EC_ORDER =
  0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2fn;
export const MAX_PRIVATE_KEY = EC_ORDER / 2n - 1n;

// ── OneKey / Trezor script types ──────────────────────────────────
export enum ScriptType {
  /** P2PKH (legacy) — byte0 offset +0 */
  P2PKH = 0,
  /** P2SH-P2WPKH (nested segwit) — byte0 offset +4 */
  P2SH_SEGWIT = 4,
  /** P2WPKH (native segwit) — byte0 offset +8 */
  NATIVE_SEGWIT = 8,
}
