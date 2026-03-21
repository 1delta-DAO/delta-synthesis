/**
 * Test fixtures — mock user positions and pools on Celo.
 */

import type { LenderPositions } from '../src/direct/api.js'
import type { PoolInfo } from '../src/interpret/pools.js'
import type { MerkleLeaf, StoredOrder } from '../src/order.js'
import type { LeafDescription } from '../src/order.js'
import type { Address, Hex } from 'viem'

// ── Celo token addresses ────────────────────────────────────────────────

export const CELO_TOKENS = {
  CUSD:  '0x765DE816845861e75A25fCA122bb6898B8B1282a' as Address,
  CEUR:  '0xd8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73' as Address,
  CELO:  '0x471EcE3750Da237f93B8E339c536989b8978a438' as Address,
  WETH:  '0xD221812de1BD094f35587EE8E174B07B6167D9Af' as Address,
  USDC:  '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as Address,
  USDT:  '0x48065fbBE25f71C9282ddf5e1cd6D6A887483D5e' as Address,
  CREAL: '0xe8537a3d056DA446677B9e9d6c5dB704EaAb4787' as Address,
}

// ── Scenario 1: User with ONLY deposits (no debt) ───────────────────────
//    Has cUSD deposited in Moola at 0.5% APY.
//    Aave V3 offers 1.2% APY on cUSD → should migrate.

export const SCENARIO_NO_DEBT: {
  positions: LenderPositions[]
  leaves: LeafDescription[]
} = {
  positions: [
    {
      lender: 'MOOLA',
      chainId: '42220',
      account: '0xTestUser1111111111111111111111111111111111',
      data: [
        {
          accountId: '0xTestUser1111111111111111111111111111111111',
          health: 999,
          borrowCapacityUSD: 5000,
          balanceData: { deposits: 10000, debt: 0, collateral: 10000, nav: 10000 },
          aprData: { apr: 0.5, depositApr: 0.5, borrowApr: 0 },
          positions: [
            {
              marketUid: 'MOOLA:42220:0x765de816845861e75a25fca122bb6898b8b1282a',
              deposits: '10000000000000000000000',
              debt: '0',
              depositsUSD: 10000,
              debtUSD: 0,
              collateralEnabled: true,
              underlyingInfo: {
                asset: {
                  chainId: '42220',
                  address: CELO_TOKENS.CUSD,
                  symbol: 'cUSD',
                  name: 'Celo Dollar',
                  decimals: 18,
                  logoURI: 'https://example.com/cusd.png',
                },
              },
            },
          ],
        },
      ],
    },
  ],
  leaves: [
    // WITHDRAW from Moola (lenderId 1000 = AAVE_V2 range)
    { index: 0, op: 'WITHDRAW', protocol: 'AAVE_V2', lenderId: 1000, pool: '0x970b12522CA9b4054807a2c5B736149a5BE6f670' },
    // DEPOSIT to Aave V3 (lenderId 0)
    { index: 1, op: 'DEPOSIT', protocol: 'AAVE_V3', lenderId: 0, pool: '0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402' },
    // DEPOSIT to Moola (lenderId 1000)
    { index: 2, op: 'DEPOSIT', protocol: 'AAVE_V2', lenderId: 1000, pool: '0x970b12522CA9b4054807a2c5B736149a5BE6f670' },
  ],
}

// ── Scenario 2: User with deposits + debt ───────────────────────────────
//    Has WETH collateral and USDC debt on Aave V3.
//    Should fall through to the full debt migration flow.

export const SCENARIO_WITH_DEBT: {
  positions: LenderPositions[]
  leaves: LeafDescription[]
} = {
  positions: [
    {
      lender: 'AAVE_V3',
      chainId: '42220',
      account: '0xTestUser2222222222222222222222222222222222',
      data: [
        {
          accountId: '0xTestUser2222222222222222222222222222222222',
          health: 1.85,
          borrowCapacityUSD: 2000,
          balanceData: { deposits: 5000, debt: 1500, collateral: 5000, nav: 3500 },
          aprData: { apr: -1.2, depositApr: 0.5, borrowApr: 1.7 },
          positions: [
            {
              marketUid: 'AAVE_V3:42220:0xd221812de1bd094f35587ee8e174b07b6167d9af',
              deposits: '2000000000000000000',
              debt: '0',
              depositsUSD: 5000,
              debtUSD: 0,
              collateralEnabled: true,
              underlyingInfo: {
                asset: {
                  chainId: '42220',
                  address: CELO_TOKENS.WETH,
                  symbol: 'WETH',
                  name: 'Wrapped Ether',
                  decimals: 18,
                },
              },
            },
            {
              marketUid: 'AAVE_V3:42220:0xceba9300f2b948710d2653dd7b07f33a8b32118c',
              deposits: '0',
              debt: '1500000000',
              depositsUSD: 0,
              debtUSD: 1500,
              collateralEnabled: false,
              underlyingInfo: {
                asset: {
                  chainId: '42220',
                  address: CELO_TOKENS.USDC,
                  symbol: 'USDC',
                  name: 'USD Coin',
                  decimals: 6,
                },
              },
            },
          ],
        },
      ],
    },
  ],
  leaves: [
    { index: 0, op: 'WITHDRAW', protocol: 'AAVE_V3', lenderId: 0 },
    { index: 1, op: 'REPAY', protocol: 'AAVE_V3', lenderId: 0 },
    { index: 2, op: 'DEPOSIT', protocol: 'AAVE_V3', lenderId: 0 },
    { index: 3, op: 'BORROW', protocol: 'AAVE_V3', lenderId: 0 },
    { index: 4, op: 'DEPOSIT', protocol: 'AAVE_V2', lenderId: 1000 },
    { index: 5, op: 'BORROW', protocol: 'AAVE_V2', lenderId: 1000 },
  ],
}

// ── Scenario 3: Cross-asset swap opportunity ────────────────────────────
//    Has CELO deposited in Moola at ~0.1% APY.
//    USDC on Aave V3 offers 2.0% APY → swap CELO→USDC and deposit.

export const SCENARIO_SWAP: {
  positions: LenderPositions[]
  leaves: LeafDescription[]
} = {
  positions: [
    {
      lender: 'MOOLA',
      chainId: '42220',
      account: '0xTestUser3333333333333333333333333333333333',
      data: [
        {
          accountId: '0xTestUser3333333333333333333333333333333333',
          health: 999,
          borrowCapacityUSD: 500,
          balanceData: { deposits: 1000, debt: 0, collateral: 1000, nav: 1000 },
          aprData: { apr: 0.1, depositApr: 0.1, borrowApr: 0 },
          positions: [
            {
              marketUid: 'MOOLA:42220:0x471ece3750da237f93b8e339c536989b8978a438',
              deposits: '12000000000000000000000',
              debt: '0',
              depositsUSD: 1000,
              debtUSD: 0,
              collateralEnabled: true,
              underlyingInfo: {
                asset: {
                  chainId: '42220',
                  address: CELO_TOKENS.CELO,
                  symbol: 'CELO',
                  name: 'Celo',
                  decimals: 18,
                },
              },
            },
          ],
        },
      ],
    },
  ],
  leaves: [
    // WITHDRAW CELO from Moola
    { index: 0, op: 'WITHDRAW', protocol: 'AAVE_V2', lenderId: 1000 },
    // DEPOSIT to Aave V3 (could be USDC after swap)
    { index: 1, op: 'DEPOSIT', protocol: 'AAVE_V3', lenderId: 0 },
  ],
}

// ── Mock pools (Celo mainnet-like rates) ────────────────────────────────

export const MOCK_POOLS: PoolInfo[] = [
  {
    marketUid: 'AAVE_V3:42220:0x765de816845861e75a25fca122bb6898b8b1282a',
    lenderKey: 'AAVE_V3',
    name: 'Aave V3 cUSD',
    token: CELO_TOKENS.CUSD,
    symbol: 'cUSD',
    decimals: 18,
    depositRate: 1.2,
    variableBorrowRate: 3.5,
    totalDepositsUsd: 5_000_000,
    totalLiquidityUsd: 3_000_000,
    borrowingEnabled: true,
    collateralActive: true,
  },
  {
    marketUid: 'MOOLA:42220:0x765de816845861e75a25fca122bb6898b8b1282a',
    lenderKey: 'MOOLA',
    name: 'Moola cUSD',
    token: CELO_TOKENS.CUSD,
    symbol: 'cUSD',
    decimals: 18,
    depositRate: 0.5,
    variableBorrowRate: 2.0,
    totalDepositsUsd: 1_000_000,
    totalLiquidityUsd: 800_000,
    borrowingEnabled: true,
    collateralActive: true,
  },
  {
    marketUid: 'AAVE_V3:42220:0xceba9300f2b948710d2653dd7b07f33a8b32118c',
    lenderKey: 'AAVE_V3',
    name: 'Aave V3 USDC',
    token: CELO_TOKENS.USDC,
    symbol: 'USDC',
    decimals: 6,
    depositRate: 2.0,
    variableBorrowRate: 4.0,
    totalDepositsUsd: 8_000_000,
    totalLiquidityUsd: 5_000_000,
    borrowingEnabled: true,
    collateralActive: true,
  },
  {
    marketUid: 'AAVE_V3:42220:0xd221812de1bd094f35587ee8e174b07b6167d9af',
    lenderKey: 'AAVE_V3',
    name: 'Aave V3 WETH',
    token: CELO_TOKENS.WETH,
    symbol: 'WETH',
    decimals: 18,
    depositRate: 0.01,
    variableBorrowRate: 0.2,
    totalDepositsUsd: 5_000_000,
    totalLiquidityUsd: 4_500_000,
    borrowingEnabled: true,
    collateralActive: true,
  },
  {
    marketUid: 'MOOLA:42220:0x471ece3750da237f93b8e339c536989b8978a438',
    lenderKey: 'MOOLA',
    name: 'Moola CELO',
    token: CELO_TOKENS.CELO,
    symbol: 'CELO',
    decimals: 18,
    depositRate: 0.1,
    variableBorrowRate: 1.0,
    totalDepositsUsd: 500_000,
    totalLiquidityUsd: 400_000,
    borrowingEnabled: true,
    collateralActive: true,
  },
  {
    marketUid: 'AAVE_V3:42220:0x471ece3750da237f93b8e339c536989b8978a438',
    lenderKey: 'AAVE_V3',
    name: 'Aave V3 CELO',
    token: CELO_TOKENS.CELO,
    symbol: 'CELO',
    decimals: 18,
    depositRate: 0.53,
    variableBorrowRate: 3.8,
    totalDepositsUsd: 200_000,
    totalLiquidityUsd: 150_000,
    borrowingEnabled: false,
    collateralActive: true,
  },
  {
    marketUid: 'AAVE_V3:42220:0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e',
    lenderKey: 'AAVE_V3',
    name: 'Aave V3 USDT',
    token: CELO_TOKENS.USDT,
    symbol: 'USDT',
    decimals: 6,
    depositRate: 0.63,
    variableBorrowRate: 1.85,
    totalDepositsUsd: 8_700_000,
    totalLiquidityUsd: 5_000_000,
    borrowingEnabled: true,
    collateralActive: true,
  },
]
