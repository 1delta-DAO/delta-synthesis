import { useState, useMemo } from 'react'
import type {
  AaveTokensData, MorphoPoolsData, SelectionState, AaveSelection,
  TokenSelection, MorphoMarketSelection, CollectedConfig, CollectedEntry,
} from '../types'
import { CHAIN_NAMES } from '../types'
import aaveTokensRaw from '../data/aave-tokens.json'
import morphoPoolsRaw from '../data/morpho-pools.json'
import OrderBuilder from './OrderBuilder'
import {
  useLendingData,
  isAaveLender, isMorphoLender,
  isMorphoMarket,
  type LenderItem,
} from '../hooks/useLendingData'

const aaveTokens = aaveTokensRaw as AaveTokensData
const morphoPools = morphoPoolsRaw as MorphoPoolsData

function shortenAddress(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function chainName(id: string) {
  return CHAIN_NAMES[id] ?? `Chain ${id}`
}

function formatUsd(v: number): string {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${v.toFixed(2)}`
}

function formatRate(v: number): string {
  return `${v.toFixed(2)}%`
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

// ── Aave Fork Section ───────────────────────────────────────────────────────

function AaveForkSection({
  fork,
  chainId,
  tokens,
  onChange,
  lenderItem,
}: {
  fork: string
  chainId: string
  tokens: Record<string, TokenSelection>
  onChange: (next: Record<string, TokenSelection>) => void
  lenderItem?: LenderItem
}) {
  const reserves = useMemo(() => aaveTokens[fork]?.[chainId] ?? {}, [fork, chainId])

  const toggle = (underlying: string, field: 'collateral' | 'debt') => {
    const current = tokens[underlying]
    if (current) {
      const next = { ...current, [field]: !current[field] }
      if (!next.collateral && !next.debt) {
        onChange(Object.fromEntries(Object.entries(tokens).filter(([k]) => k !== underlying)))
      } else {
        onChange({ ...tokens, [underlying]: next })
      }
    } else {
      onChange({ ...tokens, [underlying]: { collateral: field === 'collateral', debt: field === 'debt' } })
    }
  }

  const allSelected = Object.keys(reserves).length > 0 && Object.keys(reserves).every((u) => {
    const s = tokens[u]
    return s?.collateral && s?.debt
  })
  const toggleAll = () => {
    if (allSelected) {
      onChange({})
    } else {
      const all: Record<string, TokenSelection> = {}
      for (const u of Object.keys(reserves)) all[u] = { collateral: true, debt: true }
      onChange(all)
    }
  }

  const hasSelections = Object.keys(tokens).length > 0

  // Match live market data by underlying address
  const getMarketData = (underlying: string) => {
    if (!lenderItem) return null
    return lenderItem.markets.find(m =>
      m.underlyingInfo?.asset?.address?.toLowerCase() === underlying.toLowerCase()
    )
  }

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <div className={`flex items-center justify-between px-3 py-2 ${hasSelections ? 'bg-indigo-600/10' : 'bg-gray-900'}`}>
        <div className="flex items-center gap-2">
          {lenderItem?.lenderInfo?.logoURI && (
            <img src={lenderItem.lenderInfo.logoURI} alt="" className="w-5 h-5 rounded" />
          )}
          <span className="text-sm font-medium text-white">
            {lenderItem?.lenderInfo?.name ?? fork.replace(/_/g, ' ')}
          </span>
          {lenderItem && (
            <span className="text-xs text-gray-500">
              TVL {formatUsd(lenderItem.tvlUsd)}
            </span>
          )}
        </div>
        <button onClick={toggleAll} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
          {allSelected ? 'Deselect all' : 'Select all'}
        </button>
      </div>
      <div className="space-y-1 p-2 max-h-64 overflow-y-auto">
        {Object.entries(reserves).map(([underlying, entry]) => {
          const sel = tokens[underlying]
          const active = sel?.collateral || sel?.debt
          const market = getMarketData(underlying)
          return (
            <div
              key={underlying}
              className={`px-3 py-2 rounded transition-colors ${
                active ? 'bg-indigo-600/20 border border-indigo-500/40' : 'bg-gray-800/60 border border-transparent'
              }`}
            >
              <div className="flex items-center gap-3">
                {market?.underlyingInfo?.asset?.logoURI && (
                  <img src={market.underlyingInfo.asset.logoURI} alt="" className="w-5 h-5 rounded-full" />
                )}
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-white">{entry.symbol}</span>
                  <span className="ml-2 text-xs text-gray-500 font-mono">{shortenAddress(underlying)}</span>
                </div>
                {market && (
                  <div className="flex gap-3 text-xs text-gray-500">
                    <span>{formatUsd(market.totalDepositsUsd)} dep</span>
                    <span className="text-emerald-500">{formatRate(market.depositRate)}</span>
                    <span className="text-red-400">{formatRate(market.variableBorrowRate)}</span>
                  </div>
                )}
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
  )
}

// ── Aave Panel ──────────────────────────────────────────────────────────────

function AavePanel({
  chainId,
  selection,
  onChange,
  lenders,
}: {
  chainId: string
  selection: AaveSelection
  onChange: (next: AaveSelection) => void
  lenders: LenderItem[]
}) {
  const forks = useMemo(
    () => Object.keys(aaveTokens).filter((fork) => chainId in (aaveTokens[fork] ?? {})),
    [chainId],
  )

  if (forks.length === 0) {
    return <p className="text-sm text-gray-600">No Aave forks on {chainName(chainId)}.</p>
  }

  const updateFork = (fork: string, tokens: Record<string, TokenSelection>) => {
    if (Object.keys(tokens).length === 0) {
      const rest = Object.fromEntries(Object.entries(selection).filter(([k]) => k !== fork))
      onChange(rest)
    } else {
      onChange({ ...selection, [fork]: tokens })
    }
  }

  return (
    <div className="space-y-3">
      {forks.map((fork) => {
        const lenderItem = lenders.find(l => l.lenderKey === fork)
        return (
          <AaveForkSection
            key={fork}
            fork={fork}
            chainId={chainId}
            tokens={selection[fork] ?? {}}
            onChange={(tokens) => updateFork(fork, tokens)}
            lenderItem={lenderItem}
          />
        )
      })}
    </div>
  )
}

// ── Morpho Markets Panel ────────────────────────────────────────────────────

function MorphoMarketsPanel({
  lenders,
  selection,
  onChange,
}: {
  lenders: LenderItem[]
  selection: Record<string, MorphoMarketSelection>
  onChange: (next: Record<string, MorphoMarketSelection>) => void
}) {
  const morphoLenders = lenders.filter(l => isMorphoLender(l.lenderKey))

  if (morphoLenders.length === 0) {
    return <p className="text-sm text-gray-600">No Morpho markets on this chain.</p>
  }

  const allMarkets = morphoLenders.flatMap(l =>
    l.markets.filter(isMorphoMarket).map(m => ({ market: m, lender: l }))
  )

  const toggle = (uid: string, field: 'collateral' | 'debt') => {
    const current = selection[uid]
    if (current) {
      const next = { ...current, [field]: !current[field] }
      if (!next.collateral && !next.debt) {
        const rest = { ...selection }
        delete rest[uid]
        onChange(rest)
      } else {
        onChange({ ...selection, [uid]: next })
      }
    } else {
      onChange({
        ...selection,
        [uid]: { collateral: field === 'collateral', debt: field === 'debt' },
      })
    }
  }

  const allSelected = allMarkets.length > 0 && allMarkets.every(({ market }) => {
    const s = selection[market.marketUid]
    return s?.collateral && s?.debt
  })

  const toggleAll = () => {
    if (allSelected) {
      onChange({})
    } else {
      const all: Record<string, MorphoMarketSelection> = {}
      for (const { market } of allMarkets) {
        all[market.marketUid] = { collateral: true, debt: true }
      }
      onChange(all)
    }
  }

  return (
    <div className="space-y-3">
      <div className="border border-gray-800 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-gray-900">
          <div className="flex items-center gap-2">
            {morphoLenders[0]?.lenderInfo?.logoURI && (
              <img src={morphoLenders[0].lenderInfo.logoURI} alt="" className="w-5 h-5 rounded" />
            )}
            <span className="text-sm font-medium text-white">Morpho Blue Markets</span>
            <span className="text-xs text-gray-500">{allMarkets.length} markets</span>
          </div>
          <button onClick={toggleAll} className="text-xs text-violet-400 hover:text-violet-300 transition-colors">
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
        </div>
        <div className="space-y-1 p-2 max-h-80 overflow-y-auto">
          {allMarkets.map(({ market }) => {
            const mp = market.params.market
            const sel = selection[market.marketUid]
            const active = sel?.collateral || sel?.debt
            // Derive collateral symbol from the market name or address
            const loanSymbol = market.underlyingInfo?.asset?.symbol ?? shortenAddress(mp.loanAddress)
            const collateralShort = shortenAddress(mp.collateralAddress)
            const lltv = (Number(mp.lltv) / 1e18 * 100).toFixed(1)

            return (
              <div
                key={market.marketUid}
                className={`px-3 py-2 rounded transition-colors ${
                  active ? 'bg-violet-600/20 border border-violet-500/40' : 'bg-gray-800/60 border border-transparent'
                }`}
              >
                <div className="flex items-center gap-3">
                  {market.underlyingInfo?.asset?.logoURI && (
                    <img src={market.underlyingInfo.asset.logoURI} alt="" className="w-5 h-5 rounded-full" />
                  )}
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-white">{market.name ?? loanSymbol}</span>
                  </div>
                  <div className="flex gap-3 text-xs text-gray-500">
                    <span>LLTV {lltv}%</span>
                    <span>{formatUsd(market.tvlUsd)} TVL</span>
                    <span className="text-emerald-500">{formatRate(market.depositRate)}</span>
                    <span className="text-red-400">{formatRate(market.variableBorrowRate)}</span>
                  </div>
                </div>
                <div className="flex gap-3 mt-1 text-xs text-gray-600 font-mono">
                  <span>Loan: {loanSymbol} ({shortenAddress(mp.loanAddress)})</span>
                  <span>Collateral: {collateralShort}</span>
                </div>
                <div className="flex gap-4 mt-1.5 ml-0.5">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sel?.collateral ?? false}
                      onChange={() => toggle(market.marketUid, 'collateral')}
                      className="accent-violet-500 w-3.5 h-3.5"
                    />
                    <span className="text-xs text-gray-400">Supply Collateral</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sel?.debt ?? false}
                      onChange={() => toggle(market.marketUid, 'debt')}
                      className="accent-violet-500 w-3.5 h-3.5"
                    />
                    <span className="text-xs text-gray-400">Borrow</span>
                  </label>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Selection Summary ───────────────────────────────────────────────────────

function SelectionSummary({ selection }: { selection: SelectionState }) {
  const aaveForks = Object.entries(selection.aave).filter(([, tokens]) => Object.keys(tokens).length > 0)
  const aaveCount = aaveForks.reduce((sum, [, tokens]) => sum + Object.keys(tokens).length, 0)
  const morphoMarketCount = Object.keys(selection.morphoMarkets).length
  const total = aaveCount + morphoMarketCount

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

      {aaveForks.map(([fork, tokens]) => (
        <div key={fork}>
          <h4 className="text-xs text-indigo-400 mb-1">
            {fork.replace(/_/g, ' ')} &middot; {chainName(selection.chainId)}
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(tokens).map(([underlying, sel]) => {
              const entry = aaveTokens[fork]?.[selection.chainId]?.[underlying]
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
      ))}

      {morphoMarketCount > 0 && (
        <div>
          <h4 className="text-xs text-violet-400 mb-1">Morpho Markets</h4>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(selection.morphoMarkets).map(([uid, sel]) => {
              const roles = [sel.collateral && 'collateral', sel.debt && 'borrow'].filter(Boolean).join(', ')
              return (
                <span key={uid} className="text-xs bg-violet-600/20 text-violet-300 px-2 py-0.5 rounded border border-violet-500/30">
                  {uid.split(':')[0]?.replace(/_/g, ' ').slice(0, 20)}… ({roles})
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

function useCollectedConfig(
  selection: SelectionState,
  lenders: LenderItem[],
): CollectedConfig {
  return useMemo(() => {
    const entries: CollectedEntry[] = []

    // Aave entries
    for (const [fork, tokens] of Object.entries(selection.aave)) {
      const tokenEntries = Object.entries(tokens)
      if (tokenEntries.length === 0) continue
      const forkData = aaveTokens[fork]?.[selection.chainId] ?? {}
      entries.push({
        protocol: 'aave',
        fork,
        chainId: selection.chainId,
        tokens: tokenEntries.map(([underlying, sel]) => {
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

    // Morpho market entries — find the market data from lenders
    for (const [marketUid, sel] of Object.entries(selection.morphoMarkets)) {
      for (const lender of lenders) {
        if (!isMorphoLender(lender.lenderKey)) continue
        const market = lender.markets.find(m => m.marketUid === marketUid)
        if (!market || !isMorphoMarket(market)) continue
        const mp = market.params.market

        // Find the Morpho Blue singleton address from morpho-pools.json
        // or derive from lender data
        let morphoAddress = ''
        for (const [poolType, chains] of Object.entries(morphoPools)) {
          if (poolType.startsWith('MORPHO')) {
            const addr = chains[selection.chainId]
            if (addr) { morphoAddress = addr; break }
          }
        }

        entries.push({
          protocol: 'morpho-market',
          lenderKey: lender.lenderKey,
          chainId: selection.chainId,
          morphoAddress,
          marketId: market.marketUid,
          loanToken: mp.loanAddress,
          collateralToken: mp.collateralAddress,
          oracle: mp.oracle,
          irm: mp.irm,
          lltv: mp.lltv,
          loanSymbol: market.underlyingInfo?.asset?.symbol ?? shortenAddress(mp.loanAddress),
          collateralSymbol: shortenAddress(mp.collateralAddress),
          selectedCollateral: sel.collateral,
          selectedDebt: sel.debt,
        })
        break
      }
    }

    return { chainId: selection.chainId, entries }
  }, [selection, lenders])
}

// ── Main Configurator ───────────────────────────────────────────────────────

export default function Configurator() {
  const [selection, setSelection] = useState<SelectionState>({
    chainId: '42220',
    aave: {},
    morpho: { pools: [] },
    morphoMarkets: {},
  })

  const { lenders, loading } = useLendingData(selection.chainId || null)
  const aaveLenders = lenders.filter(l => isAaveLender(l.lenderKey))
  const config = useCollectedConfig(selection, lenders)

  const setChain = (chainId: string) => {
    setSelection({ chainId, aave: {}, morpho: { pools: [] }, morphoMarkets: {} })
  }

  return (
    <div className="w-full max-w-2xl mx-auto space-y-8">
      {/* Chain selector */}
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

      {loading && (
        <div className="text-center py-4 text-gray-500 text-sm">
          Loading market data...
        </div>
      )}

      {selection.chainId && !loading && (
        <>
          {/* Aave section */}
          <section>
            <h2 className="text-lg font-semibold text-indigo-400 mb-3">Aave / Lending Protocols</h2>
            <AavePanel
              chainId={selection.chainId}
              selection={selection.aave}
              onChange={(aave) => setSelection((s) => ({ ...s, aave }))}
              lenders={aaveLenders}
            />
          </section>

          {/* Morpho Markets section */}
          <section>
            <h2 className="text-lg font-semibold text-violet-400 mb-3">Morpho Blue Markets</h2>
            <MorphoMarketsPanel
              lenders={lenders}
              selection={selection.morphoMarkets}
              onChange={(morphoMarkets) => setSelection((s) => ({ ...s, morphoMarkets }))}
            />
          </section>
        </>
      )}

      {/* Summary */}
      <div className="border-t border-gray-800 pt-4">
        <SelectionSummary selection={selection} />
      </div>

      {/* Order builder */}
      {config.entries.length > 0 && (
        <section className="border-t border-gray-800 pt-4">
          <h2 className="text-lg font-semibold text-emerald-400 mb-3">Build Order</h2>
          <OrderBuilder config={config} />
        </section>
      )}
    </div>
  )
}
