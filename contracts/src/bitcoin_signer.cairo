use core::poseidon::poseidon_hash_span;
use core::sha256::compute_sha256_byte_array;
use starknet::secp256_trait::{
    Secp256PointTrait, Signature as Secp256Signature, is_signature_entry_valid, recover_public_key,
};
use starknet::secp256k1::Secp256k1Point;

/// Half the secp256k1 curve order — signatures with s > HALF are malleable.
pub const SECP_256_K1_HALF: u256 = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141 / 2;

/// Domain tag appended to Starknet transaction signatures and mixed into the signed hash.
pub const TX_SIGNATURE_DOMAIN_TAG: felt252 = 0x4f4e454b45595f54585f415554485f5631; // "ONEKEY_TX_AUTH_V1"

/// Domain-separate generic off-chain signatures from transaction authorization.
pub const OFFCHAIN_SIGNATURE_DOMAIN_TAG: felt252 = 0x4f4e454b45595f4f4646434841494e5f5631; // "ONEKEY_OFFCHAIN_V1"

#[must_use]
pub fn get_transaction_signature_hash(tx_hash: felt252) -> felt252 {
    poseidon_hash_span(array![TX_SIGNATURE_DOMAIN_TAG, tx_hash].span())
}

#[must_use]
pub fn get_offchain_signature_hash(message_hash: felt252) -> felt252 {
    poseidon_hash_span(array![OFFCHAIN_SIGNATURE_DOMAIN_TAG, message_hash].span())
}

/// Validates a Bitcoin-style secp256k1 signature against an application-specific 32-byte hash.
///
/// Compliant with the OneKey / Trezor legacy signing format:
///   digest = SHA256(SHA256(varint(24) || "Bitcoin Signed Message:\n" || varint(32) || hash))
///
/// Uses Poseidon hash of recovered public key coordinates instead of keccak256,
/// making it compatible with the Starknet virtual OS (which lacks keccak support).
///
/// Signature is deserialized from a felt252 span:
///   [r_low, r_high, s_low, s_high, y_parity]
#[must_use]
pub fn is_valid_bitcoin_signature(hash: felt252, pubkey_hash: felt252, signature: Secp256Signature) -> bool {
    if !is_signature_entry_valid::<Secp256k1Point>(signature.r) {
        return false;
    }
    if !is_signature_entry_valid::<Secp256k1Point>(signature.s) {
        return false;
    }
    if signature.s > SECP_256_K1_HALF {
        return false;
    }

    let hash_u256: u256 = hash.into();

    // Build 58-byte Bitcoin message:
    //   varint(24)  = 0x18   (length of "Bitcoin Signed Message:\n")
    //   "Bitcoin Signed Message:\n"  (24 bytes)
    //   varint(32)  = 0x20   (length of tx hash)
    //   tx_hash                      (32 bytes)
    let mut msg: ByteArray = "";

    // Header length varint + "Bitcoin Signed Message:\n"
    msg.append_byte(0x18);
    msg.append_byte(0x42); // B
    msg.append_byte(0x69); // i
    msg.append_byte(0x74); // t
    msg.append_byte(0x63); // c
    msg.append_byte(0x6f); // o
    msg.append_byte(0x69); // i
    msg.append_byte(0x6e); // n
    msg.append_byte(0x20); // (space)
    msg.append_byte(0x53); // S
    msg.append_byte(0x69); // i
    msg.append_byte(0x67); // g
    msg.append_byte(0x6e); // n
    msg.append_byte(0x65); // e
    msg.append_byte(0x64); // d
    msg.append_byte(0x20); // (space)
    msg.append_byte(0x4d); // M
    msg.append_byte(0x65); // e
    msg.append_byte(0x73); // s
    msg.append_byte(0x73); // s
    msg.append_byte(0x61); // a
    msg.append_byte(0x67); // g
    msg.append_byte(0x65); // e
    msg.append_byte(0x3a); // :
    msg.append_byte(0x0a); // \n

    // Message length varint (32 = 0x20)
    msg.append_byte(0x20);

    // Append 32-byte tx hash in big-endian
    append_u128_be(ref msg, hash_u256.high);
    append_u128_be(ref msg, hash_u256.low);

    // First SHA256
    let first_hash = compute_sha256_byte_array(@msg);

    // Second SHA256
    let mut second_input: ByteArray = "";
    append_u32_array_be(ref second_input, first_hash);
    let double_hash_words = compute_sha256_byte_array(@second_input);

    // Convert [u32; 8] → u256
    let double_hash: u256 = eight_words_to_u256(double_hash_words);

    // Recover public key from the double-hashed digest
    let recovered = recover_public_key::<Secp256k1Point>(double_hash, signature);
    if recovered.is_none() {
        return false;
    }

    // Compute Poseidon hash of (x_low, x_high, y_low, y_high)
    let point = recovered.unwrap();
    let (x, y) = point.get_coordinates().unwrap();
    let recovered_hash = poseidon_hash_span(array![x.low.into(), x.high.into(), y.low.into(), y.high.into()].span());
    recovered_hash == pubkey_hash
}

/// Appends a u128 as 16 big-endian bytes to a ByteArray.
fn append_u128_be(ref ba: ByteArray, value: u128) {
    let mut i: u32 = 0;
    loop {
        if i == 16 {
            break;
        }
        let shift = 120 - (i * 8);
        let byte: u8 = ((value / pow2_128(shift)) % 256).try_into().unwrap();
        ba.append_byte(byte);
        i += 1;
    };
}

/// Appends [u32; 8] as 32 big-endian bytes to a ByteArray.
fn append_u32_array_be(ref ba: ByteArray, words: [u32; 8]) {
    let [w0, w1, w2, w3, w4, w5, w6, w7] = words;
    append_single_u32_be(ref ba, w0);
    append_single_u32_be(ref ba, w1);
    append_single_u32_be(ref ba, w2);
    append_single_u32_be(ref ba, w3);
    append_single_u32_be(ref ba, w4);
    append_single_u32_be(ref ba, w5);
    append_single_u32_be(ref ba, w6);
    append_single_u32_be(ref ba, w7);
}

/// Appends a single u32 as 4 big-endian bytes.
fn append_single_u32_be(ref ba: ByteArray, value: u32) {
    ba.append_byte(((value / 0x1000000) % 0x100).try_into().unwrap());
    ba.append_byte(((value / 0x10000) % 0x100).try_into().unwrap());
    ba.append_byte(((value / 0x100) % 0x100).try_into().unwrap());
    ba.append_byte((value % 0x100).try_into().unwrap());
}

/// Converts [u32; 8] to u256 (big-endian word order).
fn eight_words_to_u256(words: [u32; 8]) -> u256 {
    let [word_0, word_1, word_2, word_3, word_4, word_5, word_6, word_7] = words;
    let high: felt252 = word_3.into()
        + word_2.into() * 0x1_0000_0000
        + word_1.into() * 0x1_0000_0000_0000_0000
        + word_0.into() * 0x1_0000_0000_0000_0000_0000_0000;
    let high: u128 = high.try_into().expect('overflow-hi');
    let low: felt252 = word_7.into()
        + word_6.into() * 0x1_0000_0000
        + word_5.into() * 0x1_0000_0000_0000_0000
        + word_4.into() * 0x1_0000_0000_0000_0000_0000_0000;
    let low: u128 = low.try_into().expect('overflow-lo');
    u256 { high, low }
}

/// Returns 2^n for bit shifts on u128 values (multiples of 8 only).
fn pow2_128(n: u32) -> u128 {
    if n == 0 {
        return 1;
    }
    if n == 8 {
        return 0x100;
    }
    if n == 16 {
        return 0x10000;
    }
    if n == 24 {
        return 0x1000000;
    }
    if n == 32 {
        return 0x100000000;
    }
    if n == 40 {
        return 0x10000000000;
    }
    if n == 48 {
        return 0x1000000000000;
    }
    if n == 56 {
        return 0x100000000000000;
    }
    if n == 64 {
        return 0x10000000000000000;
    }
    if n == 72 {
        return 0x1000000000000000000;
    }
    if n == 80 {
        return 0x100000000000000000000;
    }
    if n == 88 {
        return 0x10000000000000000000000;
    }
    if n == 96 {
        return 0x1000000000000000000000000;
    }
    if n == 104 {
        return 0x100000000000000000000000000;
    }
    if n == 112 {
        return 0x10000000000000000000000000000;
    }
    if n == 120 {
        return 0x1000000000000000000000000000000;
    }
    panic!("pow2_128: unsupported shift")
}
