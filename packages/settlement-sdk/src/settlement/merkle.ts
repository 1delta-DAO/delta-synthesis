import { encodePacked, keccak256, type Hex } from "viem";
import type { MerkleLeaf, MerkleAction, LendingOpCode } from "./types.js";

/**
 * Compute a Merkle leaf hash from a lending operation.
 * Mirrors the on-chain formula: keccak256(abi.encodePacked(op, lender, data))
 */
export function computeLeaf(leaf: MerkleLeaf): Hex {
  return keccak256(
    encodePacked(
      ["uint8", "uint16", "bytes"],
      [leaf.op, leaf.lenderId, leaf.data]
    )
  );
}

/**
 * Hash a pair of nodes — sorts them (smaller first) to match Solidity's
 * canonical Merkle tree ordering.
 */
export function hashPair(a: Hex, b: Hex): Hex {
  const aBig = BigInt(a);
  const bBig = BigInt(b);
  return aBig < bBig
    ? keccak256(encodePacked(["bytes32", "bytes32"], [a, b]))
    : keccak256(encodePacked(["bytes32", "bytes32"], [b, a]));
}

/**
 * Build a Merkle tree from an array of leaves.
 * Returns { root, proofs } where proofs[i] is the proof for leaves[i].
 */
export function buildMerkleTree(leaves: MerkleLeaf[]): {
  root: Hex;
  hashes: Hex[];
  proofs: Hex[][];
} {
  if (leaves.length === 0) {
    throw new Error("Cannot build Merkle tree from zero leaves");
  }

  const hashes = leaves.map(computeLeaf);

  if (hashes.length === 1) {
    return { root: hashes[0], hashes, proofs: [[]] };
  }

  // Build tree layers bottom-up, tracking proofs
  const proofs: Hex[][] = hashes.map(() => []);
  let currentLayer = [...hashes];
  let indices = hashes.map((_, i) => i);

  while (currentLayer.length > 1) {
    const nextLayer: Hex[] = [];
    const nextIndices: number[] = [];

    for (let i = 0; i < currentLayer.length; i += 2) {
      if (i + 1 < currentLayer.length) {
        const parent = hashPair(currentLayer[i], currentLayer[i + 1]);
        nextLayer.push(parent);
        // Both children need the sibling as proof
        proofs[indices[i]].push(currentLayer[i + 1]);
        proofs[indices[i + 1]].push(currentLayer[i]);
        nextIndices.push(indices[i]);
      } else {
        // Odd node — promoted without pairing
        nextLayer.push(currentLayer[i]);
        nextIndices.push(indices[i]);
      }
    }

    currentLayer = nextLayer;
    indices = nextIndices;
  }

  return { root: currentLayer[0], hashes, proofs };
}

/**
 * Convenience: build leaves from an array of action descriptors,
 * returning the Merkle root and the actions enriched with proofs.
 */
export function buildOrderActions(
  actions: Array<{
    asset: `0x${string}`;
    amount: bigint;
    receiver: `0x${string}`;
    op: LendingOpCode;
    lenderId: number;
    data: Hex;
  }>
): { root: Hex; actions: MerkleAction[] } {
  const leaves: MerkleLeaf[] = actions.map((a) => ({
    op: a.op,
    lenderId: a.lenderId,
    data: a.data,
  }));

  const { root, proofs } = buildMerkleTree(leaves);

  const enriched: MerkleAction[] = actions.map((a, i) => ({
    ...a,
    proof: proofs[i],
  }));

  return { root, actions: enriched };
}
