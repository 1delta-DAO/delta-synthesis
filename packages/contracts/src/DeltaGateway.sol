// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {IERC20} from "lib/forge-std/src/interfaces/IERC20.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {IReputationRegistry} from "./interfaces/IReputationRegistry.sol";

/// @title DeltaGateway
/// @notice Gateway contract that AI agents use to manage user lending positions.
///         Users permission agents either by direct address trust or via
///         Celo ERC-8004 agent trust (identity + reputation gating).
contract DeltaGateway {
    // --- Types ---

    struct Position {
        uint256 deposited;
        uint256 borrowed;
    }

    /// @notice Per-user trust policy. Users choose how agents are vetted.
    struct TrustPolicy {
        bool requireRegistered; // agent must hold an ERC-8004 identity NFT
        uint256 minReputation;  // minimum average reputation score (0-100, 0 = no check)
    }

    // --- Immutables ---

    IIdentityRegistry public immutable identityRegistry;
    IReputationRegistry public immutable reputationRegistry;

    // --- State ---

    /// @notice owner → agent address → authorised (direct trust)
    mapping(address => mapping(address => bool)) public authorisedAgents;

    /// @notice owner → agent ERC-8004 token ID → authorised
    mapping(address => mapping(uint256 => bool)) public authorisedAgentIds;

    /// @notice user → trust policy
    mapping(address => TrustPolicy) public trustPolicies;

    /// @notice agent address → ERC-8004 token ID (set by agent calling linkAgentId)
    mapping(address => uint256) public agentIdOf;

    /// @notice agent address → whether agentIdOf has been set
    mapping(address => bool) public hasLinkedId;

    /// @notice user → token → Position
    mapping(address => mapping(address => Position)) public positions;

    // --- Events ---

    event AgentAuthorised(address indexed owner, address indexed agent);
    event AgentRevoked(address indexed owner, address indexed agent);
    event AgentIdAuthorised(address indexed owner, uint256 indexed agentId);
    event AgentIdRevoked(address indexed owner, uint256 indexed agentId);
    event TrustPolicyUpdated(address indexed owner, bool requireRegistered, uint256 minReputation);
    event AgentLinked(address indexed agent, uint256 indexed agentId);
    event Deposit(address indexed user, address indexed token, uint256 amount);
    event Withdraw(address indexed user, address indexed token, uint256 amount);
    event Borrow(address indexed user, address indexed token, uint256 amount);
    event Repay(address indexed user, address indexed token, uint256 amount);

    // --- Errors ---

    error Unauthorised();
    error InsufficientBalance();
    error ZeroAmount();
    error AgentNotRegistered();
    error ReputationTooLow();

    // --- Constructor ---

    constructor(address _identityRegistry, address _reputationRegistry) {
        identityRegistry = IIdentityRegistry(_identityRegistry);
        reputationRegistry = IReputationRegistry(_reputationRegistry);
    }

    // --- Modifiers ---

    /// @dev Caller must be the user themselves or pass all trust checks.
    modifier onlyAuthorised(address user) {
        if (msg.sender != user) {
            _checkAuthorised(user, msg.sender);
        }
        _;
    }

    // --- Trust policy management ---

    /// @notice Set your trust requirements for agents.
    /// @param requireRegistered If true, agents must hold an ERC-8004 identity NFT.
    /// @param minReputation     Minimum average reputation score (0-100). 0 disables the check.
    function setTrustPolicy(bool requireRegistered, uint256 minReputation) external {
        trustPolicies[msg.sender] = TrustPolicy(requireRegistered, minReputation);
        emit TrustPolicyUpdated(msg.sender, requireRegistered, minReputation);
    }

    // --- Agent management ---

    /// @notice Directly authorise an agent by address (no trust checks applied).
    function authoriseAgent(address agent) external {
        authorisedAgents[msg.sender][agent] = true;
        emit AgentAuthorised(msg.sender, agent);
    }

    function revokeAgent(address agent) external {
        authorisedAgents[msg.sender][agent] = false;
        emit AgentRevoked(msg.sender, agent);
    }

    /// @notice Authorise an agent by its ERC-8004 token ID.
    ///         Any address that has linked itself to this ID can then act.
    function authoriseAgentId(uint256 agentId) external {
        authorisedAgentIds[msg.sender][agentId] = true;
        emit AgentIdAuthorised(msg.sender, agentId);
    }

    function revokeAgentId(uint256 agentId) external {
        authorisedAgentIds[msg.sender][agentId] = false;
        emit AgentIdRevoked(msg.sender, agentId);
    }

    /// @notice Agent calls this to link its address to its ERC-8004 NFT token ID.
    ///         The caller must own at least one identity NFT (checked via balanceOf).
    function linkAgentId(uint256 agentId) external {
        if (identityRegistry.balanceOf(msg.sender) == 0) revert AgentNotRegistered();
        agentIdOf[msg.sender] = agentId;
        hasLinkedId[msg.sender] = true;
        emit AgentLinked(msg.sender, agentId);
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

    // --- Internal ---

    function _checkAuthorised(address user, address caller) internal view {
        // Path 1: direct address trust (bypasses all policy checks)
        if (authorisedAgents[user][caller]) return;

        // Path 2: ERC-8004 identity-based trust
        if (hasLinkedId[caller]) {
            uint256 agentId = agentIdOf[caller];
            if (authorisedAgentIds[user][agentId]) {
                TrustPolicy memory policy = trustPolicies[user];
                _enforceTrustPolicy(policy, caller, agentId);
                return;
            }
        }

        revert Unauthorised();
    }

    function _enforceTrustPolicy(TrustPolicy memory policy, address caller, uint256 agentId) internal view {
        if (policy.requireRegistered) {
            if (identityRegistry.balanceOf(caller) == 0) revert AgentNotRegistered();
        }

        if (policy.minReputation > 0) {
            IReputationRegistry.Summary memory summary = reputationRegistry.getSummary(agentId);
            if (summary.averageScore < policy.minReputation) revert ReputationTooLow();
        }
    }
}
