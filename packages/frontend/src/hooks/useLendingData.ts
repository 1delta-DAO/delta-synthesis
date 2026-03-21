import { useState, useEffect } from "react";
import { PORTAL_PROXY_URL } from "../config/constants";

// ── Aave market types ───────────────────────────────────────────────────

export interface AaveMarketParams {
  metadata: {
    aToken: string;
    vToken: string;
    sToken: string;
  };
}

export interface AaveMarket {
  marketUid: string;
  name: string;
  totalDepositsUsd: number;
  totalDebtUsd: number;
  totalLiquidityUsd: number;
  depositRate: number;
  variableBorrowRate: number;
  utilization: number;
  flags: {
    isActive: boolean;
    isFrozen: boolean;
    borrowingEnabled: boolean;
    collateralActive: boolean;
  };
  caps: {
    borrowCap: number | null;
    supplyCap: number | null;
  };
  config?: Record<
    string,
    {
      collateralFactor: number;
      borrowCollateralFactor: number;
      debtDisabled?: boolean;
      collateralDisabled?: boolean;
    }
  >;
  underlyingInfo: {
    asset: {
      address: string;
      symbol: string;
      name: string;
      decimals: number;
      logoURI?: string;
    };
    prices: {
      priceUsd: number;
    };
  };
  params: AaveMarketParams;
}

// ── Morpho types ────────────────────────────────────────────────────────

export interface MorphoMarketParams {
  market: {
    lender: string;
    id: string;
    collateralDecimals: number;
    loanDecimals: number;
    lltv: string;
    oracle: string;
    irm: string;
    collateralAddress: string;
    loanAddress: string;
    fee: string;
    rateAtTarget?: string;
  };
}

/** A single sub-market inside a Morpho lender (collateral side or loan side) */
export interface MorphoSubMarket {
  marketUid: string;
  name: string;
  totalDepositsUsd: number;
  totalDebtUsd: number;
  totalLiquidityUsd: number;
  depositRate: number;
  variableBorrowRate: number;
  utilization: number | null;
  flags: {
    isActive: boolean;
    isFrozen: boolean;
    borrowingEnabled: boolean;
    collateralActive: boolean;
  };
  underlyingInfo: {
    asset: {
      address: string;
      symbol: string;
      name: string;
      decimals: number;
      logoURI?: string;
    };
    prices: {
      priceUsd: number;
    };
  };
  config?: Record<
    string,
    {
      collateralFactor: number;
      borrowCollateralFactor: number;
    }
  >;
}

/** Enriched Morpho market derived from lender-level params + sub-markets */
export interface EnrichedMorphoMarket {
  lenderKey: string;
  lenderName: string;
  lenderLogoURI?: string;
  marketIdHash: string;
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: string;
  fee: string;
  loanSymbol: string;
  collateralSymbol: string;
  loanDecimals: number;
  collateralDecimals: number;
  loanLogoURI?: string;
  collateralLogoURI?: string;
  tvlUsd: number;
  totalDepositsUsd: number;
  totalDebtUsd: number;
  depositRate: number;
  variableBorrowRate: number;
  collateralFactor: number;
}

// ── Lender item (from API) ──────────────────────────────────────────────

export interface LenderItem {
  chainId: string;
  lenderKey: string;
  lenderInfo: {
    key: string;
    name: string;
    logoURI?: string;
  };
  totalDepositsUsd: number;
  totalDebtUsd: number;
  tvlUsd: number;
  params?: MorphoMarketParams; // present on Morpho lenders at the top level
  markets: Array<AaveMarket | MorphoSubMarket>;
}

interface LendingResponse {
  success: boolean;
  data: {
    count: number;
    items: LenderItem[];
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

export function isAaveLender(key: string): boolean {
  return key === "AAVE_V3" || key === "MOOLA" || key.startsWith("AAVE_V3_");
}

export function isMorphoLender(key: string): boolean {
  return key.startsWith("MORPHO_BLUE");
}

export function isAaveMarket(
  market: AaveMarket | MorphoSubMarket,
): market is AaveMarket {
  const p = (market as AaveMarket).params;
  return p?.metadata?.aToken !== undefined;
}

// ── Build enriched Morpho markets from lender-level params ──────────────

function buildMorphoMarkets(lenders: LenderItem[]): EnrichedMorphoMarket[] {
  const results: EnrichedMorphoMarket[] = [];

  for (const lender of lenders) {
    if (!isMorphoLender(lender.lenderKey)) continue;
    if (!lender.params?.market) continue;

    const mp = lender.params.market;
    const hexPart = lender.lenderKey.replace("MORPHO_BLUE_", "");
    const marketIdHash = `0x${hexPart.toLowerCase()}`;

    // Find loan and collateral sub-markets by address
    const loanSub = lender.markets.find(
      (m) =>
        m.underlyingInfo?.asset?.address?.toLowerCase() ===
        mp.loanAddress.toLowerCase(),
    );
    const collateralSub = lender.markets.find(
      (m) =>
        m.underlyingInfo?.asset?.address?.toLowerCase() ===
        mp.collateralAddress.toLowerCase(),
    );

    results.push({
      lenderKey: lender.lenderKey,
      lenderName: lender.lenderInfo.name,
      lenderLogoURI: lender.lenderInfo.logoURI,
      marketIdHash,
      loanToken: mp.loanAddress,
      collateralToken: mp.collateralAddress,
      oracle: mp.oracle,
      irm: mp.irm,
      lltv: mp.lltv,
      fee: mp.fee,
      loanDecimals: mp.loanDecimals,
      collateralDecimals: mp.collateralDecimals,
      loanSymbol: loanSub?.underlyingInfo?.asset?.symbol ?? "Unknown",
      collateralSymbol:
        collateralSub?.underlyingInfo?.asset?.symbol ?? "Unknown",
      loanLogoURI: loanSub?.underlyingInfo?.asset?.logoURI,
      collateralLogoURI: collateralSub?.underlyingInfo?.asset?.logoURI,
      tvlUsd: lender.tvlUsd,
      totalDepositsUsd: lender.totalDepositsUsd,
      totalDebtUsd: lender.totalDebtUsd,
      depositRate: loanSub?.depositRate ?? 0,
      variableBorrowRate: loanSub?.variableBorrowRate ?? 0,
      collateralFactor: Number(mp.lltv) / 1e18,
    });
  }

  results.sort((a, b) => b.tvlUsd - a.tvlUsd);
  return results;
}

// ── Hook ────────────────────────────────────────────────────────────────

export function useLendingData(chainId: string | null) {
  const [lenders, setLenders] = useState<LenderItem[]>([]);
  const [morphoMarkets, setMorphoMarkets] = useState<EnrichedMorphoMarket[]>(
    [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!chainId) {
      setLenders([]);
      setMorphoMarkets([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    async function fetchData() {
      try {
        const params = new URLSearchParams({
          chains: chainId!,
          count: "1000",
          maxRiskScore: "5",
        });
        const res = await fetch(
          `${PORTAL_PROXY_URL}/v1/data/lending/latest?${params}`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: LendingResponse = await res.json();
        if (!json.success) throw new Error("API returned success=false");

        if (!cancelled) {
          setLenders(json.data.items);
          setMorphoMarkets(buildMorphoMarkets(json.data.items));
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchData();
    return () => {
      cancelled = true;
    };
  }, [chainId]);

  return { lenders, morphoMarkets, loading, error };
}
