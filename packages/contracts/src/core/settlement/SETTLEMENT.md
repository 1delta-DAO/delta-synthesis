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
    bytes32 merkleRoot,    // Commits to all allowed lending operations
    uint48  deadline,      // Expiry, also serves as nonce for bulk cancellation
    uint256 maxFeeBps,     // Max fee (1e7 denominator: 50000 = 0.5%)
    address solver,        // Restricted solver, or address(0) = permissionless
    bytes   settlementData // Packed conversions + conditions (see below)
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

## Celo-Specific: Agent Trust

### Direct Trust
```solidity
authoriseAgent(address agent)   // Whitelist by address
revokeAgent(address agent)
```

### Identity-Based Trust (ERC-8004)
```solidity
authoriseAgentId(uint256 agentId)  // Trust by on-chain identity
setTrustPolicy(TrustPolicy policy) // requireRegistered or minReputation
setMinReputation(uint256 minRep)
```

Agents link their identity via `linkAgentId(agentId)` and must hold the identity NFT.

### Solver Reputation Gating
```solidity
setUserSolverTrust(solver, true)      // Direct trust (skips reputation)
linkSolverAgentId(uint256 agentId)    // Link solver identity
userMinReputation[user] = threshold   // Per-user reputation floor
```

Before settlement, `_checkSolverReputation()` verifies the solver meets the user's trust requirements.

### Agent Fees
- 0.10% fee on all position operations (configurable via `FEE_BPS`)
- Fees tracked per agent/token in `agentFees[agent][token]`
- Agents can `claimFeesAsNative()` to swap fees to CELO via Uniswap

### Success Tracking
```
agentScores[user][agent].opsSettled   // Total operations
agentScores[user][agent].opsReverted  // Disputed operations
agentScores[user][agent].feesEarned   // Total fees collected
```

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
