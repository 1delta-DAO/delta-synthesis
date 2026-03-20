# Verato Settlement Architecture

## Overview

Verato enables **autonomous agents to manage user lending positions** across protocols on Celo. Users sign EIP-712 orders that commit to a set of lending operations (via Merkle root) and conditions (health factors, oracle-verified swaps). Solvers (agents) execute these orders, earning fees from borrow surplus.

## Order Lifecycle

```
User signs EIP-712 order
        │
        ▼
Solver calls settle() or settleWithFlashLoan()
        │
        ▼
┌───────────────────────────┐
│  1. Verify signature      │  EIP-712 digest, deadline, nonce, solver restriction
│  2. Check solver trust    │  Direct trust OR reputation registry (ERC-8004)
│  3. Execute pre-actions   │  Merkle-verified lending ops (withdraw, repay, ...)
│  4. Execute conversions   │  Oracle-verified swaps via SettlementForwarder
│  5. Execute post-actions  │  Merkle-verified lending ops (deposit, borrow, ...)
│  6. Verify deltas         │  Per-asset zero-sum accounting
│  7. Sweep fees            │  Borrow surplus only, capped by maxFeeBps
│  8. Check conditions      │  Health factors per touched protocol
└───────────────────────────┘
```

## EIP-712 Order

```solidity
VeratoOrder(
    bytes32 merkleRoot,           // Commits to all allowed lending operations
    uint48  deadline,             // Expiry, also serves as nonce for bulk cancellation
    uint256 maxFeeBps,            // Max fee (1e7 denominator: 50000 = 0.5%)
    address solver,               // Restricted solver, or address(0) = permissionless
    uint256 minSolverReputation,  // Min ERC-8004 reputation, or 0 = no check
    bytes   settlementData        // Packed conversions + conditions (see below)
)
```

## Data Layout

### settlementData (user-signed)

```
[1: numConversions]
  per conversion: [20: assetIn][20: assetOut][20: oracle][6: swapTolerance]
[1: numConditions]
  per condition (protocol-specific):
    Aave:      [2: lenderId][20: pool][16: minHealthFactor]
    CompV3:    [2: lenderId][20: comet][2: assetBitmap][16: minHF]
    CompV2:    [2: lenderId][20: comptroller]
    Morpho:    [2: lenderId][20: morpho][32: marketId][16: minHF]
```

### executionData (solver-provided)

```
[1: numPre][1: numPost][20: feeRecipient]
  per action:
    [20: asset][14: amount][20: receiver][1: op][2: lender][2: dataLen][data...][proofLen][proof...]
```

### Amount Resolution

| Value | Meaning |
|-------|---------|
| `0` | Contract's current balance of the asset |
| `type(uint112).max` | User's full position balance (max withdraw/repay) |
| Any other | Literal amount |

## Lending Operations

Operations are dispatched by `lenderId` range:

| Range | Protocol | Examples |
|-------|----------|----------|
| 0–999 | Aave V3 | `lenderId=500` → Aave V3 on Celo |
| 1000–1999 | Aave V2 | `lenderId=1500` → Moola on Celo |
| 2000–2999 | Compound V3 | Comet markets |
| 3000–3999 | Compound V2 | Venus, Iron Bank, dForce forks |
| 4000–4999 | Morpho Blue | Isolated lending markets |

Operations: `DEPOSIT(0)`, `BORROW(1)`, `REPAY(2)`, `WITHDRAW(3)`, `DEPOSIT_LENDING(4)`, `WITHDRAW_LENDING(5)`

## Merkle Verification

Every lending action must reconstruct the signed `merkleRoot`:

```
leaf = keccak256(abi.encodePacked(op, lender, data))
```

The solver provides sibling hashes as proof. This prevents solvers from executing operations the user didn't authorize.

## Fee Model

```
For each asset with a positive delta (totalOut > totalIn):
  - If the asset was borrowed: delta is the fee
    Constraint: fee × 1e7 ≤ totalBorrowed × maxFeeBps
  - If the asset was NOT borrowed: revert (must be re-deposited)
  - Negative delta: revert (UnbalancedSettlement)
```

Fees are only extracted from borrow surplus. A solver borrows slightly more than needed, keeps the difference.

## Oracle Swap Verification

For each conversion, the solver routes through any DEX but must satisfy:

```
amountOut × 1e7 ≥ oracleExpectedOutput × (1e7 − swapTolerance)
```

The `SettlementForwarder` executes DEX calls in an isolated context (no persistent approvals).

## Flash Loan Flow

```
settleWithFlashLoan()
  → morphoFlashLoan(asset, amount, user, packedData)
    → Morpho sends tokens to Verato
      → onMorphoFlashLoan() callback
        → _executeSettlement() (pre-actions, swaps, post-actions, fees, conditions)
      → Morpho pulls back loan amount
```

On Celo, Morpho Blue is the flash loan source.

## Solver Trust Model

Trust is **fully embedded in the signed EIP-712 order** — no storage-based permissioning needed.
The `solver` and `minSolverReputation` fields together express the user's trust requirements:

| solver | minSolverReputation | Meaning |
|--------|---------------------|---------|
| `address(0)` | `0` | Permissionless — anyone can settle |
| `address(0)` | `500` | Any solver with reputation ≥ 500 |
| `0xABC` | `0` | Direct trust — only 0xABC, no reputation check |
| `0xABC` | `500` | Only 0xABC AND must have reputation ≥ 500 |

### Global reputation floor

The contract owner can set `minReputation` — a global floor that applies regardless of
what individual orders specify. The effective minimum for any order is:

```
effective = max(order.minSolverReputation, global minReputation)
```

If effective is 0, the reputation check is skipped entirely.

### Solver identity (ERC-8004)

Solvers must link their address to an on-chain identity before executing reputation-gated orders:

```solidity
linkSolverAgentId(uint256 agentId)  // Requires identityRegistry.balanceOf(solver) > 0
```

When `effective > 0`, settlement checks:
1. `solverLinked[solver]` — solver has linked an agentId
2. `identityRegistry.balanceOf(solver) > 0` — solver holds an identity NFT
3. `reputationRegistry.getSummary(agentId).averageScore ≥ effective` — meets reputation threshold

## Migration Example: Moola → Aave V3

```
Pre-Actions:
  1. REPAY cUSD on Moola (lender=1500, Aave V2)
  2. WITHDRAW CELO collateral from Moola

Conversions: (none if same assets)

Post-Actions:
  1. DEPOSIT CELO collateral on Aave V3 (lender=500)
  2. BORROW cUSD on Aave V3

Verification:
  - All deltas zero (balanced)
  - Health factor on Aave V3 ≥ user's minHealthFactor
```

## Contract Inheritance

```
Verato
├── MorphoFlashLoans
├── MorphoSettlementCallback
│   └── SettlementExecutor
│       └── UniversalSettlementLending
│           ├── AaveSettlementLending
│           ├── CompoundV2SettlementLending
│           ├── CompoundV3SettlementLending
│           └── MorphoSettlementLending
├── EIP712OrderVerifier
├── SwapVerifier
│   └── AaveOracleAdapter
└── HealthFactorChecker
```

## File Map

```
src/core/settlement/
├── celo/Verato.sol              # Main entry point (Celo-specific)
├── SettlementExecutor.sol       # Core execution loop
├── SettlementForwarder.sol      # Isolated DEX call sandbox
├── EIP712OrderVerifier.sol      # Signature + nonce management
├── flash-loan/
│   ├── Morpho.sol               # Flash loan initiation
│   └── MorphoSettlementCallback.sol  # Callback unpacking
├── lending/
│   ├── UniversalSettlementLending.sol  # Router by lenderId
│   ├── AaveSettlementLending.sol       # Aave V2/V3
│   ├── CompoundV2SettlementLending.sol # Compound V2 forks
│   ├── CompoundV3SettlementLending.sol # Comet
│   ├── MorphoSettlementLending.sol     # Morpho Blue
│   ├── BorrowBalanceFetcher.sol        # Max-borrow resolution
│   ├── DepositBalanceFetcher.sol       # Max-withdraw resolution
│   └── DeltaEnums.sol                  # Operation/lender enums
├── conditions/
│   └── HealthFactorChecker.sol  # Per-protocol HF verification
├── oracle/
│   ├── SwapVerifier.sol         # Oracle-vs-actual comparison
│   ├── AaveOracleAdapter.sol    # Aave oracle → ISettlementPriceOracle
│   └── ISettlementPriceOracle.sol  # Oracle interface
├── errors/Errors.sol
└── masks/Masks.sol
```
