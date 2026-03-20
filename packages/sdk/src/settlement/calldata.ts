import {
  encodeFunctionData,
  type Address,
  type Hex,
} from "viem";
import type { SettleParams, SettleWithFlashLoanParams } from "./types.js";

// ── Verato ABI fragments ────────────────────────────────────────────────

const settleAbi = [
  {
    name: "settle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "maxFeeBps", type: "uint256" },
      { name: "solver", type: "address" },
      { name: "minSolverReputation", type: "uint256" },
      { name: "deadline", type: "uint48" },
      { name: "signature", type: "bytes" },
      { name: "orderData", type: "bytes" },
      { name: "executionData", type: "bytes" },
      { name: "fillerCalldata", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const settleWithFlashLoanAbi = [
  {
    name: "settleWithFlashLoan",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "flashLoanAsset", type: "address" },
      { name: "flashLoanAmount", type: "uint256" },
      { name: "flashLoanPool", type: "address" },
      { name: "poolId", type: "uint8" },
      { name: "maxFeeBps", type: "uint256" },
      { name: "solver", type: "address" },
      { name: "minSolverReputation", type: "uint256" },
      { name: "deadline", type: "uint48" },
      { name: "signature", type: "bytes" },
      { name: "orderData", type: "bytes" },
      { name: "executionData", type: "bytes" },
      { name: "fillerCalldata", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export const veratoAbi = [...settleAbi, ...settleWithFlashLoanAbi] as const;

// ── Calldata builders ───────────────────────────────────────────────────

/**
 * Encode calldata for Verato.settle().
 */
export function encodeSettle(params: SettleParams): Hex {
  return encodeFunctionData({
    abi: settleAbi,
    functionName: "settle",
    args: [
      params.maxFeeBps,
      params.solver,
      params.minSolverReputation,
      params.deadline,
      params.signature,
      params.orderData,
      params.executionData,
      params.fillerCalldata,
    ],
  });
}

/**
 * Encode calldata for Verato.settleWithFlashLoan().
 */
export function encodeSettleWithFlashLoan(
  params: SettleWithFlashLoanParams
): Hex {
  return encodeFunctionData({
    abi: settleWithFlashLoanAbi,
    functionName: "settleWithFlashLoan",
    args: [
      params.flashLoanAsset,
      params.flashLoanAmount,
      params.flashLoanPool,
      params.poolId,
      params.maxFeeBps,
      params.solver,
      params.minSolverReputation,
      params.deadline,
      params.signature,
      params.orderData,
      params.executionData,
      params.fillerCalldata,
    ],
  });
}
