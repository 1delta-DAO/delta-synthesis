import { useCallback, useState } from 'react'
import { useAccount, usePublicClient, useWalletClient } from 'wagmi'
import {
  type Address,
  type Hex,
  maxUint256,
  parseSignature,
} from 'viem'

export type PermissionKind =
  | 'ERC2612_PERMIT'         // aToken approve
  | 'AAVE_DELEGATION'        // vToken credit delegation
  | 'MORPHO_AUTHORIZATION'   // Morpho Blue setAuthorization


export interface SignatureResult {
  v: number
  r: Hex
  s: Hex
}

export interface PermissionSignatureRequest {
  kind: PermissionKind
  label: string
  targetAddress: Address  // comet / morpho / aToken / debtToken
  chainId: number
  /** Extra params depending on kind */
  extra?: {
    tokenName?: string
    tokenVersion?: string
  }
}

export interface SignedPermission {
  request: PermissionSignatureRequest
  signature: SignatureResult
  deadline: bigint
  nonce: bigint
}

// ABI fragments for reading nonces
const noncesAbi = [{ name: 'nonces', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }] as const
const nonceAbi = [{ name: 'nonce', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }] as const
const _noncesAbi = [{ name: '_nonces', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }] as const
const nameAbi = [{ name: 'name', type: 'function', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' }] as const

// Default deadline: 1 hour from now
function getDeadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 3600)
}

export function usePermitSignatures(settlementAddress: Address) {
  const { address } = useAccount()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()

  const [signedPermissions, setSignedPermissions] = useState<SignedPermission[]>([])
  const [signing, setSigning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const signPermission = useCallback(async (request: PermissionSignatureRequest) => {
    if (!address || !walletClient || !publicClient) {
      setError('Wallet not connected')
      return
    }

    setSigning(request.label)
    setError(null)

    try {
      const deadline = getDeadline()
      let signature: Hex
      let nonce: bigint

      switch (request.kind) {
        case 'ERC2612_PERMIT': {
          // Read nonce from the token
          nonce = await publicClient.readContract({
            address: request.targetAddress,
            abi: noncesAbi,
            functionName: 'nonces',
            args: [address],
          })

          const tokenName = request.extra?.tokenName ?? await publicClient.readContract({
            address: request.targetAddress,
            abi: nameAbi,
            functionName: 'name',
          })

          signature = await walletClient.signTypedData({
            account: address,
            domain: {
              name: tokenName,
              version: '1',
              chainId: request.chainId,
              verifyingContract: request.targetAddress,
            },
            types: {
              Permit: [
                { name: 'owner', type: 'address' },
                { name: 'spender', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
              ],
            },
            primaryType: 'Permit',
            message: {
              owner: address,
              spender: settlementAddress,
              value: maxUint256,
              nonce,
              deadline,
            },
          })
          break
        }

        case 'MORPHO_AUTHORIZATION': {
          nonce = await publicClient.readContract({
            address: request.targetAddress,
            abi: nonceAbi,
            functionName: 'nonce',
            args: [address],
          })

          signature = await walletClient.signTypedData({
            account: address,
            domain: {
              chainId: request.chainId,
              verifyingContract: request.targetAddress,
            },
            types: {
              Authorization: [
                { name: 'authorizer', type: 'address' },
                { name: 'authorized', type: 'address' },
                { name: 'isAuthorized', type: 'bool' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
              ],
            },
            primaryType: 'Authorization',
            message: {
              authorizer: address,
              authorized: settlementAddress,
              isAuthorized: true,
              nonce,
              deadline,
            },
          })
          break
        }

        case 'AAVE_DELEGATION': {
          // Aave V3 newer deployments use `nonces` (ERC-2612 style);
          // older V3 deployments exposed `_nonces` via mapping auto-getter.
          try {
            nonce = await publicClient.readContract({
              address: request.targetAddress,
              abi: noncesAbi,
              functionName: 'nonces',
              args: [address],
            })
          } catch {
            nonce = await publicClient.readContract({
              address: request.targetAddress,
              abi: _noncesAbi,
              functionName: '_nonces',
              args: [address],
            })
          }
          
          const debtTokenName = request.extra?.tokenName ?? await publicClient.readContract({
            address: request.targetAddress,
            abi: nameAbi,
            functionName: 'name',
          })

          signature = await walletClient.signTypedData({
            account: address,
            domain: {
              name: debtTokenName,
              version: '1',
              chainId: request.chainId,
              verifyingContract: request.targetAddress,
            },
            types: {
              DelegationWithSig: [
                { name: 'delegatee', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
              ],
            },
            primaryType: 'DelegationWithSig',
            message: {
              delegatee: settlementAddress,
              value: maxUint256,
              nonce,
              deadline,
            },
          })
          break
        }
      }

      const parsed = parseSignature(signature)
      const result: SignedPermission = {
        request,
        signature: { v: Number(parsed.v), r: parsed.r, s: parsed.s },
        deadline,
        nonce,
      }

      setSignedPermissions((prev) => [...prev.filter(p => p.request.label !== request.label), result])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signature failed')
    } finally {
      setSigning(null)
    }
  }, [address, walletClient, publicClient, settlementAddress])

  const clearSignatures = useCallback(() => {
    setSignedPermissions([])
    setError(null)
  }, [])

  return {
    signPermission,
    signedPermissions,
    signing,
    error,
    clearSignatures,
  }
}
