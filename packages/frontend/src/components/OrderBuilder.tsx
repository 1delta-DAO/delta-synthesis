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
  type Conversion,
  type BuildOrderInput,
} from '../settlement'
import { getOracleAddress } from '../config/constants'

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

/**
 * Auto-generate pairwise conversions from all unique tokens across selected entries.
 * Each pair gets a conversion in both directions so the solver can swap either way.
 */
function autoConversions(config: CollectedConfig, swapTolerance: bigint): Conversion[] {
  const oracle = getOracleAddress(config.chainId)
  if (oracle === '0x0000000000000000000000000000000000000000') return []

  // Collect all unique underlying token addresses
  const tokens = new Set<string>()
  for (const entry of config.entries) {
    if (entry.protocol === 'aave') {
      const aave = entry as CollectedAaveConfig
      for (const t of aave.tokens) {
        tokens.add(t.underlying.toLowerCase())
      }
    } else if (entry.protocol === 'morpho-market') {
      const m = entry as CollectedMorphoMarket
      tokens.add(m.loanToken.toLowerCase())
      tokens.add(m.collateralToken.toLowerCase())
    }
  }

  const tokenList = [...tokens]
  const conversions: Conversion[] = []

  // Generate all directed pairs
  for (let i = 0; i < tokenList.length; i++) {
    for (let j = 0; j < tokenList.length; j++) {
      if (i === j) continue
      conversions.push({
        assetIn: tokenList[i] as Address,
        assetOut: tokenList[j] as Address,
        oracle,
        swapTolerance,
      })
    }
  }

  return conversions
}

function selectionToLeaves(config: CollectedConfig, chainId: string): LeafInput[] {
  const leaves: LeafInput[] = []
  const seen = new Set<string>()

  for (const entry of config.entries) {
    // ── Aave leaves ─────────────────────────────────────────────────
    if (entry.protocol === 'aave') {
      const aave = entry as CollectedAaveConfig
      const lenderId = lenderIdForFork(aave.fork)
      const pool = getPoolAddress(chainId, aave.fork)

      for (const token of aave.tokens) {
        if (token.collateralToken) {
          const data = encodePacked(['address'], [pool])
          const key = `${LendingOp.DEPOSIT}:${lenderId}:${data}`
          if (!seen.has(key)) {
            seen.add(key)
            leaves.push({ op: LendingOp.DEPOSIT, lenderId, data, label: `Deposit ${token.symbol} (${aave.fork})` })
          }

          const wdData = encodePacked(['address', 'address'], [token.collateralToken as Address, pool])
          const wdKey = `${LendingOp.WITHDRAW}:${lenderId}:${wdData}`
          if (!seen.has(wdKey)) {
            seen.add(wdKey)
            leaves.push({ op: LendingOp.WITHDRAW, lenderId, data: wdData, label: `Withdraw ${token.symbol} (${aave.fork})` })
          }
        }

        if (token.debtToken) {
          // Borrow data: [1: mode][20: pool]
          const brData = encodePacked(['uint8', 'address'], [2, pool])
          const brKey = `${LendingOp.BORROW}:${lenderId}:${brData}`
          if (!seen.has(brKey)) {
            seen.add(brKey)
            leaves.push({ op: LendingOp.BORROW, lenderId, data: brData, label: `Borrow ${token.symbol} (${aave.fork})` })
          }

          // Repay data: [1: mode][20: debtToken][20: pool]
          const rpData = encodePacked(['uint8', 'address', 'address'], [2, token.debtToken as Address, pool])
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
              label: `Permit ${token.symbol} aToken (${aave.fork.replace(/_/g, ' ')})`,
              targetAddress: token.collateralToken as Address,
              chainId,
            })
          }
        }

        if (token.debtToken) {
          const key = `delegation:${token.debtToken}`
          if (!seen.has(key)) {
            seen.add(key)
            // Moola (Aave V2-based) vTokens don't support delegationWithSig,
            // so use an on-chain approveDelegation tx instead
            const usesTx = aave.fork === 'MOOLA'
            requests.push({
              kind: usesTx ? 'AAVE_DELEGATION_TX' : 'AAVE_DELEGATION',
              label: `Delegate ${token.symbol} vToken (${aave.fork.replace(/_/g, ' ')})`,
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
  const [maxFeePct, setMaxFeePct] = useState(0.5) // percentage, converted to 1e7 units internally
  const maxFeeBps = Math.round(maxFeePct * 1e5) // 0.5% → 50000 (1e7 denominator: 100% = 1e7)
  const [swapTolerancePct, setSwapTolerancePct] = useState(0.5) // 0.5% swap tolerance
  const swapTolerance = BigInt(Math.round(swapTolerancePct * 1e5)) // 1e7 denominator
  const [deadlineDays, setDeadlineDays] = useState(7)
  const deadlineMinutes = deadlineDays * 24 * 60

  const chainId = Number(config.chainId)
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
  const leafInputs = useMemo(() => selectionToLeaves(config, config.chainId), [config])

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
        if (entry.protocol === 'aave') {
          const aave = entry as CollectedAaveConfig
          pools.add(getPoolAddress(config.chainId, aave.fork))
        }
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

    const conversions = autoConversions(config, swapTolerance)
    const deadline = Math.floor(Date.now() / 1000) + deadlineMinutes * 60
    const input: BuildOrderInput = {
      leaves: leafInputs,
      conversions,
      conditions,
      maxFeeBps,
      solver: zeroAddress,
      minSolverReputation: minReputation,
      deadline,
      chainId,
      veratoAddress,
    }

    return buildUnsignedOrder(input)
  }, [leafInputs, minHealthFactor, maxFeeBps, deadlineMinutes, minReputation, config, veratoAddress, chainId, swapTolerance])

  // Check which permits are still needed
  const signedLabels = new Set(signedPermissions.map(p => p.request.label))
  const pendingPermits = permissionRequests.filter(r => !signedLabels.has(r.label))
  const allPermitsSigned = pendingPermits.length === 0 && permissionRequests.length > 0

  // Submit: sign order + send to backend
  const handleSubmit = useCallback(async () => {
    if (!preview) return

    const conditions: Condition[] = []
    if (minHealthFactor > 0) {
      for (const entry of config.entries) {
        if (entry.protocol === 'aave') {
          const aave = entry as CollectedAaveConfig
          conditions.push({
            type: 'aave',
            lenderId: lenderIdForFork(aave.fork),
            pool: getPoolAddress(config.chainId, aave.fork),
            minHealthFactor: BigInt(Math.floor(minHealthFactor * 1e18)),
          })
        }
      }
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
  }, [preview, signedPermissions, deadlineMinutes, maxFeeBps, minReputation, minHealthFactor, config, leafInputs, submitOrder])

  if (leafInputs.length === 0) {
    return (
      <div className="text-center py-6 text-gray-500 text-sm">
        Select tokens above to build an order.
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Wallet status */}
      {!isConnected && (
        <div className="flex items-center gap-2 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 animate-fade-in">
          <div className="w-2 h-2 rounded-full bg-gray-600" />
          <span className="text-sm text-gray-400">Connect your wallet using the button in the top right corner</span>
        </div>
      )}

      {/* Merkle leaves — compact chips */}
      <div>
        <h3 className="text-xs font-medium text-gray-500 mb-1.5">
          Permitted Operations <span className="text-gray-600">({leafInputs.length})</span>
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {leafInputs.map((l, i) => (
            <span
              key={i}
              style={{ animationDelay: `${i * 30}ms` }}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium animate-fade-in transition-all duration-200 hover:scale-105 ${OP_COLORS[l.op] ?? 'bg-gray-600/20 text-gray-400'}`}
              title={l.label}
            >
              {OP_NAMES[l.op]}
              <span className="text-[9px] opacity-60">{l.label?.replace(/^(Deposit|Withdraw|Borrow|Repay)\s+/, '').replace(/\s*\(.*\)$/, '')}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Parameters */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'Reputation', value: minReputation, set: setMinReputation, min: 0, step: 1, hint: '0 = any', icon: '\u2605' },
          { label: 'Health Factor', value: minHealthFactor, set: setMinHealthFactor, min: 0, step: 0.1, hint: '0 = skip', icon: '\u2764' },
          { label: 'Max Fee', value: maxFeePct, set: setMaxFeePct, min: 0, step: 0.01, suffix: '%', icon: '\u2696' },
          { label: 'Swap Tolerance', value: swapTolerancePct, set: setSwapTolerancePct, min: 0, step: 0.01, suffix: '%', icon: '\u21C4' },
          { label: 'Deadline', value: deadlineDays, set: setDeadlineDays, min: 1, step: 1, suffix: 'days', icon: '\u23F1' },
        ].map(({ label, value, set, min, step, suffix, hint, icon }) => (
          <div key={label} className="group">
            <label className="flex items-center gap-1 text-[10px] font-medium text-gray-500 mb-0.5 group-focus-within:text-amber-400 transition-colors">
              <span className="text-xs opacity-50">{icon}</span>
              {label}
            </label>
            <div className="relative">
              <input
                type="number"
                value={value}
                onChange={(e) => set(Number(e.target.value))}
                step={step}
                min={min}
                className="w-full bg-gray-900/80 border border-gray-700/60 rounded-md px-2 py-1.5 text-xs text-white font-mono tabular-nums focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/20 transition-all duration-200 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              {suffix && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-gray-500 pointer-events-none">{suffix}</span>
              )}
            </div>
            {hint && <span className="text-[9px] text-gray-600 mt-0.5 block">{hint}</span>}
          </div>
        ))}
      </div>

      {/* Preview */}
      {preview && (
        <div className="animate-slide-down">
          <h3 className="text-sm font-medium text-gray-400 mb-2">Order Preview</h3>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 space-y-1 text-xs font-mono">
            <div><span className="text-gray-500">merkleRoot:</span> <span className="text-emerald-400">{preview.merkleRoot}</span></div>
            <div><span className="text-gray-500">leaves:</span> <span className="text-gray-300">{preview.leaves.length}</span></div>
            <div><span className="text-gray-500">conditions:</span> <span className="text-gray-300">{minHealthFactor > 0 ? `HF ≥ ${minHealthFactor}` : 'none'}</span></div>
            <div><span className="text-gray-500">solver:</span> <span className="text-gray-300">permissionless</span></div>
            <div><span className="text-gray-500">minReputation:</span> <span className="text-gray-300">{minReputation}</span></div>
            <div><span className="text-gray-500">maxFee:</span> <span className="text-gray-300">{maxFeePct.toFixed(2)}%</span></div>
          </div>
        </div>
      )}

      {/* Permission Signatures */}
      {permissionRequests.length > 0 && (
        <div className="animate-slide-down">
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
          <div className="space-y-1.5">
            {permissionRequests.map((req, idx) => {
              const signed = signedPermissions.find(p => p.request.label === req.label)
              const isCurrentlySigning = signingPermission === req.label

              return (
                <div
                  key={req.label}
                  style={{ animationDelay: `${idx * 50}ms` }}
                  className={`flex items-center justify-between rounded-lg border transition-all duration-300 ease-in-out animate-slide-up ${
                    signed
                      ? 'px-2.5 py-1.5 bg-emerald-600/5 border-emerald-500/20'
                      : 'px-3 py-2.5 bg-gray-800/60 border-gray-700/50'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`shrink-0 flex items-center justify-center transition-all duration-300 ${
                      signed ? 'w-4 h-4' : 'w-5 h-5'
                    }`}>
                      {signed ? (
                        <svg className="w-4 h-4 text-emerald-400" viewBox="0 0 16 16" fill="none">
                          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
                          <path d="M4.5 8.5L7 11L11.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : (
                        <span className="w-5 h-5 rounded-full border border-gray-600 bg-gray-800/50" />
                      )}
                    </span>
                    <span className={`truncate transition-all duration-300 ${signed ? 'text-xs text-gray-400' : 'text-sm text-white'}`}>
                      {req.label}
                    </span>
                    {!signed && (
                      <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full ${
                        req.kind === 'ERC2612_PERMIT' ? 'bg-indigo-600/15 text-indigo-400' :
                        req.kind === 'AAVE_DELEGATION' ? 'bg-red-600/15 text-red-400' :
                        req.kind === 'AAVE_DELEGATION_TX' ? 'bg-orange-600/15 text-orange-400' :
                        'bg-violet-600/15 text-violet-400'
                      }`}>
                        {req.kind === 'ERC2612_PERMIT' ? 'Permit' :
                         req.kind === 'AAVE_DELEGATION' ? 'Delegation' :
                         req.kind === 'AAVE_DELEGATION_TX' ? 'Tx' :
                         'Auth'}
                      </span>
                    )}
                  </div>
                  {!signed && (
                    <button
                      onClick={() => signPermission(req)}
                      disabled={!isConnected || isCurrentlySigning}
                      className={`shrink-0 px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-200 ${
                        isCurrentlySigning
                          ? 'bg-gray-700 text-gray-400 cursor-wait'
                          : 'bg-amber-600 hover:bg-amber-500 active:scale-95 text-white shadow-sm shadow-amber-600/20'
                      }`}
                    >
                      {isCurrentlySigning
                        ? (req.kind === 'AAVE_DELEGATION_TX' ? 'Approving...' : 'Signing...')
                        : (req.kind === 'AAVE_DELEGATION_TX' ? 'Approve' : 'Sign')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          {permitError && (
            <div className="mt-2 bg-red-900/30 border border-red-700/50 rounded-lg p-2 text-xs text-red-300 animate-slide-up">
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
          className={`w-full py-2.5 rounded-lg font-medium text-sm animate-slide-up transition-all duration-200 active:scale-[0.98] ${
            signingPermission
              ? 'bg-gray-700 text-gray-400 cursor-wait'
              : 'bg-amber-600 hover:bg-amber-500 text-white shadow-sm shadow-amber-600/20'
          }`}
        >
          {signingPermission ? `Signing: ${signingPermission}` : `Sign All Remaining (${pendingPermits.length})`}
        </button>
      )}

      {/* Submit Order button */}
      <button
        onClick={handleSubmit}
        disabled={submitting || !preview || !isConnected || !allPermitsSigned}
        className={`w-full py-3 rounded-xl font-medium text-sm transition-all duration-200 active:scale-[0.98] ${
          submitting
            ? 'bg-gray-700 text-gray-400 cursor-wait animate-pulse'
            : !isConnected
            ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
            : !allPermitsSigned
            ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
            : 'bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer shadow-md shadow-emerald-600/20 hover:shadow-emerald-500/30'
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
        <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-3 text-sm text-red-300 animate-slide-up">
          {submitError}
        </div>
      )}

      {/* Success */}
      {submitted && (
        <div className="bg-emerald-900/30 border border-emerald-700/50 rounded-lg p-4 space-y-2 animate-slide-up">
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
