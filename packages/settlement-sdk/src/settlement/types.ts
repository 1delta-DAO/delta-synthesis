import type { Address, Hex } from "viem";

// ── Lending operations ──────────────────────────────────────────────────

export const LendingOp = {
  DEPOSIT: 0,
  BORROW: 1,
  REPAY: 2,
  WITHDRAW: 3,
  DEPOSIT_LENDING: 4,
  WITHDRAW_LENDING: 5,
} as const;

export type LendingOpCode = (typeof LendingOp)[keyof typeof LendingOp];

// ── Lender ID ranges ────────────────────────────────────────────────────

export const LenderRange = {
  AAVE_V3: { min: 0, max: 999 },
  AAVE_V2: { min: 1000, max: 1999 },
  COMPOUND_V3: { min: 2000, max: 2999 },
  COMPOUND_V2: { min: 3000, max: 3999 },
  MORPHO_BLUE: { min: 4000, max: 4999 },
} as const;

// ── Merkle tree ─────────────────────────────────────────────────────────

export interface MerkleLeaf {
  op: LendingOpCode;
  lenderId: number;
  data: Hex;
}

export interface MerkleAction {
  asset: Address;
  /** 0 = use contract balance, 2^112-1 = max position, else literal */
  amount: bigint;
  receiver: Address;
  op: LendingOpCode;
  lenderId: number;
  data: Hex;
  proof: Hex[];
}

// ── Conversions (oracle-verified swaps) ─────────────────────────────────

export interface Conversion {
  assetIn: Address;
  assetOut: Address;
  oracle: Address;
  /** Tolerance in 1e7 units (e.g. 50000 = 0.5%) */
  swapTolerance: bigint;
}

// ── Post-settlement conditions ──────────────────────────────────────────

export type Condition =
  | { type: "aave"; lenderId: number; pool: Address; minHealthFactor: bigint }
  | {
      type: "compoundV3";
      lenderId: number;
      comet: Address;
      assetBitmap: number;
      minHealthFactor: bigint;
    }
  | { type: "compoundV2"; lenderId: number; comptroller: Address }
  | {
      type: "morpho";
      lenderId: number;
      morpho: Address;
      marketId: Hex;
      minHealthFactor: bigint;
    };

// ── Filler swap calldata ────────────────────────────────────────────────

export interface FillerSwap {
  assetIn: Address;
  assetOut: Address;
  /** 0 = use contract balance */
  amountIn: bigint;
  target: Address;
  swapCalldata: Hex;
}

// ── Order ───────────────────────────────────────────────────────────────

export interface VeratoOrder {
  merkleRoot: Hex;
  deadline: number;
  maxFeeBps: bigint;
  solver: Address;
  minSolverReputation: bigint;
  settlementData: Hex;
}

// ── Settlement params ───────────────────────────────────────────────────

export interface SettleParams {
  maxFeeBps: bigint;
  solver: Address;
  minSolverReputation: bigint;
  deadline: number;
  signature: Hex;
  orderData: Hex;
  executionData: Hex;
  fillerCalldata: Hex;
}

export interface SettleWithFlashLoanParams extends SettleParams {
  flashLoanAsset: Address;
  flashLoanAmount: bigint;
  flashLoanPool: Address;
  poolId: number;
}

// ── Celo addresses ──────────────────────────────────────────────────────

export const CeloAddresses = {
  AAVE_V3_POOL: "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402" as Address,
  MOOLA_POOL: "0x970b12522CA9b4054807a2c5B736149a5BE6f670" as Address,
  CELO: "0x471EcE3750Da237f93B8E339c536989b8978a438" as Address,
  CUSD: "0x765DE816845861e75A25fCA122bb6898B8B1282a" as Address,
  USDC: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as Address,
  USDT: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as Address,
  WETH: "0xD221812de1BD094f35587EE8E174B07B6167D9Af" as Address,
  IDENTITY_REGISTRY: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address,
  REPUTATION_REGISTRY:
    "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as Address,
} as const;

export const CELO_CHAIN_ID = 42220;

/** Amount sentinel: use contract's current balance */
export const AMOUNT_BALANCE = 0n;
/** Amount sentinel: use full position (max withdraw/repay) */
export const AMOUNT_MAX = (1n << 112n) - 1n;
