// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {IERC20} from "lib/forge-std/src/interfaces/IERC20.sol";

/// @title DeltaGateway
/// @notice Gateway contract that AI agents use to manage user lending positions
///         based on permissions granted by the user.
contract DeltaGateway {
    // --- Types ---

    struct Position {
        uint256 deposited;
        uint256 borrowed;
    }

    // --- State ---

    /// @notice owner → agent → authorised
    mapping(address => mapping(address => bool)) public authorisedAgents;

    /// @notice user → token → Position
    mapping(address => mapping(address => Position)) public positions;

    // --- Events ---

    event AgentAuthorised(address indexed owner, address indexed agent);
    event AgentRevoked(address indexed owner, address indexed agent);
    event Deposit(address indexed user, address indexed token, uint256 amount);
    event Withdraw(address indexed user, address indexed token, uint256 amount);
    event Borrow(address indexed user, address indexed token, uint256 amount);
    event Repay(address indexed user, address indexed token, uint256 amount);

    // --- Errors ---

    error Unauthorised();
    error InsufficientBalance();
    error ZeroAmount();

    // --- Modifiers ---

    /// @dev Caller must be the user themselves or an authorised agent.
    modifier onlyAuthorised(address user) {
        if (msg.sender != user && !authorisedAgents[user][msg.sender]) {
            revert Unauthorised();
        }
        _;
    }

    // --- Agent management ---

    function authoriseAgent(address agent) external {
        authorisedAgents[msg.sender][agent] = true;
        emit AgentAuthorised(msg.sender, agent);
    }

    function revokeAgent(address agent) external {
        authorisedAgents[msg.sender][agent] = false;
        emit AgentRevoked(msg.sender, agent);
    }

    // --- Core actions (mock implementations) ---

    /// @notice Deposit tokens on behalf of `user`.
    function deposit(address user, address token, uint256 amount) external onlyAuthorised(user) {
        if (amount == 0) revert ZeroAmount();

        IERC20(token).transferFrom(user, address(this), amount);
        positions[user][token].deposited += amount;

        emit Deposit(user, token, amount);
    }

    /// @notice Withdraw tokens back to `user`.
    function withdraw(address user, address token, uint256 amount) external onlyAuthorised(user) {
        if (amount == 0) revert ZeroAmount();
        if (positions[user][token].deposited < amount) revert InsufficientBalance();

        positions[user][token].deposited -= amount;
        IERC20(token).transfer(user, amount);

        emit Withdraw(user, token, amount);
    }

    /// @notice Mock borrow – records debt, transfers tokens from gateway reserves.
    function borrow(address user, address token, uint256 amount) external onlyAuthorised(user) {
        if (amount == 0) revert ZeroAmount();

        positions[user][token].borrowed += amount;
        IERC20(token).transfer(user, amount);

        emit Borrow(user, token, amount);
    }

    /// @notice Mock repay – reduces debt, pulls tokens from user.
    function repay(address user, address token, uint256 amount) external onlyAuthorised(user) {
        if (amount == 0) revert ZeroAmount();
        if (positions[user][token].borrowed < amount) revert InsufficientBalance();

        IERC20(token).transferFrom(user, address(this), amount);
        positions[user][token].borrowed -= amount;

        emit Repay(user, token, amount);
    }
}
