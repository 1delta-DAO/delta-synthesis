import { useState, useMemo } from 'react'
import type { AaveTokensData, MorphoPoolsData, SelectionState, CollectedConfig, CollectedEntry } from '../types'
import { CHAIN_NAMES } from '../types'
import aaveTokensRaw from '../data/aave-tokens.json'
import morphoPoolsRaw from '../data/morpho-pools.json'

const aaveTokens = aaveTokensRaw as AaveTokensData
const morphoPools = morphoPoolsRaw as MorphoPoolsData

function shortenAddress(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function chainName(id: string) {
  return CHAIN_NAMES[id] ?? `Chain ${id}`
}

/** Collect all unique chain IDs across both data sources */
function getAllChains(): string[] {
  const set = new Set<string>()
  for (const forkChains of Object.values(aaveTokens)) {
    for (const cId of Object.keys(forkChains)) set.add(cId)
  }
  for (const poolChains of Object.values(morphoPools)) {
    for (const cId of Object.keys(poolChains)) set.add(cId)
  }
  return [...set]
}

const allChains = getAllChains()

// ── Aave Panel ──────────────────────────────────────────────────────────────

function AavePanel({
  chainId,
  selection,
  onChange,
}: {
  chainId: string
  selection: SelectionState['aave']
  onChange: (next: SelectionState['aave']) => void
}) {
  const forks = useMemo(
    () => Object.keys(aaveTokens).filter((fork) => chainId in (aaveTokens[fork] ?? {})),
    [chainId],
  )

  const tokens = useMemo(() => {
    if (!selection.fork) return {}
    return aaveTokens[selection.fork]?.[chainId] ?? {}
  }, [selection.fork, chainId])

  const toggle = (underlying: string, field: 'collateral' | 'debt') => {
    const current = selection.tokens[underlying]
    if (current) {
      const next = { ...current, [field]: !current[field] }
      if (!next.collateral && !next.debt) {
        const rest = Object.fromEntries(
          Object.entries(selection.tokens).filter(([k]) => k !== underlying),
        )
        onChange({ ...selection, tokens: rest })
      } else {
        onChange({ ...selection, tokens: { ...selection.tokens, [underlying]: next } })
      }
    } else {
      onChange({ ...selection, tokens: { ...selection.tokens, [underlying]: { collateral: field === 'collateral', debt: field === 'debt' } } })
    }
  }

  const allSelected = Object.keys(tokens).length > 0 && Object.keys(tokens).every((u) => {
    const s = selection.tokens[u]
    return s?.collateral && s?.debt
  })
  const toggleAll = () => {
    if (allSelected) {
      onChange({ ...selection, tokens: {} })
    } else {
      const all: Record<string, { collateral: boolean; debt: boolean }> = {}
      for (const u of Object.keys(tokens)) {
        all[u] = { collateral: true, debt: true }
      }
      onChange({ ...selection, tokens: all })
    }
  }

  if (forks.length === 0) {
    return <p className="text-sm text-gray-600">No Aave forks on {chainName(chainId)}.</p>
  }

  return (
    <div className="space-y-4">
      {/* Fork selector */}
      <div>
        <label className="block text-sm font-medium text-gray-400 mb-1">Protocol Fork</label>
        <div className="flex flex-wrap gap-2">
          {forks.map((fork) => (
            <button
              key={fork}
              onClick={() => onChange({ fork, tokens: {} })}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                selection.fork === fork
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
            >
              {fork.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      </div>

      {/* Token list */}
      {Object.keys(tokens).length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-gray-400">Reserve Tokens</label>
            <button
              onClick={toggleAll}
              className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              {allSelected ? 'Deselect all' : 'Select all'}
            </button>
          </div>
          <div className="space-y-1 max-h-80 overflow-y-auto pr-1">
            {Object.entries(tokens).map(([underlying, entry]) => {
              const sel = selection.tokens[underlying]
              const active = sel?.collateral || sel?.debt
              return (
                <div
                  key={underlying}
                  className={`px-3 py-2 rounded transition-colors ${
                    active ? 'bg-indigo-600/20 border border-indigo-500/40' : 'bg-gray-800/60 border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-white">{entry.symbol}</span>
                      <span className="ml-2 text-xs text-gray-500 font-mono">{shortenAddress(underlying)}</span>
                    </div>
                  </div>
                  <div className="flex gap-4 mt-1.5 ml-0.5">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={sel?.collateral ?? false}
                        onChange={() => toggle(underlying, 'collateral')}
                        className="accent-indigo-500 w-3.5 h-3.5"
                      />
                      <span className="text-xs text-gray-400">Collateral</span>
                      <span className="text-xs text-gray-600 font-mono">{shortenAddress(entry.aToken)}</span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={sel?.debt ?? false}
                        onChange={() => toggle(underlying, 'debt')}
                        className="accent-indigo-500 w-3.5 h-3.5"
                      />
                      <span className="text-xs text-gray-400">Debt</span>
                      <span className="text-xs text-gray-600 font-mono">{shortenAddress(entry.vToken)}</span>
                    </label>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Morpho Panel ────────────────────────────────────────────────────────────

interface PoolEntry {
  key: string // "POOL_TYPE:CHAIN_ID"
  poolType: string
  address: string
}

function MorphoPanel({
  chainId,
  selection,
  onChange,
}: {
  chainId: string
  selection: SelectionState['morpho']
  onChange: (next: SelectionState['morpho']) => void
}) {
  const pools = useMemo(() => {
    const entries: PoolEntry[] = []
    for (const [poolType, chains] of Object.entries(morphoPools)) {
      const address = chains[chainId]
      if (address) {
        entries.push({ key: `${poolType}:${chainId}`, poolType, address })
      }
    }
    return entries
  }, [chainId])

  const togglePool = (key: string) => {
    const next = selection.pools.includes(key)
      ? selection.pools.filter((k) => k !== key)
      : [...selection.pools, key]
    onChange({ pools: next })
  }

  const allSelected = pools.length > 0 && pools.every((p) => selection.pools.includes(p.key))
  const toggleAll = () => {
    if (allSelected) {
      const poolKeys = new Set(pools.map((p) => p.key))
      onChange({ pools: selection.pools.filter((k) => !poolKeys.has(k)) })
    } else {
      const existing = new Set(selection.pools)
      onChange({ pools: [...selection.pools, ...pools.filter((p) => !existing.has(p.key)).map((p) => p.key)] })
    }
  }

  if (pools.length === 0) {
    return <p className="text-sm text-gray-600">No Morpho pools on {chainName(chainId)}.</p>
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-gray-400">Pools</label>
          <button
            onClick={toggleAll}
            className="text-xs text-violet-400 hover:text-violet-300 transition-colors"
          >
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
        </div>
        <div className="space-y-1 max-h-80 overflow-y-auto pr-1">
          {pools.map((pool) => {
            const checked = selection.pools.includes(pool.key)
            return (
              <label
                key={pool.key}
                className={`flex items-center gap-3 px-3 py-2 rounded cursor-pointer transition-colors ${
                  checked ? 'bg-violet-600/20 border border-violet-500/40' : 'bg-gray-800/60 border border-transparent hover:bg-gray-800'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => togglePool(pool.key)}
                  className="accent-violet-500 w-4 h-4"
                />
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-white">{pool.poolType.replace(/_/g, ' ')}</span>
                </div>
                <span className="text-xs text-gray-500 font-mono">{shortenAddress(pool.address)}</span>
              </label>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Selection Summary ───────────────────────────────────────────────────────

function SelectionSummary({ selection }: { selection: SelectionState }) {
  const aaveEntries = Object.entries(selection.aave.tokens)
  const aaveCount = aaveEntries.length
  const morphoCount = selection.morpho.pools.length
  const total = aaveCount + morphoCount

  if (total === 0) {
    return (
      <div className="text-center py-6 text-gray-500 text-sm">
        No items selected. Select tokens or pools above.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-400">Selection Summary</h3>
        <span className="text-xs bg-gray-800 text-gray-300 px-2 py-0.5 rounded-full">
          {total} selected
        </span>
      </div>

      {aaveCount > 0 && (
        <div>
          <h4 className="text-xs text-indigo-400 mb-1">
            Aave &middot; {selection.aave.fork.replace(/_/g, ' ')} &middot; {chainName(selection.chainId)}
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {aaveEntries.map(([underlying, sel]) => {
              const entry = aaveTokens[selection.aave.fork]?.[selection.chainId]?.[underlying]
              const symbol = entry?.symbol ?? shortenAddress(underlying)
              const roles = [sel.collateral && 'collateral', sel.debt && 'debt'].filter(Boolean).join(', ')
              return (
                <span key={underlying} className="text-xs bg-indigo-600/20 text-indigo-300 px-2 py-0.5 rounded border border-indigo-500/30">
                  {symbol} ({roles})
                </span>
              )
            })}
          </div>
        </div>
      )}

      {morphoCount > 0 && (
        <div>
          <h4 className="text-xs text-violet-400 mb-1">Morpho Pools</h4>
          <div className="flex flex-wrap gap-1.5">
            {selection.morpho.pools.map((key) => {
              const [poolType, cId] = key.split(':')
              return (
                <span key={key} className="text-xs bg-violet-600/20 text-violet-300 px-2 py-0.5 rounded border border-violet-500/30">
                  {poolType.replace(/_/g, ' ')} &middot; {chainName(cId)}
                </span>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Collected Config ─────────────────────────────────────────────────────────

function useCollectedConfig(selection: SelectionState): CollectedConfig {
  return useMemo(() => {
    const entries: CollectedEntry[] = []

    // Aave entries
    const aaveTokenEntries = Object.entries(selection.aave.tokens)
    if (selection.aave.fork && aaveTokenEntries.length > 0) {
      const forkData = aaveTokens[selection.aave.fork]?.[selection.chainId] ?? {}
      entries.push({
        protocol: 'aave',
        fork: selection.aave.fork,
        chainId: selection.chainId,
        tokens: aaveTokenEntries.map(([underlying, sel]) => {
          const token = forkData[underlying]
          return {
            underlying,
            symbol: token?.symbol ?? underlying,
            collateralToken: sel.collateral ? (token?.aToken ?? null) : null,
            debtToken: sel.debt ? (token?.vToken ?? null) : null,
          }
        }),
      })
    }

    // Morpho entries
    for (const key of selection.morpho.pools) {
      const [poolType, cId] = key.split(':')
      const address = morphoPools[poolType]?.[cId]
      if (address) {
        entries.push({ protocol: 'morpho', poolType, chainId: cId, address })
      }
    }

    return { chainId: selection.chainId, entries }
  }, [selection])
}

// ── Main Configurator ───────────────────────────────────────────────────────

export default function Configurator() {
  const [selection, setSelection] = useState<SelectionState>({
    chainId: '',
    aave: { fork: '', tokens: {} },
    morpho: { pools: [] },
  })

  const config = useCollectedConfig(selection)

  const setChain = (chainId: string) => {
    setSelection({ chainId, aave: { fork: '', tokens: {} }, morpho: { pools: [] } })
  }

  return (
    <div className="w-full max-w-2xl mx-auto space-y-8">
      {/* Unified chain selector */}
      <div>
        <label className="block text-sm font-medium text-gray-400 mb-2">Chain</label>
        <div className="flex flex-wrap gap-2">
          {allChains.map((id) => (
            <button
              key={id}
              onClick={() => setChain(id)}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                selection.chainId === id
                  ? 'bg-white text-gray-950'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
            >
              {chainName(id)}
            </button>
          ))}
        </div>
      </div>

      {selection.chainId && (
        <>
          {/* Aave section */}
          <section>
            <h2 className="text-lg font-semibold text-indigo-400 mb-3">Aave Tokens</h2>
            <AavePanel
              chainId={selection.chainId}
              selection={selection.aave}
              onChange={(aave) => setSelection((s) => ({ ...s, aave }))}
            />
          </section>

          {/* Morpho section */}
          <section>
            <h2 className="text-lg font-semibold text-violet-400 mb-3">Morpho Pools</h2>
            <MorphoPanel
              chainId={selection.chainId}
              selection={selection.morpho}
              onChange={(morpho) => setSelection((s) => ({ ...s, morpho }))}
            />
          </section>
        </>
      )}

      {/* Summary */}
      <div className="border-t border-gray-800 pt-4">
        <SelectionSummary selection={selection} />
      </div>

      {/* Collected config output */}
      {config.entries.length > 0 && (
        <div className="border-t border-gray-800 pt-4">
          <h3 className="text-sm font-medium text-gray-400 mb-2">Collected Config</h3>
          <pre className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-xs text-gray-300 overflow-x-auto max-h-96 overflow-y-auto">
            {JSON.stringify(config, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
