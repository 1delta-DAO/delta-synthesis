// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {SettlementExecutor} from "../src/core/settlement/SettlementExecutor.sol";

/**
 * @notice Concrete harness that inherits SettlementExecutor.
 *         Overrides lending dispatch and intent to record calls instead of hitting real protocols.
 *         Returns (asset, 0, 0) so deltas are always zero — isolates merkle tests from accounting.
 */
contract SettlementHarness is SettlementExecutor {
    struct LendingCall {
        address callerAddress;
        address asset;
        uint256 amount;
        address receiver;
        uint256 op;
        uint256 lender;
        bytes data;
    }

    struct IntentCall {
        address callerAddress;
        bytes settlementData;
        bytes fillerCalldata;
    }

    LendingCall[] public lendingCalls;
    IntentCall[] public intentCalls;

    function getLendingCallCount() external view returns (uint256) { return lendingCalls.length; }
    function getLendingCall(uint256 i) external view returns (LendingCall memory) { return lendingCalls[i]; }
    function getIntentCallCount() external view returns (uint256) { return intentCalls.length; }
    function getIntentCall(uint256 i) external view returns (IntentCall memory) { return intentCalls[i]; }

    function _lendingOperations(
        address callerAddress, address asset, uint256 amount, address receiver,
        uint256 lendingOperation, uint256 lender, bytes memory data
    ) internal override returns (address assetUsed, uint256 amountIn, uint256 amountOut) {
        assetUsed = asset;
        lendingCalls.push(LendingCall(callerAddress, asset, amount, receiver, lendingOperation, lender, data));
    }

    function _executeIntent(
        address callerAddress, bytes memory settlementData, bytes memory fillerCalldata,
        AssetDelta[] memory, uint256 deltaCount
    ) internal override returns (uint256 newDeltaCount) {
        newDeltaCount = deltaCount;
        intentCalls.push(IntentCall(callerAddress, settlementData, fillerCalldata));
    }

    function executeSettlement(
        address callerAddress, bytes memory orderData,
        bytes memory executionData, bytes memory fillerCalldata
    ) external {
        _executeSettlement(callerAddress, 0, orderData, executionData, fillerCalldata);
    }
}

contract SettlementExecutorTest is Test {
    SettlementHarness harness;

    address constant CALLER = address(0xCAFE);
    // Celo mainnet tokens
    address constant CUSD = 0x765DE816845861e75A25fCA122bb6898B8B1282a;
    address constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
    address constant RECEIVER = address(0xBEEF);

    function setUp() public {
        harness = new SettlementHarness();
    }

    function _leaf(uint8 op, uint16 lender, bytes memory data) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(op, lender, data));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return uint256(a) < uint256(b)
            ? keccak256(abi.encodePacked(a, b))
            : keccak256(abi.encodePacked(b, a));
    }

    function _execHeader(uint8 numPre, uint8 numPost) internal pure returns (bytes memory) {
        return abi.encodePacked(numPre, numPost, address(0));
    }

    function _orderData(bytes32 root, bytes memory settlement) internal pure returns (bytes memory) {
        return abi.encodePacked(root, uint16(settlement.length), settlement);
    }

    function _action(
        address asset, uint112 amount, address receiver,
        uint8 op, uint16 lender, bytes memory data, bytes32[] memory proof
    ) internal pure returns (bytes memory) {
        bytes memory r = abi.encodePacked(asset, amount, receiver, op, lender, uint16(data.length), data, uint8(proof.length));
        for (uint256 i; i < proof.length; i++) {
            r = abi.encodePacked(r, proof[i]);
        }
        return r;
    }

    // ── Tests ───────────────────────────────────────────────

    function test_singlePre_singlePost() public {
        bytes memory poolData = abi.encodePacked(address(0x1111));
        bytes memory borrowData = abi.encodePacked(uint8(2), address(0x1111));

        bytes32 l0 = _leaf(0, 0, poolData);
        bytes32 l1 = _leaf(1, 1, borrowData);
        bytes32 root = _pair(l0, l1);

        bytes32[] memory p0 = new bytes32[](1);
        p0[0] = l1;
        bytes32[] memory p1 = new bytes32[](1);
        p1[0] = l0;

        bytes memory od = _orderData(root, hex"DEADBEEF");
        bytes memory ed = abi.encodePacked(
            _execHeader(1, 1),
            _action(CUSD, 1000, RECEIVER, 0, 0, poolData, p0),
            _action(USDT, 500, RECEIVER, 1, 1, borrowData, p1)
        );

        harness.executeSettlement(CALLER, od, ed, bytes(""));

        assertEq(harness.getLendingCallCount(), 2);
        assertEq(harness.getIntentCallCount(), 1);

        SettlementHarness.LendingCall memory c0 = harness.getLendingCall(0);
        assertEq(c0.callerAddress, CALLER);
        assertEq(c0.asset, CUSD);
        assertEq(c0.amount, 1000);
        assertEq(c0.receiver, CALLER);
        assertEq(c0.op, 0);

        SettlementHarness.LendingCall memory c1 = harness.getLendingCall(1);
        assertEq(c1.asset, USDT);
        assertEq(c1.amount, 500);
        assertEq(c1.op, 1);

        SettlementHarness.IntentCall memory ic = harness.getIntentCall(0);
        assertEq(ic.callerAddress, CALLER);
        assertEq(ic.settlementData, hex"DEADBEEF");
    }

    function test_noActions_intentOnly() public {
        bytes memory od = _orderData(bytes32(0), hex"1234");
        bytes memory ed = abi.encodePacked(_execHeader(0, 0));

        harness.executeSettlement(CALLER, od, ed, bytes(""));

        assertEq(harness.getLendingCallCount(), 0);
        assertEq(harness.getIntentCallCount(), 1);
    }

    function test_revert_invalidProof() public {
        bytes memory data = abi.encodePacked(address(0x1111));
        bytes32 realLeaf = _leaf(0, 0, data);
        bytes32 fakeLeaf = keccak256("fake");
        bytes32 root = _pair(realLeaf, fakeLeaf);

        bytes memory od = _orderData(root, hex"");

        bytes memory badData = abi.encodePacked(address(0x9999));
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = fakeLeaf;

        bytes memory ed = abi.encodePacked(
            _execHeader(1, 0),
            _action(CUSD, 100, RECEIVER, 0, 0, badData, proof)
        );

        vm.expectRevert(SettlementExecutor.InvalidMerkleProof.selector);
        harness.executeSettlement(CALLER, od, ed, bytes(""));
    }

    function test_solverChoosesFromMenu_4leaves() public {
        bytes memory p0 = abi.encodePacked(address(0xAA));
        bytes memory p1 = abi.encodePacked(address(0xBB));
        bytes memory p2 = abi.encodePacked(address(0xCC));
        bytes memory p3 = abi.encodePacked(address(0xDD));

        bytes32 l0 = _leaf(0, 0, p0);
        bytes32 l1 = _leaf(0, 0, p1);
        bytes32 l2 = _leaf(0, 0, p2);
        bytes32 l3 = _leaf(0, 0, p3);

        bytes32 h01 = _pair(l0, l1);
        bytes32 h23 = _pair(l2, l3);
        bytes32 root = _pair(h01, h23);

        bytes32[] memory proof = new bytes32[](2);
        proof[0] = l3;
        proof[1] = h01;

        bytes memory od = _orderData(root, hex"");
        bytes memory ed = abi.encodePacked(
            _execHeader(1, 0),
            _action(CUSD, 5000, RECEIVER, 0, 0, p2, proof)
        );

        harness.executeSettlement(CALLER, od, ed, bytes(""));

        assertEq(harness.getLendingCallCount(), 1);
        assertEq(harness.getLendingCall(0).data, p2);
    }

    function test_fillerCalldata_passedToIntent() public {
        bytes memory od = _orderData(bytes32(0), hex"AA");
        bytes memory ed = abi.encodePacked(_execHeader(0, 0));
        bytes memory filler = hex"DEADBEEFCAFE";

        harness.executeSettlement(CALLER, od, ed, filler);

        assertEq(harness.getIntentCallCount(), 1);
        SettlementHarness.IntentCall memory ic = harness.getIntentCall(0);
        assertEq(ic.fillerCalldata, filler);
    }
}
