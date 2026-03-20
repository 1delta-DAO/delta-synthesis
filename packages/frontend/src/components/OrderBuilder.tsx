import { useState, useMemo, useCallback } from 'react'
import { encodePacked, createWalletClient, custom, zeroAddress, type Address, type Hex } from 'viem'
import { celo } from 'viem/chains'
import type { CollectedConfig, CollectedAaveConfig } from '../types'
import {
  LendingOp,
  buildUnsignedOrder,
  buildAndSignOrder,
  type MerkleLeaf,
  type Condition,
  type SignedOrder,
  type BuildOrderInput,
} from '../settlement'

// ── Lender IDs for known forks ──────────────────────────────────────────

const FORK_LENDER_ID: Record<string, number> = {
  AAVE_V3: 0,
  AAVE_V3_LIDO: 0,
  AAVE_V3_ETHERFI: 0,
  MOOLA: 1000,
}

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

function selectionToLeaves(config: CollectedConfig, poolAddress: Address): LeafInput[] {
  const leaves: LeafInput[] = []
  const seen = new Set<string>()

  for (const entry of config.entries) {
    if (entry.protocol !== 'aave') continue
    const aave = entry as CollectedAaveConfig
    const lenderId = lenderIdForFork(aave.fork)

    for (const token of aave.tokens) {
      if (token.collateralToken) {
        // DEPOSIT: user deposits collateral → data = abi.encodePacked(pool)
        const data = encodePacked(['address'], [poolAddress])
        const key = `${LendingOp.DEPOSIT}:${lenderId}:${data}`
        if (!seen.has(key)) {
          seen.add(key)
          leaves.push({
            op: LendingOp.DEPOSIT,
            lenderId,
            data,
            label: `Deposit ${token.symbol} (${aave.fork})`,
          })
        }

        // WITHDRAW: data = abi.encodePacked(aToken, pool)
        const wdData = encodePacked(
          ['address', 'address'],
          [token.collateralToken as Address, poolAddress]
        )
        const wdKey = `${LendingOp.WITHDRAW}:${lenderId}:${wdData}`
        if (!seen.has(wdKey)) {
          seen.add(wdKey)
          leaves.push({
            op: LendingOp.WITHDRAW,
            lenderId,
            data: wdData,
            label: `Withdraw ${token.symbol} (${aave.fork})`,
          })
        }
      }

      if (token.debtToken) {
        // BORROW: data = abi.encodePacked(uint8(2), pool, debtToken) — rateMode=2 (variable)
        const brData = encodePacked(
          ['uint8', 'address', 'address'],
          [2, poolAddress, token.debtToken as Address]
        )
        const brKey = `${LendingOp.BORROW}:${lenderId}:${brData}`
        if (!seen.has(brKey)) {
          seen.add(brKey)
          leaves.push({
            op: LendingOp.BORROW,
            lenderId,
            data: brData,
            label: `Borrow ${token.symbol} (${aave.fork})`,
          })
        }

        // REPAY: data = abi.encodePacked(uint8(2), pool, debtToken) — rateMode=2
        const rpData = encodePacked(
          ['uint8', 'address', 'address'],
          [2, poolAddress, token.debtToken as Address]
        )
        const rpKey = `${LendingOp.REPAY}:${lenderId}:${rpData}`
        if (!seen.has(rpKey)) {
          seen.add(rpKey)
          leaves.push({
            op: LendingOp.REPAY,
            lenderId,
            data: rpData,
            label: `Repay ${token.symbol} (${aave.fork})`,
          })
        }
      }
    }
  }

  return leaves
}

// ── Pool addresses per chain ────────────────────────────────────────────

const POOL_ADDRESSES: Record<string, Address> = {
  '42220': '0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402', // Celo Aave V3
  '1':     '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',  // Ethereum
  '10':    '0x794a61358D6845594F94dc1DB02A252b5b4814aD',   // Optimism
  '137':   '0x794a61358D6845594F94dc1DB02A252b5b4814aD',   // Polygon
  '42161': '0x794a61358D6845594F94dc1DB02A252b5b4814aD',   // Arbitrum
  '8453':  '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',   // Base
  '43114': '0x794a61358D6845594F94dc1DB02A252b5b4814aD',   // Avalanche
  '56':    '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',    // BNB
}

// ── Verato addresses (deployed) ─────────────────────────────────────────

const VERATO_ADDRESSES: Record<string, Address> = {
  '42220': zeroAddress, // Placeholder — replace with actual deployment
}

// ── Component ───────────────────────────────────────────────────────────

const OP_NAMES = ['Deposit', 'Borrow', 'Repay', 'Withdraw', 'Deposit (lending)', 'Withdraw (lending)']

export default function OrderBuilder({ config }: { config: CollectedConfig }) {
  const [minReputation, setMinReputation] = useState(0)
  const [minHealthFactor, setMinHealthFactor] = useState(1.1)
  const [maxFeeBps, setMaxFeeBps] = useState(50000) // 0.5% in 1e7 units
  const [deadlineMinutes, setDeadlineMinutes] = useState(60)
  const [signedOrder, setSignedOrder] = useState<SignedOrder | null>(null)
  const [signing, setSigning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const poolAddress = POOL_ADDRESSES[config.chainId] ?? zeroAddress
  const veratoAddress = VERATO_ADDRESSES[config.chainId] ?? zeroAddress

  // Derive leaves from selection
  const leafInputs = useMemo(
    () => selectionToLeaves(config, poolAddress),
    [config, poolAddress]
  )

  // Build unsigned order for preview
  const preview = useMemo(() => {
    if (leafInputs.length === 0) return null

    const conditions: Condition[] = []
    if (minHealthFactor > 0) {
      // Find distinct Aave pools used
      const pools = new Set<string>()
      for (const entry of config.entries) {
        if (entry.protocol === 'aave') {
          pools.add(poolAddress)
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

    const deadline = Math.floor(Date.now() / 1000) + deadlineMinutes * 60
    const input: BuildOrderInput = {
      leaves: leafInputs,
      conditions,
      maxFeeBps,
      solver: zeroAddress,
      minSolverReputation: minReputation,
      deadline,
      chainId: Number(config.chainId),
      veratoAddress,
    }

    return buildUnsignedOrder(input)
  }, [leafInputs, minHealthFactor, maxFeeBps, deadlineMinutes, minReputation, config, poolAddress, veratoAddress])

  // Sign
  const handleSign = useCallback(async () => {
    if (!preview || leafInputs.length === 0) return
    setError(null)
    setSigning(true)

    try {
      const ethereum = (window as any).ethereum
      if (!ethereum) throw new Error('No wallet detected. Install MetaMask or similar.')

      const [address] = await ethereum.request({ method: 'eth_requestAccounts' }) as string[]

      const client = createWalletClient({
        account: address as Address,
        chain: celo,
        transport: custom(ethereum),
      })

      const conditions: Condition[] = []
      if (minHealthFactor > 0) {
        conditions.push({
          type: 'aave',
          lenderId: 0,
          pool: poolAddress,
          minHealthFactor: BigInt(Math.floor(minHealthFactor * 1e18)),
        })
      }

      const deadline = Math.floor(Date.now() / 1000) + deadlineMinutes * 60

      const result = await buildAndSignOrder(client, {
        leaves: leafInputs,
        conditions,
        maxFeeBps,
        solver: zeroAddress,
        minSolverReputation: minReputation,
        deadline,
        chainId: Number(config.chainId),
        veratoAddress,
      })

      setSignedOrder(result)
    } catch (e: any) {
      setError(e.message ?? String(e))
    } finally {
      setSigning(false)
    }
  }, [preview, leafInputs, minHealthFactor, maxFeeBps, deadlineMinutes, minReputation, config, poolAddress, veratoAddress])

  if (leafInputs.length === 0) {
    return (
      <div className="text-center py-6 text-gray-500 text-sm">
        Select tokens above to build an order.
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Merkle leaves */}
      <div>
        <h3 className="text-sm font-medium text-gray-400 mb-2">
          Approved Actions ({leafInputs.length} leaves)
        </h3>
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {leafInputs.map((l, i) => (
            <div
              key={i}
              className="flex items-center gap-2 px-3 py-1.5 bg-gray-800/60 rounded text-xs"
            >
              <span className={`px-1.5 py-0.5 rounded font-medium ${
                l.op === 0 ? 'bg-green-600/20 text-green-400' :
                l.op === 1 ? 'bg-red-600/20 text-red-400' :
                l.op === 2 ? 'bg-blue-600/20 text-blue-400' :
                'bg-yellow-600/20 text-yellow-400'
              }`}>
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

      {/* Sign button */}
      <button
        onClick={handleSign}
        disabled={signing || !preview}
        className={`w-full py-3 rounded-lg font-medium text-sm transition-colors ${
          signing
            ? 'bg-gray-700 text-gray-400 cursor-wait'
            : 'bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer'
        }`}
      >
        {signing ? 'Signing...' : 'Sign Order with Wallet'}
      </button>

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Signed order output */}
      {signedOrder && (
        <div>
          <h3 className="text-sm font-medium text-emerald-400 mb-2">Signed Order</h3>
          <pre className="bg-gray-900 border border-emerald-800/40 rounded-lg p-4 text-xs text-gray-300 overflow-x-auto max-h-96 overflow-y-auto">
            {JSON.stringify(signedOrder, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
