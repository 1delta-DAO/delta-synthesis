// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {Verato} from "../src/core/settlement/celo/Verato.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MockReputationRegistry} from "./mocks/MockReputationRegistry.sol";

contract VeratoTest is Test {
    Verato public verato;
    MockIdentityRegistry public identityRegistry;
    MockReputationRegistry public reputationRegistry;

    address owner = makeAddr("owner");
    address solver = makeAddr("solver");
    address stranger = makeAddr("stranger");

    uint256 constant SOLVER_AGENT_ID = 42;

    function setUp() public {
        identityRegistry = new MockIdentityRegistry();
        reputationRegistry = new MockReputationRegistry();

        vm.prank(owner);
        verato = new Verato(
            address(identityRegistry),
            address(reputationRegistry)
        );
    }

    // =====================================================================
    // Ownership
    // =====================================================================

    function test_owner_isDeployer() public view {
        assertEq(verato.owner(), owner);
    }

    function test_transferOwnership() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        verato.transferOwnership(newOwner);
        assertEq(verato.owner(), newOwner);
    }

    function test_transferOwnership_reverts_nonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(Verato.OnlyOwner.selector);
        verato.transferOwnership(stranger);
    }

    // =====================================================================
    // Global reputation floor
    // =====================================================================

    function test_setMinReputation() public {
        vm.prank(owner);
        verato.setMinReputation(500);
        assertEq(verato.minReputation(), 500);
    }

    function test_setMinReputation_reverts_nonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(Verato.OnlyOwner.selector);
        verato.setMinReputation(100);
    }

    // =====================================================================
    // Solver identity linking
    // =====================================================================

    function test_linkSolverAgentId() public {
        identityRegistry.mint(solver);
        reputationRegistry.setReputation(SOLVER_AGENT_ID, 80, 10);

        vm.prank(solver);
        verato.linkSolverAgentId(SOLVER_AGENT_ID);

        assertTrue(verato.solverLinked(solver));
        assertEq(verato.solverAgentId(solver), SOLVER_AGENT_ID);
    }

    function test_linkSolverAgentId_reverts_unregistered() public {
        vm.prank(solver);
        vm.expectRevert(Verato.SolverNotRegistered.selector);
        verato.linkSolverAgentId(SOLVER_AGENT_ID);
    }

    // =====================================================================
    // Forwarder deployment
    // =====================================================================

    function test_forwarder_deployed() public view {
        address fwd = address(verato.forwarder());
        assertGt(fwd.code.length, 0, "forwarder has code");
    }

    // =====================================================================
    // Domain separator
    // =====================================================================

    function test_domainSeparator_nonZero() public view {
        assertNotEq(verato.DOMAIN_SEPARATOR(), bytes32(0));
    }
}
