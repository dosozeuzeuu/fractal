// fractal — the `transact` circuit (v2: multi-token, private swaps).
//
// Every private action (send, withdraw, swap, payment-link claim) is one proof of this circuit.
// It spends three notes and creates three, in two lanes:
//
//   main lane  in[0], in[1]  →  out[0], out[1]     notes of `token` (any listed token, or ETH = 0)
//   gas lane   in[2]         →  out[2]             ETH notes, so a token transfer can still pay gas
//
//   token == ETH:  in0 + in1 + in2 == out0 + out1 + out2 + exit + swap + gas
//   token != ETH:  in0 + in1       == out0 + out1        + exit + swap
//                  in2             == out2                            + gas
//
// `swap_amount` of `token` leaves the notes to be swapped by the vault; the vault then creates the
// output note itself as H(1, swap_out_stub, amountOut, tokenOut) once the swap's amount is known.
//
// Hashes (H = Poseidon2 over BN254, sponge as in noir-lang/poseidon):
//   opk        = H(nk, x_hi, x_lo, y_hi, y_lo)          owner key, binds the wallet key
//   stub       = H(opk, rho, r)                          what the payer knows
//   commitment = H(1, stub, amount, token)               leaf in the note tree
//   nullifier  = H(2, nk, commitment, index)             published when the note is spent
//   node       = H(left, right)                          note tree, depth 24
//   tx         = H(root, nf0, nf1, nf2, cm0, cm1, cm2, token, exit, swap, swap_out_stub, gas, ext)

use keccak256::keccak256;
use poseidon::poseidon2::Poseidon2;

pub global DEPTH: u32 = 24;
pub global N_IN: u32 = 3;
pub global N_OUT: u32 = 3;

// keccak256("Spend(bytes32 transaction)")
global SPEND_TYPEHASH: [u8; 32] = [
    0x2b, 0xca, 0xd2, 0x2c, 0xcc, 0xb2, 0xbc, 0x24, 0x44, 0xab, 0xf8, 0x83, 0xe6, 0xdb, 0x15, 0xb1,
    0x3f, 0x0d, 0x67, 0x67, 0x72, 0x22, 0xf1, 0xa9, 0xe4, 0x70, 0xf0, 0x95, 0x2f, 0x22, 0xb2, 0xdd,
];

pub fn h<let N: u32>(input: [Field; N]) -> Field {
    Poseidon2::hash(input, N)
}

fn bytes_to_field<let N: u32>(bytes: [u8; N]) -> Field {
    let mut acc: Field = 0;
    for i in 0..N {
        acc = acc * 256 + bytes[i] as Field;
    }
    acc
}

/// Splits a 32-byte big-endian value into (hi, lo) 128-bit limbs.
fn limbs(bytes: [u8; 32]) -> (Field, Field) {
    let mut hi: [u8; 16] = [0; 16];
    let mut lo: [u8; 16] = [0; 16];
    for i in 0..16 {
        hi[i] = bytes[i];
        lo[i] = bytes[16 + i];
    }
    (bytes_to_field(hi), bytes_to_field(lo))
}

pub fn owner_key(nk: Field, pk_x: [u8; 32], pk_y: [u8; 32]) -> Field {
    let (x_hi, x_lo) = limbs(pk_x);
    let (y_hi, y_lo) = limbs(pk_y);
    h([nk, x_hi, x_lo, y_hi, y_lo])
}

pub fn note_stub(opk: Field, rho: Field, r: Field) -> Field {
    h([opk, rho, r])
}

pub fn note_commitment(stub: Field, amount: Field, token: Field) -> Field {
    h([1, stub, amount, token])
}

pub fn note_nullifier(nk: Field, commitment: Field, index: Field) -> Field {
    h([2, nk, commitment, index])
}

pub fn merkle_root(leaf: Field, index: Field, path: [Field; DEPTH]) -> Field {
    // to_le_bits also constrains index < 2^DEPTH
    let bits: [bool; DEPTH] = index.to_le_bits();
    let mut node = leaf;
    for i in 0..DEPTH {
        let sibling = path[i];
        node = if bits[i] { h([sibling, node]) } else { h([node, sibling]) };
    }
    node
}

pub fn spend_digest(transaction: Field, domain_hi: Field, domain_lo: Field) -> [u8; 32] {
    let tx_bytes: [u8; 32] = transaction.to_be_bytes();
    let mut struct_input: [u8; 64] = [0; 64];
    for i in 0..32 {
        struct_input[i] = SPEND_TYPEHASH[i];
        struct_input[32 + i] = tx_bytes[i];
    }
    let struct_hash = keccak256(struct_input, 64);

    let hi: [u8; 16] = domain_hi.to_be_bytes();
    let lo: [u8; 16] = domain_lo.to_be_bytes();
    let mut digest_input: [u8; 66] = [0; 66];
    digest_input[0] = 0x19;
    digest_input[1] = 0x01;
    for i in 0..16 {
        digest_input[2 + i] = hi[i];
        digest_input[18 + i] = lo[i];
    }
    for i in 0..32 {
        digest_input[34 + i] = struct_hash[i];
    }
    keccak256(digest_input, 66)
}

fn main(
    // ---- public inputs (order matters: it is the order PrivateVault builds) ----
    root: pub Field,
    nullifiers: pub [Field; N_IN],
    out_commitments: pub [Field; N_OUT],
    token: pub Field,
    exit_amount: pub Field,
    swap_amount: pub Field,
    swap_out_stub: pub Field,
    gas_fee: pub Field,
    ext_data_hash: pub Field,
    domain_hi: pub Field,
    domain_lo: pub Field,
    // ---- private inputs ----
    in_nk: [Field; N_IN],
    in_rho: [Field; N_IN],
    in_r: [Field; N_IN],
    in_amount: [Field; N_IN],
    in_index: [Field; N_IN],
    in_path: [[Field; DEPTH]; N_IN],
    out_stub: [Field; N_OUT],
    out_amount: [Field; N_OUT],
    pk_x: [u8; 32],
    pk_y: [u8; 32],
    signature: [u8; 64],
) {
    token.assert_max_bit_size::<160>(); // an address, or 0 for ETH

    // Inputs: membership (unless a zero-value dummy) and nullifiers. Lane 2 is always ETH.
    for i in 0..N_IN {
        in_amount[i].assert_max_bit_size::<120>();
        let note_token = if i == 2 { 0 } else { token };
        let opk = owner_key(in_nk[i], pk_x, pk_y);
        let cm = note_commitment(note_stub(opk, in_rho[i], in_r[i]), in_amount[i], note_token);
        let computed_root = merkle_root(cm, in_index[i], in_path[i]);
        if in_amount[i] != 0 {
            assert(computed_root == root, "input note not in tree");
        }
        assert(nullifiers[i] == note_nullifier(in_nk[i], cm, in_index[i]), "bad nullifier");
    }
    assert(nullifiers[0] != nullifiers[1], "duplicate nullifier");
    assert(nullifiers[0] != nullifiers[2], "duplicate nullifier");
    assert(nullifiers[1] != nullifiers[2], "duplicate nullifier");

    // Outputs.
    for j in 0..N_OUT {
        out_amount[j].assert_max_bit_size::<120>();
        let note_token = if j == 2 { 0 } else { token };
        assert(
            out_commitments[j] == note_commitment(out_stub[j], out_amount[j], note_token),
            "bad commitment",
        );
    }

    // Conservation of value, per lane. 120-bit ranges keep every sum far below p.
    exit_amount.assert_max_bit_size::<120>();
    swap_amount.assert_max_bit_size::<120>();
    gas_fee.assert_max_bit_size::<120>();
    if swap_amount == 0 {
        assert(swap_out_stub == 0, "swap stub without a swap");
    }
    let main_in = in_amount[0] + in_amount[1];
    let main_out = out_amount[0] + out_amount[1] + exit_amount + swap_amount;
    if token == 0 {
        assert(main_in + in_amount[2] == main_out + out_amount[2] + gas_fee, "value not conserved");
    } else {
        assert(main_in == main_out, "token value not conserved");
        assert(in_amount[2] == out_amount[2] + gas_fee, "gas value not conserved");
    }

    // Authorization: the wallet key hashed into every input's owner key signed exactly this
    // transaction under this vault's EIP-712 domain.
    domain_hi.assert_max_bit_size::<128>();
    domain_lo.assert_max_bit_size::<128>();
    let transaction = h([
        root,
        nullifiers[0],
        nullifiers[1],
        nullifiers[2],
        out_commitments[0],
        out_commitments[1],
        out_commitments[2],
        token,
        exit_amount,
        swap_amount,
        swap_out_stub,
        gas_fee,
        ext_data_hash,
    ]);
    let digest = spend_digest(transaction, domain_hi, domain_lo);
    assert(
        std::ecdsa_secp256k1::verify_signature(pk_x, pk_y, signature, digest),
        "bad spend signature",
    );
}

#[test]
fn test_hash_vectors() {
    // Pinned so the TypeScript SDK and Solidity can be checked against the same values.
    assert(h([1, 2]) == 0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383);
}

#[test]
fn test_token_changes_commitment() {
    assert(note_commitment(5, 7, 0) != note_commitment(5, 7, 1));
}
