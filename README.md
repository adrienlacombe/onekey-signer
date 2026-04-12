# SNIP-36 OneKey Starknet Account

This repository contains a Starknet account implementation and demo app that derive a Starknet account from a OneKey Bitcoin secp256k1 key and use it with SNIP-36 privacy-pool flows on Starknet Sepolia.

## Repository Layout

- `contracts/`: Cairo contracts and Scarb configuration for the Starknet account.
- `src/`: TypeScript signer and shared constants used by scripts and tests.
- `scripts/`: Utility scripts for address computation and balance checks.
- `test/`: End-to-end flows for deployment, deposit, transfer, and withdraw operations.
- `web/`: Vite + React demo app for connecting a OneKey device and interacting with the account.

## Prerequisites

- Node.js 20+ and npm
- Scarb with Cairo `2.15.0`
- A Starknet Sepolia RPC endpoint
- Optional: a OneKey hardware wallet for the web demo

## Setup

Install dependencies in both JavaScript workspaces:

```bash
npm install
cd web && npm install
```

Create local environment files from the checked-in templates:

```bash
cp .env.example .env
cp web/.env.example web/.env
```

Fill in the required values:

- Root `.env`
  - `STARKNET_RPC_URL`
  - `AVNU_API_KEY`
  - `AVNU_PAYMASTER_URL`
  - `PROVING_SERVICE_URL`
  - `DISCOVERY_SERVICE_URL`
- `web/.env`
  - `VITE_STARKNET_RPC_URL`
  - `VITE_AVNU_API_KEY`
  - `VITE_AVNU_PAYMASTER_URL`
  - `VITE_PROVING_SERVICE_URL`
  - `VITE_DISCOVERY_SERVICE_URL`

## Common Commands

Build the Cairo contracts:

```bash
npm run build:contracts
```

Run the TypeScript end-to-end flows:

```bash
npm run test:setup
npm run test:deposit
npm run test:transfer
npm run test:withdraw
npm run test:all
```

Start the web app:

```bash
cd web
npm run dev
```

Create a production web build:

```bash
cd web
npm run build
```

## Notes

- The repository intentionally ignores local secrets, dependency directories, and generated build output.
- The end-to-end tests target Starknet Sepolia and assume the configured class hash and privacy-pool addresses are valid for that network.
- The demo UI expects a connected OneKey device with the Bitcoin app open.
