import type { Address, Hex, WalletClient, Account } from "viem";
import type { VeratoOrder } from "./types.js";
import { CELO_CHAIN_ID } from "./types.js";

// ── EIP-712 type definitions ────────────────────────────────────────────

export const VERATO_DOMAIN = {
  name: "Verato" as const,
  version: "1" as const,
};

export function getVeratoDomain(
  chainId: number,
  verifyingContract: Address
) {
  return {
    name: VERATO_DOMAIN.name,
    version: VERATO_DOMAIN.version,
    chainId: BigInt(chainId),
    verifyingContract,
  } as const;
}

export const veratoOrderTypes = {
  VeratoOrder: [
    { name: "merkleRoot", type: "bytes32" },
    { name: "deadline", type: "uint48" },
    { name: "maxFeeBps", type: "uint256" },
    { name: "solver", type: "address" },
    { name: "minSolverReputation", type: "uint256" },
    { name: "settlementData", type: "bytes" },
  ],
} as const;

// ── Signing ─────────────────────────────────────────────────────────────

/**
 * Sign a Verato order using EIP-712 via a viem WalletClient.
 *
 * @param client     - viem WalletClient with an account
 * @param order      - The order to sign
 * @param contract   - Verato contract address (verifyingContract)
 * @param chainId    - Chain ID (defaults to Celo mainnet 42220)
 * @returns 65-byte packed signature (hex string)
 */
export async function signOrder(
  client: WalletClient,
  order: VeratoOrder,
  contract: Address,
  chainId: number = CELO_CHAIN_ID
): Promise<Hex> {
  const account = client.account;
  if (!account) throw new Error("WalletClient must have an account");

  const domain = getVeratoDomain(chainId, contract);

  const signature = await client.signTypedData({
    account,
    domain,
    types: veratoOrderTypes,
    primaryType: "VeratoOrder",
    message: {
      merkleRoot: order.merkleRoot,
      deadline: order.deadline,
      maxFeeBps: order.maxFeeBps,
      solver: order.solver,
      minSolverReputation: order.minSolverReputation,
      settlementData: order.settlementData,
    },
  });

  return signature;
}
