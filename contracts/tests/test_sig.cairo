use core::poseidon::poseidon_hash_span;
use core::sha256::compute_sha256_byte_array;
use onekey_account::bitcoin_signer::{is_valid_bitcoin_signature, SECP_256_K1_HALF};
use starknet::secp256_trait::{
    Secp256PointTrait, Signature as Secp256Signature, is_signature_entry_valid, recover_public_key,
};
use starknet::secp256k1::Secp256k1Point;

/// Sanity: SHA256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
#[test]
fn test_sha256_abc() {
    let mut msg: ByteArray = "";
    msg.append_byte(0x61); // a
    msg.append_byte(0x62); // b
    msg.append_byte(0x63); // c
    let h = compute_sha256_byte_array(@msg);
    let [w0, w1, w2, w3, w4, w5, w6, w7] = h;
    assert!(w0 == 0xba7816bf, "w0 mismatch");
    assert!(w1 == 0x8f01cfea, "w1 mismatch");
    assert!(w2 == 0x414140de, "w2 mismatch");
    assert!(w3 == 0x5dae2223, "w3 mismatch");
    assert!(w4 == 0xb00361a3, "w4 mismatch");
    assert!(w5 == 0x96177a9c, "w5 mismatch");
    assert!(w6 == 0xb410ff61, "w6 mismatch");
    assert!(w7 == 0xf20015ad, "w7 mismatch");
}

/// Confirm the 77-byte wrap SHA256 matches the JS side.
/// Inner felt: 0x117e6a01a26dcdb871dfdbb6b28c12c93e75b3a3cf2e154753a4a4f4ab16763
/// JS computed bitcoinMessageDigest(inner) = 79d78d1c97dc9feaad9a818d2fdedb3084ea6ede942bc955fc8726ad38bb33e2
/// Which is double-SHA256. So single SHA256 of the 77-byte wrap would be an intermediate we'd have
/// to recompute; easier to just double-sha256 and compare.
#[test]
fn test_wrap_double_sha256_matches_js() {
    let mut msg: ByteArray = "";
    // "0x18 || Bitcoin Signed Message:\n || 0x33 || STARKNET_ONEKEY_V1: || hash_32B"
    msg.append_byte(0x18);
    msg.append_byte(0x42); msg.append_byte(0x69); msg.append_byte(0x74); msg.append_byte(0x63);
    msg.append_byte(0x6f); msg.append_byte(0x69); msg.append_byte(0x6e); msg.append_byte(0x20);
    msg.append_byte(0x53); msg.append_byte(0x69); msg.append_byte(0x67); msg.append_byte(0x6e);
    msg.append_byte(0x65); msg.append_byte(0x64); msg.append_byte(0x20); msg.append_byte(0x4d);
    msg.append_byte(0x65); msg.append_byte(0x73); msg.append_byte(0x73); msg.append_byte(0x61);
    msg.append_byte(0x67); msg.append_byte(0x65); msg.append_byte(0x3a); msg.append_byte(0x0a);

    msg.append_byte(0x33);

    msg.append_byte(0x53); msg.append_byte(0x54); msg.append_byte(0x41); msg.append_byte(0x52);
    msg.append_byte(0x4b); msg.append_byte(0x4e); msg.append_byte(0x45); msg.append_byte(0x54);
    msg.append_byte(0x5f); msg.append_byte(0x4f); msg.append_byte(0x4e); msg.append_byte(0x45);
    msg.append_byte(0x4b); msg.append_byte(0x45); msg.append_byte(0x59); msg.append_byte(0x5f);
    msg.append_byte(0x56); msg.append_byte(0x31); msg.append_byte(0x3a);

    // hash_32B big-endian: 01 17 e6 a0 1a 26 dc db 87 1d fd bb 6b 28 c1 2c 93 e7 5b 3a 3c f2 e1 54 75 3a 4a 4f 4a b1 67 63
    let bytes: Array<u8> = array![
        0x01, 0x17, 0xe6, 0xa0, 0x1a, 0x26, 0xdc, 0xdb,
        0x87, 0x1d, 0xfd, 0xbb, 0x6b, 0x28, 0xc1, 0x2c,
        0x93, 0xe7, 0x5b, 0x3a, 0x3c, 0xf2, 0xe1, 0x54,
        0x75, 0x3a, 0x4a, 0x4f, 0x4a, 0xb1, 0x67, 0x63,
    ];
    for b in bytes.span() {
        msg.append_byte(*b);
    }
    assert!(msg.len() == 77, "wrap not 77 bytes");

    let first = compute_sha256_byte_array(@msg);
    let [w0, w1, w2, w3, w4, w5, w6, w7] = first;
    let mut second_in: ByteArray = "";
    // Pack as 32 BE bytes
    let pack = array![w0, w1, w2, w3, w4, w5, w6, w7];
    for word in pack.span() {
        let w = *word;
        second_in.append_byte(((w / 0x1000000) % 0x100).try_into().unwrap());
        second_in.append_byte(((w / 0x10000) % 0x100).try_into().unwrap());
        second_in.append_byte(((w / 0x100) % 0x100).try_into().unwrap());
        second_in.append_byte((w % 0x100).try_into().unwrap());
    }
    let second = compute_sha256_byte_array(@second_in);
    let [d0, d1, d2, d3, d4, d5, d6, d7] = second;

    // Expected JS digest: 79d78d1c97dc9feaad9a818d2fdedb3084ea6ede942bc955fc8726ad38bb33e2
    println!("cairo d0..d7 = {:x} {:x} {:x} {:x} {:x} {:x} {:x} {:x}", d0, d1, d2, d3, d4, d5, d6, d7);
    assert!(d0 == 0x79d78d1c, "d0 mismatch");
    assert!(d1 == 0x97dc9fea, "d1 mismatch");
    assert!(d2 == 0xad9a818d, "d2 mismatch");
    assert!(d3 == 0x2fdedb30, "d3 mismatch");
    assert!(d4 == 0x84ea6ede, "d4 mismatch");
    assert!(d5 == 0x942bc955, "d5 mismatch");
    assert!(d6 == 0xfc8726ad, "d6 mismatch");
    assert!(d7 == 0x38bb33e2, "d7 mismatch");
}

/// Reproduce the exact failing deploy-account case.
/// The inner felt = poseidon(TX_TAG, tx_hash) = 0x117e6a01a26dcdb871dfdbb6b28c12c93e75b3a3cf2e154753a4a4f4ab16763
/// Pubkey hash (DEFAULT_TEST_PRIVATE_KEY_A) = 0x6debc3459ef4fa87045dbc7d424486764636eeeef31cdb4870d5d9e9711ba45
/// Signature (from the RPC error):
///   r_low  = 0x21eb5204d1d06a3ad4aec36586db022c
///   r_high = 0xca0e0084e64b2e7f734ca68a638a9d62
///   s_low  = 0x117be8b5c216bb6f2a01330fdeb74207
///   s_high = 0x2034c762a89e9ac28a22fc4acf9ad4a1
///   y_parity = 0
#[test]
fn test_reproduce_failing_deploy_sig() {
    let hash: felt252 =
        0x117e6a01a26dcdb871dfdbb6b28c12c93e75b3a3cf2e154753a4a4f4ab16763;
    let pubkey_hash: felt252 =
        0x6debc3459ef4fa87045dbc7d424486764636eeeef31cdb4870d5d9e9711ba45;

    let r_low: u128 = 0x21eb5204d1d06a3ad4aec36586db022c;
    let r_high: u128 = 0xca0e0084e64b2e7f734ca68a638a9d62;
    let s_low: u128 = 0x117be8b5c216bb6f2a01330fdeb74207;
    let s_high: u128 = 0x2034c762a89e9ac28a22fc4acf9ad4a1;

    let signature = Secp256Signature {
        r: u256 { low: r_low, high: r_high },
        s: u256 { low: s_low, high: s_high },
        y_parity: false,
    };

    let ok = is_valid_bitcoin_signature(hash, pubkey_hash, signature);
    assert!(ok, "Bitcoin signature verification rejected a sig that should validate");
}

/// Recover directly from the known digest + sig, print the point, verify poseidon(x, y).
#[test]
fn test_recover_direct() {
    // Digest = double-SHA256 of the 77-byte wrap for inner felt 0x117e...6763
    // = 79d78d1c97dc9feaad9a818d2fdedb3084ea6ede942bc955fc8726ad38bb33e2
    let d_hi: u128 = 0x79d78d1c97dc9feaad9a818d2fdedb30;
    let d_lo: u128 = 0x84ea6ede942bc955fc8726ad38bb33e2;
    let digest = u256 { low: d_lo, high: d_hi };

    let r_low: u128 = 0x21eb5204d1d06a3ad4aec36586db022c;
    let r_high: u128 = 0xca0e0084e64b2e7f734ca68a638a9d62;
    let s_low: u128 = 0x117be8b5c216bb6f2a01330fdeb74207;
    let s_high: u128 = 0x2034c762a89e9ac28a22fc4acf9ad4a1;

    let sig = Secp256Signature {
        r: u256 { low: r_low, high: r_high },
        s: u256 { low: s_low, high: s_high },
        y_parity: false,
    };
    let p = recover_public_key::<Secp256k1Point>(digest, sig);
    assert!(p.is_some(), "recover returned none");
    let pt = p.unwrap();
    let (x, y) = pt.get_coordinates().unwrap();
    println!("x.high={:x} x.low={:x}", x.high, x.low);
    println!("y.high={:x} y.low={:x}", y.high, y.low);

    // Expected from JS:
    //   pubkey = 048318535b54105d4a7aae60c08fc45f9687181b4fdfc625bd1a753fa7397fed753547f11ca8696646f2f3acb08e31016afac23e630c5d11f59f61fef57b0d2aa5
    //   x = 8318535b54105d4a7aae60c08fc45f9687181b4fdfc625bd1a753fa7397fed75
    //   y = 3547f11ca8696646f2f3acb08e31016afac23e630c5d11f59f61fef57b0d2aa5
    let exp_x = u256 {
        high: 0x8318535b54105d4a7aae60c08fc45f96,
        low: 0x87181b4fdfc625bd1a753fa7397fed75,
    };
    let exp_y = u256 {
        high: 0x3547f11ca8696646f2f3acb08e31016a,
        low: 0xfac23e630c5d11f59f61fef57b0d2aa5,
    };
    println!(
        "expected x.high={:x} x.low={:x}  y.high={:x} y.low={:x}",
        exp_x.high, exp_x.low, exp_y.high, exp_y.low,
    );
    assert!(x == exp_x, "x mismatch");
    assert!(y == exp_y, "y mismatch");

    let got_hash = poseidon_hash_span(
        array![x.low.into(), x.high.into(), y.low.into(), y.high.into()].span(),
    );
    println!("poseidon(x_lo,x_hi,y_lo,y_hi) = {:x}", got_hash);
    assert!(
        got_hash == 0x6debc3459ef4fa87045dbc7d424486764636eeeef31cdb4870d5d9e9711ba45,
        "poseidon pubkey_hash mismatch",
    );
}

/// Run the `is_valid_bitcoin_signature` body inline, printing every step.
#[test]
fn test_inlined_verify() {
    let hash: felt252 =
        0x117e6a01a26dcdb871dfdbb6b28c12c93e75b3a3cf2e154753a4a4f4ab16763;
    let pubkey_hash: felt252 =
        0x6debc3459ef4fa87045dbc7d424486764636eeeef31cdb4870d5d9e9711ba45;

    let hash_u256: u256 = hash.into();
    println!("hash_u256.high={:x} .low={:x}", hash_u256.high, hash_u256.low);

    let mut msg: ByteArray = "";
    msg.append_byte(0x18);
    msg.append_byte(0x42); msg.append_byte(0x69); msg.append_byte(0x74); msg.append_byte(0x63);
    msg.append_byte(0x6f); msg.append_byte(0x69); msg.append_byte(0x6e); msg.append_byte(0x20);
    msg.append_byte(0x53); msg.append_byte(0x69); msg.append_byte(0x67); msg.append_byte(0x6e);
    msg.append_byte(0x65); msg.append_byte(0x64); msg.append_byte(0x20); msg.append_byte(0x4d);
    msg.append_byte(0x65); msg.append_byte(0x73); msg.append_byte(0x73); msg.append_byte(0x61);
    msg.append_byte(0x67); msg.append_byte(0x65); msg.append_byte(0x3a); msg.append_byte(0x0a);
    msg.append_byte(0x33);
    msg.append_byte(0x53); msg.append_byte(0x54); msg.append_byte(0x41); msg.append_byte(0x52);
    msg.append_byte(0x4b); msg.append_byte(0x4e); msg.append_byte(0x45); msg.append_byte(0x54);
    msg.append_byte(0x5f); msg.append_byte(0x4f); msg.append_byte(0x4e); msg.append_byte(0x45);
    msg.append_byte(0x4b); msg.append_byte(0x45); msg.append_byte(0x59); msg.append_byte(0x5f);
    msg.append_byte(0x56); msg.append_byte(0x31); msg.append_byte(0x3a);

    // Inline append_u128_be
    let mut i: u32 = 0;
    loop {
        if i == 16 { break; }
        let shift = 120 - (i * 8);
        let byte: u8 = ((hash_u256.high / pow2_inline(shift)) % 256).try_into().unwrap();
        msg.append_byte(byte);
        i += 1;
    };
    i = 0;
    loop {
        if i == 16 { break; }
        let shift = 120 - (i * 8);
        let byte: u8 = ((hash_u256.low / pow2_inline(shift)) % 256).try_into().unwrap();
        msg.append_byte(byte);
        i += 1;
    };

    println!("msg.len={}", msg.len());
    assert!(msg.len() == 77, "wrap len mismatch");

    let first = compute_sha256_byte_array(@msg);
    let [f0, f1, f2, f3, f4, f5, f6, f7] = first;
    println!("first SHA = {:x} {:x} {:x} {:x} {:x} {:x} {:x} {:x}", f0, f1, f2, f3, f4, f5, f6, f7);

    let mut second: ByteArray = "";
    let w = array![f0, f1, f2, f3, f4, f5, f6, f7];
    for ww in w.span() {
        let v = *ww;
        second.append_byte(((v / 0x1000000) % 0x100).try_into().unwrap());
        second.append_byte(((v / 0x10000) % 0x100).try_into().unwrap());
        second.append_byte(((v / 0x100) % 0x100).try_into().unwrap());
        second.append_byte((v % 0x100).try_into().unwrap());
    }
    let h2 = compute_sha256_byte_array(@second);
    let [d0, d1, d2, d3, d4, d5, d6, d7] = h2;
    println!("double SHA = {:x} {:x} {:x} {:x} {:x} {:x} {:x} {:x}", d0, d1, d2, d3, d4, d5, d6, d7);

    // u256 from [u32; 8]
    let high_f: felt252 = d3.into()
        + d2.into() * 0x1_0000_0000
        + d1.into() * 0x1_0000_0000_0000_0000
        + d0.into() * 0x1_0000_0000_0000_0000_0000_0000;
    let high: u128 = high_f.try_into().unwrap();
    let low_f: felt252 = d7.into()
        + d6.into() * 0x1_0000_0000
        + d5.into() * 0x1_0000_0000_0000_0000
        + d4.into() * 0x1_0000_0000_0000_0000_0000_0000;
    let low: u128 = low_f.try_into().unwrap();
    let digest = u256 { high, low };
    println!("digest.high={:x} digest.low={:x}", digest.high, digest.low);

    let r_low: u128 = 0x21eb5204d1d06a3ad4aec36586db022c;
    let r_high: u128 = 0xca0e0084e64b2e7f734ca68a638a9d62;
    let s_low: u128 = 0x117be8b5c216bb6f2a01330fdeb74207;
    let s_high: u128 = 0x2034c762a89e9ac28a22fc4acf9ad4a1;
    let signature = Secp256Signature {
        r: u256 { low: r_low, high: r_high },
        s: u256 { low: s_low, high: s_high },
        y_parity: false,
    };

    let rec = recover_public_key::<Secp256k1Point>(digest, signature);
    println!("recover is_some = {}", rec.is_some());
    assert!(rec.is_some(), "recover returned None on inlined path");
    let pt = rec.unwrap();
    let (x, y) = pt.get_coordinates().unwrap();
    println!("x.high={:x} .low={:x}", x.high, x.low);
    println!("y.high={:x} .low={:x}", y.high, y.low);

    let got = poseidon_hash_span(
        array![x.low.into(), x.high.into(), y.low.into(), y.high.into()].span(),
    );
    println!("poseidon = {:x}", got);
    assert!(got == pubkey_hash, "poseidon mismatch on inlined path");
}

fn pow2_inline(n: u32) -> u128 {
    if n == 0 { return 1; }
    if n == 8 { return 0x100; }
    if n == 16 { return 0x10000; }
    if n == 24 { return 0x1000000; }
    if n == 32 { return 0x100000000; }
    if n == 40 { return 0x10000000000; }
    if n == 48 { return 0x1000000000000; }
    if n == 56 { return 0x100000000000000; }
    if n == 64 { return 0x10000000000000000; }
    if n == 72 { return 0x1000000000000000000; }
    if n == 80 { return 0x100000000000000000000; }
    if n == 88 { return 0x10000000000000000000000; }
    if n == 96 { return 0x1000000000000000000000000; }
    if n == 104 { return 0x100000000000000000000000000; }
    if n == 112 { return 0x10000000000000000000000000000; }
    if n == 120 { return 0x1000000000000000000000000000000; }
    panic!("unsupported")
}

/// Check the four preconditions of `is_valid_bitcoin_signature` for the failing sig.
#[test]
fn test_preconditions() {
    let r_low: u128 = 0x21eb5204d1d06a3ad4aec36586db022c;
    let r_high: u128 = 0xca0e0084e64b2e7f734ca68a638a9d62;
    let s_low: u128 = 0x117be8b5c216bb6f2a01330fdeb74207;
    let s_high: u128 = 0x2034c762a89e9ac28a22fc4acf9ad4a1;
    let r = u256 { low: r_low, high: r_high };
    let s = u256 { low: s_low, high: s_high };

    let r_valid = is_signature_entry_valid::<Secp256k1Point>(r);
    let s_valid = is_signature_entry_valid::<Secp256k1Point>(s);
    let high_s = s > SECP_256_K1_HALF;
    println!("r_valid={}, s_valid={}, high_s={}", r_valid, s_valid, high_s);
    println!("SECP_HALF.high={:x} .low={:x}", SECP_256_K1_HALF.high, SECP_256_K1_HALF.low);
    println!("s.high={:x}       s.low={:x}", s.high, s.low);
    assert!(r_valid, "r invalid");
    assert!(s_valid, "s invalid");
    assert!(!high_s, "s is high (should already be low-normalized)");
}
