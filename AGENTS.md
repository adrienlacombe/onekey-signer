# AGENTS

This file is for coding agents working in this repository. It documents the repo-specific behavior that is easy to miss if you only read the code surface.

## Repo Shape

- `contracts/`: Cairo Starknet account contract
- `src/`: shared signer and account utilities used by scripts, tests, and the web app
- `scripts/`: simulator bootstrap and launcher scripts
- `test/`: Sepolia E2E flows
- `web/`: React demo app and dev-only simulator transport

## Install And Build

Use both Node workspaces:

```bash
npm install
cd web && npm install
```

Common verification commands:

```bash
npm run build:contracts
npm run test:setup
npm run test:deposit
npm run test:transfer
npm run test:withdraw
npm run test:all
cd web && npm run build
```

## Environment Files

Root env lives in `.env`. Frontend env lives in `web/.env`.

Backend/service values that must usually be present:

- `STARKNET_RPC_URL`
- `AVNU_API_KEY`
- `AVNU_PAYMASTER_URL`
- `PROVING_SERVICE_URL`
- `DISCOVERY_SERVICE_URL`

Simulator-related root env:

- `ONEKEY_EMULATOR`
- `ONEKEY_EMULATOR_MNEMONIC`
- `ONEKEY_EMULATOR_ACCOUNT_A`
- `ONEKEY_EMULATOR_ACCOUNT_B`
- `ONEKEY_SIMULATOR_MODEL`

Frontend simulator env:

- `VITE_ONEKEY_SIMULATOR`
- `VITE_ONEKEY_SIMULATOR_API_BASE`
- `VITE_ONEKEY_SIMULATOR_CONTAINER`
- `VITE_ONEKEY_SIMULATOR_REVIEW_URL`

## Simulator Workflow

Bootstrap once:

```bash
npm run simulator:setup
```

Run either image:

```bash
npm run simulator:pro
npm run simulator:1s
```

Useful URLs:

- noVNC: `http://localhost:6088/vnc.html?host=localhost&port=6088`
- bridge: `http://localhost:21333`
- simulator web app: `http://127.0.0.1:4173`

### Important Simulator Behavior

- Do not assume the active Docker container is always named `onekey-emu-1s`. The dev transport was hardened to auto-detect and recover the running simulator.
- The web simulator transport lives in `web/dev/onekeySimulator.ts`.
- The Vite dev middleware serializes simulator calls, times out stale helpers, kills stuck Python transport processes, and may restart the emulator headlessly.
- The noVNC tab can be stale even when the transport is healthy. If the user reports a dead or black page, a fresh tab is often required.
- The 1S UI path is fragile. If transport works but the UI is black, the X11/VNC stack may be up with no mapped emulator window.

## Web App Behavior

The current simulator-backed flow in the UI is:

1. Connect
2. Set Viewing Key
3. Deposit STRK
4. Withdraw STRK

The old combined `Deposit + Withdraw` flow is gone.

The web app has a `Private Pool Balance` card. That balance is derived from discovery-service note state, not a single on-chain balance field.

### Physical OneKey Transport

- `web/src/lib/onekey.ts` uses `SDK.HardwareSDKLowLevel` with `env: 'webusb'`. Do not revert to `HardwareWebSdk` / `connectSrc` — the low-level transport is what lets the app call `navigator.usb.requestDevice` with the OneKey vendor/product filter and drive the device directly.
- `connectOneKey` authorizes the device via the browser USB chooser, then calls `searchDevices` and falls back to `getFeatures` to recover `deviceId` when the search result omits it.
- PIN and passphrase are bound to on-device entry: the global UI event listener auto-responds with `@@ONEKEY_INPUT_PIN_IN_DEVICE` for `ui-request_pin` and `{ passphraseOnDevice: true, value: '' }` for passphrase requests. The app must never prompt for either in the UI.
- `btcSignMessage` can return the signature as hex or base64; the `decodeSignatureBytes` helper handles both and expects exactly 65 bytes.

## Privacy Pool Integration Pitfalls

- Normalize hex values before comparing addresses or token IDs. Leading-zero mismatches already caused the UI to hide valid STRK notes.
- Do not guess channel or note indices from discovery cursors when constructing privacy-pool actions. Use the on-chain helpers in `web/src/lib/privacyPool.ts`.
- `compile_actions` failures are usually action-construction problems, not simulator transport problems.
- `Set Viewing Key` can legitimately fail on Sepolia if that account already has a non-zero public key registered.
- After accepted deposits or withdrawals, discovery can lag. The UI now polls after successful transactions, but stale local state is still a common debugging angle.
- All reads used to build a proof must be pinned to the same `proveBlock = latest - 20`. That includes `compile_actions`, `get_outgoing_channel_info`, `get_note`, and the pool nonce. `PrivacyActions.tsx` threads `proveBlock` through `compileVariants`, `getNextChannelIndex`, `getNextNoteIndex`, and `proveAndExecute` — keep that invariant if you touch either file.
- Deposits wait for the RPC tip to advance `PROVER_FINALITY_MARGIN` (25) blocks past the approve tx before picking a `proveBlock`. Withdrawals wait until every selected note is visible at `proveBlock` via `get_note`. Both loops surface a `Waiting for the prover to catch up...` status; tune the constants at the top of `PrivacyActions.tsx` if the proving service changes its lag.

## Account Security Invariants

- `pubkey_hash` is set once in the constructor and is intentionally immutable. The contract has no rotation, guardian, or social-recovery path. If this changes, update the README "Account Security Model" section at the same time.
- All four protocol entry points (`__validate__`, `__validate_declare__`, `__validate_deploy__`, `__execute__`) must reject non-zero callers. `_validate_tx` enforces this for the three validate methods; `__execute__` enforces it directly. Keep both guards in place when refactoring.
- `supports_interface` must return true for both ISRC5 and ISRC6. Account discovery tooling probes SRC5 first.

## Signer Domain Separation

- `src/signer.ts` exposes two distinct signing entry points that must not be swapped:
  - `signHash(offchainHash)` — 5-felt OFFCHAIN signature used by `is_valid_signature` and anything that verifies via the contract's generic signature check.
  - `signTransactionHash(txHash)` — 6-felt signature with a trailing transaction marker, used for actual Starknet transaction authorization.
- `PrivacyActions.tsx` calls `signer.signTransactionHash(onchainHash)` when submitting the proof-carrying tx. If you refactor the web signer path, keep the domain split — reverting to `signHash` for transactions will fail account validation.

## Bitcoin Signed Message Prefix (cross-domain replay defense)

Every hash handed to the OneKey is wrapped with a Starknet-specific prefix *inside* the bytes that get Bitcoin-signed. Never bypass it — if the TS prefix and the Cairo prefix ever drift, all signatures start rejecting.

- Magic string: `"STARKNET_ONEKEY_V1:"` (19 bytes, hex `535441524b4e45545f4f4e454b45595f56313a`).
- Inner signed payload: `"STARKNET_ONEKEY_V1:" || hash_32B` → 51 bytes → varint `0x33`.
- Full wrapped payload (what the device double-SHA256s before ECDSA):
  `0x18 || "Bitcoin Signed Message:\n" || 0x33 || "STARKNET_ONEKEY_V1:" || hash_32B`.
- Authoritative constants:
  - Cairo: `contracts/src/bitcoin_signer.cairo` inside `is_valid_bitcoin_signature` (the `msg.append_byte(...)` block).
  - TS local signer (digest built in-process): `STARKNET_AUTH_PREFIX` + `bitcoinMessageDigest` in `src/signer.ts`.
  - TS device/emulator signers (device does the outer wrap): `STARKNET_AUTH_PREFIX_HEX` prepended to `messageHex` in `web/src/lib/signer.ts` and `test/onekey-emulator.ts`.
- This is why a plain Bitcoin-signed-message request to the same BIP44 key can't be replayed as Starknet auth: any other app signs `0x20 || raw_bytes`, we sign `0x33 || "STARKNET_ONEKEY_V1:" || hash` — the double-SHA256 inputs cannot collide.
- Bumping the version suffix (`V1` → `V2`) is a consensus break; it requires redeploying the account class and regenerating addresses.

## E2E Notes

- The Sepolia tests use the emulator for signing, but still derive local bookkeeping keys from `ONEKEY_EMULATOR_MNEMONIC`.
- If the device mnemonic and `ONEKEY_EMULATOR_MNEMONIC` diverge, the test flow should stop on public-key mismatch.
- `test:setup` can fail for lack of STRK on the simulator-derived deployment account. Check account funding before debugging the signer path.

## When Updating Docs Or UX

- Keep `README.md` aligned with the current simulator-backed web flow.
- If you change the simulator transport, update both the README and this file.
- If you change balance handling, document whether the source of truth is on-chain state, discovery-service state, or both.
