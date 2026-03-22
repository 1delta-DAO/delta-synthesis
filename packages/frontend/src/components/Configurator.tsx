import { useState, useMemo } from 'react'
import { useAccount } from 'wagmi'
import type {
  SelectionState, AaveSelection,
  TokenSelection, MorphoMarketSelection, CollectedConfig, CollectedEntry,
} from '../types'
import { CHAIN_NAMES } from '../types'
import morphoPoolsRaw from '../data/morpho-pools.json'
import OrderBuilder from './OrderBuilder'
import {
  useLendingData,
  isAaveLender,
  type LenderItem, type AaveMarket, type EnrichedMorphoMarket,
} from '../hooks/useLendingData'
import { useUserPositions } from '../hooks/useUserPositions'

const morphoPools = morphoPoolsRaw as Record<string, Record<string, string>>

// Supported chains — Celo only for now
const SUPPORTED_CHAINS = ['42220']

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

function formatPct(v: number): string {
  return `${(v * 100).toFixed(0)}%`
}

// ── User Positions Panel ─────────────────────────────────────────────────────

function UserPositionsPanel({
  chainId,
}: {
  chainId: string
}) {
  const { address } = useAccount()
  const { positions, loading, error, refetch } = useUserPositions(address, address ? parseInt(chainId) : null)

  if (!address) return null

  const hasPositions = positions.length > 0 && positions.some(lp => lp.data.some(d => d.positions.length > 0))

  return (
    <section className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-amber-400">Your Positions</h2>
        <button
          onClick={refetch}
          disabled={loading}
          className="text-xs text-gray-400 hover:text-amber-400 transition-colors disabled:opacity-50"
          title="Refresh positions"
        >
          {loading ? '...' : '\u21BB'}
        </button>
      </div>
      {loading && (
        <div className="flex items-center gap-2 py-3 px-3 rounded-xl bg-gray-900/40 border border-gray-800/80">
          <div className="w-3.5 h-3.5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
          <span className="text-xs text-gray-400">Loading positions...</span>
        </div>
      )}
      {error && (
        <div className="text-xs text-red-400 px-3 py-2 rounded-xl bg-red-900/10 border border-red-900/30">
          {error}
        </div>
      )}
      {!loading && !error && !hasPositions && (
        <div className="text-xs text-gray-600 px-3 py-3 rounded-xl bg-gray-900/40 border border-dashed border-gray-800/60 text-center">
          No lending positions found on {chainName(chainId)}
        </div>
      )}
      {!loading && hasPositions && (
        <div className="space-y-2">
          {positions.map((lp) =>
            lp.data.map((acct, ai) => {
              const activePositions = acct.positions.filter(p => parseFloat(p.deposits) > 0 || parseFloat(p.debt) > 0)
              if (activePositions.length === 0) return null
              const lenderName = lp.lender.replace(/_/g, ' ')
              return (
                <div key={`${lp.lender}-${ai}`} className="rounded-xl border border-gray-800/80 overflow-hidden bg-gray-900/40">
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-800/50 bg-amber-500/5">
                    <span className="text-xs font-semibold text-white">{lenderName}</span>
                    <div className="flex gap-3 text-[10px] text-gray-500">
                      <span>Health: <span className={acct.health == null ? 'text-gray-500' : acct.health > 1.5 ? 'text-emerald-400' : acct.health > 1.1 ? 'text-amber-400' : 'text-red-400'}>{acct.health == null ? '–' : acct.health > 100 ? '∞' : acct.health.toFixed(2)}</span></span>
                      <span>NAV: {formatUsd(acct.balanceData.nav)}</span>
                      {/* Account-level net APR (value from API is already in %) */}
                      {acct.aprData && (
                        <span>APR: <span className={acct.aprData.apr >= 0 ? 'text-emerald-400' : 'text-red-400'}>{acct.aprData.apr.toFixed(2)}%</span></span>
                      )}
                    </div>
                  </div>
                  <div className="divide-y divide-gray-800/30">
                    {activePositions.map((pos) => {
                      const asset = pos.underlyingInfo?.asset
                      const hasDeposit = parseFloat(pos.deposits) > 0
                      const hasDebt = parseFloat(pos.debt) > 0
                      return (
                        <div key={pos.marketUid} className="flex items-center gap-2 px-3 py-1.5">
                          {asset?.logoURI ? (
                            <img src={asset.logoURI} alt="" className="w-5 h-5 rounded-full bg-white shrink-0" />
                          ) : (
                            <div className="w-5 h-5 rounded-full bg-gray-700 shrink-0" />
                          )}
                          <span className="text-xs font-medium text-white w-14 truncate">{asset?.symbol ?? '?'}</span>
                          <div className="flex gap-3 text-[11px] ml-auto">
                            {hasDeposit && (
                              <span className="text-emerald-400" title="Deposited">
                                +{formatUsd(pos.depositsUSD)}
                                {/* Per-asset supply APR (value from API is already in %) */}
                                {pos.depositApr != null && (
                                  <span className="text-emerald-600 ml-1 text-[10px]">{pos.depositApr.toFixed(2)}%</span>
                                )}
                              </span>
                            )}
                            {hasDebt && (
                              <span className="text-red-400" title="Borrowed">
                                -{formatUsd(pos.debtUSD)}
                                {/* Per-asset borrow APR (value from API is already in %) */}
                                {pos.borrowApr != null && (
                                  <span className="text-red-600 ml-1 text-[10px]">{pos.borrowApr.toFixed(2)}%</span>
                                )}
                              </span>
                            )}
                            {pos.collateralEnabled && (
                              <span className="text-[10px] text-gray-600" title="Collateral enabled">C</span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            }),
          )}
        </div>
      )}
    </section>
  )
}

// ── Helpers to extract data from API market objects ──────────────────────────

function getAaveMarketParams(market: AaveMarket) {
  return market.params?.metadata
}

function getCollateralFactor(market: AaveMarket): number {
  const cfg = market.config
  if (!cfg) return 0
  const first = Object.values(cfg)[0]
  return first?.collateralFactor ?? 0
}

function isBorrowable(market: AaveMarket): boolean {
  return market.flags?.borrowingEnabled ?? false
}

function isCollateralEnabled(market: AaveMarket): boolean {
  return market.flags?.collateralActive ?? false
}

// ── Aave Fork Section ───────────────────────────────────────────────────────

function AaveForkSection({
  tokens,
  onChange,
  lenderItem,
}: {
  tokens: Record<string, TokenSelection>
  onChange: (next: Record<string, TokenSelection>) => void
  lenderItem: LenderItem
}) {
  const markets = lenderItem.markets as AaveMarket[]

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

  const underlyings = markets.map(m => m.underlyingInfo.asset.address.toLowerCase())
  const allSelected = underlyings.length > 0 && underlyings.every(u => tokens[u]?.collateral && tokens[u]?.debt)
  const toggleAll = () => {
    if (allSelected) onChange({})
    else {
      const all: Record<string, TokenSelection> = {}
      for (const u of underlyings) all[u] = { collateral: true, debt: true }
      onChange(all)
    }
  }

  const hasSelections = Object.keys(tokens).length > 0

  return (
    <div className="rounded-xl border border-gray-800/80 overflow-hidden bg-gray-900/40 backdrop-blur-sm">
      <div className={`flex items-center justify-between px-3 py-2 border-b border-gray-800/50 ${hasSelections ? 'bg-indigo-500/5' : ''}`}>
        <div className="flex items-center gap-2">
          {lenderItem.lenderInfo?.logoURI && (
            <img src={lenderItem.lenderInfo.logoURI} alt="" className="w-5 h-5 rounded-full bg-white" />
          )}
          <span className="text-xs font-semibold text-white">
            {lenderItem.lenderInfo?.name ?? lenderItem.lenderKey.replace(/_/g, ' ')}
          </span>
          <span className="text-[10px] text-gray-500">TVL {formatUsd(lenderItem.tvlUsd)}</span>
        </div>
        <button onClick={toggleAll} className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors font-medium">
          {allSelected ? 'Deselect all' : 'Select all'}
        </button>
      </div>
      {/* Column headers */}
      <div className="hidden sm:flex items-center gap-2 px-3 py-1 border-b border-gray-800/30 text-[10px] text-gray-600">
        <span className="w-5" />
        <span className="w-14">Token</span>
        <div className="flex gap-3 ml-auto mr-2">
          <span className="w-12 text-right">LTV</span>
          <span className="w-12 text-right">Deposits</span>
          <span className="w-10 text-right">Supply</span>
          <span className="w-10 text-right">Borrow</span>
        </div>
        <span className="w-7 text-center">C</span>
        <span className="w-7 text-center">D</span>
      </div>
      <div className="divide-y divide-gray-800/30">
        {markets.map((market) => {
          const underlying = market.underlyingInfo.asset.address.toLowerCase()
          const sel = tokens[underlying]
          const active = sel?.collateral || sel?.debt
          const ltv = getCollateralFactor(market)
          const borrowable = isBorrowable(market)
          const collateralEnabled = isCollateralEnabled(market)

          return (
            <div key={underlying} className={`flex items-center gap-2 px-3 py-1.5 transition-colors ${active ? 'bg-indigo-500/5' : 'hover:bg-gray-800/30'}`}>
              {market.underlyingInfo.asset.logoURI ? (
                <img src={market.underlyingInfo.asset.logoURI} alt="" className="w-5 h-5 rounded-full bg-white shrink-0" />
              ) : (
                <div className="w-5 h-5 rounded-full bg-gray-700 shrink-0" />
              )}
              <span className="text-xs font-medium text-white w-14 truncate">{market.underlyingInfo.asset.symbol}</span>
              <div className="hidden sm:flex gap-3 text-[11px] text-gray-500 ml-auto mr-2">
                <span className="w-12 text-right">{ltv > 0 ? formatPct(ltv) : <span className="text-gray-700">--</span>}</span>
                <span className="w-12 text-right">{formatUsd(market.totalDepositsUsd)}</span>
                <span className="w-10 text-right text-emerald-500">{formatRate(market.depositRate)}</span>
                <span className={`w-10 text-right ${borrowable ? 'text-red-400' : 'text-gray-700'}`}>
                  {borrowable ? formatRate(market.variableBorrowRate) : '--'}
                </span>
              </div>
              <label className={`flex items-center gap-1 shrink-0 ${collateralEnabled ? 'cursor-pointer' : 'opacity-30 pointer-events-none'}`}>
                <input
                  type="checkbox"
                  checked={sel?.collateral ?? false}
                  onChange={() => toggle(underlying, 'collateral')}
                  disabled={!collateralEnabled}
                  className="accent-indigo-500 w-3 h-3"
                />
                <span className="text-[10px] text-gray-500">C</span>
              </label>
              <label className={`flex items-center gap-1 shrink-0 ${borrowable ? 'cursor-pointer' : 'opacity-30 pointer-events-none'}`}>
                <input
                  type="checkbox"
                  checked={sel?.debt ?? false}
                  onChange={() => toggle(underlying, 'debt')}
                  disabled={!borrowable}
                  className="accent-indigo-500 w-3 h-3"
                />
                <span className="text-[10px] text-gray-500">D</span>
              </label>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Aave Panel ──────────────────────────────────────────────────────────────

function AavePanel({
  selection,
  onChange,
  lenders,
}: {
  selection: AaveSelection
  onChange: (next: AaveSelection) => void
  lenders: LenderItem[]
}) {
  if (lenders.length === 0) return <p className="text-sm text-gray-600">No lending protocols found.</p>

  const updateFork = (fork: string, tokens: Record<string, TokenSelection>) => {
    if (Object.keys(tokens).length === 0) {
      onChange(Object.fromEntries(Object.entries(selection).filter(([k]) => k !== fork)))
    } else {
      onChange({ ...selection, [fork]: tokens })
    }
  }

  return (
    <div className="space-y-3">
      {lenders.map((lender) => (
        <AaveForkSection
          key={lender.lenderKey}
          tokens={selection[lender.lenderKey] ?? {}}
          onChange={(tokens) => updateFork(lender.lenderKey, tokens)}
          lenderItem={lender}
        />
      ))}
    </div>
  )
}

// ── Morpho Markets Panel ────────────────────────────────────────────────────

function MorphoMarketsPanel({
  morphoMarkets,
  selection,
  onChange,
}: {
  morphoMarkets: EnrichedMorphoMarket[]
  selection: Record<string, MorphoMarketSelection>
  onChange: (next: Record<string, MorphoMarketSelection>) => void
}) {
  if (morphoMarkets.length === 0) {
    return <p className="text-sm text-gray-600">No Morpho markets found on this chain.</p>
  }

  const toggle = (key: string, field: 'collateral' | 'debt') => {
    const current = selection[key]
    if (current) {
      const next = { ...current, [field]: !current[field] }
      if (!next.collateral && !next.debt) {
        const rest = { ...selection }
        delete rest[key]
        onChange(rest)
      } else {
        onChange({ ...selection, [key]: next })
      }
    } else {
      onChange({ ...selection, [key]: { collateral: field === 'collateral', debt: field === 'debt' } })
    }
  }

  const allSelected = morphoMarkets.every(m => {
    const s = selection[m.marketIdHash]
    return s?.collateral && s?.debt
  })
  const toggleAll = () => {
    if (allSelected) onChange({})
    else {
      const all: Record<string, MorphoMarketSelection> = {}
      for (const m of morphoMarkets) all[m.marketIdHash] = { collateral: true, debt: true }
      onChange(all)
    }
  }

  return (
    <div className="rounded-xl border border-gray-800/80 overflow-hidden bg-gray-900/40 backdrop-blur-sm">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800/50">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-full bg-violet-600/20 flex items-center justify-center">
            <span className="text-violet-400 text-[10px] font-bold">M</span>
          </div>
          <span className="text-xs font-semibold text-white">Morpho Blue</span>
          <span className="text-[10px] text-gray-500">{morphoMarkets.length} markets</span>
        </div>
        <button onClick={toggleAll} className="text-[10px] text-violet-400 hover:text-violet-300 transition-colors font-medium">
          {allSelected ? 'Deselect all' : 'Select all'}
        </button>
      </div>
      <div className="divide-y divide-gray-800/30">
        {morphoMarkets.map((m) => {
          const sel = selection[m.marketIdHash]
          const active = sel?.collateral || sel?.debt
          const lltv = (Number(m.lltv) / 1e18 * 100).toFixed(0)

          return (
            <div key={m.marketIdHash} className={`flex items-center gap-2 px-3 py-1.5 transition-colors ${active ? 'bg-violet-500/5' : 'hover:bg-gray-800/30'}`}>
              <div className="flex -space-x-1 shrink-0">
                {m.collateralLogoURI && (
                  <img src={m.collateralLogoURI} alt="" className="w-5 h-5 rounded-full ring-1 ring-gray-900 relative z-10 bg-white" />
                )}
                {m.loanLogoURI && (
                  <img src={m.loanLogoURI} alt="" className="w-5 h-5 rounded-full ring-1 ring-gray-900 bg-white" />
                )}
              </div>
              <span className="text-xs font-medium text-white truncate">{m.collateralSymbol}/{m.loanSymbol}</span>
              <span className="text-[10px] text-gray-600">{lltv}%</span>
              <div className="hidden sm:flex gap-3 text-[11px] text-gray-500 ml-auto mr-2">
                <span>{formatUsd(m.tvlUsd)}</span>
                <span className="text-emerald-500">{formatRate(m.depositRate)}</span>
                <span className="text-red-400">{formatRate(m.variableBorrowRate)}</span>
              </div>
              <label className="flex items-center gap-1 cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={sel?.collateral ?? false}
                  onChange={() => toggle(m.marketIdHash, 'collateral')}
                  className="accent-violet-500 w-3 h-3"
                />
                <span className="text-[10px] text-gray-500">C</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={sel?.debt ?? false}
                  onChange={() => toggle(m.marketIdHash, 'debt')}
                  className="accent-violet-500 w-3 h-3"
                />
                <span className="text-[10px] text-gray-500">D</span>
              </label>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Selection Summary ───────────────────────────────────────────────────────

function SelectionSummary({
  selection,
  morphoMarkets,
  lenders,
}: {
  selection: SelectionState
  morphoMarkets: EnrichedMorphoMarket[]
  lenders: LenderItem[]
}) {
  const aaveForks = Object.entries(selection.aave).filter(([, tokens]) => Object.keys(tokens).length > 0)
  const aaveCount = aaveForks.reduce((sum, [, tokens]) => sum + Object.keys(tokens).length, 0)
  const morphoCount = Object.keys(selection.morphoMarkets).length
  const total = aaveCount + morphoCount

  if (total === 0) {
    return <div className="text-center py-8 text-gray-600 text-sm">No items selected. Select tokens or pools above to build an order.</div>
  }

  // Helper to find symbol from lender markets
  const findSymbol = (fork: string, underlying: string): string => {
    const lender = lenders.find(l => l.lenderKey === fork)
    if (!lender) return shortenAddress(underlying)
    const market = lender.markets.find(m =>
      m.underlyingInfo?.asset?.address?.toLowerCase() === underlying.toLowerCase()
    )
    return market?.underlyingInfo?.asset?.symbol ?? shortenAddress(underlying)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-300">Selection Summary</h3>
        <span className="text-xs bg-gray-800 text-gray-300 px-2.5 py-1 rounded-full font-medium">{total} selected</span>
      </div>

      {aaveForks.map(([fork, tokens]) => (
        <div key={fork}>
          <h4 className="text-xs font-medium text-indigo-400 mb-1.5">{fork.replace(/_/g, ' ')} &middot; {chainName(selection.chainId)}</h4>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(tokens).map(([underlying, sel]) => {
              const symbol = findSymbol(fork, underlying)
              const roles = [sel.collateral && 'collateral', sel.debt && 'debt'].filter(Boolean).join(' + ')
              return (
                <span key={underlying} className="text-xs bg-indigo-500/10 text-indigo-300 px-2 py-1 rounded-md border border-indigo-500/20 font-medium">
                  {symbol} <span className="text-indigo-400/60 font-normal">({roles})</span>
                </span>
              )
            })}
          </div>
        </div>
      ))}

      {morphoCount > 0 && (
        <div>
          <h4 className="text-xs font-medium text-violet-400 mb-1.5">Morpho Blue</h4>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(selection.morphoMarkets).map(([hash, sel]) => {
              const m = morphoMarkets.find(mm => mm.marketIdHash === hash)
              const label = m ? `${m.collateralSymbol}/${m.loanSymbol}` : shortenAddress(hash)
              const roles = [sel.collateral && 'collateral', sel.debt && 'borrow'].filter(Boolean).join(' + ')
              return (
                <span key={hash} className="text-xs bg-violet-500/10 text-violet-300 px-2 py-1 rounded-md border border-violet-500/20 font-medium">
                  {label} <span className="text-violet-400/60 font-normal">({roles})</span>
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
  morphoMarkets: EnrichedMorphoMarket[],
  lenders: LenderItem[],
): CollectedConfig {
  return useMemo(() => {
    const entries: CollectedEntry[] = []

    // Aave entries — pull aToken/vToken from API market params
    for (const [fork, tokens] of Object.entries(selection.aave)) {
      const tokenEntries = Object.entries(tokens)
      if (tokenEntries.length === 0) continue

      const lender = lenders.find(l => l.lenderKey === fork)

      entries.push({
        protocol: 'aave',
        fork,
        chainId: selection.chainId,
        tokens: tokenEntries.map(([underlying, sel]) => {
          const market = lender?.markets.find(m =>
            m.underlyingInfo?.asset?.address?.toLowerCase() === underlying.toLowerCase()
          ) as AaveMarket | undefined
          const params = market ? getAaveMarketParams(market) : undefined
          return {
            underlying,
            symbol: market?.underlyingInfo?.asset?.symbol ?? underlying,
            collateralToken: sel.collateral ? (params?.aToken ?? null) : null,
            debtToken: sel.debt ? (params?.vToken ?? null) : null,
          }
        }),
      })
    }

    // Morpho market entries
    for (const [hash, sel] of Object.entries(selection.morphoMarkets)) {
      const m = morphoMarkets.find(mm => mm.marketIdHash === hash)
      if (!m) continue

      entries.push({
        protocol: 'morpho-market',
        lenderKey: m.lenderKey,
        chainId: selection.chainId,
        morphoAddress: morphoPools['MORPHO_BLUE']?.[selection.chainId] ?? '',
        marketId: m.marketIdHash,
        loanToken: m.loanToken,
        collateralToken: m.collateralToken,
        oracle: m.oracle,
        irm: m.irm,
        lltv: m.lltv,
        loanSymbol: m.loanSymbol,
        collateralSymbol: m.collateralSymbol,
        selectedCollateral: sel.collateral,
        selectedDebt: sel.debt,
      })
    }

    return { chainId: selection.chainId, entries }
  }, [selection, morphoMarkets, lenders])
}

// ── Main Configurator ───────────────────────────────────────────────────────

export default function Configurator() {
  const [selection, setSelection] = useState<SelectionState>({
    chainId: '42220',
    aave: {},
    morpho: { pools: [] },
    morphoMarkets: {},
  })

  const { lenders, morphoMarkets, loading } = useLendingData(selection.chainId || null)
  const aaveLenders = lenders.filter(l => isAaveLender(l.lenderKey))
  const config = useCollectedConfig(selection, morphoMarkets, lenders)

  const setChain = (chainId: string) => {
    setSelection({ chainId, aave: {}, morpho: { pools: [] }, morphoMarkets: {} })
  }

  const hasSelections = config.entries.length > 0

  return (
    <div className="w-full max-w-7xl mx-auto">
      {/* Chain selector */}
      <div className="mb-6">
        <label className="block text-sm font-semibold text-gray-300 mb-3">Network</label>
        <div className="flex flex-wrap gap-2">
          {SUPPORTED_CHAINS.map((id) => (
            <button
              key={id}
              onClick={() => setChain(id)}
              className={`px-3.5 py-2 rounded-xl text-sm font-medium transition-all ${
                selection.chainId === id
                  ? 'bg-white text-gray-950 shadow-lg shadow-white/10'
                  : 'bg-gray-800/60 text-gray-400 hover:bg-gray-800 hover:text-gray-200'
              }`}
            >
              {chainName(id)}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-3 py-12">
          <div className="w-5 h-5 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-gray-400">Loading market data...</span>
        </div>
      )}

      {selection.chainId && !loading && (
        <div className="grid gap-6 grid-cols-1 lg:grid-cols-[minmax(0,480px)_1fr]">
          {/* Left column: Market selection */}
          <div className="space-y-4 min-w-0">
            <UserPositionsPanel chainId={selection.chainId} />

            <section>
              <h2 className="text-sm font-semibold text-indigo-400 mb-2">Lending Protocols</h2>
              <AavePanel
                selection={selection.aave}
                onChange={(aave) => setSelection((s) => ({ ...s, aave }))}
                lenders={aaveLenders}
              />
            </section>

            <section>
              <h2 className="text-sm font-semibold text-violet-400 mb-2">Morpho Blue Markets</h2>
              <MorphoMarketsPanel
                morphoMarkets={morphoMarkets}
                selection={selection.morphoMarkets}
                onChange={(morphoMarkets) => setSelection((s) => ({ ...s, morphoMarkets }))}
              />
            </section>
          </div>

          {/* Right column: Summary + Signatures + Order */}
          <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            {hasSelections ? (
              <>
                <div className="rounded-xl border border-gray-800/80 bg-gray-900/60 backdrop-blur-sm p-4 space-y-4">
                  <SelectionSummary selection={selection} morphoMarkets={morphoMarkets} lenders={lenders} />
                </div>

                <div className="rounded-xl border border-gray-800/80 bg-gray-900/60 backdrop-blur-sm p-4">
                  <h2 className="text-sm font-semibold text-emerald-400 mb-3">Build Order</h2>
                  <OrderBuilder config={config} />
                </div>
              </>
            ) : (
              <>
                <div className="rounded-xl border border-dashed border-gray-800/60 bg-gray-900/20 p-6 text-center">
                  <div className="text-gray-600 text-sm">Selected Assets</div>
                  <p className="text-gray-700 text-xs mt-1">Select tokens or markets on the left to build your order</p>
                </div>
                <div className="rounded-xl border border-dashed border-gray-800/60 bg-gray-900/20 p-6 text-center">
                  <div className="text-gray-600 text-sm">Signatures & Order</div>
                  <p className="text-gray-700 text-xs mt-1">Permission signatures and order details will appear here</p>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
