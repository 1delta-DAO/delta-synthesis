// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {DeltaGateway} from "../src/DeltaGateway.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract DeltaGatewayTest is Test {
    DeltaGateway public gateway;
    MockERC20 public token;

    address user = makeAddr("user");
    address agent = makeAddr("agent");
    address stranger = makeAddr("stranger");

    function setUp() public {
        gateway = new DeltaGateway();
        token = new MockERC20("Mock USDC", "mUSDC", 6);

        // Fund user and approve gateway
        token.mint(user, 10_000e6);
        vm.prank(user);
        token.approve(address(gateway), type(uint256).max);
    }

    // --- Agent authorisation ---

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

    // --- Deposit ---

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

    // --- Withdraw ---

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

    // --- Borrow ---

    function test_borrow() public {
        // Seed gateway with reserves so borrow transfer succeeds
        token.mint(address(gateway), 5_000e6);

        vm.prank(user);
        gateway.authoriseAgent(agent);

        vm.prank(agent);
        gateway.borrow(user, address(token), 2_000e6);

        (, uint256 borrowed) = gateway.positions(user, address(token));
        assertEq(borrowed, 2_000e6);
        assertEq(token.balanceOf(user), 12_000e6); // original 10k + 2k borrowed
    }

    // --- Repay ---

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
