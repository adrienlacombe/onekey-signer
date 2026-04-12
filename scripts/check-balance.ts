import 'dotenv/config';
import { RpcProvider } from 'starknet';

const RPC = process.env.STARKNET_RPC_URL || '';
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const ADDR_A = '0x0635642a119e1bbe07605cfc12dc9fe839235dda1130334aae5d8148851a7280';

async function main() {
  const provider = new RpcProvider({ nodeUrl: RPC });

  console.log('Waiting for funding tx...');
  const receipt = await provider.waitForTransaction('0x04a6cf3a78cdc678fbd2a1811296b8cd9af62ecf73591036bdd547cad0060014');
  console.log('TX status:', receipt.isSuccess() ? 'accepted' : 'failed');

  const result = await provider.callContract({
    contractAddress: STRK,
    entrypoint: 'balanceOf',
    calldata: [ADDR_A],
  });
  const balance = BigInt(result[0] ?? '0') + (BigInt(result[1] ?? '0') << 128n);
  console.log('Wallet A balance:', (balance / 10n**18n).toString() + '.' + (balance % 10n**18n).toString().padStart(18, '0').slice(0,4) + ' STRK');
}
main();
