import { useCallback, useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import type { Address, Hex } from 'viem'
import { VERATO_ADDRESSES, ORDER_BACKEND_URL } from '../config/constants'
import type { SignedPermission } from './usePermitSignatures'

export interface GeneratedLeaf {
  leaf: Hex
  op: number
  lenderId: number
  data: Hex
  label: string
  proof: Hex[]
}

// EIP-712 typed data matching Verato contract
const VERATO_ORDER_TYPES = {
  VeratoOrder: [
    { name: 'merkleRoot', type: 'bytes32' },
    { name: 'deadline', type: 'uint48' },
    { name: 'maxFeeBps', type: 'uint256' },
    { name: 'solver', type: 'address' },
    { name: 'minSolverReputation', type: 'uint256' },
    { name: 'settlementData', type: 'bytes' },
  ],
} as const

interface SubmitOrderParams {
  merkleRoot: Hex
  settlementData: Hex
  orderData: Hex
  leaves: GeneratedLeaf[]
  permits: SignedPermission[]
  deadlineSeconds?: number
  maxFeeBps?: number
  solver?: Address
  minSolverReputation?: number
}

interface SubmittedOrder {
  id: string
  status: string
}

export function useOrderSubmission(chainId: number | null) {
  const { address } = useAccount()
  const { data: walletClient } = useWalletClient()
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState<SubmittedOrder | null>(null)
  const [error, setError] = useState<string | null>(null)

  const settlementAddress = chainId ? VERATO_ADDRESSES[String(chainId)] : undefined

  const submitOrder = useCallback(async (params: SubmitOrderParams) => {
    if (!walletClient || !address || !chainId || !settlementAddress) {
      setError('Wallet not connected or chain not supported')
      return
    }

    setSubmitting(true)
    setError(null)
    setSubmitted(null)

    try {
      const deadline = Math.floor(Date.now() / 1000) + (params.deadlineSeconds ?? 3600)
      const maxFeeBps = params.maxFeeBps ?? 0
      const solver = params.solver ?? '0x0000000000000000000000000000000000000000'
      const minSolverReputation = params.minSolverReputation ?? 0

      // Sign the EIP-712 order (matching Verato contract)
      const signature = await walletClient.signTypedData({
        domain: {
          name: 'Verato',
          version: '1',
          chainId: BigInt(chainId),
          verifyingContract: settlementAddress,
        },
        types: VERATO_ORDER_TYPES,
        primaryType: 'VeratoOrder',
        message: {
          merkleRoot: params.merkleRoot,
          deadline,
          maxFeeBps: BigInt(maxFeeBps),
          solver,
          minSolverReputation: BigInt(minSolverReputation),
          settlementData: params.settlementData,
        },
      })

      // Build backend payload
      const backendLeaves = params.leaves.map(l => ({
        op: l.op,
        lenderId: l.lenderId,
        data: l.data,
        leaf: l.leaf,
        proof: l.proof,
      }))

      const body = {
        order: {
          merkleRoot: params.merkleRoot,
          deadline,
          settlementData: params.settlementData,
          orderData: params.orderData,
          executionData: '0x' as Hex,
          fillerCalldata: '0x' as Hex,
          chainId,
          maxFeeBps,
          solver,
          minSolverReputation,
          leaves: backendLeaves,
        },
        signature,
        signer: address,
        permits: params.permits.map(p => ({
          kind: p.request.kind,
          targetAddress: p.request.targetAddress,
          signature: p.signature,
          deadline: p.deadline.toString(),
          nonce: p.nonce.toString(),
        })),
      }

      const res = await fetch(`${ORDER_BACKEND_URL}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(err.error || `HTTP ${res.status}`)
      }

      const result = await res.json() as SubmittedOrder
      setSubmitted(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }, [walletClient, address, chainId, settlementAddress])

  return { submitOrder, submitting, submitted, error, settlementAddress }
}
