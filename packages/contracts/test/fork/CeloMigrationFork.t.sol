// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test, console} from "forge-std/Test.sol";
import {IVerato} from "./IVerato.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IAavePool {
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
    function deposit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
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
 * @title CeloMigrationForkTest
 * @notice Fork tests: Moola → Aave V3 cross-protocol settlement on Celo.
 *
 *  Pool addresses from: https://github.com/1delta-DAO/lender-metadata/blob/main/config/aave-pools.json
 *    Aave V3: 0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402
 *    Moola:   0x970b12522CA9b4054807a2c5B736149a5BE6f670
 *
 *  Tests use settle() (no flash loan) since Morpho Blue is not on Celo.
 *  The migration pattern: withdraw from Moola → deposit to Aave V3.
 */
contract CeloMigrationForkTest is Test {
    // ── Celo mainnet protocols (from 1delta lender-metadata) ──
    address constant AAVE_V3_POOL = 0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402;
    address constant MOOLA_POOL   = 0x970b12522CA9b4054807a2c5B736149a5BE6f670;


    // ── Celo mainnet tokens ──────────────────────────────────
    address constant CELO = 0x471EcE3750Da237f93B8E339c536989b8978a438;
    address constant CUSD = 0x765DE816845861e75A25fCA122bb6898B8B1282a;
    address constant USDC = 0xcebA9300f2b948710d2653dD7B07f33A8B32118C;

    // ── ERC-8004 registries ──────────────────────────────────
    address constant IDENTITY_REGISTRY  = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant REPUTATION_REGISTRY = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    bytes32 constant VERATO_ORDER_TYPEHASH =
        keccak256("VeratoOrder(bytes32 merkleRoot,uint48 deadline,uint256 maxFeeBps,address solver,uint256 minSolverReputation,bytes settlementData)");

    IVerato verato;
    address user;
    uint256 userPk;

    // Moola aCUSD (from on-chain getReserveData — Aave V2 struct layout)
    address constant mCUSD_src = 0x918146359264C492BD6934071c6Bd31C854EDBc3;
    // Aave V3 aCUSD (resolved in setUp)
    address aCUSD_dst;

    uint256 constant USER_CUSD_SUPPLY = 500e18;

    // ── Helpers ──────────────────────────────────────────────

    function _leaf(uint8 op, uint16 lender, bytes memory data) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(op, lender, data));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return uint256(a) < uint256(b)
            ? keccak256(abi.encodePacked(a, b))
            : keccak256(abi.encodePacked(b, a));
    }

    function _action(
        address asset, uint112 amount, address receiver,
        uint8 op, uint16 lender, bytes memory data, bytes32[] memory proof
    ) internal pure returns (bytes memory) {
        bytes memory r = abi.encodePacked(
            asset, amount, receiver, op, lender, uint16(data.length), data, uint8(proof.length)
        );
        for (uint256 i; i < proof.length; i++) {
            r = abi.encodePacked(r, proof[i]);
        }
        return r;
    }

    function _signOrder(
        uint256 pk, bytes32 merkleRoot, uint48 deadline,
        uint256 maxFeeBps, address solver, uint256 minSolverRep, bytes memory settlementPayload
    ) internal view returns (bytes memory) {
        bytes32 domainSeparator = verato.DOMAIN_SEPARATOR();
        bytes32 structHash = keccak256(
            abi.encode(VERATO_ORDER_TYPEHASH, merkleRoot, deadline, maxFeeBps, solver, minSolverRep, keccak256(settlementPayload))
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ── Setup ────────────────────────────────────────────────

    function setUp() public {
        string memory rpcUrl = vm.envOr("CELO_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) { vm.skip(true); return; }
        vm.createSelectFork(rpcUrl, 62_100_000);

        // Skip if protocols not deployed
        if (MOOLA_POOL.code.length == 0 || AAVE_V3_POOL.code.length == 0) { vm.skip(true); return; }

        (user, userPk) = makeAddrAndKey("migrationUser");

        bytes memory args = abi.encode(IDENTITY_REGISTRY, REPUTATION_REGISTRY);
        bytes memory bytecode = abi.encodePacked(vm.getCode("out/Verato.sol/Verato.json"), args);
        address deployed;
        assembly { deployed := create(0, add(bytecode, 0x20), mload(bytecode)) }
        require(deployed != address(0), "Verato deploy failed");
        verato = IVerato(deployed);

        // Resolve Aave V3 aToken (Moola aToken is hardcoded — V2 struct differs)
        IAavePool.ReserveDataLegacy memory aaveCusd = IAavePool(AAVE_V3_POOL).getReserveData(CUSD);
        aCUSD_dst = aaveCusd.aTokenAddress;

        // Verato approvals for both pools
        verato.approveToken(CUSD, MOOLA_POOL, type(uint256).max);
        verato.approveToken(CUSD, AAVE_V3_POOL, type(uint256).max);
    }

    function _setupUserOnMoola() internal {
        deal(CUSD, user, USER_CUSD_SUPPLY);
        vm.startPrank(user);
        IERC20(CUSD).approve(MOOLA_POOL, type(uint256).max);
        IAavePool(MOOLA_POOL).deposit(CUSD, USER_CUSD_SUPPLY, user, 0);
        // Grant Verato permission to pull Moola aTokens
        IERC20(mCUSD_src).approve(address(verato), type(uint256).max);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════
    //  Test: Moola → Aave V3 collateral migration (no debt, no flash loan)
    //  Withdraw cUSD from Moola → deposit cUSD to Aave V3
    // ═══════════════════════════════════════════════════════════

    function test_celoMigration_moolaToAaveV3() public {
        _setupUserOnMoola();


        uint256 moolaBefore = IERC20(mCUSD_src).balanceOf(user);

        console.log("--- Pre-migration ---");
        console.log("Moola aCUSD:", moolaBefore);
        console.log("Aave  aCUSD:", IERC20(aCUSD_dst).balanceOf(user));

        // lenderId 1000 = Aave V2 (Moola), lenderId 0 = Aave V3
        bytes memory withdrawData = abi.encodePacked(mCUSD_src, MOOLA_POOL);
        bytes memory depositData  = abi.encodePacked(AAVE_V3_POOL);

        bytes32 l0 = _leaf(3, 1000, withdrawData);  // withdraw from Moola
        bytes32 l1 = _leaf(0, 0, depositData);       // deposit to Aave V3
        bytes32 root = _pair(l0, l1);

        bytes32[] memory pr0 = new bytes32[](1);
        pr0[0] = l1;
        bytes32[] memory pr1 = new bytes32[](1);
        pr1[0] = l0;

        bytes memory orderData = abi.encodePacked(root, uint16(0));
        bytes memory executionData = abi.encodePacked(
            uint8(1), uint8(1), address(0),
            _action(CUSD, type(uint112).max, address(verato), 3, 1000, withdrawData, pr0),
            _action(CUSD, 0, user, 0, 0, depositData, pr1)
        );

        uint48 deadline = uint48(block.timestamp + 1 hours);
        bytes memory sig = _signOrder(userPk, root, deadline, 0, address(0), 0, hex"");

        verato.settle(0, address(0), 0, deadline, sig, orderData, executionData, hex"");

        uint256 moolaAfter = IERC20(mCUSD_src).balanceOf(user);
        uint256 aaveAfter = IERC20(aCUSD_dst).balanceOf(user);

        console.log("--- Post-migration ---");
        console.log("Moola aCUSD:", moolaAfter);
        console.log("Aave  aCUSD:", aaveAfter);

        assertEq(moolaAfter, 0, "Moola collateral fully withdrawn");
        assertGt(aaveAfter, 0, "user has Aave V3 collateral");
        assertEq(IERC20(CUSD).balanceOf(address(verato)), 0, "no cUSD left in Verato");
    }

    // ═══════════════════════════════════════════════════════════
    //  Test: wrong signer reverts
    // ═══════════════════════════════════════════════════════════

    function test_celoMigration_wrongSigner_reverts() public {
        _setupUserOnMoola();


        bytes memory withdrawData = abi.encodePacked(mCUSD_src, MOOLA_POOL);
        bytes memory depositData  = abi.encodePacked(AAVE_V3_POOL);

        bytes32 l0 = _leaf(3, 1000, withdrawData);
        bytes32 l1 = _leaf(0, 0, depositData);
        bytes32 root = _pair(l0, l1);

        bytes32[] memory pr0 = new bytes32[](1);
        pr0[0] = l1;
        bytes32[] memory pr1 = new bytes32[](1);
        pr1[0] = l0;

        bytes memory orderData = abi.encodePacked(root, uint16(0));
        bytes memory executionData = abi.encodePacked(
            uint8(1), uint8(1), address(0),
            _action(CUSD, type(uint112).max, address(verato), 3, 1000, withdrawData, pr0),
            _action(CUSD, 0, user, 0, 0, depositData, pr1)
        );

        // Sign with wrong key
        (, uint256 wrongPk) = makeAddrAndKey("attacker");
        uint48 deadline = uint48(block.timestamp + 1 hours);
        bytes memory sig = _signOrder(wrongPk, root, deadline, 0, address(0), 0, hex"");

        // Wrong signer has no aToken approval → revert
        vm.expectRevert();
        verato.settle(0, address(0), 0, deadline, sig, orderData, executionData, hex"");
    }

    // ═══════════════════════════════════════════════════════════
    //  Test: Aave V3 health factor condition on migrated position
    // ═══════════════════════════════════════════════════════════

    function test_celoMigration_withHealthFactorCondition() public {
        _setupUserOnMoola();


        bytes memory withdrawData = abi.encodePacked(mCUSD_src, MOOLA_POOL);
        bytes memory depositData  = abi.encodePacked(AAVE_V3_POOL);

        bytes32 l0 = _leaf(3, 1000, withdrawData);
        bytes32 l1 = _leaf(0, 0, depositData);
        bytes32 root = _pair(l0, l1);

        bytes32[] memory pr0 = new bytes32[](1);
        pr0[0] = l1;
        bytes32[] memory pr1 = new bytes32[](1);
        pr1[0] = l0;

        // Settlement with Aave V3 HF condition (minHF = 1.0 — no debt so always passes)
        bytes memory settlementPayload = abi.encodePacked(
            uint8(0), uint8(1), uint16(0), AAVE_V3_POOL, uint112(1e18)
        );

        bytes memory orderData = abi.encodePacked(root, uint16(settlementPayload.length), settlementPayload);
        bytes memory executionData = abi.encodePacked(
            uint8(1), uint8(1), address(0),
            _action(CUSD, type(uint112).max, address(verato), 3, 1000, withdrawData, pr0),
            _action(CUSD, 0, user, 0, 0, depositData, pr1)
        );

        uint48 deadline = uint48(block.timestamp + 1 hours);
        bytes memory sig = _signOrder(userPk, root, deadline, 0, address(0), 0, settlementPayload);

        verato.settle(0, address(0), 0, deadline, sig, orderData, executionData, hex"");

        (,,,,, uint256 hf) = IAavePool(AAVE_V3_POOL).getUserAccountData(user);
        assertEq(hf, type(uint256).max, "no debt = max HF");
        assertGt(IERC20(aCUSD_dst).balanceOf(user), 0, "user has Aave V3 collateral");
        console.log("Migration with HF condition passed");
    }
}
