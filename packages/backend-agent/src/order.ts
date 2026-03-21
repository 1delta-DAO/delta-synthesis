/**
 * Order backend client and StoredOrder.
 *
 * Decodes merkle leaves to extract:
 *   - Which lenders the user approved (numeric ID → protocol string)
 *   - Pool / aToken / debtToken addresses (Aave)
 *   - Market params (Morpho)
 *
 * Uses LenderRange from the settlement-sdk to map numeric IDs to protocol families.
 */

import { getAddress } from 'viem'
import type { Hex, Address } from 'viem'
import { LenderRange, LendingOp } from '@delta-synthesis/settlement-sdk'

// ─── Types aligned with backend-orders ──────────────────────────────────────

export interface MerkleLeaf {
  op: number
  lenderId: number
  data: Hex
  leaf: Hex
  proof: Hex[]
}

export interface StoredPermit {
  kind: 'ERC2612_PERMIT' | 'AAVE_DELEGATION' | 'AAVE_DELEGATION_TX' | 'MORPHO_AUTHORIZATION'
  targetAddress: Address
  signature: { v: number; r: Hex; s: Hex }
  deadline: string
  nonce: string
}

export interface StoredOrder {
  id: string
  createdAt: number
  status: 'open' | 'filled' | 'cancelled' | 'expired'
  signer: Address
  signature: Hex
  txHash?: string
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
  permits: StoredPermit[]
}

// ─── Numeric lender ID → protocol string ────────────────────────────────────

function fromLenderId(id: number): string {
  if (id >= LenderRange.MORPHO_BLUE.min && id <= LenderRange.MORPHO_BLUE.max) return 'MORPHO_BLUE'
  if (id >= LenderRange.COMPOUND_V2.min && id <= LenderRange.COMPOUND_V2.max) return 'COMPOUND_V2'
  if (id >= LenderRange.COMPOUND_V3.min && id <= LenderRange.COMPOUND_V3.max) return 'COMPOUND_V3'
  if (id >= LenderRange.AAVE_V2.min && id <= LenderRange.AAVE_V2.max) return 'AAVE_V2'
  if (id >= LenderRange.AAVE_V3.min && id <= LenderRange.AAVE_V3.max) return 'AAVE_V3'
  return `UNKNOWN_${id}`
}

// ─── Lender family checks ───────────────────────────────────────────────────

function isAaveLender(id: number): boolean {
  return id <= LenderRange.AAVE_V2.max // 0–1999
}

function isMorphoLender(id: number): boolean {
  return id >= LenderRange.MORPHO_BLUE.min && id <= LenderRange.MORPHO_BLUE.max
}

// ─── Leaf data decoders ─────────────────────────────────────────────────────

function addrAt(data: Hex, byteOffset: number): Address {
  return getAddress(`0x${data.slice(2 + byteOffset * 2, 2 + (byteOffset + 20) * 2)}`)
}

// DEPOSIT: [20: pool]
function decodeAaveDeposit(data: Hex) {
  return { pool: addrAt(data, 0) }
}

// BORROW: [1: mode][20: pool]
function decodeAaveBorrow(data: Hex) {
  const raw = data.slice(2)
  return {
    mode: parseInt(raw.slice(0, 2), 16),
    pool: getAddress(`0x${raw.slice(2, 42)}`),
  }
}

// REPAY: [1: mode][20: debtToken][20: pool]
function decodeAaveRepay(data: Hex) {
  const raw = data.slice(2)
  return {
    mode: parseInt(raw.slice(0, 2), 16),
    debtToken: getAddress(`0x${raw.slice(2, 42)}`),
    pool: getAddress(`0x${raw.slice(42, 82)}`),
  }
}

// WITHDRAW: [20: aToken][20: pool]
function decodeAaveWithdraw(data: Hex) {
  return {
    aToken: addrAt(data, 0),
    pool: addrAt(data, 20),
  }
}

// All Morpho ops: [20: loan][20: coll][20: oracle][20: irm][16: lltv][1: flags][20: morpho]
function decodeMorphoAction(data: Hex) {
  const raw = data.slice(2)
  return {
    loanToken: getAddress(`0x${raw.slice(0, 40)}`),
    collateralToken: getAddress(`0x${raw.slice(40, 80)}`),
    oracle: getAddress(`0x${raw.slice(80, 120)}`),
    irm: getAddress(`0x${raw.slice(120, 160)}`),
    lltv: BigInt(`0x${raw.slice(160, 192)}`),
    flags: parseInt(raw.slice(192, 194), 16),
    morpho: getAddress(`0x${raw.slice(194, 234)}`),
  }
}

// ─── Leaf descriptions for the agent ─────────────────────────────────────────

const OP_NAMES: Record<number, string> = {
  [LendingOp.DEPOSIT]: 'DEPOSIT',
  [LendingOp.BORROW]: 'BORROW',
  [LendingOp.REPAY]: 'REPAY',
  [LendingOp.WITHDRAW]: 'WITHDRAW',
  [LendingOp.DEPOSIT_LENDING]: 'DEPOSIT_LENDING_TOKEN',
  [LendingOp.WITHDRAW_LENDING]: 'WITHDRAW_LENDING_TOKEN',
}

export interface LeafDescription {
  index: number
  op: string
  protocol: string
  lenderId: number
  pool?: string
  aToken?: string
  debtToken?: string
  loanToken?: string
  collateralToken?: string
  lltv?: string
  oracle?: string
  morpho?: string
}

export function describeLeaves(leaves: MerkleLeaf[]): LeafDescription[] {
  return leaves.map((leaf, index) => {
    const protocol = fromLenderId(leaf.lenderId)
    const base: LeafDescription = {
      index,
      op: OP_NAMES[leaf.op] ?? String(leaf.op),
      protocol,
      lenderId: leaf.lenderId,
    }

    if (isAaveLender(leaf.lenderId)) {
      if (leaf.op === LendingOp.DEPOSIT) {
        const d = decodeAaveDeposit(leaf.data)
        return { ...base, pool: d.pool }
      }
      if (leaf.op === LendingOp.BORROW) {
        const d = decodeAaveBorrow(leaf.data)
        return { ...base, pool: d.pool }
      }
      if (leaf.op === LendingOp.REPAY) {
        const d = decodeAaveRepay(leaf.data)
        return { ...base, debtToken: d.debtToken, pool: d.pool }
      }
      if (leaf.op === LendingOp.WITHDRAW) {
        const d = decodeAaveWithdraw(leaf.data)
        return { ...base, aToken: d.aToken, pool: d.pool }
      }
    }

    if (isMorphoLender(leaf.lenderId)) {
      const d = decodeMorphoAction(leaf.data)
      const lltvPct = (Number(d.lltv) / 1e16).toFixed(2) + '%'
      return {
        ...base,
        loanToken: d.loanToken,
        collateralToken: d.collateralToken,
        oracle: d.oracle,
        lltv: lltvPct,
        morpho: d.morpho,
      }
    }

    return base
  })
}

// ─── Backend client ─────────────────────────────────────────────────────────

export async function fetchOpenOrders(
  ordersApiUrl: string,
  chainId: number,
  signer?: Address,
): Promise<StoredOrder[]> {
  const url = new URL(`${ordersApiUrl}/orders`)
  url.searchParams.set('chainId', String(chainId))
  url.searchParams.set('status', 'open')
  if (signer) url.searchParams.set('signer', signer)

  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`Order backend error: ${res.status} ${await res.text()}`)

  return res.json() as Promise<StoredOrder[]>
}

export async function fetchOrder(
  ordersApiUrl: string,
  id: string,
): Promise<StoredOrder> {
  const res = await fetch(`${ordersApiUrl}/orders/${id}`)
  if (!res.ok) throw new Error(`Order backend error: ${res.status} ${await res.text()}`)

  return res.json() as Promise<StoredOrder>
}

export async function markOrderFilled(
  ordersApiUrl: string,
  id: string,
  txHash: string,
): Promise<void> {
  const res = await fetch(`${ordersApiUrl}/orders/${id}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'filled', txHash }),
  })
  if (!res.ok) throw new Error(`Failed to mark order filled: ${res.status} ${await res.text()}`)
}
