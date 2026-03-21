import { useState, useMemo, useCallback } from 'react'
import { useAccount } from 'wagmi'
import { encodePacked, numberToHex, concatHex, zeroAddress, type Address, type Hex } from 'viem'
import type { CollectedConfig, CollectedAaveConfig, CollectedMorphoMarket } from '../types'
import { getVeratoAddress, getPoolAddress } from '../config/constants'
import { usePermitSignatures, type PermissionSignatureRequest } from '../hooks/usePermitSignatures'
import { useOrderSubmission } from '../hooks/useOrderSubmission'
import {
  LendingOp,
  buildUnsignedOrder,
  type Condition,
  type BuildOrderInput,
} from '../settlement'

// ── Lender IDs for known forks ──────────────────────────────────────────
// Matches DeltaEnums.sol: UP_TO_AAVE_V3=1000, UP_TO_AAVE_V2=2000, ..., UP_TO_MORPHO=5000

const FORK_LENDER_ID: Record<string, number> = {
  AAVE_V3: 0,
  AAVE_V3_LIDO: 0,
  AAVE_V3_ETHERFI: 0,
  MOOLA: 1000,
}

// Morpho lender IDs fall in the 4000-4999 range (UP_TO_COMPOUND_V2 < id < UP_TO_MORPHO)
const MORPHO_LENDER_ID = 4000

function lenderIdForFork(fork: string): number {
  return FORK_LENDER_ID[fork] ?? 0
}

// ── Convert selections → leaf inputs ────────────────────────────────────

interface LeafInput {
  op: number
  lenderId: number
  data: Hex
  label: string
}

/**
 * Encode Morpho market data for Merkle leaf.
 * Layout: [20: loanToken][20: collateralToken][20: oracle][20: irm][16: lltv][1: flags][20: morpho]
 */
function encodeMorphoData(
  loanToken: Address,
  collateralToken: Address,
  oracle: Address,
  irm: Address,
  lltv: string,
  morpho: Address,
  flags: number = 0,
): Hex {
  return concatHex([
    loanToken,                        // 20 bytes
    collateralToken,                  // 20 bytes
    oracle,                           // 20 bytes
    irm,                              // 20 bytes
    numberToHex(BigInt(lltv), { size: 16 }),  // 16 bytes (uint128)
    numberToHex(flags, { size: 1 }),  // 1 byte
    morpho,                           // 20 bytes
  ])
}

function selectionToLeaves(config: CollectedConfig, poolAddress: Address): LeafInput[] {
  const leaves: LeafInput[] = []
  const seen = new Set<string>()

  for (const entry of config.entries) {
    // ── Aave leaves ─────────────────────────────────────────────────
    if (entry.protocol === 'aave') {
      const aave = entry as CollectedAaveConfig
      const lenderId = lenderIdForFork(aave.fork)

      for (const token of aave.tokens) {
        if (token.collateralToken) {
          const data = encodePacked(['address'], [poolAddress])
          const key = `${LendingOp.DEPOSIT}:${lenderId}:${data}`
          if (!seen.has(key)) {
            seen.add(key)
            leaves.push({ op: LendingOp.DEPOSIT, lenderId, data, label: `Deposit ${token.symbol} (${aave.fork})` })
          }

          const wdData = encodePacked(['address', 'address'], [token.collateralToken as Address, poolAddress])
          const wdKey = `${LendingOp.WITHDRAW}:${lenderId}:${wdData}`
          if (!seen.has(wdKey)) {
            seen.add(wdKey)
            leaves.push({ op: LendingOp.WITHDRAW, lenderId, data: wdData, label: `Withdraw ${token.symbol} (${aave.fork})` })
          }
        }

        if (token.debtToken) {
          const brData = encodePacked(['uint8', 'address', 'address'], [2, poolAddress, token.debtToken as Address])
          const brKey = `${LendingOp.BORROW}:${lenderId}:${brData}`
          if (!seen.has(brKey)) {
            seen.add(brKey)
            leaves.push({ op: LendingOp.BORROW, lenderId, data: brData, label: `Borrow ${token.symbol} (${aave.fork})` })
          }

          const rpData = encodePacked(['uint8', 'address', 'address'], [2, poolAddress, token.debtToken as Address])
          const rpKey = `${LendingOp.REPAY}:${lenderId}:${rpData}`
          if (!seen.has(rpKey)) {
            seen.add(rpKey)
            leaves.push({ op: LendingOp.REPAY, lenderId, data: rpData, label: `Repay ${token.symbol} (${aave.fork})` })
          }
        }
      }
    }

    // ── Morpho market leaves ────────────────────────────────────────
    if (entry.protocol === 'morpho-market') {
      const m = entry as CollectedMorphoMarket
      const lenderId = MORPHO_LENDER_ID

      const morphoData = encodeMorphoData(
        m.loanToken as Address,
        m.collateralToken as Address,
        m.oracle as Address,
        m.irm as Address,
        m.lltv,
        m.morphoAddress as Address,
      )

      if (m.selectedCollateral) {
        // DEPOSIT (supply collateral)
        const depKey = `${LendingOp.DEPOSIT}:${lenderId}:${morphoData}`
        if (!seen.has(depKey)) {
          seen.add(depKey)
          leaves.push({ op: LendingOp.DEPOSIT, lenderId, data: morphoData, label: `Deposit collateral (Morpho ${m.loanSymbol})` })
        }

        // WITHDRAW (withdraw collateral)
        const wdKey = `${LendingOp.WITHDRAW}:${lenderId}:${morphoData}`
        if (!seen.has(wdKey)) {
          seen.add(wdKey)
          leaves.push({ op: LendingOp.WITHDRAW, lenderId, data: morphoData, label: `Withdraw collateral (Morpho ${m.loanSymbol})` })
        }
      }

      if (m.selectedDebt) {
        // BORROW
        const brKey = `${LendingOp.BORROW}:${lenderId}:${morphoData}`
        if (!seen.has(brKey)) {
          seen.add(brKey)
          leaves.push({ op: LendingOp.BORROW, lenderId, data: morphoData, label: `Borrow ${m.loanSymbol} (Morpho)` })
        }

        // REPAY
        const rpKey = `${LendingOp.REPAY}:${lenderId}:${morphoData}`
        if (!seen.has(rpKey)) {
          seen.add(rpKey)
          leaves.push({ op: LendingOp.REPAY, lenderId, data: morphoData, label: `Repay ${m.loanSymbol} (Morpho)` })
        }
      }

      // DEPOSIT_LENDING_TOKEN (supply loan token to earn yield)
      if (m.selectedDebt) {
        const dlKey = `${LendingOp.DEPOSIT_LENDING}:${lenderId}:${morphoData}`
        if (!seen.has(dlKey)) {
          seen.add(dlKey)
          leaves.push({ op: LendingOp.DEPOSIT_LENDING, lenderId, data: morphoData, label: `Supply ${m.loanSymbol} (Morpho lending)` })
        }

        const wlKey = `${LendingOp.WITHDRAW_LENDING}:${lenderId}:${morphoData}`
        if (!seen.has(wlKey)) {
          seen.add(wlKey)
          leaves.push({ op: LendingOp.WITHDRAW_LENDING, lenderId, data: morphoData, label: `Withdraw ${m.loanSymbol} (Morpho lending)` })
        }
      }
    }
  }

  return leaves
}

// ── Derive required permission signatures from config ───────────────────

function derivePermissionRequests(
  config: CollectedConfig,
): PermissionSignatureRequest[] {
  const requests: PermissionSignatureRequest[] = []
  const seen = new Set<string>()
  const chainId = Number(config.chainId)

  for (const entry of config.entries) {
    if (entry.protocol === 'aave') {
      const aave = entry as CollectedAaveConfig

      for (const token of aave.tokens) {
        if (token.collateralToken) {
          const key = `permit:${token.collateralToken}`
          if (!seen.has(key)) {
            seen.add(key)
            requests.push({
              kind: 'ERC2612_PERMIT',
              label: `Permit ${token.symbol} aToken`,
              targetAddress: token.collateralToken as Address,
              chainId,
            })
          }
        }

        if (token.debtToken) {
          const key = `delegation:${token.debtToken}`
          if (!seen.has(key)) {
            seen.add(key)
            requests.push({
              kind: 'AAVE_DELEGATION',
              label: `Delegate ${token.symbol} vToken`,
              targetAddress: token.debtToken as Address,
              chainId,
            })
          }
        }
      }
    }

    if (entry.protocol === 'morpho-market') {
      const m = entry as CollectedMorphoMarket
      const key = `morpho:${m.morphoAddress}`
      if (!seen.has(key)) {
        seen.add(key)
        requests.push({
          kind: 'MORPHO_AUTHORIZATION',
          label: `Authorize Morpho Blue`,
          targetAddress: m.morphoAddress as Address,
          chainId,
        })
      }
    }
  }

  return requests
}

// ── Component ───────────────────────────────────────────────────────────

const OP_NAMES = ['Deposit', 'Borrow', 'Repay', 'Withdraw', 'Deposit (lending)', 'Withdraw (lending)']
const OP_COLORS: Record<number, string> = {
  0: 'bg-green-600/20 text-green-400',
  1: 'bg-red-600/20 text-red-400',
  2: 'bg-blue-600/20 text-blue-400',
  3: 'bg-yellow-600/20 text-yellow-400',
}

export default function OrderBuilder({ config }: { config: CollectedConfig }) {
  const { isConnected } = useAccount()

  const [minReputation, setMinReputation] = useState(0)
  const [minHealthFactor, setMinHealthFactor] = useState(1.1)
  const [maxFeeBps, setMaxFeeBps] = useState(50000)
  const [deadlineMinutes, setDeadlineMinutes] = useState(60)

  const chainId = Number(config.chainId)
  const poolAddress = getPoolAddress(config.chainId)
  const veratoAddress = getVeratoAddress(config.chainId)

  // Hooks
  const {
    signPermission,
    signedPermissions,
    signing: signingPermission,
    error: permitError,
    clearSignatures,
  } = usePermitSignatures(veratoAddress)

  const {
    submitOrder,
    submitting,
    submitted,
    error: submitError,
  } = useOrderSubmission(chainId)

  // Derive leaves from selection
  const leafInputs = useMemo(() => selectionToLeaves(config, poolAddress), [config, poolAddress])

  // Derive required permission signatures
  const permissionRequests = useMemo(
    () => derivePermissionRequests(config),
    [config],
  )

  // Build unsigned order for preview
  const preview = useMemo(() => {
    if (leafInputs.length === 0) return null

    const conditions: Condition[] = []
    if (minHealthFactor > 0) {
      const pools = new Set<string>()
      for (const entry of config.entries) {
        if (entry.protocol === 'aave') pools.add(poolAddress)
      }
      for (const pool of pools) {
        conditions.push({
          type: 'aave',
          lenderId: 0,
          pool: pool as Address,
          minHealthFactor: BigInt(Math.floor(minHealthFactor * 1e18)),
        })
      }
    }

    const deadline = Math.floor(Date.now() / 1000) + deadlineMinutes * 60
    const input: BuildOrderInput = {
      leaves: leafInputs,
      conditions,
      maxFeeBps,
      solver: zeroAddress,
      minSolverReputation: minReputation,
      deadline,
      chainId,
      veratoAddress,
    }

    return buildUnsignedOrder(input)
  }, [leafInputs, minHealthFactor, maxFeeBps, deadlineMinutes, minReputation, config, poolAddress, veratoAddress, chainId])

  // Check which permits are still needed
  const signedLabels = new Set(signedPermissions.map(p => p.request.label))
  const pendingPermits = permissionRequests.filter(r => !signedLabels.has(r.label))
  const allPermitsSigned = pendingPermits.length === 0 && permissionRequests.length > 0

  // Submit: sign order + send to backend
  const handleSubmit = useCallback(async () => {
    if (!preview) return

    const conditions: Condition[] = []
    if (minHealthFactor > 0) {
      conditions.push({
        type: 'aave',
        lenderId: 0,
        pool: poolAddress,
        minHealthFactor: BigInt(Math.floor(minHealthFactor * 1e18)),
      })
    }

    await submitOrder({
      merkleRoot: preview.merkleRoot,
      settlementData: preview.settlementData,
      orderData: preview.orderData,
      leaves: preview.leaves.map(l => ({
        ...l,
        label: leafInputs.find(li => li.op === l.op && li.lenderId === l.lenderId)?.label ?? '',
      })),
      permits: signedPermissions,
      deadlineSeconds: deadlineMinutes * 60,
      maxFeeBps,
      solver: zeroAddress,
      minSolverReputation: minReputation,
    })
  }, [preview, signedPermissions, deadlineMinutes, maxFeeBps, minReputation, minHealthFactor, poolAddress, leafInputs, submitOrder])

  if (leafInputs.length === 0) {
    return (
      <div className="text-center py-6 text-gray-500 text-sm">
        Select tokens above to build an order.
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Wallet status */}
      {!isConnected && (
        <div className="flex items-center gap-2 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
          <div className="w-2 h-2 rounded-full bg-gray-600" />
          <span className="text-sm text-gray-400">Connect your wallet using the button in the top right corner</span>
        </div>
      )}

      {/* Merkle leaves */}
      <div>
        <h3 className="text-sm font-medium text-gray-400 mb-2">
          Approved Actions ({leafInputs.length} leaves)
        </h3>
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {leafInputs.map((l, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-1.5 bg-gray-800/60 rounded text-xs">
              <span className={`px-1.5 py-0.5 rounded font-medium ${OP_COLORS[l.op] ?? 'bg-gray-600/20 text-gray-400'}`}>
                {OP_NAMES[l.op]}
              </span>
              <span className="text-gray-300">{l.label}</span>
              <span className="text-gray-600 ml-auto font-mono">L{l.lenderId}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Parameters */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Min Solver Reputation</label>
          <input
            type="number"
            value={minReputation}
            onChange={(e) => setMinReputation(Number(e.target.value))}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white"
            min={0}
          />
          <span className="text-xs text-gray-600">0 = permissionless</span>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Min Health Factor</label>
          <input
            type="number"
            step="0.1"
            value={minHealthFactor}
            onChange={(e) => setMinHealthFactor(Number(e.target.value))}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white"
            min={0}
          />
          <span className="text-xs text-gray-600">0 = no HF check</span>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Max Fee (1e7 units)</label>
          <input
            type="number"
            value={maxFeeBps}
            onChange={(e) => setMaxFeeBps(Number(e.target.value))}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white"
            min={0}
          />
          <span className="text-xs text-gray-600">50000 = 0.5%</span>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Deadline (minutes)</label>
          <input
            type="number"
            value={deadlineMinutes}
            onChange={(e) => setDeadlineMinutes(Number(e.target.value))}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white"
            min={1}
          />
          <span className="text-xs text-gray-600">From now</span>
        </div>
      </div>

      {/* Preview */}
      {preview && (
        <div>
          <h3 className="text-sm font-medium text-gray-400 mb-2">Order Preview</h3>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 space-y-1 text-xs font-mono">
            <div><span className="text-gray-500">merkleRoot:</span> <span className="text-emerald-400">{preview.merkleRoot}</span></div>
            <div><span className="text-gray-500">leaves:</span> <span className="text-gray-300">{preview.leaves.length}</span></div>
            <div><span className="text-gray-500">conditions:</span> <span className="text-gray-300">{minHealthFactor > 0 ? `HF ≥ ${minHealthFactor}` : 'none'}</span></div>
            <div><span className="text-gray-500">solver:</span> <span className="text-gray-300">permissionless</span></div>
            <div><span className="text-gray-500">minReputation:</span> <span className="text-gray-300">{minReputation}</span></div>
            <div><span className="text-gray-500">maxFee:</span> <span className="text-gray-300">{(maxFeeBps / 1e5).toFixed(2)}%</span></div>
          </div>
        </div>
      )}

      {/* Permission Signatures */}
      {permissionRequests.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-amber-400">
              Required Signatures ({signedPermissions.length}/{permissionRequests.length})
            </h3>
            {signedPermissions.length > 0 && (
              <button
                onClick={clearSignatures}
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                Clear all
              </button>
            )}
          </div>
          <div className="space-y-2">
            {permissionRequests.map((req) => {
              const signed = signedPermissions.find(p => p.request.label === req.label)
              const isCurrentlySigning = signingPermission === req.label

              return (
                <div
                  key={req.label}
                  className={`flex items-center justify-between px-3 py-2.5 rounded-lg border transition-colors ${
                    signed
                      ? 'bg-emerald-600/10 border-emerald-500/30'
                      : 'bg-gray-800/60 border-gray-700/50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${signed ? 'bg-emerald-400' : 'bg-gray-600'}`} />
                    <div>
                      <span className="text-sm text-white">{req.label}</span>
                      <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${
                        req.kind === 'ERC2612_PERMIT' ? 'bg-indigo-600/20 text-indigo-400' :
                        req.kind === 'AAVE_DELEGATION' ? 'bg-red-600/20 text-red-400' :
                        'bg-violet-600/20 text-violet-400'
                      }`}>
                        {req.kind === 'ERC2612_PERMIT' ? 'Permit' :
                         req.kind === 'AAVE_DELEGATION' ? 'Delegation' :
                         'Authorization'}
                      </span>
                    </div>
                  </div>
                  {signed ? (
                    <span className="text-xs text-emerald-400">Signed</span>
                  ) : (
                    <button
                      onClick={() => signPermission(req)}
                      disabled={!isConnected || isCurrentlySigning}
                      className={`px-3 py-1 text-xs rounded transition-colors ${
                        isCurrentlySigning
                          ? 'bg-gray-700 text-gray-400 cursor-wait'
                          : 'bg-amber-600 hover:bg-amber-500 text-white'
                      }`}
                    >
                      {isCurrentlySigning ? 'Signing...' : 'Sign'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          {permitError && (
            <div className="mt-2 bg-red-900/30 border border-red-700/50 rounded-lg p-2 text-xs text-red-300">
              {permitError}
            </div>
          )}
        </div>
      )}

      {/* Sign All Remaining button */}
      {pendingPermits.length > 1 && isConnected && (
        <button
          onClick={async () => {
            for (const req of pendingPermits) {
              await signPermission(req)
            }
          }}
          disabled={!!signingPermission}
          className={`w-full py-2 rounded-lg font-medium text-sm transition-colors ${
            signingPermission
              ? 'bg-gray-700 text-gray-400 cursor-wait'
              : 'bg-amber-600 hover:bg-amber-500 text-white'
          }`}
        >
          {signingPermission ? `Signing: ${signingPermission}` : `Sign All Remaining (${pendingPermits.length})`}
        </button>
      )}

      {/* Submit Order button */}
      <button
        onClick={handleSubmit}
        disabled={submitting || !preview || !isConnected || !allPermitsSigned}
        className={`w-full py-3 rounded-lg font-medium text-sm transition-colors ${
          submitting
            ? 'bg-gray-700 text-gray-400 cursor-wait'
            : !isConnected
            ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
            : !allPermitsSigned
            ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
            : 'bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer'
        }`}
      >
        {submitting
          ? 'Signing & Submitting...'
          : !isConnected
          ? 'Connect Wallet First'
          : !allPermitsSigned
          ? `Sign ${pendingPermits.length} Permission${pendingPermits.length > 1 ? 's' : ''} First`
          : 'Sign Order & Submit'}
      </button>

      {submitError && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-3 text-sm text-red-300">
          {submitError}
        </div>
      )}

      {/* Success */}
      {submitted && (
        <div className="bg-emerald-900/30 border border-emerald-700/50 rounded-lg p-4 space-y-2">
          <h3 className="text-sm font-medium text-emerald-400">Order Submitted</h3>
          <div className="text-xs font-mono text-gray-300">
            <div>ID: {submitted.id}</div>
            <div>Status: {submitted.status}</div>
          </div>
        </div>
      )}
    </div>
  )
}
