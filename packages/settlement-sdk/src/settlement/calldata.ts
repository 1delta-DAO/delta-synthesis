import {
  encodeFunctionData,
  maxUint256,
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

const approveTokenAbi = [
  {
    name: "approveToken",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const permitAbi = [
  {
    name: "permit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

const aaveDelegationWithSigAbi = [
  {
    name: "aaveDelegationWithSig",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "debtToken", type: "address" },
      { name: "delegator", type: "address" },
      { name: "delegatee", type: "address" },
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

const morphoSetAuthorizationWithSigAbi = [
  {
    name: "morphoSetAuthorizationWithSig",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "morpho", type: "address" },
      { name: "authorizer", type: "address" },
      { name: "authorized", type: "address" },
      { name: "isAuthorized", type: "bool" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

const multicallAbi = [
  {
    name: "multicall",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [],
  },
] as const;

export const veratoAbi = [
  ...settleAbi,
  ...settleWithFlashLoanAbi,
  ...approveTokenAbi,
  ...permitAbi,
  ...aaveDelegationWithSigAbi,
  ...morphoSetAuthorizationWithSigAbi,
  ...multicallAbi,
] as const;

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

// ── Multicall helpers ───────────────────────────────────────────────────

export interface PermitParams {
  token: Address;
  owner: Address;
  spender: Address;
  value: bigint;
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

export interface AaveDelegationParams {
  debtToken: Address;
  delegator: Address;
  delegatee: Address;
  value: bigint;
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

export interface MorphoAuthorizationParams {
  morpho: Address;
  authorizer: Address;
  authorized: Address;
  isAuthorized: boolean;
  nonce: bigint;
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

/** Encode approveToken(token, spender, max) for multicall. */
export function encodeApproveToken(token: Address, spender: Address): Hex {
  return encodeFunctionData({
    abi: approveTokenAbi,
    functionName: "approveToken",
    args: [token, spender, maxUint256],
  });
}

/** Encode a permit call for multicall (aToken ERC-2612 permit). */
export function encodePermit(params: PermitParams): Hex {
  return encodeFunctionData({
    abi: permitAbi,
    functionName: "permit",
    args: [
      params.token,
      params.owner,
      params.spender,
      params.value,
      params.deadline,
      params.v,
      params.r,
      params.s,
    ],
  });
}

/** Encode Aave V3 delegationWithSig for multicall (vToken credit delegation). */
export function encodeAaveDelegation(params: AaveDelegationParams): Hex {
  return encodeFunctionData({
    abi: aaveDelegationWithSigAbi,
    functionName: "aaveDelegationWithSig",
    args: [
      params.debtToken,
      params.delegator,
      params.delegatee,
      params.value,
      params.deadline,
      params.v,
      params.r,
      params.s,
    ],
  });
}

/** Encode Morpho setAuthorizationWithSig for multicall. */
export function encodeMorphoAuthorization(
  params: MorphoAuthorizationParams
): Hex {
  return encodeFunctionData({
    abi: morphoSetAuthorizationWithSigAbi,
    functionName: "morphoSetAuthorizationWithSig",
    args: [
      params.morpho,
      params.authorizer,
      params.authorized,
      params.isAuthorized,
      params.nonce,
      params.deadline,
      params.v,
      params.r,
      params.s,
    ],
  });
}

/** Encode multicall(data[]) wrapping multiple calls into one tx. */
export function encodeMulticall(calls: Hex[]): Hex {
  return encodeFunctionData({
    abi: multicallAbi,
    functionName: "multicall",
    args: [calls],
  });
}
