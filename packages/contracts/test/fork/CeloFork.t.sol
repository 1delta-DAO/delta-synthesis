// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test, console} from "forge-std/Test.sol";
import {IVerato} from "./IVerato.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IAaveV3Pool {
    struct ReserveDataLegacy {
        uint256 configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
    function getReserveData(address asset) external view returns (ReserveDataLegacy memory);
    function getUserAccountData(address user) external view returns (
        uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase,
        uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor
    );
}

interface ICreditDelegation {
    function approveDelegation(address delegatee, uint256 amount) external;
}

/**
 * @title CeloForkTest
 * @notice Fork tests against Celo mainnet Aave V3.
 *  Pool: https://github.com/1delta-DAO/lender-metadata/blob/main/config/aave-pools.json
 *  Collateral: WETH | Debt: USDC (for HF tests only)
 */
contract CeloForkTest is Test {
    address constant AAVE_V3_POOL = 0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402;
    address constant UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;

    address constant CELO = 0x471EcE3750Da237f93B8E339c536989b8978a438;
    address constant CUSD = 0x765DE816845861e75A25fCA122bb6898B8B1282a;
    address constant USDC = 0xcebA9300f2b948710d2653dD7B07f33A8B32118C;
    address constant WETH = 0xD221812de1BD094f35587EE8E174B07B6167D9Af;

    address constant IDENTITY_REGISTRY  = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant REPUTATION_REGISTRY = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    bytes32 constant VERATO_ORDER_TYPEHASH =
        keccak256("VeratoOrder(bytes32 merkleRoot,uint48 deadline,uint256 maxFeeBps,address solver,bytes settlementData)");

    IVerato verato;
    address user;
    uint256 userPk;
    address aWETH;
    address vDebtUSDC;

    function _leaf(uint8 op, uint16 lender, bytes memory data) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(op, lender, data));
    }
    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return uint256(a) < uint256(b) ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
    function _action(address asset, uint112 amount, address receiver, uint8 op, uint16 lender, bytes memory data, bytes32[] memory proof) internal pure returns (bytes memory) {
        bytes memory r = abi.encodePacked(asset, amount, receiver, op, lender, uint16(data.length), data, uint8(proof.length));
        for (uint256 i; i < proof.length; i++) r = abi.encodePacked(r, proof[i]);
        return r;
    }
    function _signOrder(uint256 pk, bytes32 root, uint48 deadline, uint256 maxFee, address solver, bytes memory sd) internal view returns (bytes memory) {
        bytes32 ds = verato.DOMAIN_SEPARATOR();
        bytes32 sh = keccak256(abi.encode(VERATO_ORDER_TYPEHASH, root, deadline, maxFee, solver, keccak256(sd)));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ds, sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ── Setup: WETH collateral only (no debt — safe for withdraw round-trips) ──

    function setUp() public {
        string memory rpcUrl = vm.envOr("CELO_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) { vm.skip(true); return; }
        vm.createSelectFork(rpcUrl, 62_100_000);
        if (AAVE_V3_POOL.code.length == 0) { vm.skip(true); return; }

        (user, userPk) = makeAddrAndKey("celoUser");

        bytes memory args = abi.encode(IDENTITY_REGISTRY, REPUTATION_REGISTRY, UNISWAP_V3_ROUTER, CELO);
        bytes memory bc = abi.encodePacked(vm.getCode("out/Verato.sol/Verato.json"), args);
        address d; assembly { d := create(0, add(bc, 0x20), mload(bc)) }
        require(d != address(0)); verato = IVerato(d);

        aWETH = IAaveV3Pool(AAVE_V3_POOL).getReserveData(WETH).aTokenAddress;
        vDebtUSDC = IAaveV3Pool(AAVE_V3_POOL).getReserveData(USDC).variableDebtTokenAddress;

        verato.approveToken(WETH, AAVE_V3_POOL, type(uint256).max);
        verato.approveToken(USDC, AAVE_V3_POOL, type(uint256).max);

        deal(WETH, user, 1e18);
        vm.startPrank(user);
        IERC20(WETH).approve(AAVE_V3_POOL, type(uint256).max);
        IAaveV3Pool(AAVE_V3_POOL).supply(WETH, 1e18, user, 0);
        IERC20(aWETH).approve(address(verato), type(uint256).max);
        ICreditDelegation(vDebtUSDC).approveDelegation(address(verato), type(uint256).max);
        vm.stopPrank();
    }

    function _addDebt(uint256 amount) internal {
        vm.prank(user);
        IAaveV3Pool(AAVE_V3_POOL).borrow(USDC, amount, 2, 0, user);
    }

    // ═══════════════════════════════════════════════════════════
    //  Test: balanced withdraw + deposit (no debt — safe round-trip)
    // ═══════════════════════════════════════════════════════════

    function test_celoFork_balancedWithdrawDeposit() public {
        bytes memory wd = abi.encodePacked(aWETH, AAVE_V3_POOL);
        bytes memory dd = abi.encodePacked(AAVE_V3_POOL);
        bytes32 l0 = _leaf(3, 0, wd); bytes32 l1 = _leaf(0, 0, dd);
        bytes32 root = _pair(l0, l1);
        bytes32[] memory p0 = new bytes32[](1); p0[0] = l1;
        bytes32[] memory p1 = new bytes32[](1); p1[0] = l0;

        bytes memory od = abi.encodePacked(root, uint16(0));
        bytes memory ed = abi.encodePacked(uint8(1), uint8(1), address(0),
            _action(WETH, type(uint112).max, address(verato), 3, 0, wd, p0),
            _action(WETH, 0, user, 0, 0, dd, p1));

        uint48 dl = uint48(block.timestamp + 1 hours);
        bytes memory sig = _signOrder(userPk, root, dl, 0, address(0), hex"");
        vm.prank(user); verato.setUserSolverTrust(address(this), true);

        uint256 before = IERC20(aWETH).balanceOf(user);
        verato.settle(0, address(0), dl, sig, od, ed, hex"");
        uint256 after_ = IERC20(aWETH).balanceOf(user);

        assertApproxEqRel(after_, before, 1e15, "aWETH preserved");
        assertEq(IERC20(WETH).balanceOf(address(verato)), 0, "no WETH left");
        console.log("Balanced: aWETH", before, "->", after_);
    }

    // ═══════════════════════════════════════════════════════════

    function test_celoFork_expiredDeadline_reverts() public {
        bytes memory wd = abi.encodePacked(aWETH, AAVE_V3_POOL);
        bytes memory dd = abi.encodePacked(AAVE_V3_POOL);
        bytes32 l0 = _leaf(3, 0, wd); bytes32 l1 = _leaf(0, 0, dd);
        bytes32 root = _pair(l0, l1);
        bytes32[] memory p0 = new bytes32[](1); p0[0] = l1;
        bytes32[] memory p1 = new bytes32[](1); p1[0] = l0;
        bytes memory od = abi.encodePacked(root, uint16(0));
        bytes memory ed = abi.encodePacked(uint8(1), uint8(1), address(0),
            _action(WETH, type(uint112).max, address(verato), 3, 0, wd, p0),
            _action(WETH, 0, user, 0, 0, dd, p1));
        uint48 dl = uint48(block.timestamp - 1);
        bytes memory sig = _signOrder(userPk, root, dl, 0, address(0), hex"");
        vm.prank(user); verato.setUserSolverTrust(address(this), true);
        vm.expectRevert(bytes4(keccak256("OrderExpired()")));
        verato.settle(0, address(0), dl, sig, od, ed, hex"");
    }

    // ═══════════════════════════════════════════════════════════

    function test_celoFork_invalidProof_reverts() public {
        bytes memory wd = abi.encodePacked(aWETH, AAVE_V3_POOL);
        bytes memory dd = abi.encodePacked(AAVE_V3_POOL);
        bytes32 l0 = _leaf(3, 0, wd); bytes32 l1 = _leaf(0, 0, dd);
        bytes32 root = _pair(l0, l1);
        bytes32[] memory bad = new bytes32[](1); bad[0] = bytes32(uint256(0xDEAD));
        bytes32[] memory p1 = new bytes32[](1); p1[0] = l0;
        bytes memory od = abi.encodePacked(root, uint16(0));
        bytes memory ed = abi.encodePacked(uint8(1), uint8(1), address(0),
            _action(WETH, type(uint112).max, address(verato), 3, 0, wd, bad),
            _action(WETH, 0, user, 0, 0, dd, p1));
        uint48 dl = uint48(block.timestamp + 1 hours);
        bytes memory sig = _signOrder(userPk, root, dl, 0, address(0), hex"");
        vm.prank(user); verato.setUserSolverTrust(address(this), true);
        vm.expectRevert(bytes4(keccak256("InvalidMerkleProof()")));
        verato.settle(0, address(0), dl, sig, od, ed, hex"");
    }

    // ═══════════════════════════════════════════════════════════
    //  Test: Aave V3 HF condition passes (no debt = max HF)
    // ═══════════════════════════════════════════════════════════

    function test_celoFork_healthFactor_noDebt_passes() public {
        bytes memory wd = abi.encodePacked(aWETH, AAVE_V3_POOL);
        bytes memory dd = abi.encodePacked(AAVE_V3_POOL);
        bytes32 l0 = _leaf(3, 0, wd); bytes32 l1 = _leaf(0, 0, dd);
        bytes32 root = _pair(l0, l1);
        bytes32[] memory p0 = new bytes32[](1); p0[0] = l1;
        bytes32[] memory p1 = new bytes32[](1); p1[0] = l0;

        // Absurdly high minHF — passes because no debt
        bytes memory sp = abi.encodePacked(uint8(0), uint8(1), uint16(0), AAVE_V3_POOL, uint112(100e18));
        bytes memory od = abi.encodePacked(root, uint16(sp.length), sp);
        bytes memory ed = abi.encodePacked(uint8(1), uint8(1), address(0),
            _action(WETH, type(uint112).max, address(verato), 3, 0, wd, p0),
            _action(WETH, 0, user, 0, 0, dd, p1));

        uint48 dl = uint48(block.timestamp + 1 hours);
        bytes memory sig = _signOrder(userPk, root, dl, 0, address(0), sp);
        vm.prank(user); verato.setUserSolverTrust(address(this), true);

        verato.settle(0, address(0), dl, sig, od, ed, hex"");

        (,,,,, uint256 hf) = IAaveV3Pool(AAVE_V3_POOL).getUserAccountData(user);
        assertEq(hf, type(uint256).max, "no debt = max HF");
        console.log("HF no-debt: max");
    }

    // ═══════════════════════════════════════════════════════════
    //  Test: HF condition with active debt (WETH collateral / USDC debt)
    //  Round-trip the collateral — HF stays the same (minHF = 1.1 passes)
    // ═══════════════════════════════════════════════════════════

    function test_celoFork_healthFactor_withDebt_passes() public {
        // Borrow 100 USDC against 1 WETH — safe LTV
        _addDebt(100e6);

        (,,,,, uint256 hfBefore) = IAaveV3Pool(AAVE_V3_POOL).getUserAccountData(user);
        console.log("HF before:", hfBefore);

        // Partial withdraw + redeposit (don't withdraw ALL — keep HF > 1)
        uint256 partialAmount = IERC20(aWETH).balanceOf(user) / 10; // 10%

        bytes memory wd = abi.encodePacked(aWETH, AAVE_V3_POOL);
        bytes memory dd = abi.encodePacked(AAVE_V3_POOL);
        bytes32 l0 = _leaf(3, 0, wd); bytes32 l1 = _leaf(0, 0, dd);
        bytes32 root = _pair(l0, l1);
        bytes32[] memory p0 = new bytes32[](1); p0[0] = l1;
        bytes32[] memory p1 = new bytes32[](1); p1[0] = l0;

        bytes memory sp = abi.encodePacked(uint8(0), uint8(1), uint16(0), AAVE_V3_POOL, uint112(1.1e18));
        bytes memory od = abi.encodePacked(root, uint16(sp.length), sp);
        bytes memory ed = abi.encodePacked(uint8(1), uint8(1), address(0),
            _action(WETH, uint112(partialAmount), address(verato), 3, 0, wd, p0),
            _action(WETH, 0, user, 0, 0, dd, p1));

        uint48 dl = uint48(block.timestamp + 1 hours);
        bytes memory sig = _signOrder(userPk, root, dl, 0, address(0), sp);
        vm.prank(user); verato.setUserSolverTrust(address(this), true);

        verato.settle(0, address(0), dl, sig, od, ed, hex"");

        (,,,,, uint256 hfAfter) = IAaveV3Pool(AAVE_V3_POOL).getUserAccountData(user);
        assertGt(hfAfter, 1.1e18, "HF above 1.1");
        console.log("HF after:", hfAfter);
    }
}
