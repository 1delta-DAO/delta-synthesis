# Verato

**A trustless settlement gateway that lets users safely delegate complex DeFi operations to autonomous agents on Celo.**

Built for the Celo hackathon. Verato bridges the gap between AI agents and on-chain lending by giving users fine-grained, cryptographic control over what agents can do with their positions.

---

## The Problem

AI agents are increasingly capable of managing DeFi positions, but delegating control today means either:
- Granting blanket token approvals and hoping the agent behaves, or
- Manually executing every transaction yourself

There's no middle ground where users can specify *exactly* which operations an agent may perform, verify the agent's reputation on-chain, and enforce safety invariants like health factor minimums -- all without trusting a centralized intermediary.

## How Verato Works

Users sign EIP-712 orders that encode a **Merkle tree of permitted operations**. Agents (called "solvers") can only execute operations whose Merkle proofs verify against the user-signed root. Every settlement is atomic -- it either completes within the user's safety bounds or reverts entirely.

```
User signs order                Agent submits settlement
       |                                |
  [Merkle root]  ----verifies---->  [Merkle proof per operation]
  [max fee]                         [oracle-verified swaps]
  [health factor min]               [lending ops: deposit/borrow/repay/withdraw]
  [solver trust policy]             [post-settlement health check]
```

### Solver Trust Model

Trust is embedded directly in the signed order -- no storage-based permissioning:

| `solver` | `minSolverReputation` | Behavior |
|---|---|---|
| `address(0)` | `0` | Permissionless -- any agent can fill |
| `address(0)` | `500` | Any agent with reputation >= 500 |
| `0xABC` | `0` | Only `0xABC` can fill |
| `0xABC` | `500` | Only `0xABC`, and only if rep >= 500 |

Solver identity is backed by **Celo ERC-8004** registries -- agents mint an NFT identity and accumulate on-chain reputation scores from user feedback.

### Supported Operations

Verato covers the full lifecycle of lending positions across multiple protocols:

| Operation | Description |
|---|---|
| **Deposit** | Supply collateral |
| **Borrow** | Take a loan |
| **Repay** | Pay back debt |
| **Withdraw** | Remove collateral |
| **Swap** | Oracle-verified token conversion with user-signed slippage tolerance |
| **Flash Loan** | Atomic leveraged operations via Morpho Blue |

### Supported Protocols

- **Aave V3 & V2**
- **Morpho Blue**
- **Moola** (Celo-native, Aave V2 fork)
- **Compound V2 & V3**

This combination makes Verato ideal for **forex hedging strategies** on Celo -- agents can autonomously rebalance leveraged positions across stablecoins (cUSD, cEUR, cREAL, USDC, USDT) using Moola and Aave, with oracle-verified swaps ensuring fair execution.

### Safety Guarantees

- **Merkle-verified actions** -- agents can only execute operations the user explicitly permitted
- **Oracle-verified swaps** -- every swap is checked against Aave's price oracle with user-defined slippage tolerance
- **Health factor enforcement** -- post-settlement checks ensure positions remain safe across all touched protocols
- **Fee caps** -- solvers can only charge fees on borrowed amounts, capped by a user-signed `maxFeeBps`
- **Per-asset zero-sum accounting** -- the settlement executor tracks every token flow and enforces balance invariants
- **Isolated execution** -- solver-provided calldata runs through a sandboxed `SettlementForwarder`, isolated from token approvals

## Project Structure

```
packages/
  contracts/       Solidity smart contracts (Foundry)
    src/core/
      settlement/
        celo/Verato.sol              Main protocol contract
        SettlementExecutor.sol       Settlement orchestration engine
        SettlementForwarder.sol      Sandboxed execution environment
        EIP712OrderVerifier.sol      Signature verification & replay protection
        lending/                     Protocol adapters (Aave, Morpho, Compound)
        oracle/                      Swap verification via Aave oracle
        conditions/                  Post-settlement health factor checks
        flash-loan/                  Morpho Blue flash loan support
    src/interfaces/
      IIdentityRegistry.sol          ERC-8004 agent identity (NFT-based)
      IReputationRegistry.sol        On-chain reputation scoring

  sdk/             TypeScript SDK (@delta-synthesis/sdk)
    settlement/
      builder.ts                     Fluent API for constructing orders
      merkle.ts                      Merkle tree construction & proof generation
      encode.ts                      ABI encoding for on-chain submission
      sign.ts                        EIP-712 signing utilities

  frontend/        React web application
  backend/         Backend service
```

## Quick Start

```bash
# Install dependencies
pnpm install

# Build & test contracts
pnpm contracts:build
pnpm contracts:test

# Run frontend
pnpm dev
```

## How It Enables Forex Hedging on Celo

Celo's multi-currency stablecoin ecosystem (cUSD, cEUR, cREAL) combined with lending protocols like Moola creates natural opportunities for forex hedging. Verato enables agents to:

1. **Open leveraged positions** -- deposit cUSD, borrow cEUR via flash loan for leveraged EUR/USD exposure
2. **Rebalance across currencies** -- swap between stablecoins with oracle-verified pricing
3. **Manage health factors** -- automatically repay or add collateral when positions approach liquidation
4. **Unwind positions** -- atomically close multi-leg positions in a single transaction

All while the user retains cryptographic control over exactly which operations are permitted and what safety bounds must be maintained.

## Built With

- **Solidity 0.8.34** + Foundry
- **EIP-712** typed structured data signing
- **Celo ERC-8004** identity and reputation registries
- **Morpho Blue** flash loans
- **React 19** + TypeScript + Vite
- **viem** for blockchain interactions

## License

MIT
