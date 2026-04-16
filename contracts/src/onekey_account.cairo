/// OneKey Bitcoin Account — a minimal Starknet account contract that validates
/// secp256k1 signatures wrapped with the Bitcoin "Signed Message" double-SHA256
/// prefix, following the OneKey / Trezor legacy signing format.
///
/// Based on the OpenZeppelin Cairo account pattern but uses:
///   - Poseidon hash of secp256k1 public key coords (virtual OS compatible)
///   - Bitcoin message wrapping for signature verification
///
/// Off-chain signature format (5 felt252):
///   [r_low, r_high, s_low, s_high, y_parity]
///
/// On-chain transaction signature format (6 felt252):
///   [r_low, r_high, s_low, s_high, y_parity, tx_domain_tag]

use starknet::account::Call;

#[starknet::interface]
pub trait IAccount<TContractState> {
    fn __validate__(ref self: TContractState, calls: Array<Call>) -> felt252;
    fn __execute__(ref self: TContractState, calls: Array<Call>) -> Array<Span<felt252>>;
    fn is_valid_signature(self: @TContractState, hash: felt252, signature: Array<felt252>) -> felt252;
}

#[starknet::interface]
pub trait IOnekeyAccount<TState> {
    fn get_public_key(self: @TState) -> felt252;
    fn supports_interface(self: @TState, interface_id: felt252) -> bool;
}

#[starknet::contract(account)]
pub mod OnekeyBitcoinAccount {
    use core::num::traits::Zero;
    use onekey_account::bitcoin_signer::{
        TX_SIGNATURE_DOMAIN_TAG, get_offchain_signature_hash, get_transaction_signature_hash,
        is_valid_bitcoin_signature,
    };
    use starknet::account::Call;
    use starknet::secp256_trait::Signature as Secp256Signature;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{SyscallResultTrait, get_caller_address, get_tx_info};

    // ISRC6 interface ID
    const ISRC6_ID: felt252 = 0x2ceccef7f994940b3962a6c67e0ba4fcd37df7d131417c604f91e03caecc1cd;

    #[storage]
    struct Storage {
        pubkey_hash: felt252,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        OwnerAdded: OwnerAdded,
    }

    #[derive(Drop, starknet::Event)]
    struct OwnerAdded {
        #[key]
        pubkey_hash: felt252,
    }

    mod Errors {
        pub const INVALID_CALLER: felt252 = 'Account: invalid caller';
        pub const INVALID_SIGNATURE: felt252 = 'Account: invalid signature';
        pub const INVALID_TX_VERSION: felt252 = 'Account: invalid tx version';
        pub const ZERO_PUBKEY: felt252 = 'Account: zero pubkey hash';
    }

    #[constructor]
    fn constructor(ref self: ContractState, pubkey_hash: felt252) {
        assert(pubkey_hash != 0, Errors::ZERO_PUBKEY);
        self.pubkey_hash.write(pubkey_hash);
        self.emit(OwnerAdded { pubkey_hash });
    }

    // ── IAccount (SRC6-compatible)
    // ──────────────────────────────────

    #[abi(embed_v0)]
    impl AccountImpl of super::IAccount<ContractState> {
        fn __execute__(ref self: ContractState, calls: Array<Call>) -> Array<Span<felt252>> {
            assert(get_caller_address().is_zero(), Errors::INVALID_CALLER);
            self._assert_supported_tx_version();
            let mut results: Array<Span<felt252>> = array![];
            for call in calls.span() {
                let res = starknet::syscalls::call_contract_syscall(*call.to, *call.selector, *call.calldata)
                    .unwrap_syscall();
                results.append(res);
            }
            results
        }

        fn __validate__(ref self: ContractState, calls: Array<Call>) -> felt252 {
            self._validate_tx()
        }

        fn is_valid_signature(self: @ContractState, hash: felt252, signature: Array<felt252>) -> felt252 {
            if self._is_valid_offchain_signature(hash, signature.span()) {
                starknet::VALIDATED
            } else {
                0
            }
        }
    }

    // ── Deploy validation
    // ────────────────────────────────────────────

    #[external(v0)]
    fn __validate_deploy__(
        self: @ContractState, class_hash: felt252, contract_address_salt: felt252, pubkey_hash: felt252,
    ) -> felt252 {
        self._validate_tx()
    }

    #[external(v0)]
    fn __validate_declare__(self: @ContractState, class_hash: felt252) -> felt252 {
        self._validate_tx()
    }

    // ── Public key getter + SRC5
    // ─────────────────────────────────────

    #[abi(embed_v0)]
    impl OnekeyAccountImpl of super::IOnekeyAccount<ContractState> {
        fn get_public_key(self: @ContractState) -> felt252 {
            self.pubkey_hash.read()
        }

        fn supports_interface(self: @ContractState, interface_id: felt252) -> bool {
            interface_id == ISRC6_ID
        }
    }

    // ── Internals
    // ────────────────────────────────────────────────────

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _assert_supported_tx_version(self: @ContractState) {
            let tx_info = get_tx_info().unbox();
            let version: felt252 = tx_info.version.into();
            assert(version != 0, Errors::INVALID_TX_VERSION);
        }

        /// Validate the current transaction's signature.
        fn _validate_tx(self: @ContractState) -> felt252 {
            self._assert_supported_tx_version();
            let tx_info = get_tx_info().unbox();
            assert(
                self._is_valid_transaction_signature(tx_info.transaction_hash, tx_info.signature),
                Errors::INVALID_SIGNATURE,
            );
            starknet::VALIDATED
        }

        /// Parse a 5-felt signature and verify an off-chain hash under the off-chain domain.
        fn _is_valid_offchain_signature(self: @ContractState, hash: felt252, signature: Span<felt252>) -> bool {
            let sig = match self._parse_signature(signature, false) {
                Option::Some(sig) => sig,
                Option::None => { return false; },
            };
            is_valid_bitcoin_signature(get_offchain_signature_hash(hash), self.pubkey_hash.read(), sig)
        }

        /// Parse a 6-felt transaction signature and verify the transaction-auth domain hash.
        fn _is_valid_transaction_signature(self: @ContractState, tx_hash: felt252, signature: Span<felt252>) -> bool {
            if signature.len() != 6 {
                return false;
            }
            if *signature[5] != TX_SIGNATURE_DOMAIN_TAG {
                return false;
            }
            let sig = match self._parse_signature(signature, true) {
                Option::Some(sig) => sig,
                Option::None => { return false; },
            };
            is_valid_bitcoin_signature(get_transaction_signature_hash(tx_hash), self.pubkey_hash.read(), sig)
        }

        fn _parse_signature(
            self: @ContractState, signature: Span<felt252>, allow_tx_suffix: bool,
        ) -> Option<Secp256Signature> {
            let expected_len = if allow_tx_suffix {
                6
            } else {
                5
            };
            if signature.len() != expected_len {
                return Option::None;
            }
            let r_low: u128 = match (*signature[0]).try_into() {
                Option::Some(v) => v,
                Option::None => { return Option::None; },
            };
            let r_high: u128 = match (*signature[1]).try_into() {
                Option::Some(v) => v,
                Option::None => { return Option::None; },
            };
            let s_low: u128 = match (*signature[2]).try_into() {
                Option::Some(v) => v,
                Option::None => { return Option::None; },
            };
            let s_high: u128 = match (*signature[3]).try_into() {
                Option::Some(v) => v,
                Option::None => { return Option::None; },
            };
            let y_parity_felt = *signature[4];
            if y_parity_felt != 0 && y_parity_felt != 1 {
                return Option::None;
            }
            let y_parity: bool = y_parity_felt == 1;

            Option::Some(
                Secp256Signature {
                    r: u256 { low: r_low, high: r_high }, s: u256 { low: s_low, high: s_high }, y_parity,
                },
            )
        }
    }
}
