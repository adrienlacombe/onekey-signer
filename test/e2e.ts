/**
 * E2E Integration Tests for SNIP-36 Privacy Pool (OneKey Bitcoin signer)
 *
 * Run:  npx tsx test/e2e.ts [step]
 *
 * Steps:
 *   setup    — deploy accounts A and B (all 3 script types tested)
 *   deposit  — A: deposit + withdraw to self via privacy pool
 *   transfer — A → B: private transfer via CreateEncNote
 *   withdraw — A: standalone withdraw from privacy pool
 *   all      — setup + deposit + transfer
 *
 * Requires .env with:
 *   STARKNET_RPC_URL, AVNU_API_KEY, PROVING_SERVICE_URL
 *
 * The contract class hash must be declared on Sepolia and set in
 * src/constants.ts (ONEKEY_ACCOUNT_CLASS_HASH) before running.
 */
import 'dotenv/config';
import {
  extractPubKeyCoords,
  deployViaPaymaster,
  deployAccountDirect,
  isDeployed,
  getStrkBalance,
  waitForTx,
  derivePrivacyKey,
  signAndExecuteInvoke,
  directInvoke,
  proveAndExecute,
  formatStrk,
  getProvider,
  deriveStarkPublicKey,
  computeChannelKey,
  generateRandom120,
  getNextChannelIndex,
  getNextNoteIndex,
  ONEKEY_ACCOUNT_CLASS_HASH,
  PRIVACY_POOL_ADDRESS,
  STRK_TOKEN_ADDRESS,
  AVNU_API_KEY,
  PROVING_SERVICE_URL,
  ScriptType,
} from './e2e-helpers.js';
import {
  signBitcoinMessage,
  decodeCompactSignature,
} from '../src/signer.js';
import {
  ONEKEY_EMULATOR_REVIEW_URL,
  createConfiguredTestWallet,
  isOneKeyEmulatorEnabled,
  type ConfiguredTestWallet,
} from './onekey-emulator.js';

// ============================================================
// Default local test private keys — used when ONEKEY_EMULATOR is not enabled
// ============================================================
const DEFAULT_TEST_PRIVATE_KEY_A =
  'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DEFAULT_TEST_PRIVATE_KEY_B =
  '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

let walletA: ConfiguredTestWallet | undefined;
let walletB: ConfiguredTestWallet | undefined;

function getWallets(): { walletA: ConfiguredTestWallet; walletB: ConfiguredTestWallet } {
  if (!walletA || !walletB) {
    walletA = createConfiguredTestWallet({
      label: 'Wallet A',
      fallbackPrivateKeyHex: DEFAULT_TEST_PRIVATE_KEY_A,
      emulatorSlot: 'A',
    });
    walletB = createConfiguredTestWallet({
      label: 'Wallet B',
      fallbackPrivateKeyHex: DEFAULT_TEST_PRIVATE_KEY_B,
      emulatorSlot: 'B',
    });
  }

  return { walletA, walletB };
}

// ============================================================
// Helpers
// ============================================================

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`ASSERTION FAILED: ${msg}`);
    process.exit(1);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// Step 0: Verify the signer format across all script types
// ============================================================

async function verifySignerFormat() {
  console.log('\n=== Verify OneKey Signer Format ===\n');
  const { walletA } = getWallets();

  const testHash =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  for (const [name, scriptType] of [
    ['P2PKH', ScriptType.P2PKH],
    ['P2SH-segwit', ScriptType.P2SH_SEGWIT],
    ['Native segwit', ScriptType.NATIVE_SEGWIT],
  ] as const) {
    const sig = await signBitcoinMessage(walletA.privateKeyHex, testHash, scriptType);

    console.log(`  ${name}:`);
    console.log(`    byte0 = ${sig.byte0} (0x${sig.byte0.toString(16)})`);
    console.log(`    r = 0x${sig.r.toString(16).slice(0, 16)}...`);
    console.log(`    s = 0x${sig.s.toString(16).slice(0, 16)}...`);
    console.log(`    yParity = ${sig.yParity}`);

    // Verify byte0 encoding
    const expectedBase = 27 + sig.yParity + 4 + scriptType;
    assert(sig.byte0 === expectedBase, `byte0 mismatch for ${name}`);

    // Verify round-trip decode
    const decoded = decodeCompactSignature(sig.compact65);
    assert(decoded.r === sig.r, `r mismatch for ${name}`);
    assert(decoded.s === sig.s, `s mismatch for ${name}`);
    assert(decoded.yParity === sig.yParity, `yParity mismatch for ${name}`);
    assert(decoded.scriptType === scriptType, `scriptType mismatch for ${name}`);

    // Byte 0 range checks per the spec
    if (scriptType === ScriptType.P2PKH) {
      assert(sig.byte0 >= 31 && sig.byte0 <= 34, `P2PKH byte0 out of range: ${sig.byte0}`);
    } else if (scriptType === ScriptType.P2SH_SEGWIT) {
      assert(sig.byte0 >= 35 && sig.byte0 <= 38, `P2SH byte0 out of range: ${sig.byte0}`);
    } else if (scriptType === ScriptType.NATIVE_SEGWIT) {
      assert(sig.byte0 >= 39 && sig.byte0 <= 42, `Segwit byte0 out of range: ${sig.byte0}`);
    }
  }

  console.log('\n  All script types verified!\n');
}

// ============================================================
// Step 1: Setup — Compute address and deploy
// ============================================================

async function deployAccount(
  name: string,
  wallet: ConfiguredTestWallet,
  sponsor?: ConfiguredTestWallet,
) {
  console.log(`\n--- ${name} ---`);
  const { address, pubkeyHash } = wallet;
  console.log('  Address:', address);
  console.log('  PubkeyHash:', pubkeyHash);

  const deployed = await isDeployed(address);
  if (deployed) {
    console.log('  Already deployed');
  } else {
    let success = false;

    // If account already has balance, deploy directly (skip paymaster)
    const preFundBalance = await getStrkBalance(address);
    if (preFundBalance > 0n) {
      console.log(`  Pre-funded (${formatStrk(preFundBalance)}), deploying directly...`);
      const deployTx = await deployAccountDirect({
        privateKeyHex: wallet.privateKeyHex,
        address,
        pubkeyHash,
        signer: wallet.signer,
      });
      console.log('  Deploy TX:', deployTx);
      const deployStatus = await waitForTx(deployTx);
      assert(deployStatus === 'accepted', `${name} deploy rejected`);
      console.log('  Deploy confirmed!');
      success = true;
    } else if (sponsor) {
      // Fund from sponsor, then deploy
      console.log('  Deploying via sponsor...');
      const fundAmount = 2000000000000000000n; // 2 STRK
      const fundTx = await directInvoke({
        privateKeyHex: sponsor.privateKeyHex,
        starknetAddress: sponsor.address,
        pubkeyHash: sponsor.pubkeyHash,
        signer: sponsor.signer,
        calls: [
          {
            contractAddress: STRK_TOKEN_ADDRESS,
            entrypoint: 'transfer',
            calldata: [address, fundAmount.toString(), '0'],
          },
        ],
      });
      console.log('  Fund TX:', fundTx);
      await waitForTx(fundTx);
      const deployTx = await deployAccountDirect({
        privateKeyHex: wallet.privateKeyHex,
        address,
        pubkeyHash,
        signer: wallet.signer,
      });
      console.log('  Deploy TX:', deployTx);
      const deployStatus = await waitForTx(deployTx);
      assert(deployStatus === 'accepted', `${name} deploy rejected`);
      console.log('  Deploy confirmed (sponsor-funded)!');
      success = true;
    } else {
      throw new Error(`${name}: account has no balance and no sponsor — fund it first at ${address}`);
    }
    assert(success, `${name} deploy failed`);
  }

  const balance = await getStrkBalance(address);
  console.log(`  Balance: ${formatStrk(balance)}`);
  return { address, pubkeyHash, balance };
}

async function setup() {
  console.log('\n=== STEP 1: Setup ===\n');
  const { walletA, walletB } = getWallets();

  assert(
    ONEKEY_ACCOUNT_CLASS_HASH !== '0x0000000000000000000000000000000000000000000000000000000000000000',
    'ONEKEY_ACCOUNT_CLASS_HASH not set — declare the contract first',
  );

  const a = await deployAccount('Wallet A', walletA);
  const b = await deployAccount('Wallet B', walletB, walletA);

  if (a.balance === 0n) {
    console.log(
      '\n╔══════════════════════════════════════════════════════╗',
    );
    console.log(
      '║  FUND WALLET A WITH STRK:                            ║',
    );
    console.log(`║  ${a.address} ║`);
    console.log(
      '╚══════════════════════════════════════════════════════╝',
    );
  }

  return { addressA: a.address, addressB: b.address, pubkeyHashA: a.pubkeyHash, pubkeyHashB: b.pubkeyHash };
}

// ============================================================
// Step 2: Privacy pool deposit + withdraw
// ============================================================

async function deposit() {
  console.log('\n=== STEP 2: Privacy Pool Integration ===\n');
  const { walletA } = getWallets();

  const { address, pubkeyHash } = walletA;
  console.log('Account:', address);

  const balance = await getStrkBalance(address);
  console.log('Balance:', formatStrk(balance));
  assert(balance > 0n, 'Account has no STRK balance — fund it first');

  const privacyKey = derivePrivacyKey(walletA.privateKeyHex, address);
  console.log('Privacy key:', privacyKey);

  const provider = getProvider();
  const randomFelt = () => {
    const bytes = new Uint8Array(31);
    crypto.getRandomValues(bytes);
    return (
      '0x' +
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    );
  };

  // Check if viewing key is set
  let needsViewingKey = true;
  try {
    const pubKeyResult = await provider.callContract({
      contractAddress: PRIVACY_POOL_ADDRESS,
      entrypoint: 'get_public_key',
      calldata: [address],
    });
    if (pubKeyResult[0] !== '0x0' && pubKeyResult[0] !== '0') {
      needsViewingKey = false;
      console.log('  Viewing key already set');
    }
  } catch {
    // Not set yet
  }

  if (needsViewingKey) {
    console.log('\nSetting viewing key via proving service...');
    const vkClientActions = [address, privacyKey, '1', '0', randomFelt()];
    const vkServerActions = await provider.callContract({
      contractAddress: PRIVACY_POOL_ADDRESS,
      entrypoint: 'compile_actions',
      calldata: vkClientActions,
    });
    console.log('  Compiled, proving and executing...');
    const vkTx = await proveAndExecute({
      privateKeyHex: walletA.privateKeyHex,
      starknetAddress: address,
      pubkeyHash,
      signHash: walletA.signHash,
      clientActions: vkClientActions,
      serverActions: [...vkServerActions],
    });
    console.log('  ViewingKey TX:', vkTx);
    const vkStatus = await waitForTx(vkTx);
    assert(vkStatus === 'accepted', 'SetViewingKey transaction rejected');
    console.log(
      '\n  Full pipeline verified: compile → prove → sign(proof_facts) → submit → confirmed',
    );
  }

  // Verify viewing key
  const pubKeyCheck = await provider.callContract({
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'get_public_key',
    calldata: [address],
  });
  assert(
    pubKeyCheck[0] !== '0x0' && pubKeyCheck[0] !== '0',
    'Viewing key not set after registration',
  );
  console.log('  On-chain viewing key:', pubKeyCheck[0].slice(0, 16) + '...');

  // Deposit
  const depositAmount = 1000000000000000n; // 0.001 STRK
  const starkPubKey = pubKeyCheck[0];

  const channelIndex = await getNextChannelIndex(address, privacyKey);
  const selfChannelExists = channelIndex > 0;

  if (selfChannelExists) {
    console.log(
      `\nDeposit + CreateEncNote(to_self) ${formatStrk(depositAmount)}...`,
    );
    const channelKey = computeChannelKey(
      address,
      privacyKey,
      address,
      starkPubKey,
    );

    console.log('  Approving STRK...');
    const approveTxHash = await directInvoke({
      privateKeyHex: walletA.privateKeyHex,
      starknetAddress: address,
      pubkeyHash,
      signer: walletA.signer,
      calls: [
        {
          contractAddress: STRK_TOKEN_ADDRESS,
          entrypoint: 'approve',
          calldata: [PRIVACY_POOL_ADDRESS, depositAmount.toString(), '0'],
        },
      ],
    });
    console.log('  Approve TX:', approveTxHash);
    const approveStatus = await waitForTx(approveTxHash);
    assert(approveStatus === 'accepted', 'Approve rejected');

    // Wait for blocks so prover can see the approve
    console.log('  Waiting for block finality...');
    const approveBlockNum = await provider.getBlockNumber();
    for (let i = 0; i < 60; i++) {
      const cur = await provider.getBlockNumber();
      if (cur >= approveBlockNum + 25) break;
      if (i % 5 === 0) console.log(`    Block ${cur}, need ${approveBlockNum + 25}...`);
      await sleep(3000);
    }

    const noteIndex = await getNextNoteIndex(channelKey, STRK_TOKEN_ADDRESS);
    console.log('  Next note index:', noteIndex);

    let depositClientActions: string[];
    let depositServerActions: string[];
    try {
      depositClientActions = [
        address,
        privacyKey,
        '3',
        '2', address, starkPubKey, channelKey, '0', STRK_TOKEN_ADDRESS, randomFelt(),
        '5', STRK_TOKEN_ADDRESS, depositAmount.toString(),
        '3', address, starkPubKey, STRK_TOKEN_ADDRESS, depositAmount.toString(), noteIndex.toString(), generateRandom120(),
      ];
      depositServerActions = [
        ...(await provider.callContract({
          contractAddress: PRIVACY_POOL_ADDRESS,
          entrypoint: 'compile_actions',
          calldata: depositClientActions,
        })),
      ];
    } catch {
      console.log('  Subchannel exists, retrying without OpenSubchannel...');
      depositClientActions = [
        address,
        privacyKey,
        '2',
        '5', STRK_TOKEN_ADDRESS, depositAmount.toString(),
        '3', address, starkPubKey, STRK_TOKEN_ADDRESS, depositAmount.toString(), noteIndex.toString(), generateRandom120(),
      ];
      depositServerActions = [
        ...(await provider.callContract({
          contractAddress: PRIVACY_POOL_ADDRESS,
          entrypoint: 'compile_actions',
          calldata: depositClientActions,
        })),
      ];
    }

    console.log('  Compiled:', depositServerActions.length, 'server action felts');

    const depositTxHash = await proveAndExecute({
      privateKeyHex: walletA.privateKeyHex,
      starknetAddress: address,
      pubkeyHash,
      signHash: walletA.signHash,
      clientActions: depositClientActions,
      serverActions: depositServerActions,
    });
    console.log('  Deposit TX:', depositTxHash);
    const depositStatus = await waitForTx(depositTxHash);
    assert(depositStatus === 'accepted', 'Deposit transaction rejected');
  } else {
    console.log(
      `\nDeposit + Withdraw ${formatStrk(depositAmount)} (first run)...`,
    );

    console.log('  Approving STRK...');
    const approveTxHash = await directInvoke({
      privateKeyHex: walletA.privateKeyHex,
      starknetAddress: address,
      pubkeyHash,
      signer: walletA.signer,
      calls: [
        {
          contractAddress: STRK_TOKEN_ADDRESS,
          entrypoint: 'approve',
          calldata: [PRIVACY_POOL_ADDRESS, depositAmount.toString(), '0'],
        },
      ],
    });
    console.log('  Approve TX:', approveTxHash);
    const approveStatus = await waitForTx(approveTxHash);
    assert(approveStatus === 'accepted', 'Approve rejected');

    // Wait for blocks so prover (latestBlock - 20) can see the approve
    console.log('  Waiting for block finality (prover needs latestBlock - 20)...');
    const approveBlock = await provider.getBlockNumber();
    for (let i = 0; i < 60; i++) {
      const current = await provider.getBlockNumber();
      if (current >= approveBlock + 25) break;
      if (i % 5 === 0) console.log(`    Block ${current}, need ${approveBlock + 25}...`);
      await sleep(3000);
    }

    const depositClientActions = [
      address,
      privacyKey,
      '3',
      '1', address, '0', randomFelt(), randomFelt(),
      '5', STRK_TOKEN_ADDRESS, depositAmount.toString(),
      '7', address, STRK_TOKEN_ADDRESS, depositAmount.toString(), randomFelt(),
    ];
    const depositServerActions = [
      ...(await provider.callContract({
        contractAddress: PRIVACY_POOL_ADDRESS,
        entrypoint: 'compile_actions',
        calldata: depositClientActions,
      })),
    ];
    console.log('  Compiled:', depositServerActions.length, 'server action felts');

    const depositTxHash = await proveAndExecute({
      privateKeyHex: walletA.privateKeyHex,
      starknetAddress: address,
      pubkeyHash,
      signHash: walletA.signHash,
      clientActions: depositClientActions,
      serverActions: depositServerActions,
    });
    console.log('  Deposit+Withdraw TX:', depositTxHash);
    const depositStatus = await waitForTx(depositTxHash);
    assert(depositStatus === 'accepted', 'Deposit+Withdraw rejected');
  }

  const balanceAfter = await getStrkBalance(address);
  console.log(`  Balance after: ${formatStrk(balanceAfter)}`);
  console.log('\nDEPOSIT TEST PASSED!\n');
}

// ============================================================
// Step 3: Private transfer A → B via CreateEncNote
// ============================================================

async function transfer() {
  console.log('\n=== STEP 3: Private Transfer A → B ===\n');
  const { walletA, walletB } = getWallets();

  const provider = getProvider();

  const { address: addrA, pubkeyHash: hashA } = walletA;
  const privacyKeyA = derivePrivacyKey(walletA.privateKeyHex, addrA);

  const { address: addrB, pubkeyHash: hashB } = walletB;
  const privacyKeyB = derivePrivacyKey(walletB.privateKeyHex, addrB);

  console.log('Wallet A:', addrA);
  console.log('Wallet B:', addrB);

  // Ensure B has gas
  const balB = await getStrkBalance(addrB);
  if (balB < 500000000000000n) {
    console.log('\nFunding Wallet B with gas from Wallet A...');
    const fundAmount = 1000000000000000000n;
    const fundTx = await directInvoke({
      privateKeyHex: walletA.privateKeyHex,
      starknetAddress: addrA,
      pubkeyHash: hashA,
      signer: walletA.signer,
      calls: [
        {
          contractAddress: STRK_TOKEN_ADDRESS,
          entrypoint: 'transfer',
          calldata: [addrB, fundAmount.toString(), '0'],
        },
      ],
    });
    console.log('  Fund TX:', fundTx);
    await waitForTx(fundTx);
  }

  // Register B's viewing key
  const randomFelt = () => {
    const bytes = new Uint8Array(31);
    crypto.getRandomValues(bytes);
    return (
      '0x' +
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    );
  };

  let bNeedsViewingKey = true;
  try {
    const bPubResult = await provider.callContract({
      contractAddress: PRIVACY_POOL_ADDRESS,
      entrypoint: 'get_public_key',
      calldata: [addrB],
    });
    if (bPubResult[0] !== '0x0' && bPubResult[0] !== '0') {
      bNeedsViewingKey = false;
      console.log('  Wallet B viewing key already set');
    }
  } catch {
    /* not set */
  }

  if (bNeedsViewingKey) {
    console.log('\nRegistering Wallet B viewing key...');
    const vkActions = [addrB, privacyKeyB, '1', '0', randomFelt()];
    const vkServer = await provider.callContract({
      contractAddress: PRIVACY_POOL_ADDRESS,
      entrypoint: 'compile_actions',
      calldata: vkActions,
    });
    const vkTx = await proveAndExecute({
      privateKeyHex: walletB.privateKeyHex,
      starknetAddress: addrB,
      pubkeyHash: hashB,
      signHash: walletB.signHash,
      clientActions: vkActions,
      serverActions: [...vkServer],
    });
    console.log('  ViewingKey TX:', vkTx);
    const vkStatus = await waitForTx(vkTx);
    assert(vkStatus === 'accepted', 'Wallet B SetViewingKey rejected');
  }

  const bPubKeyResult = await provider.callContract({
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'get_public_key',
    calldata: [addrB],
  });
  const bStarkPubKey = bPubKeyResult[0];

  const channelKey = computeChannelKey(addrA, privacyKeyA, addrB, bStarkPubKey);

  const transferAmount = 1000000000000000n; // 0.001 STRK
  console.log(
    `\nPrivate transfer ${formatStrk(transferAmount)} from A to B...`,
  );

  console.log('  Approving STRK...');
  const approveTx = await directInvoke({
    privateKeyHex: walletA.privateKeyHex,
    starknetAddress: addrA,
    pubkeyHash: hashA,
    signer: walletA.signer,
    calls: [
      {
        contractAddress: STRK_TOKEN_ADDRESS,
        entrypoint: 'approve',
        calldata: [PRIVACY_POOL_ADDRESS, transferAmount.toString(), '0'],
      },
    ],
  });
  console.log('  Approve TX:', approveTx);
  await waitForTx(approveTx);

  // Wait for block finality
  console.log(
    '  Waiting for block finality (prover needs latestBlock - 20)...',
  );
  const targetBlock = await provider.getBlockNumber();
  for (let i = 0; i < 60; i++) {
    const current = await provider.getBlockNumber();
    if (current >= targetBlock + 25) break;
    if (i % 5 === 0)
      console.log(`    Block ${current}, need ${targetBlock + 25}...`);
    await sleep(3000);
  }

  const channelIndex = await getNextChannelIndex(addrA, privacyKeyA);
  const clientActions = [
    addrA,
    privacyKeyA,
    '4',
    '1', addrB, channelIndex.toString(), randomFelt(), randomFelt(),
    '2', addrB, bStarkPubKey, channelKey, '0', STRK_TOKEN_ADDRESS, randomFelt(),
    '5', STRK_TOKEN_ADDRESS, transferAmount.toString(),
    '3', addrB, bStarkPubKey, STRK_TOKEN_ADDRESS, transferAmount.toString(), '0', generateRandom120(),
  ];

  console.log('  Compiling actions...');
  const serverActions = await provider.callContract({
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'compile_actions',
    calldata: clientActions,
  });

  const txHash = await proveAndExecute({
    privateKeyHex: walletA.privateKeyHex,
    starknetAddress: addrA,
    pubkeyHash: hashA,
    signHash: walletA.signHash,
    clientActions,
    serverActions: [...serverActions],
  });
  console.log('  Transfer TX:', txHash);
  const txStatus = await waitForTx(txHash);
  assert(txStatus === 'accepted', 'Private transfer rejected');

  console.log('\nPRIVATE TRANSFER TEST PASSED!\n');
}

// ============================================================
// Step 4: Withdraw
// ============================================================

async function withdraw() {
  console.log('\n=== STEP 4: Withdraw ===\n');
  const { walletA } = getWallets();

  const { address, pubkeyHash } = walletA;
  console.log('Account:', address);

  const balanceBefore = await getStrkBalance(address);
  console.log('Balance before:', formatStrk(balanceBefore));

  const privacyKey = derivePrivacyKey(walletA.privateKeyHex, address);
  const provider = getProvider();
  const randomFelt = () => {
    const bytes = new Uint8Array(31);
    crypto.getRandomValues(bytes);
    return '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  // Withdraw via Deposit+CreateEncNote(to_self)+Withdraw batch.
  // CreateEncNote provides replay protection; Deposit funds the Withdraw.
  // Net: pool balance unchanged, user receives withdrawAmount after gas.
  const withdrawAmount = 500000000000000n; // 0.0005 STRK

  // Approve STRK for the deposit component
  console.log(`Withdrawing ${formatStrk(withdrawAmount)} via Deposit+Note+Withdraw batch...`);
  console.log('  Approving STRK...');
  const approveTx = await directInvoke({
    privateKeyHex: walletA.privateKeyHex,
    starknetAddress: address,
    pubkeyHash,
    signer: walletA.signer,
    calls: [{
      contractAddress: STRK_TOKEN_ADDRESS,
      entrypoint: 'approve',
      calldata: [PRIVACY_POOL_ADDRESS, withdrawAmount.toString(), '0'],
    }],
  });
  console.log('  Approve TX:', approveTx);
  await waitForTx(approveTx);

  // Wait for block finality
  console.log('  Waiting for block finality...');
  const approveBlock = await provider.getBlockNumber();
  for (let i = 0; i < 60; i++) {
    const current = await provider.getBlockNumber();
    if (current >= approveBlock + 25) break;
    if (i % 5 === 0) console.log(`    Block ${current}, need ${approveBlock + 25}...`);
    await sleep(3000);
  }

  // Get self-channel info for CreateEncNote
  const starkPubKey = (await provider.callContract({
    contractAddress: PRIVACY_POOL_ADDRESS,
    entrypoint: 'get_public_key',
    calldata: [address],
  }))[0];
  const channelKey = computeChannelKey(address, privacyKey, address, starkPubKey);
  const noteIndex = await getNextNoteIndex(channelKey, STRK_TOKEN_ADDRESS);

  // 3 actions: Deposit + CreateEncNote(to_self) + Withdraw
  // Balance: Deposit(+X) + CreateEncNote(-X) + Withdraw(-X) doesn't work (negative after note+withdraw)
  // Correct: Deposit(+X) + Withdraw(-X) + CreateEncNote(0 for replay protection)
  // Actually, the pool requires Deposit before Withdraw for intermediate balance.
  // And CreateEncNote provides write-once replay protection.
  // Pattern: Deposit(X) → intermediate=+X, Withdraw(X) → intermediate=0, CreateEncNote(0) for replay.
  // But CreateEncNote with amount 0 may not work. Let's use: Deposit(2X), CreateEncNote(X), Withdraw(X)
  // intermediate after Deposit(2X)=+2X, CreateEncNote(X) →+X, Withdraw(X) →0. Pool holds X extra.
  //
  // Simplest: Deposit(X) + Withdraw(X) + CreateEncNote(to_self, 0 amount) or use a fresh OpenSubchannel.
  //
  // Actually, looking at reference first-run: OpenChannel + Deposit + Withdraw. OpenChannel is the replay protector.
  // For subsequent runs: use a new OpenSubchannel on a fresh token/channel combo.

  // Use Deposit + Withdraw + CreateEncNote(0) for replay protection.
  // If amount=0 doesn't work, we just use Deposit(X), CreateEncNote(X-W), Withdraw(W).
  // For simplicity: match the reference first-run pattern — open a new subchannel.

  let withdrawClientActions: string[];
  let withdrawServerActions: string[];
  try {
    // Try OpenSubchannel for replay protection + Deposit + Withdraw
    withdrawClientActions = [
      address, privacyKey, '3',
      '2', address, starkPubKey, channelKey, noteIndex.toString(), STRK_TOKEN_ADDRESS, randomFelt(),
      '5', STRK_TOKEN_ADDRESS, withdrawAmount.toString(),
      '7', address, STRK_TOKEN_ADDRESS, withdrawAmount.toString(), randomFelt(),
    ];
    withdrawServerActions = [...await provider.callContract({
      contractAddress: PRIVACY_POOL_ADDRESS,
      entrypoint: 'compile_actions',
      calldata: withdrawClientActions,
    })];
  } catch (e: any) {
    console.log('  OpenSubchannel failed, using CreateEncNote for replay protection...');
    // Deposit(2*amount) + CreateEncNote(amount) + Withdraw(amount)
    // Intermediate: +2X → +X → 0
    const doubleAmount = withdrawAmount * 2n;
    const approveTx2 = await directInvoke({
      privateKeyHex: walletA.privateKeyHex,
      starknetAddress: address,
      pubkeyHash,
      signer: walletA.signer,
      calls: [{
        contractAddress: STRK_TOKEN_ADDRESS,
        entrypoint: 'approve',
        calldata: [PRIVACY_POOL_ADDRESS, doubleAmount.toString(), '0'],
      }],
    });
    await waitForTx(approveTx2);
    const ab2 = await provider.getBlockNumber();
    for (let i = 0; i < 60; i++) {
      const c = await provider.getBlockNumber();
      if (c >= ab2 + 25) break;
      await sleep(3000);
    }
    const ni2 = await getNextNoteIndex(channelKey, STRK_TOKEN_ADDRESS);
    withdrawClientActions = [
      address, privacyKey, '3',
      '5', STRK_TOKEN_ADDRESS, doubleAmount.toString(),
      '3', address, starkPubKey, STRK_TOKEN_ADDRESS, withdrawAmount.toString(), ni2.toString(), generateRandom120(),
      '7', address, STRK_TOKEN_ADDRESS, withdrawAmount.toString(), randomFelt(),
    ];
    withdrawServerActions = [...await provider.callContract({
      contractAddress: PRIVACY_POOL_ADDRESS,
      entrypoint: 'compile_actions',
      calldata: withdrawClientActions,
    })];
  }

  console.log('  Compiled:', withdrawServerActions.length, 'felts');

  const txHash = await proveAndExecute({
    privateKeyHex: walletA.privateKeyHex,
    starknetAddress: address,
    pubkeyHash,
    signHash: walletA.signHash,
    clientActions: withdrawClientActions,
    serverActions: withdrawServerActions,
  });
  console.log('  Withdraw TX:', txHash);
  const status = await waitForTx(txHash);
  assert(status === 'accepted', 'Withdraw transaction rejected');

  const balanceAfter = await getStrkBalance(address);
  console.log(`\nBalance after withdraw: ${formatStrk(balanceAfter)}`);
  console.log('WITHDRAW TEST PASSED!\n');
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('SNIP-36 — E2E Integration Tests (OneKey Bitcoin Signer)');
  console.log('=======================================================');
  console.log(`Class hash: ${ONEKEY_ACCOUNT_CLASS_HASH}`);
  console.log(`Privacy pool: ${PRIVACY_POOL_ADDRESS}`);

  if (!AVNU_API_KEY) {
    console.error('ERROR: Set AVNU_API_KEY environment variable');
    process.exit(1);
  }
  if (!PROVING_SERVICE_URL) {
    console.error('ERROR: Set PROVING_SERVICE_URL environment variable');
    process.exit(1);
  }

  const step = process.argv[2] || 'setup';

  try {
    const { walletA, walletB } = getWallets();
    console.log(
      `Signer mode: ${isOneKeyEmulatorEnabled() ? `OneKey emulator bridge (${ONEKEY_EMULATOR_REVIEW_URL})` : 'local private key mock'}`,
    );
    console.log(`Wallet A: ${walletA.address}`);
    console.log(`Wallet B: ${walletB.address}`);

    // Always verify the signer format first
    await verifySignerFormat();

    switch (step) {
      case 'setup':
        await setup();
        break;
      case 'deposit':
        await deposit();
        break;
      case 'transfer':
        await transfer();
        break;
      case 'withdraw':
        await withdraw();
        break;
      case 'all': {
        const { addressA } = await setup();
        console.log('\nWaiting for account to be funded...');
        let balance = 0n;
        for (let i = 0; i < 120; i++) {
          balance = await getStrkBalance(addressA);
          if (balance > 0n) break;
          if (i % 10 === 0) console.log(`  Still waiting... (${i}s)`);
          await sleep(1000);
        }
        assert(balance > 0n, 'Account not funded after 120s');
        console.log(`  Funded: ${formatStrk(balance)}`);

        await deposit();
        await transfer();
        console.log('\n=== ALL TESTS PASSED ===\n');
        break;
      }
      default:
        console.error(
          `Unknown step: ${step}. Use: setup, deposit, transfer, withdraw, all`,
        );
        process.exit(1);
    }
  } catch (e: any) {
    console.error('\nTEST FAILED:', e.message || e);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  }
}

main();
