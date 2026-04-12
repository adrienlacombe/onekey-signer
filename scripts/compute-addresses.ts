import { getUncompressedPubKey, pubkeyToPoseidonHash, calculateAccountAddress } from '../src/signer.js';
import { ONEKEY_ACCOUNT_CLASS_HASH } from '../src/constants.js';

const KEY_A = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const KEY_B = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

for (const [name, key] of [['A', KEY_A], ['B', KEY_B]]) {
  const pub = getUncompressedPubKey(key);
  const hash = pubkeyToPoseidonHash(pub);
  const addr = calculateAccountAddress(hash, ONEKEY_ACCOUNT_CLASS_HASH);
  console.log(`Wallet ${name}:`);
  console.log(`  pubkeyHash: ${hash}`);
  console.log(`  address:    ${addr}`);
}
