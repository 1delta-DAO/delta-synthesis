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
  const proofs: Hex[][] = hashes.map(() => [])

  if (hashes.length === 1) {
    return {
      root: hashes[0],
      leaves: [{ ...leafInputs[0], leaf: hashes[0], proof: [] }],
    }
  }

  let currentLayer = [...hashes]
  let indices = hashes.map((_, i) => i)

  while (currentLayer.length > 1) {
    const nextLayer: Hex[] = []
    const nextIndices: number[] = []

    for (let i = 0; i < currentLayer.length; i += 2) {
      if (i + 1 < currentLayer.length) {
        const parent = hashPair(currentLayer[i], currentLayer[i + 1])
        nextLayer.push(parent)
        proofs[indices[i]].push(currentLayer[i + 1])
        proofs[indices[i + 1]].push(currentLayer[i])
        nextIndices.push(indices[i])
      } else {
        nextLayer.push(currentLayer[i])
        nextIndices.push(indices[i])
      }
    }

    currentLayer = nextLayer
    indices = nextIndices
  }

  const leaves: MerkleLeaf[] = leafInputs.map((l, i) => ({
    ...l,
    leaf: hashes[i],
    proof: proofs[i],
  }))

  return { root: currentLayer[0], leaves }
}

// ── Encoding ────────────────────────────────────────────────────────────

export function encodeSettlementData(conditions: Condition[]): Hex {
  const parts: Hex[] = []

  // numConversions = 0 (frontend doesn't create swaps)
  parts.push(numberToHex(0, { size: 1 }))

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
  const settlementData = encodeSettlementData(input.conditions)
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
