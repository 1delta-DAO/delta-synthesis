import type { Address, Hex, WalletClient } from "viem";
import { zeroAddress } from "viem";
import type {
  LendingOpCode,
  Conversion,
  Condition,
  FillerSwap,
  MerkleAction,
  SettleParams,
  SettleWithFlashLoanParams,
  VeratoOrder,
} from "./types.js";
import { AMOUNT_BALANCE, AMOUNT_MAX, CELO_CHAIN_ID } from "./types.js";
import { buildOrderActions } from "./merkle.js";
import {
  encodeSettlementData,
  encodeOrderData,
  encodeExecutionData,
  encodeFillerCalldata,
} from "./encode.js";
import { signOrder } from "./sign.js";

// ── Action descriptor (before Merkle enrichment) ────────────────────────

interface ActionInput {
  asset: Address;
  amount: bigint;
  receiver: Address;
  op: LendingOpCode;
  lenderId: number;
  data: Hex;
}

// ── Builder ─────────────────────────────────────────────────────────────

/**
 * Fluent builder for constructing Verato settlement orders.
 *
 * Usage:
 * ```ts
 * const { settleParams } = await new SettlementBuilder()
 *   .preAction({ asset: WETH, amount: AMOUNT_MAX, receiver: verato, op: 3, lenderId: 0, data: withdrawData })
 *   .postAction({ asset: WETH, amount: AMOUNT_BALANCE, receiver: user, op: 0, lenderId: 0, data: depositData })
 *   .maxFee(50_000n)        // 0.5%
 *   .solver(zeroAddress)     // permissionless
 *   .minReputation(0n)       // no reputation check
 *   .deadline(Math.floor(Date.now() / 1000) + 3600)
 *   .feeRecipient(zeroAddress)
 *   .sign(walletClient, veratoAddress)
 * ```
 */
export class SettlementBuilder {
  private _preActions: ActionInput[] = [];
  private _postActions: ActionInput[] = [];
  private _conversions: Conversion[] = [];
  private _conditions: Condition[] = [];
  private _fillerSwaps: FillerSwap[] = [];
  private _maxFeeBps: bigint = 0n;
  private _solver: Address = zeroAddress;
  private _minSolverReputation: bigint = 0n;
  private _deadline: number = 0;
  private _feeRecipient: Address = zeroAddress;
  private _chainId: number = CELO_CHAIN_ID;

  // ── Fluent setters ──────────────────────────────────────────────────

  preAction(action: ActionInput): this {
    this._preActions.push(action);
    return this;
  }

  postAction(action: ActionInput): this {
    this._postActions.push(action);
    return this;
  }

  conversion(conv: Conversion): this {
    this._conversions.push(conv);
    return this;
  }

  condition(cond: Condition): this {
    this._conditions.push(cond);
    return this;
  }

  fillerSwap(swap: FillerSwap): this {
    this._fillerSwaps.push(swap);
    return this;
  }

  maxFee(bps: bigint): this {
    this._maxFeeBps = bps;
    return this;
  }

  solver(addr: Address): this {
    this._solver = addr;
    return this;
  }

  minReputation(rep: bigint): this {
    this._minSolverReputation = rep;
    return this;
  }

  deadline(ts: number): this {
    this._deadline = ts;
    return this;
  }

  feeRecipient(addr: Address): this {
    this._feeRecipient = addr;
    return this;
  }

  chainId(id: number): this {
    this._chainId = id;
    return this;
  }

  // ── Build (unsigned) ────────────────────────────────────────────────

  /**
   * Build all encoded data without signing.
   * Returns the order object, orderData, executionData, fillerCalldata,
   * and the enriched Merkle actions.
   */
  build(): {
    order: VeratoOrder;
    orderData: Hex;
    executionData: Hex;
    fillerCalldata: Hex;
    preActions: MerkleAction[];
    postActions: MerkleAction[];
  } {
    if (this._deadline === 0) {
      throw new Error("Deadline must be set");
    }

    // Build Merkle tree from all actions
    const allInputs = [...this._preActions, ...this._postActions];
    const { root, actions: enriched } = buildOrderActions(allInputs);

    const preActions = enriched.slice(0, this._preActions.length);
    const postActions = enriched.slice(this._preActions.length);

    // Encode settlement data (user-signed conversions + conditions)
    const settlementData = encodeSettlementData(
      this._conversions,
      this._conditions
    );

    // Encode order data (merkleRoot + settlementData)
    const orderData = encodeOrderData(root, settlementData);

    // Encode execution data (actions with Merkle proofs)
    const executionData = encodeExecutionData(
      preActions,
      postActions,
      this._feeRecipient
    );

    // Encode filler calldata (solver swap execution)
    const fillerCalldata = encodeFillerCalldata(this._fillerSwaps);

    const order: VeratoOrder = {
      merkleRoot: root,
      deadline: this._deadline,
      maxFeeBps: this._maxFeeBps,
      solver: this._solver,
      minSolverReputation: this._minSolverReputation,
      settlementData,
    };

    return {
      order,
      orderData,
      executionData,
      fillerCalldata,
      preActions,
      postActions,
    };
  }

  // ── Build + sign ────────────────────────────────────────────────────

  /**
   * Build and sign the order, returning everything needed to call settle().
   */
  async sign(
    client: WalletClient,
    veratoAddress: Address
  ): Promise<{
    settleParams: SettleParams;
    order: VeratoOrder;
    preActions: MerkleAction[];
    postActions: MerkleAction[];
  }> {
    const { order, orderData, executionData, fillerCalldata, preActions, postActions } =
      this.build();

    const signature = await signOrder(
      client,
      order,
      veratoAddress,
      this._chainId
    );

    const settleParams: SettleParams = {
      maxFeeBps: order.maxFeeBps,
      solver: order.solver,
      minSolverReputation: order.minSolverReputation,
      deadline: order.deadline,
      signature,
      orderData,
      executionData,
      fillerCalldata,
    };

    return { settleParams, order, preActions, postActions };
  }

  /**
   * Build and sign for flash-loan settlement.
   */
  async signWithFlashLoan(
    client: WalletClient,
    veratoAddress: Address,
    flashLoan: {
      asset: Address;
      amount: bigint;
      pool: Address;
      poolId: number;
    }
  ): Promise<{
    settleParams: SettleWithFlashLoanParams;
    order: VeratoOrder;
  }> {
    const { settleParams, order } = await this.sign(client, veratoAddress);

    return {
      settleParams: {
        ...settleParams,
        flashLoanAsset: flashLoan.asset,
        flashLoanAmount: flashLoan.amount,
        flashLoanPool: flashLoan.pool,
        poolId: flashLoan.poolId,
      },
      order,
    };
  }
}
