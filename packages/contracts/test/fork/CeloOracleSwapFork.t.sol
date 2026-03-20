// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test, console} from "forge-std/Test.sol";
import {IVerato} from "./IVerato.sol";
import {AaveOracleAdapter, IAaveOracle} from "../../src/core/settlement/oracle/AaveOracleAdapter.sol";
import {ISettlementPriceOracle} from "../../src/core/settlement/oracle/ISettlementPriceOracle.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IAaveV3Pool {
    struct ReserveDataLegacy {
        uint256 configuration; uint128 liquidityIndex; uint128 currentLiquidityRate;
        uint128 variableBorrowIndex; uint128 currentVariableBorrowRate; uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp; uint16 id; address aTokenAddress; address stableDebtTokenAddress;
        address variableDebtTokenAddress; address interestRateStrategyAddress;
        uint128 accruedToTreasury; uint128 unbacked; uint128 isolationModeTotalDebt;
    }
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
    function getReserveData(address asset) external view returns (ReserveDataLegacy memory);
}

interface ICreditDelegation {
    function approveDelegation(address delegatee, uint256 amount) external;
}

/// @notice Mock DEX: swaps at exact Aave oracle rate. Pre-fund with output tokens.
contract FixedRateSwapper {
    ISettlementPriceOracle public oracle;
    constructor(address _oracle) { oracle = ISettlementPriceOracle(_oracle); }

    function swap(address tokenIn, uint256 amountIn, address tokenOut) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        uint256 amountOut = oracle.getExpectedOutput(tokenIn, tokenOut, amountIn);
        IERC20(tokenOut).transfer(msg.sender, amountOut);
    }
}

/**
 * @title CeloOracleSwapForkTest
 * @notice Fork tests: oracle-verified collateral swaps on Celo Aave V3.
 *
 *  Adapted from the original OracleSwapFork.t.sol.
 *
 *  Pattern: withdraw WETH from Aave V3 -> swap WETH->cUSD at oracle rate
 *           -> deposit cUSD to Aave V3 (collateral swap)
 *
 *  Addresses:
 *    Aave V3 Pool:   0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402
 *    Aave V3 Oracle: 0x1e693D088ceFD1E95ba4c4a5F7EeA41a1Ec37e8b
 *    WETH:           0xD221812de1BD094f35587EE8E174B07B6167D9Af
 *    cUSD:           0x765DE816845861e75A25fCA122bb6898B8B1282a
 *    USDC:           0xcebA9300f2b948710d2653dD7B07f33A8B32118C
 */
contract CeloOracleSwapForkTest is Test {
    address constant AAVE_V3_POOL = 0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402;
    address constant AAVE_ORACLE  = 0x1e693D088ceFD1E95ba4c4a5F7EeA41a1Ec37e8b;
    address constant UNISWAP_V3   = 0xE592427A0AEce92De3Edee1F18E0157C05861564;

    address constant CELO = 0x471EcE3750Da237f93B8E339c536989b8978a438;
    address constant CUSD = 0x765DE816845861e75A25fCA122bb6898B8B1282a;
    address constant USDC = 0xcebA9300f2b948710d2653dD7B07f33A8B32118C;
    address constant WETH = 0xD221812de1BD094f35587EE8E174B07B6167D9Af;

    address constant IDENTITY_REGISTRY  = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant REPUTATION_REGISTRY = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    bytes32 constant VERATO_ORDER_TYPEHASH =
        keccak256("VeratoOrder(bytes32 merkleRoot,uint48 deadline,uint256 maxFeeBps,address solver,bytes settlementData)");

    IVerato verato;
    AaveOracleAdapter oracleAdapter;
    FixedRateSwapper swapper;

    address user;
    uint256 userPk;

    address aWETH;
    address aCUSD;

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
    function _signOrder(uint256 pk, bytes32 root, uint48 dl, uint256 maxFee, address solver, bytes memory sd) internal view returns (bytes memory) {
        bytes32 ds = verato.DOMAIN_SEPARATOR();
        bytes32 sh = keccak256(abi.encode(VERATO_ORDER_TYPEHASH, root, dl, maxFee, solver, keccak256(sd)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", ds, sh)));
        return abi.encodePacked(r, s, v);
    }

    function setUp() public {
        string memory rpcUrl = vm.envOr("CELO_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) { vm.skip(true); return; }
        vm.createSelectFork(rpcUrl, 62_100_000);
        if (AAVE_V3_POOL.code.length == 0) { vm.skip(true); return; }

        (user, userPk) = makeAddrAndKey("swapUser");

        // Deploy Verato from pre-compiled artifact
        bytes memory args = abi.encode(IDENTITY_REGISTRY, REPUTATION_REGISTRY, UNISWAP_V3, CELO);
        bytes memory bc = abi.encodePacked(vm.getCode("out/Verato.sol/Verato.json"), args);
        address d; assembly { d := create(0, add(bc, 0x20), mload(bc)) }
        require(d != address(0)); verato = IVerato(d);

        // Oracle adapter + mock swapper
        oracleAdapter = new AaveOracleAdapter(AAVE_ORACLE);
        swapper = new FixedRateSwapper(address(oracleAdapter));

        // Resolve aTokens
        aWETH = IAaveV3Pool(AAVE_V3_POOL).getReserveData(WETH).aTokenAddress;
        aCUSD = IAaveV3Pool(AAVE_V3_POOL).getReserveData(CUSD).aTokenAddress;

        // Verato approvals
        verato.approveToken(WETH, AAVE_V3_POOL, type(uint256).max);
        verato.approveToken(CUSD, AAVE_V3_POOL, type(uint256).max);

        // Forwarder approves mock swapper (so it can pull WETH)
        address fwd = verato.forwarder();
        vm.prank(fwd);
        IERC20(WETH).approve(address(swapper), type(uint256).max);

        // User supplies 1 WETH to Aave V3
        deal(WETH, user, 1e18);
        vm.startPrank(user);
        IERC20(WETH).approve(AAVE_V3_POOL, type(uint256).max);
        IAaveV3Pool(AAVE_V3_POOL).supply(WETH, 1e18, user, 0);
        IERC20(aWETH).approve(address(verato), type(uint256).max);
        vm.stopPrank();

        // Fund mock swapper with cUSD liquidity
        deal(CUSD, address(swapper), 100_000e18);
    }

    // ═══════════════════════════════════════════════════════════
    //  Test: oracle adapter sanity — WETH→cUSD conversion
    // ═══════════════════════════════════════════════════════════

    function test_celoOracle_wethToCusd() public view {
        uint256 wethPrice = IAaveOracle(AAVE_ORACLE).getAssetPrice(WETH);
        uint256 cusdPrice = IAaveOracle(AAVE_ORACLE).getAssetPrice(CUSD);
        console.log("WETH price (8 dec):", wethPrice);
        console.log("cUSD price (8 dec):", cusdPrice);

        uint256 expectedOut = oracleAdapter.getExpectedOutput(WETH, CUSD, 1e18);
        console.log("1 WETH -> cUSD:", expectedOut);

        // WETH should be worth something reasonable in cUSD
        assertGt(expectedOut, 100e18, "WETH > 100 cUSD");
        assertLt(expectedOut, 100_000e18, "WETH < 100k cUSD");
    }

    // ═══════════════════════════════════════════════════════════
    //  Test: collateral swap — withdraw WETH, swap to cUSD,
    //  deposit cUSD (oracle-verified, no debt)
    // ═══════════════════════════════════════════════════════════

    function test_celoSwap_wethToCusd_collateralSwap() public {
        uint256 actualWeth = IERC20(aWETH).balanceOf(user);
        uint256 expectedCusd = oracleAdapter.getExpectedOutput(WETH, CUSD, actualWeth);

        console.log("--- Pre-swap ---");
        console.log("User aWETH:", actualWeth);
        console.log("Expected cUSD:", expectedCusd);

        // Merkle tree: withdraw WETH (pre) + deposit cUSD (post)
        bytes memory withdrawData = abi.encodePacked(aWETH, AAVE_V3_POOL);
        bytes memory depositData = abi.encodePacked(AAVE_V3_POOL);

        bytes32 l0 = _leaf(3, 0, withdrawData);
        bytes32 l1 = _leaf(0, 0, depositData);
        bytes32 root = _pair(l0, l1);

        bytes32[] memory pr0 = new bytes32[](1); pr0[0] = l1;
        bytes32[] memory pr1 = new bytes32[](1); pr1[0] = l0;

        // settlementData: 1 conversion (WETH -> cUSD) with 0.5% tolerance
        bytes memory settlementPayload = abi.encodePacked(
            uint8(1),                     // 1 conversion
            WETH,                         // assetIn
            CUSD,                         // assetOut
            address(oracleAdapter),       // oracle
            uint64(50_000)                // 0.5% tolerance
        );

        bytes memory orderData = abi.encodePacked(root, uint16(settlementPayload.length), settlementPayload);

        // fillerCalldata: solver provides the actual swap execution
        bytes memory swapCalldata = abi.encodeCall(FixedRateSwapper.swap, (WETH, actualWeth, CUSD));
        bytes memory fillerCalldata = abi.encodePacked(
            WETH, CUSD,
            uint112(actualWeth),
            address(swapper),
            uint16(swapCalldata.length),
            swapCalldata
        );

        // executionData: pre=withdraw WETH, post=deposit cUSD
        bytes memory executionData = abi.encodePacked(
            uint8(1), uint8(1), address(0),
            _action(WETH, type(uint112).max, address(verato), 3, 0, withdrawData, pr0),
            _action(CUSD, 0, user, 0, 0, depositData, pr1)
        );

        uint48 deadline = uint48(block.timestamp + 1 hours);
        bytes memory sig = _signOrder(userPk, root, deadline, 0, address(0), settlementPayload);

        vm.prank(user);
        verato.setUserSolverTrust(address(this), true);

        verato.settle(0, address(0), deadline, sig, orderData, executionData, fillerCalldata);

        uint256 aWethAfter = IERC20(aWETH).balanceOf(user);
        uint256 aCusdAfter = IERC20(aCUSD).balanceOf(user);

        console.log("--- Post-swap ---");
        console.log("User aWETH:", aWethAfter);
        console.log("User aCUSD:", aCusdAfter);

        assertEq(aWethAfter, 0, "all WETH withdrawn");
        assertGt(aCusdAfter, 0, "user has cUSD collateral");
        assertApproxEqRel(aCusdAfter, expectedCusd, 1e15, "aCUSD matches oracle output");
        assertEq(IERC20(WETH).balanceOf(address(verato)), 0, "no WETH left in Verato");
        assertEq(IERC20(CUSD).balanceOf(address(verato)), 0, "no cUSD left in Verato");

        console.log("Oracle-verified swap: WETH -> %s aCUSD (oracle: %s)", aCusdAfter, expectedCusd);
    }

    // ═══════════════════════════════════════════════════════════
    //  Test: collateral swap WITH debt + HF condition
    //  WETH collateral + USDC debt -> swap partial WETH -> cUSD
    //  with health factor check
    // ═══════════════════════════════════════════════════════════

    function test_celoSwap_partialCollateralSwap_withHFCondition() public {
        // Add USDC debt
        address vDebtUSDC = IAaveV3Pool(AAVE_V3_POOL).getReserveData(USDC).variableDebtTokenAddress;
        vm.startPrank(user);
        ICreditDelegation(vDebtUSDC).approveDelegation(address(verato), type(uint256).max);
        IAaveV3Pool(AAVE_V3_POOL).borrow(USDC, 100e6, 2, 0, user);
        vm.stopPrank();

        // Swap only 10% of WETH to cUSD (keep HF healthy)
        uint256 swapAmount = IERC20(aWETH).balanceOf(user) / 10;

        bytes memory withdrawData = abi.encodePacked(aWETH, AAVE_V3_POOL);
        bytes memory depositData = abi.encodePacked(AAVE_V3_POOL);


        bytes32 l0 = _leaf(3, 0, withdrawData);
        bytes32 l1 = _leaf(0, 0, depositData);
        bytes32 root = _pair(l0, l1);
        bytes32[] memory pr0 = new bytes32[](1); pr0[0] = l1;
        bytes32[] memory pr1 = new bytes32[](1); pr1[0] = l0;

        // 1 conversion + 1 HF condition (Aave V3, minHF = 1.1)
        bytes memory settlementPayload = abi.encodePacked(
            uint8(1), WETH, CUSD, address(oracleAdapter), uint64(50_000),
            uint8(1), uint16(0), AAVE_V3_POOL, uint112(1.1e18)
        );

        bytes memory orderData = abi.encodePacked(root, uint16(settlementPayload.length), settlementPayload);

        bytes memory swapCalldata = abi.encodeCall(FixedRateSwapper.swap, (WETH, swapAmount, CUSD));
        bytes memory fillerCalldata = abi.encodePacked(
            WETH, CUSD, uint112(swapAmount), address(swapper), uint16(swapCalldata.length), swapCalldata
        );

        bytes memory executionData = abi.encodePacked(
            uint8(1), uint8(1), address(0),
            _action(WETH, uint112(swapAmount), address(verato), 3, 0, withdrawData, pr0),
            _action(CUSD, 0, user, 0, 0, depositData, pr1)
        );

        uint48 deadline = uint48(block.timestamp + 1 hours);
        bytes memory sig = _signOrder(userPk, root, deadline, 0, address(0), settlementPayload);
        vm.prank(user); verato.setUserSolverTrust(address(this), true);

        verato.settle(0, address(0), deadline, sig, orderData, executionData, fillerCalldata);

        uint256 aCusdAfter = IERC20(aCUSD).balanceOf(user);
        assertGt(aCusdAfter, 0, "user has cUSD from swap");
        assertGt(IERC20(aWETH).balanceOf(user), 0, "user still has remaining WETH");
        console.log("Partial collateral swap + HF condition passed. aCUSD:", aCusdAfter);
    }
}
