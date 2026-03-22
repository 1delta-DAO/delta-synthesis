/**
 * Settlement order building — Merkle tree, encoding, EIP-712 signing.
 * Mirrors the SDK at packages/sdk/src/settlement/ for frontend use.
 */

import {
  encodePacked,
  keccak256,
  concatHex,
  numberToHex,
  type Address,
  type Hex,
  type WalletClient,
} from 'viem'

// ── Types ───────────────────────────────────────────────────────────────

export const LendingOp = {
  DEPOSIT: 0,
  BORROW: 1,
  REPAY: 2,
  WITHDRAW: 3,
  DEPOSIT_LENDING: 4,
  WITHDRAW_LENDING: 5,
} as const

export type LendingOpCode = (typeof LendingOp)[keyof typeof LendingOp]

export interface MerkleLeaf {
  op: number
  lenderId: number
  data: Hex
  leaf: Hex
  proof: Hex[]
}

export interface Condition {
  type: 'aave'
  lenderId: number
  pool: Address
  minHealthFactor: bigint
}

export interface SignedOrder {
  order: {
    merkleRoot: Hex
    deadline: number
    settlementData: Hex
    orderData: Hex
    executionData: Hex
    fillerCalldata: Hex
    chainId: number
    maxFeeBps: number
    solver: Address
    minSolverReputation: number
    leaves: MerkleLeaf[]
  }
  signature: Hex
  signer: Address
}

// ── Merkle tree ─────────────────────────────────────────────────────────

export function computeLeafHash(op: number, lenderId: number, data: Hex): Hex {
  return keccak256(
    encodePacked(['uint8', 'uint16', 'bytes'], [op, lenderId, data])
  )
}

function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b)
    ? keccak256(encodePacked(['bytes32', 'bytes32'], [a, b]))
    : keccak256(encodePacked(['bytes32', 'bytes32'], [b, a]))
}

export function buildMerkleTree(
  leafInputs: Array<{ op: number; lenderId: number; data: Hex }>
): { root: Hex; leaves: MerkleLeaf[] } {
  if (leafInputs.length === 0) {
    throw new Error('No leaves to build tree from')
  }

  const hashes = leafInputs.map((l) => computeLeafHash(l.op, l.lenderId, l.data))

  if (hashes.length === 1) {
    return {
      root: hashes[0],
      leaves: [{ ...leafInputs[0], leaf: hashes[0], proof: [] }],
    }
  }

  // Pad to next power of 2 with duplicate of last hash
  const n = hashes.length
  let size = 1
  while (size < n) size *= 2
  const padded = [...hashes]
  while (padded.length < size) padded.push(padded[padded.length - 1])

  // Build tree bottom-up, storing all nodes by level
  const levels: Hex[][] = [padded]
  let current = padded
  while (current.length > 1) {
    const next: Hex[] = []
    for (let i = 0; i < current.length; i += 2) {
      next.push(hashPair(current[i], current[i + 1]))
    }
    levels.push(next)
    current = next
  }

  // Extract proofs by walking the tree for each original leaf
  const proofs: Hex[][] = []
  for (let i = 0; i < n; i++) {
    const proof: Hex[] = []
    let idx = i
    for (let level = 0; level < levels.length - 1; level++) {
      const sibling = idx ^ 1 // flip last bit to get sibling
      proof.push(levels[level][sibling])
      idx = idx >> 1 // parent index
    }
    proofs.push(proof)
  }

  const leaves: MerkleLeaf[] = leafInputs.map((l, i) => ({
    ...l,
    leaf: hashes[i],
    proof: proofs[i],
  }))

  return { root: levels[levels.length - 1][0], leaves }
}

// ── Encoding ────────────────────────────────────────────────────────────

export interface Conversion {
  assetIn: Address
  assetOut: Address
  oracle: Address
  /** Tolerance in 1e7 units (e.g. 50000 = 0.5%) */
  swapTolerance: bigint
}

export function encodeSettlementData(conversions: Conversion[], conditions: Condition[]): Hex {
  const parts: Hex[] = []

  // numConversions
  parts.push(numberToHex(conversions.length, { size: 1 }))

  // Each conversion: 20 + 20 + 20 + 8 = 68 bytes
  for (const c of conversions) {
    parts.push(
      encodePacked(
        ['address', 'address', 'address', 'uint64'],
        [c.assetIn, c.assetOut, c.oracle, c.swapTolerance]
      )
    )
  }

  // numConditions
  parts.push(numberToHex(conditions.length, { size: 1 }))

  for (const c of conditions) {
    parts.push(
      encodePacked(
        ['uint16', 'address', 'uint112'],
        [c.lenderId, c.pool, c.minHealthFactor]
      )
    )
  }

  return concatHex(parts)
}

export function encodeOrderData(merkleRoot: Hex, settlementData: Hex): Hex {
  const sdBytes = (settlementData.length - 2) / 2
  return concatHex([merkleRoot, numberToHex(sdBytes, { size: 2 }), settlementData])
}

// ── EIP-712 signing ─────────────────────────────────────────────────────

const veratoOrderTypes = {
  VeratoOrder: [
    { name: 'merkleRoot', type: 'bytes32' },
    { name: 'deadline', type: 'uint48' },
    { name: 'maxFeeBps', type: 'uint256' },
    { name: 'solver', type: 'address' },
    { name: 'minSolverReputation', type: 'uint256' },
    { name: 'settlementData', type: 'bytes' },
  ],
} as const

export async function signVeratoOrder(
  client: WalletClient,
  params: {
    merkleRoot: Hex
    deadline: number
    maxFeeBps: bigint
    solver: Address
    minSolverReputation: bigint
    settlementData: Hex
    veratoAddress: Address
    chainId: number
  }
): Promise<Hex> {
  const account = client.account
  if (!account) throw new Error('WalletClient must have an account')

  return client.signTypedData({
    account,
    domain: {
      name: 'Verato',
      version: '1',
      chainId: BigInt(params.chainId),
      verifyingContract: params.veratoAddress,
    },
    types: veratoOrderTypes,
    primaryType: 'VeratoOrder',
    message: {
      merkleRoot: params.merkleRoot,
      deadline: params.deadline,
      maxFeeBps: params.maxFeeBps,
      solver: params.solver,
      minSolverReputation: params.minSolverReputation,
      settlementData: params.settlementData,
    },
  })
}

// ── High-level builder ──────────────────────────────────────────────────

export interface BuildOrderInput {
  leaves: Array<{ op: number; lenderId: number; data: Hex }>
  conversions?: Conversion[]
  conditions: Condition[]
  maxFeeBps: number
  solver: Address
  minSolverReputation: number
  deadline: number
  chainId: number
  veratoAddress: Address
}

export function buildUnsignedOrder(input: BuildOrderInput) {
  const { root, leaves } = buildMerkleTree(input.leaves)
  const settlementData = encodeSettlementData(input.conversions ?? [], input.conditions)
  const orderData = encodeOrderData(root, settlementData)

  return {
    merkleRoot: root,
    deadline: input.deadline,
    settlementData,
    orderData,
    executionData: '0x' as Hex,
    fillerCalldata: '0x' as Hex,
    chainId: input.chainId,
    maxFeeBps: input.maxFeeBps,
    solver: input.solver,
    minSolverReputation: input.minSolverReputation,
    leaves,
  }
}

export async function buildAndSignOrder(
  client: WalletClient,
  input: BuildOrderInput
): Promise<SignedOrder> {
  const order = buildUnsignedOrder(input)

  const signature = await signVeratoOrder(client, {
    merkleRoot: order.merkleRoot,
    deadline: order.deadline,
    maxFeeBps: BigInt(order.maxFeeBps),
    solver: order.solver,
    minSolverReputation: BigInt(order.minSolverReputation),
    settlementData: order.settlementData,
    veratoAddress: input.veratoAddress,
    chainId: input.chainId,
  })

  return {
    order,
    signature,
    signer: client.account!.address,
  }
}
