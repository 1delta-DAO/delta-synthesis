import {
  concatHex,
  encodePacked,
  numberToHex,
  padHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import type {
  MerkleAction,
  Conversion,
  Condition,
  FillerSwap,
} from "./types.js";

// ── Settlement data (user-signed, embedded in orderData) ────────────────

/**
 * Encode settlementData — the user-signed portion that defines:
 *   - Oracle-verified swap conversions
 *   - Post-settlement health-factor conditions
 *
 * Layout:
 *   [1: numConversions]
 *   per conversion (68 bytes): [20: assetIn][20: assetOut][20: oracle][8: swapTolerance]
 *   [1: numConditions]
 *   per condition (variable): protocol-specific packed bytes
 */
export function encodeSettlementData(
  conversions: Conversion[],
  conditions: Condition[]
): Hex {
  const parts: Hex[] = [];

  // numConversions (1 byte)
  parts.push(numberToHex(conversions.length, { size: 1 }));

  // Each conversion: 20 + 20 + 20 + 8 = 68 bytes
  for (const c of conversions) {
    parts.push(
      encodePacked(
        ["address", "address", "address", "uint64"],
        [c.assetIn, c.assetOut, c.oracle, c.swapTolerance]
      )
    );
  }

  // numConditions (1 byte)
  parts.push(numberToHex(conditions.length, { size: 1 }));

  // Each condition: protocol-specific
  for (const cond of conditions) {
    switch (cond.type) {
      case "aave":
        // 2 + 20 + 14 = 36 bytes
        parts.push(
          encodePacked(
            ["uint16", "address", "uint112"],
            [cond.lenderId, cond.pool, cond.minHealthFactor]
          )
        );
        break;
      case "compoundV3":
        // 2 + 20 + 2 + 14 = 38 bytes
        parts.push(
          encodePacked(
            ["uint16", "address", "uint16", "uint112"],
            [
              cond.lenderId,
              cond.comet,
              cond.assetBitmap,
              cond.minHealthFactor,
            ]
          )
        );
        break;
      case "compoundV2":
        // 2 + 20 = 22 bytes (but on-chain cursor advances 36)
        // The on-chain code reads 2+20 then advances cursor by 36, so we pad
        parts.push(
          encodePacked(
            ["uint16", "address"],
            [cond.lenderId, cond.comptroller]
          )
        );
        break;
      case "morpho":
        // 2 + 20 + 32 + 14 = 68 bytes
        parts.push(
          encodePacked(
            ["uint16", "address", "bytes32", "uint112"],
            [
              cond.lenderId,
              cond.morpho,
              cond.marketId,
              cond.minHealthFactor,
            ]
          )
        );
        break;
    }
  }

  return concatHex(parts);
}

// ── Order data ──────────────────────────────────────────────────────────

/**
 * Encode orderData from merkleRoot + settlementData.
 *
 * Layout: [32: merkleRoot][2: settlementDataLength][settlementData...]
 */
export function encodeOrderData(
  merkleRoot: Hex,
  settlementData: Hex
): Hex {
  const sdBytes = (settlementData.length - 2) / 2; // hex string → byte count
  return concatHex([
    merkleRoot,
    numberToHex(sdBytes, { size: 2 }),
    settlementData,
  ]);
}

// ── Execution data ──────────────────────────────────────────────────────

/**
 * Encode a single Merkle-verified lending action.
 *
 * Layout per action:
 *   [20: asset][14: amount][20: receiver][1: op][2: lender]
 *   [2: dataLen][data...][1: proofLen][proof...]
 */
function encodeAction(action: MerkleAction): Hex {
  const parts: Hex[] = [];
  parts.push(
    encodePacked(
      ["address", "uint112", "address", "uint8", "uint16"],
      [
        action.asset,
        action.amount,
        action.receiver,
        action.op,
        action.lenderId,
      ]
    )
  );

  const dataBytes = (action.data.length - 2) / 2;
  parts.push(numberToHex(dataBytes, { size: 2 }));
  if (dataBytes > 0) parts.push(action.data);

  parts.push(numberToHex(action.proof.length, { size: 1 }));
  for (const sibling of action.proof) {
    parts.push(sibling);
  }

  return concatHex(parts);
}

/**
 * Encode executionData from pre-actions, post-actions, and fee recipient.
 *
 * Layout:
 *   [1: numPre][1: numPost][20: feeRecipient]
 *   [pre-actions...][post-actions...]
 */
export function encodeExecutionData(
  preActions: MerkleAction[],
  postActions: MerkleAction[],
  feeRecipient: Address
): Hex {
  const parts: Hex[] = [];

  parts.push(numberToHex(preActions.length, { size: 1 }));
  parts.push(numberToHex(postActions.length, { size: 1 }));
  parts.push(encodePacked(["address"], [feeRecipient]));

  for (const action of preActions) {
    parts.push(encodeAction(action));
  }
  for (const action of postActions) {
    parts.push(encodeAction(action));
  }

  return concatHex(parts);
}

// ── Filler calldata ─────────────────────────────────────────────────────

/**
 * Encode fillerCalldata — the solver's swap execution data.
 *
 * Per swap (76 + swapCalldata.length bytes):
 *   [20: assetIn][20: assetOut][14: amountIn][20: target]
 *   [2: swapCalldataLen][swapCalldata...]
 */
export function encodeFillerCalldata(swaps: FillerSwap[]): Hex {
  if (swaps.length === 0) return "0x";

  const parts: Hex[] = [];
  for (const swap of swaps) {
    parts.push(
      encodePacked(
        ["address", "address", "uint112", "address"],
        [swap.assetIn, swap.assetOut, swap.amountIn, swap.target]
      )
    );

    const cdBytes = (swap.swapCalldata.length - 2) / 2;
    parts.push(numberToHex(cdBytes, { size: 2 }));
    if (cdBytes > 0) parts.push(swap.swapCalldata);
  }

  return concatHex(parts);
}
