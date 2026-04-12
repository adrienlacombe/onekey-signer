# SNIP-36 OneKey Starknet Account

This repository contains:

- a Starknet account derived from a OneKey Bitcoin secp256k1 key
- TypeScript E2E flows for Starknet Sepolia
- a React demo app that works with either a physical OneKey device or the local OneKey simulator

## Repository Layout

- `contracts/`: Cairo contracts and Scarb configuration
- `src/`: shared signer and account logic
- `scripts/`: local setup and simulator helpers
- `test/`: Sepolia end-to-end flows
- `web/`: Vite + React demo app

## Prerequisites

- Node.js 20+ and npm
- Scarb with Cairo `2.15.0`
- a Starknet Sepolia RPC endpoint
- AVNU, discovery-service, and proving-service access
- optional: a physical OneKey device if you are not using the simulator

## Initial Setup

Install dependencies:

```bash
npm install
cd web && npm install
```

Create local env files:

```bash
cp .env.example .env
cp web/.env.example web/.env
```

Required root `.env` values:

- `STARKNET_RPC_URL`
- `AVNU_API_KEY`
- `AVNU_PAYMASTER_URL`
- `PROVING_SERVICE_URL`
- `DISCOVERY_SERVICE_URL`

Optional root simulator values:

- `ONEKEY_EMULATOR=1`
- `ONEKEY_EMULATOR_MNEMONIC`
- `ONEKEY_EMULATOR_ACCOUNT_A`
- `ONEKEY_EMULATOR_ACCOUNT_B`
- `ONEKEY_SIMULATOR_MODEL`

Required `web/.env` values:

- `VITE_STARKNET_RPC_URL`
- `VITE_AVNU_API_KEY`
- `VITE_AVNU_PAYMASTER_URL`
- `VITE_PROVING_SERVICE_URL`
- `VITE_DISCOVERY_SERVICE_URL`

Optional `web/.env` simulator values:

- `VITE_ONEKEY_SIMULATOR`
- `VITE_ONEKEY_SIMULATOR_API_BASE`
- `VITE_ONEKEY_SIMULATOR_CONTAINER`
- `VITE_ONEKEY_SIMULATOR_REVIEW_URL`

## Common Commands

Build contracts:

```bash
npm run build:contracts
```

Run Sepolia E2E steps:

```bash
npm run test:setup
npm run test:deposit
npm run test:transfer
npm run test:withdraw
npm run test:all
```

Start the normal web app:

```bash
cd web
npm run dev
```

Start the simulator-backed web app:

```bash
cd web
npm run dev:simulator
```

Build the web app:

```bash
cd web
npm run build
```

## OneKey Simulator

Bootstrap the local simulator checkout:

```bash
npm run simulator:setup
```

Start a simulator image:

```bash
npm run simulator:pro
# or
npm run simulator:1s
```

The setup script clones [`Johnwanzi/onekey-docker`](https://github.com/Johnwanzi/onekey-docker) into `.external/onekey-docker`.

Useful local endpoints:

- OneKey bridge: `http://localhost:21333`
- noVNC landing page: `http://localhost:6088`
- direct noVNC URL: `http://localhost:6088/vnc.html?host=localhost&port=6088`
- simulator-backed web app: `http://127.0.0.1:4173`

Notes:

- The web simulator transport is exposed by Vite at `/__onekey_simulator__` when `npm run dev:simulator` is running.
- The transport no longer depends on a fixed Docker container name at runtime. It will try to recover the active simulator automatically.
- If the noVNC page opens but shows an old failure banner, close the tab completely and reopen it.
- If the device looks black, it may just be a very small OLED window inside the VNC canvas. Use the noVNC scaling controls before assuming the emulator is dead.

## Running E2E Flows Through the Simulator

1. Start the simulator and open the VNC page.
2. Initialize the device with the same mnemonic as `ONEKEY_EMULATOR_MNEMONIC`.
3. Open the Bitcoin app in the simulator.
4. Run the same E2E commands with emulator mode enabled.

Example:

```bash
ONEKEY_EMULATOR=1 npm run test:setup
ONEKEY_EMULATOR=1 npm run test:deposit
ONEKEY_EMULATOR=1 npm run test:transfer
ONEKEY_EMULATOR=1 npm run test:withdraw
```

Simulator mode details:

- Wallet A and Wallet B default to `m/44'/0'/0'/0/0` and `m/44'/0'/0'/0/1`.
- Override them with `ONEKEY_EMULATOR_ACCOUNT_A` and `ONEKEY_EMULATOR_ACCOUNT_B` if needed.
- The test runner still derives local private bookkeeping keys from `ONEKEY_EMULATOR_MNEMONIC`, but the Starknet message hashes are signed by the emulator.
- If the emulator seed does not match `ONEKEY_EMULATOR_MNEMONIC`, the runner stops on the public-key mismatch.
- `test:setup` may require pre-funding the simulator-derived Sepolia account before deployment.

## Web Demo

The demo UI supports both a physical OneKey and the local simulator.

Current simulator UI flow:

1. Connect to the device
2. Set the viewing key once
3. Deposit STRK into the privacy pool
4. Withdraw STRK from the privacy pool

The UI also shows a `Private Pool Balance` card.

Notes about balance and discovery:

- The private balance is sourced from the discovery service, not from a single on-chain balance slot.
- After a deposit or withdraw is accepted, the UI may need a short polling window before the updated private notes appear.
- If the balance looks stale, hard-refresh the app and use the balance refresh control.

## Troubleshooting

- `compile_actions` reverts are privacy-pool action construction failures, not simulator transport failures.
- If `Set Viewing Key` fails for an already initialized account, check whether the account already has a viewing key on Sepolia.
- If the simulator transport reports timeouts or empty output, restart the web dev server and reopen the noVNC tab before assuming the bridge is broken.

## Notes

- The repository ignores local secrets, generated artifacts, and the external simulator checkout.
- The E2E flows target Starknet Sepolia and assume the configured deployed contracts and backend services are valid for that network.
