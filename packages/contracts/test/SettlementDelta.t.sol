// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {SettlementExecutor} from "../src/core/settlement/SettlementExecutor.sol";

/**
 * @notice Harness whose lending ops return realistic (amountIn, amountOut) based
 *         on the operation type, exercising the zero-sum delta accounting path.
 */
contract DeltaHarness is SettlementExecutor {
    struct Conversion {
        address inputAsset;
        uint256 inputAmount;
        address outputAsset;
        uint256 outputAmount;
    }

    Conversion public pendingConversion;
    bool public hasConversion;

    function setConversion(
        address inputAsset, uint256 inputAmount,
        address outputAsset, uint256 outputAmount
    ) external {
        pendingConversion = Conversion(inputAsset, inputAmount, outputAsset, outputAmount);
        hasConversion = true;
    }

    function _lendingOperations(
        address, address asset, uint256 amount, address,
        uint256 lendingOperation, uint256, bytes memory
    ) internal pure override returns (address assetUsed, uint256 amountIn, uint256 amountOut) {
        assetUsed = asset;
        if (lendingOperation == 0 || lendingOperation == 2) {
            amountIn = amount;
        } else if (lendingOperation == 1 || lendingOperation == 3) {
            amountOut = amount;
        }
    }

    function _executeIntent(
        address, bytes memory, bytes memory,
        AssetDelta[] memory deltas, uint256 deltaCount
    ) internal override returns (uint256 newDeltaCount) {
        if (!hasConversion) return deltaCount;
        Conversion memory c = pendingConversion;
        newDeltaCount = _updateDelta(deltas, deltaCount, c.inputAsset, -int256(c.inputAmount), 0);
        newDeltaCount = _updateDelta(deltas, newDeltaCount, c.outputAsset, int256(c.outputAmount), 0);
    }

    function executeSettlement(
        address callerAddress, bytes memory orderData,
        bytes memory executionData, bytes memory fillerCalldata
    ) external {
        _executeSettlement(callerAddress, 0, orderData, executionData, fillerCalldata);
    }
}

contract SettlementDeltaTest is Test {
    DeltaHarness harness;

    address constant CALLER = address(0xCAFE);
    // Celo mainnet tokens
    address constant CUSD = 0x765DE816845861e75A25fCA122bb6898B8B1282a;
    address constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
    address constant RECEIVER = address(0xBEEF);

    function setUp() public {
        harness = new DeltaHarness();
    }

    function _leaf(uint8 op, uint16 lender, bytes memory data) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(op, lender, data));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return uint256(a) < uint256(b)
            ? keccak256(abi.encodePacked(a, b))
            : keccak256(abi.encodePacked(b, a));
    }

    function _orderData(bytes32 root) internal pure returns (bytes memory) {
        return abi.encodePacked(root, uint16(0));
    }

    function _execHeader(uint8 numPre, uint8 numPost) internal pure returns (bytes memory) {
        return abi.encodePacked(numPre, numPost, address(0));
    }

    function _action(
        address asset, uint112 amount, uint8 op,
        bytes memory data, bytes32[] memory proof
    ) internal pure returns (bytes memory) {
        bytes memory r = abi.encodePacked(
            asset, amount, address(0xBEEF), op, uint16(0), uint16(data.length), data, uint8(proof.length)
        );
        for (uint256 i; i < proof.length; i++) {
            r = abi.encodePacked(r, proof[i]);
        }
        return r;
    }

    // ── Balanced: single-asset withdraw → deposit ────────────

    function test_balanced_sameAsset_withdrawThenDeposit() public {
        bytes memory d0 = hex"AA";
        bytes memory d1 = hex"BB";

        bytes32 l0 = _leaf(3, 0, d0);
        bytes32 l1 = _leaf(0, 0, d1);
        bytes32 root = _pair(l0, l1);

        bytes32[] memory p0 = new bytes32[](1);
        p0[0] = l1;
        bytes32[] memory p1 = new bytes32[](1);
        p1[0] = l0;

        bytes memory od = _orderData(root);
        bytes memory ed = abi.encodePacked(
            _execHeader(1, 1),
            _action(CUSD, uint112(100), 3, d0, p0),
            _action(CUSD, uint112(100), 0, d1, p1)
        );

        harness.executeSettlement(CALLER, od, ed, bytes(""));
    }

    // ── Balanced: multi-asset migration ──────────────────────

    function test_balanced_multiAsset_migration() public {
        bytes memory dWithdraw = hex"01";
        bytes memory dRepay = hex"02";
        bytes memory dDeposit = hex"03";
        bytes memory dBorrow = hex"04";

        bytes32 l0 = _leaf(3, 0, dWithdraw);
        bytes32 l1 = _leaf(2, 0, dRepay);
        bytes32 l2 = _leaf(0, 0, dDeposit);
        bytes32 l3 = _leaf(1, 0, dBorrow);

        bytes32 h01 = _pair(l0, l1);
        bytes32 h23 = _pair(l2, l3);
        bytes32 root = _pair(h01, h23);

        bytes32[] memory pr0 = new bytes32[](2);
        pr0[0] = l1; pr0[1] = h23;
        bytes32[] memory pr1 = new bytes32[](2);
        pr1[0] = l0; pr1[1] = h23;
        bytes32[] memory pr2 = new bytes32[](2);
        pr2[0] = l3; pr2[1] = h01;
        bytes32[] memory pr3 = new bytes32[](2);
        pr3[0] = l2; pr3[1] = h01;

        bytes memory od = _orderData(root);
        bytes memory ed = abi.encodePacked(
            _execHeader(2, 2),
            _action(CUSD, uint112(100), 3, dWithdraw, pr0),
            _action(USDT, uint112(500), 2, dRepay, pr1),
            _action(CUSD, uint112(100), 0, dDeposit, pr2),
            _action(USDT, uint112(500), 1, dBorrow, pr3)
        );

        harness.executeSettlement(CALLER, od, ed, bytes(""));
    }

    // ── Non-borrow surplus → reverts ───

    function test_nonBorrowSurplus_reverts() public {
        bytes memory d0 = hex"AA";
        bytes memory d1 = hex"BB";

        bytes32 l0 = _leaf(3, 0, d0);
        bytes32 l1 = _leaf(0, 0, d1);
        bytes32 root = _pair(l0, l1);

        bytes32[] memory p0 = new bytes32[](1);
        p0[0] = l1;
        bytes32[] memory p1 = new bytes32[](1);
        p1[0] = l0;

        bytes memory od = _orderData(root);
        bytes memory ed = abi.encodePacked(
            _execHeader(1, 1),
            _action(CUSD, uint112(100), 3, d0, p0),
            _action(CUSD, uint112(50), 0, d1, p1)
        );

        vm.expectRevert(SettlementExecutor.UnbalancedSettlement.selector);
        harness.executeSettlement(CALLER, od, ed, bytes(""));
    }

    // ── Unbalanced: deficit reverts ──────────────────────────

    function test_revert_unbalanced_deficit() public {
        bytes memory d0 = hex"AA";
        bytes memory d1 = hex"BB";

        bytes32 l0 = _leaf(3, 0, d0);
        bytes32 l1 = _leaf(0, 0, d1);
        bytes32 root = _pair(l0, l1);

        bytes32[] memory p0 = new bytes32[](1);
        p0[0] = l1;
        bytes32[] memory p1 = new bytes32[](1);
        p1[0] = l0;

        bytes memory od = _orderData(root);
        bytes memory ed = abi.encodePacked(
            _execHeader(1, 1),
            _action(CUSD, uint112(50), 3, d0, p0),
            _action(CUSD, uint112(100), 0, d1, p1)
        );

        vm.expectRevert(SettlementExecutor.UnbalancedSettlement.selector);
        harness.executeSettlement(CALLER, od, ed, bytes(""));
    }

    // ── Unbalanced: one asset balanced, other not → reverts ──

    function test_revert_unbalanced_oneOfTwoAssets() public {
        bytes memory dWithdraw = hex"01";
        bytes memory dRepay = hex"02";
        bytes memory dDeposit = hex"03";
        bytes memory dBorrow = hex"04";

        bytes32 l0 = _leaf(3, 0, dWithdraw);
        bytes32 l1 = _leaf(2, 0, dRepay);
        bytes32 l2 = _leaf(0, 0, dDeposit);
        bytes32 l3 = _leaf(1, 0, dBorrow);

        bytes32 h01 = _pair(l0, l1);
        bytes32 h23 = _pair(l2, l3);
        bytes32 root = _pair(h01, h23);

        bytes32[] memory pr0 = new bytes32[](2);
        pr0[0] = l1; pr0[1] = h23;
        bytes32[] memory pr1 = new bytes32[](2);
        pr1[0] = l0; pr1[1] = h23;
        bytes32[] memory pr2 = new bytes32[](2);
        pr2[0] = l3; pr2[1] = h01;
        bytes32[] memory pr3 = new bytes32[](2);
        pr3[0] = l2; pr3[1] = h01;

        bytes memory od = _orderData(root);
        bytes memory ed = abi.encodePacked(
            _execHeader(2, 2),
            _action(CUSD, uint112(100), 3, dWithdraw, pr0),
            _action(USDT, uint112(500), 2, dRepay, pr1),
            _action(CUSD, uint112(100), 0, dDeposit, pr2),
            _action(USDT, uint112(400), 1, dBorrow, pr3)
        );

        vm.expectRevert(SettlementExecutor.UnbalancedSettlement.selector);
        harness.executeSettlement(CALLER, od, ed, bytes(""));
    }

    // ── Intent conversion balances a cross-asset settlement ──

    function test_balanced_intentConversion() public {
        bytes memory dWithdraw = hex"01";
        bytes memory dDeposit = hex"02";

        bytes32 l0 = _leaf(3, 0, dWithdraw);
        bytes32 l1 = _leaf(0, 0, dDeposit);
        bytes32 root = _pair(l0, l1);

        bytes32[] memory p0 = new bytes32[](1);
        p0[0] = l1;
        bytes32[] memory p1 = new bytes32[](1);
        p1[0] = l0;

        // Convert 100 cUSD → 200 USDT
        harness.setConversion(CUSD, 100, USDT, 200);

        bytes memory od = _orderData(root);
        bytes memory ed = abi.encodePacked(
            _execHeader(1, 1),
            _action(CUSD, uint112(100), 3, dWithdraw, p0),
            _action(USDT, uint112(200), 0, dDeposit, p1)
        );

        harness.executeSettlement(CALLER, od, ed, bytes(""));
    }

    // ── Intent conversion with insufficient output → reverts ─

    function test_revert_intentConversion_insufficientOutput() public {
        bytes memory dWithdraw = hex"01";
        bytes memory dDeposit = hex"02";

        bytes32 l0 = _leaf(3, 0, dWithdraw);
        bytes32 l1 = _leaf(0, 0, dDeposit);
        bytes32 root = _pair(l0, l1);

        bytes32[] memory p0 = new bytes32[](1);
        p0[0] = l1;
        bytes32[] memory p1 = new bytes32[](1);
        p1[0] = l0;

        harness.setConversion(CUSD, 100, USDT, 150);

        bytes memory od = _orderData(root);
        bytes memory ed = abi.encodePacked(
            _execHeader(1, 1),
            _action(CUSD, uint112(100), 3, dWithdraw, p0),
            _action(USDT, uint112(200), 0, dDeposit, p1)
        );

        vm.expectRevert(SettlementExecutor.UnbalancedSettlement.selector);
        harness.executeSettlement(CALLER, od, ed, bytes(""));
    }

    // ── No actions, no intent → trivially balanced ───────────

    function test_balanced_noActions() public {
        bytes memory od = abi.encodePacked(bytes32(0), uint16(0));
        bytes memory ed = abi.encodePacked(_execHeader(0, 0));
        harness.executeSettlement(CALLER, od, ed, bytes(""));
    }
}
