// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {Verato} from "../src/core/settlement/celo/Verato.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MockReputationRegistry} from "./mocks/MockReputationRegistry.sol";
import {MockSwapRouter} from "./mocks/MockSwapRouter.sol";

contract VeratoTest is Test {
    Verato public gateway;
    MockERC20 public usdc;
    MockERC20 public celo;
    MockIdentityRegistry public identityRegistry;
    MockReputationRegistry public reputationRegistry;
    MockSwapRouter public swapRouter;

    address user = makeAddr("user");
    address agent = makeAddr("agent");
    address stranger = makeAddr("stranger");

    uint256 constant AGENT_ID = 42;
    uint256 constant FEE_BPS = 10;
    uint256 constant BPS = 10_000;

    function setUp() public {
        identityRegistry = new MockIdentityRegistry();
        reputationRegistry = new MockReputationRegistry();
        celo = new MockERC20("Celo", "CELO", 18);
        // 1 USDC (6 dec) → 5 CELO (18 dec) — rate = 5e30 relative, but we use
        // a simple 1e18-based rate: amountOut = amountIn * rate / 1e18
        // For 1e6 USDC in → 5e18 CELO out ⇒ rate = 5e30 / 1e6... simpler: just use 5e30.
        // Actually the mock rate formula is: amountOut = amountIn * rate / 1e18
        // So for 1 USDC (1e6) to get 5 CELO (5e18): rate = 5e18 * 1e18 / 1e6 = 5e30.
        swapRouter = new MockSwapRouter(5e30);

        gateway = new Verato(
            address(identityRegistry),
            address(reputationRegistry),
            address(swapRouter),
            address(celo)
        );

        usdc = new MockERC20("Mock USDC", "mUSDC", 6);

        // Fund user and approve gateway
        usdc.mint(user, 10_000e6);
        vm.prank(user);
        usdc.approve(address(gateway), type(uint256).max);

        // Fund swap router with CELO for swaps
        celo.mint(address(swapRouter), 1_000_000e18);
    }

    // =====================================================================
    // Agent authorisation (direct)
    // =====================================================================

    function test_authoriseAgent() public {
        vm.prank(user);
        gateway.authoriseAgent(agent);
        assertTrue(gateway.authorisedAgents(user, agent));
    }

    function test_revokeAgent() public {
        vm.prank(user);
        gateway.authoriseAgent(agent);
        vm.prank(user);
        gateway.revokeAgent(agent);
        assertFalse(gateway.authorisedAgents(user, agent));
    }

    // =====================================================================
    // ERC-8004 identity trust
    // =====================================================================

    function _registerAndLinkAgent() internal {
        identityRegistry.mint(agent);
        reputationRegistry.setReputation(AGENT_ID, 80, 10);
        vm.prank(agent);
        gateway.linkAgentId(AGENT_ID);
    }

    function test_authoriseAgentId_deposit() public {
        _registerAndLinkAgent();
        vm.prank(user);
        gateway.authoriseAgentId(AGENT_ID);

        vm.prank(agent);
        gateway.deposit(user, address(usdc), 500e6);

        (uint256 deposited,) = gateway.positions(user, address(usdc));
        uint256 expectedFee = (500e6 * FEE_BPS) / BPS;
        assertEq(deposited, 500e6 - expectedFee);
    }

    function test_revokeAgentId_blocks_deposit() public {
        _registerAndLinkAgent();
        vm.prank(user);
        gateway.authoriseAgentId(AGENT_ID);
        vm.prank(user);
        gateway.revokeAgentId(AGENT_ID);

        vm.prank(agent);
        vm.expectRevert(Verato.Unauthorised.selector);
        gateway.deposit(user, address(usdc), 500e6);
    }

    function test_linkAgentId_reverts_unregistered() public {
        vm.prank(agent);
        vm.expectRevert(Verato.AgentNotRegistered.selector);
        gateway.linkAgentId(AGENT_ID);
    }

    // =====================================================================
    // Trust policy enforcement
    // =====================================================================

    function test_trustPolicy_minReputation_pass() public {
        _registerAndLinkAgent();
        vm.prank(user);
        gateway.authoriseAgentId(AGENT_ID);
        vm.prank(user);
        gateway.setTrustPolicy(false, 70);

        vm.prank(agent);
        gateway.deposit(user, address(usdc), 100e6);

        (uint256 deposited,) = gateway.positions(user, address(usdc));
        assertGt(deposited, 0);
    }

    function test_trustPolicy_minReputation_fail() public {
        _registerAndLinkAgent();
        vm.prank(user);
        gateway.authoriseAgentId(AGENT_ID);
        vm.prank(user);
        gateway.setTrustPolicy(false, 90);

        vm.prank(agent);
        vm.expectRevert(Verato.ReputationTooLow.selector);
        gateway.deposit(user, address(usdc), 100e6);
    }

    function test_directTrust_bypasses_policy() public {
        vm.prank(user);
        gateway.setTrustPolicy(true, 95);
        vm.prank(user);
        gateway.authoriseAgent(agent);

        vm.prank(agent);
        gateway.deposit(user, address(usdc), 200e6);

        (uint256 deposited,) = gateway.positions(user, address(usdc));
        assertGt(deposited, 0);
    }

    // =====================================================================
    // Fee collection
    // =====================================================================

    function test_fee_collected_on_agent_deposit() public {
        vm.prank(user);
        gateway.authoriseAgent(agent);

        vm.prank(agent);
        gateway.deposit(user, address(usdc), 1_000e6);

        uint256 expectedFee = (1_000e6 * FEE_BPS) / BPS;
        assertEq(gateway.agentFees(agent, address(usdc)), expectedFee);
        assertEq(expectedFee, 1e6); // 0.10% of 1000 USDC = 1 USDC
    }

    function test_no_fee_when_user_acts_for_self() public {
        vm.prank(user);
        gateway.deposit(user, address(usdc), 1_000e6);

        (uint256 deposited,) = gateway.positions(user, address(usdc));
        assertEq(deposited, 1_000e6); // full amount, no fee
    }

    function test_claimFees() public {
        vm.prank(user);
        gateway.authoriseAgent(agent);

        vm.prank(agent);
        gateway.deposit(user, address(usdc), 1_000e6);

        uint256 fee = gateway.agentFees(agent, address(usdc));
        uint256 agentBalBefore = usdc.balanceOf(agent);

        vm.prank(agent);
        gateway.claimFees(address(usdc));

        assertEq(usdc.balanceOf(agent), agentBalBefore + fee);
        assertEq(gateway.agentFees(agent, address(usdc)), 0);
    }

    function test_claimFees_reverts_noFees() public {
        vm.prank(agent);
        vm.expectRevert(Verato.NoFeesToClaim.selector);
        gateway.claimFees(address(usdc));
    }

    // =====================================================================
    // Swap fees to native (self-funding)
    // =====================================================================

    function test_claimFeesAsNative() public {
        vm.prank(user);
        gateway.authoriseAgent(agent);

        vm.prank(agent);
        gateway.deposit(user, address(usdc), 10_000e6);

        uint256 feeUsdc = gateway.agentFees(agent, address(usdc));
        assertGt(feeUsdc, 0);

        uint256 celoBalBefore = celo.balanceOf(agent);

        vm.prank(agent);
        uint256 celoReceived = gateway.claimFeesAsNative(address(usdc), 3000, 0);

        assertGt(celoReceived, 0);
        assertEq(celo.balanceOf(agent), celoBalBefore + celoReceived);
        assertEq(gateway.agentFees(agent, address(usdc)), 0);
    }

    // =====================================================================
    // Success criteria / dispute
    // =====================================================================

    function test_agentScore_tracks_ops() public {
        vm.prank(user);
        gateway.authoriseAgent(agent);

        vm.prank(agent);
        gateway.deposit(user, address(usdc), 100e6);
        vm.prank(agent);
        gateway.deposit(user, address(usdc), 100e6);

        (uint256 settled, uint256 reverted, uint256 earned) = gateway.agentScores(user, agent);
        assertEq(settled, 2);
        assertEq(reverted, 0);
        assertGt(earned, 0);
    }

    function test_dispute_increments_revert_count() public {
        vm.prank(user);
        gateway.authoriseAgent(agent);

        vm.prank(agent);
        gateway.deposit(user, address(usdc), 100e6);

        vm.prank(user);
        gateway.disputeAgent(agent);

        (, uint256 reverted,) = gateway.agentScores(user, agent);
        assertEq(reverted, 1);
    }

    function test_successRate() public {
        vm.prank(user);
        gateway.authoriseAgent(agent);

        // 4 ops, 1 dispute → 75% success = 7500 bps
        for (uint256 i; i < 4; i++) {
            vm.prank(agent);
            gateway.deposit(user, address(usdc), 100e6);
        }

        vm.prank(user);
        gateway.disputeAgent(agent);

        uint256 rate = gateway.agentSuccessRate(user, agent);
        assertEq(rate, 7500);
    }

    function test_successRate_noOps_returns_max() public {
        uint256 rate = gateway.agentSuccessRate(user, agent);
        assertEq(rate, BPS);
    }

    // =====================================================================
    // Core actions (with fees)
    // =====================================================================

    function test_deposit_asUser_noFee() public {
        vm.prank(user);
        gateway.deposit(user, address(usdc), 1_000e6);

        (uint256 deposited,) = gateway.positions(user, address(usdc));
        assertEq(deposited, 1_000e6);
        assertEq(usdc.balanceOf(address(gateway)), 1_000e6);
    }

    function test_deposit_asAgent_withFee() public {
        vm.prank(user);
        gateway.authoriseAgent(agent);

        vm.prank(agent);
        gateway.deposit(user, address(usdc), 500e6);

        uint256 fee = (500e6 * FEE_BPS) / BPS;
        (uint256 deposited,) = gateway.positions(user, address(usdc));
        assertEq(deposited, 500e6 - fee);
    }

    function test_deposit_reverts_unauthorised() public {
        vm.prank(stranger);
        vm.expectRevert(Verato.Unauthorised.selector);
        gateway.deposit(user, address(usdc), 100e6);
    }

    function test_deposit_reverts_zeroAmount() public {
        vm.prank(user);
        vm.expectRevert(Verato.ZeroAmount.selector);
        gateway.deposit(user, address(usdc), 0);
    }

    function test_withdraw() public {
        vm.prank(user);
        gateway.deposit(user, address(usdc), 1_000e6);

        vm.prank(user);
        gateway.withdraw(user, address(usdc), 400e6);

        (uint256 deposited,) = gateway.positions(user, address(usdc));
        assertEq(deposited, 600e6);
        assertEq(usdc.balanceOf(user), 9_400e6);
    }

    function test_withdraw_reverts_insufficientBalance() public {
        vm.prank(user);
        vm.expectRevert(Verato.InsufficientBalance.selector);
        gateway.withdraw(user, address(usdc), 1);
    }

    function test_borrow() public {
        usdc.mint(address(gateway), 5_000e6);

        vm.prank(user);
        gateway.authoriseAgent(agent);

        vm.prank(agent);
        gateway.borrow(user, address(usdc), 2_000e6);

        uint256 fee = (2_000e6 * FEE_BPS) / BPS;
        (, uint256 borrowed) = gateway.positions(user, address(usdc));
        assertEq(borrowed, 2_000e6);
        assertEq(usdc.balanceOf(user), 10_000e6 + 2_000e6 - fee);
    }

    function test_repay() public {
        usdc.mint(address(gateway), 5_000e6);

        vm.prank(user);
        gateway.authoriseAgent(agent);

        vm.prank(agent);
        gateway.borrow(user, address(usdc), 2_000e6);

        vm.prank(agent);
        gateway.repay(user, address(usdc), 1_000e6);

        uint256 repayFee = (1_000e6 * FEE_BPS) / BPS;
        (, uint256 borrowed) = gateway.positions(user, address(usdc));
        assertEq(borrowed, 2_000e6 - (1_000e6 - repayFee));
    }

    function test_repay_reverts_overRepay() public {
        vm.prank(user);
        vm.expectRevert(Verato.InsufficientBalance.selector);
        gateway.repay(user, address(usdc), 1);
    }
}
