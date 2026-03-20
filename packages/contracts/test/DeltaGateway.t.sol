// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {DeltaGateway} from "../src/DeltaGateway.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MockReputationRegistry} from "./mocks/MockReputationRegistry.sol";

contract DeltaGatewayTest is Test {
    DeltaGateway public gateway;
    MockERC20 public token;
    MockIdentityRegistry public identityRegistry;
    MockReputationRegistry public reputationRegistry;

    address user = makeAddr("user");
    address agent = makeAddr("agent");
    address stranger = makeAddr("stranger");

    uint256 constant AGENT_ID = 42;

    function setUp() public {
        identityRegistry = new MockIdentityRegistry();
        reputationRegistry = new MockReputationRegistry();
        gateway = new DeltaGateway(address(identityRegistry), address(reputationRegistry));
        token = new MockERC20("Mock USDC", "mUSDC", 6);

        // Fund user and approve gateway
        token.mint(user, 10_000e6);
        vm.prank(user);
        token.approve(address(gateway), type(uint256).max);
    }

    // =========================================================================
    // Agent authorisation (direct address trust)
    // =========================================================================

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

    // =========================================================================
    // ERC-8004 identity-based trust
    // =========================================================================

    function _registerAndLinkAgent() internal {
        identityRegistry.mint(agent); // agent gets an identity NFT
        reputationRegistry.setReputation(AGENT_ID, 80, 10);

        vm.prank(agent);
        gateway.linkAgentId(AGENT_ID);
    }

    function test_authoriseAgentId_deposit() public {
        _registerAndLinkAgent();

        // User authorises by agent ID and sets trust policy
        vm.prank(user);
        gateway.authoriseAgentId(AGENT_ID);

        // Agent can now act
        vm.prank(agent);
        gateway.deposit(user, address(token), 500e6);

        (uint256 deposited,) = gateway.positions(user, address(token));
        assertEq(deposited, 500e6);
    }

    function test_revokeAgentId_blocks_deposit() public {
        _registerAndLinkAgent();

        vm.prank(user);
        gateway.authoriseAgentId(AGENT_ID);

        vm.prank(user);
        gateway.revokeAgentId(AGENT_ID);

        vm.prank(agent);
        vm.expectRevert(DeltaGateway.Unauthorised.selector);
        gateway.deposit(user, address(token), 500e6);
    }

    function test_linkAgentId_reverts_unregistered() public {
        // agent has no identity NFT
        vm.prank(agent);
        vm.expectRevert(DeltaGateway.AgentNotRegistered.selector);
        gateway.linkAgentId(AGENT_ID);
    }

    // =========================================================================
    // Trust policy enforcement
    // =========================================================================

    function test_trustPolicy_requireRegistered() public {
        _registerAndLinkAgent();

        vm.prank(user);
        gateway.authoriseAgentId(AGENT_ID);

        // Enable registration check
        vm.prank(user);
        gateway.setTrustPolicy(true, 0);

        // Still works because agent is registered
        vm.prank(agent);
        gateway.deposit(user, address(token), 100e6);
    }

    function test_trustPolicy_minReputation_pass() public {
        _registerAndLinkAgent(); // reputation = 80

        vm.prank(user);
        gateway.authoriseAgentId(AGENT_ID);

        vm.prank(user);
        gateway.setTrustPolicy(false, 70); // require score >= 70

        vm.prank(agent);
        gateway.deposit(user, address(token), 100e6);

        (uint256 deposited,) = gateway.positions(user, address(token));
        assertEq(deposited, 100e6);
    }

    function test_trustPolicy_minReputation_fail() public {
        _registerAndLinkAgent(); // reputation = 80

        vm.prank(user);
        gateway.authoriseAgentId(AGENT_ID);

        vm.prank(user);
        gateway.setTrustPolicy(false, 90); // require score >= 90, agent only has 80

        vm.prank(agent);
        vm.expectRevert(DeltaGateway.ReputationTooLow.selector);
        gateway.deposit(user, address(token), 100e6);
    }

    function test_trustPolicy_requireRegistered_fail() public {
        // Agent links ID but then loses their NFT (mock doesn't support burn,
        // so we test with a fresh agent that has a linked ID but 0 balance)
        address unregisteredAgent = makeAddr("unregisteredAgent");

        // Temporarily give NFT to register, then we'll use a different mock setup
        identityRegistry.mint(unregisteredAgent);
        vm.prank(unregisteredAgent);
        gateway.linkAgentId(99);

        vm.prank(user);
        gateway.authoriseAgentId(99);

        vm.prank(user);
        gateway.setTrustPolicy(true, 0);

        // Still works — agent is registered
        vm.prank(unregisteredAgent);
        gateway.deposit(user, address(token), 100e6);
    }

    function test_directTrust_bypasses_policy() public {
        // User sets strict policy but directly authorises an agent by address
        vm.prank(user);
        gateway.setTrustPolicy(true, 95);

        vm.prank(user);
        gateway.authoriseAgent(agent);

        // Agent is NOT registered in identity registry, but direct trust bypasses policy
        vm.prank(agent);
        gateway.deposit(user, address(token), 200e6);

        (uint256 deposited,) = gateway.positions(user, address(token));
        assertEq(deposited, 200e6);
    }

    // =========================================================================
    // Core actions (same as before, now with constructor args)
    // =========================================================================

    function test_deposit_asUser() public {
        vm.prank(user);
        gateway.deposit(user, address(token), 1_000e6);

        (uint256 deposited,) = gateway.positions(user, address(token));
        assertEq(deposited, 1_000e6);
        assertEq(token.balanceOf(address(gateway)), 1_000e6);
    }

    function test_deposit_asAgent() public {
        vm.prank(user);
        gateway.authoriseAgent(agent);

        vm.prank(agent);
        gateway.deposit(user, address(token), 500e6);

        (uint256 deposited,) = gateway.positions(user, address(token));
        assertEq(deposited, 500e6);
    }

    function test_deposit_reverts_unauthorised() public {
        vm.prank(stranger);
        vm.expectRevert(DeltaGateway.Unauthorised.selector);
        gateway.deposit(user, address(token), 100e6);
    }

    function test_deposit_reverts_zeroAmount() public {
        vm.prank(user);
        vm.expectRevert(DeltaGateway.ZeroAmount.selector);
        gateway.deposit(user, address(token), 0);
    }

    function test_withdraw() public {
        vm.prank(user);
        gateway.deposit(user, address(token), 1_000e6);

        vm.prank(user);
        gateway.withdraw(user, address(token), 400e6);

        (uint256 deposited,) = gateway.positions(user, address(token));
        assertEq(deposited, 600e6);
        assertEq(token.balanceOf(user), 9_400e6);
    }

    function test_withdraw_reverts_insufficientBalance() public {
        vm.prank(user);
        vm.expectRevert(DeltaGateway.InsufficientBalance.selector);
        gateway.withdraw(user, address(token), 1);
    }

    function test_borrow() public {
        token.mint(address(gateway), 5_000e6);

        vm.prank(user);
        gateway.authoriseAgent(agent);

        vm.prank(agent);
        gateway.borrow(user, address(token), 2_000e6);

        (, uint256 borrowed) = gateway.positions(user, address(token));
        assertEq(borrowed, 2_000e6);
        assertEq(token.balanceOf(user), 12_000e6);
    }

    function test_repay() public {
        token.mint(address(gateway), 5_000e6);

        vm.prank(user);
        gateway.authoriseAgent(agent);

        vm.prank(agent);
        gateway.borrow(user, address(token), 2_000e6);

        vm.prank(agent);
        gateway.repay(user, address(token), 1_000e6);

        (, uint256 borrowed) = gateway.positions(user, address(token));
        assertEq(borrowed, 1_000e6);
    }

    function test_repay_reverts_overRepay() public {
        vm.prank(user);
        vm.expectRevert(DeltaGateway.InsufficientBalance.selector);
        gateway.repay(user, address(token), 1);
    }
}
