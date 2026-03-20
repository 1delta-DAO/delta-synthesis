// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {IERC20} from "lib/forge-std/src/interfaces/IERC20.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {IReputationRegistry} from "./interfaces/IReputationRegistry.sol";
import {ISwapRouter} from "./interfaces/ISwapRouter.sol";

/// @title DeltaGateway
/// @notice Gateway contract that AI agents use to manage user lending positions.
///         Users permission agents either by direct address trust or via
///         Celo ERC-8004 agent trust (identity + reputation gating).
///         Agents earn fees on successful operations and can swap them to CELO.
contract DeltaGateway {
    // --- Types ---

    struct Position {
        uint256 deposited;
        uint256 borrowed;
    }

    /// @notice Per-user trust policy.
    struct TrustPolicy {
        bool requireRegistered;
        uint256 minReputation;
    }

    /// @notice Tracks an agent's performance for a given user.
    struct AgentScore {
        uint256 opsSettled;    // total operations executed
        uint256 opsReverted;   // operations that the user flagged / disputed
        uint256 feesEarned;    // lifetime fees earned (denominated in fee token)
    }

    // --- Constants ---

    uint256 public constant FEE_BPS = 10; // 0.10 % per operation
    uint256 public constant BPS = 10_000;

    // --- Immutables ---

    IIdentityRegistry public immutable identityRegistry;
    IReputationRegistry public immutable reputationRegistry;
    ISwapRouter public immutable swapRouter;
    address public immutable nativeToken; // CELO ERC-20 address

    // --- State ---

    /// @notice owner → agent address → authorised (direct trust)
    mapping(address => mapping(address => bool)) public authorisedAgents;

    /// @notice owner → agent ERC-8004 token ID → authorised
    mapping(address => mapping(uint256 => bool)) public authorisedAgentIds;

    /// @notice user → trust policy
    mapping(address => TrustPolicy) public trustPolicies;

    /// @notice agent address → ERC-8004 token ID
    mapping(address => uint256) public agentIdOf;
    mapping(address => bool) public hasLinkedId;

    /// @notice user → token → Position
    mapping(address => mapping(address => Position)) public positions;

    /// @notice agent → token → claimable fee balance
    mapping(address => mapping(address => uint256)) public agentFees;

    /// @notice user → agent → AgentScore
    mapping(address => mapping(address => AgentScore)) public agentScores;

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
    event FeeCollected(address indexed agent, address indexed token, uint256 fee);
    event FeesClaimed(address indexed agent, address indexed token, uint256 amount);
    event FeesSwappedToNative(address indexed agent, address indexed tokenIn, uint256 amountIn, uint256 amountOut);
    event OpDisputed(address indexed user, address indexed agent);

    // --- Errors ---

    error Unauthorised();
    error InsufficientBalance();
    error ZeroAmount();
    error AgentNotRegistered();
    error ReputationTooLow();
    error NoFeesToClaim();
    error SwapFailed();

    // --- Constructor ---

    constructor(
        address _identityRegistry,
        address _reputationRegistry,
        address _swapRouter,
        address _nativeToken
    ) {
        identityRegistry = IIdentityRegistry(_identityRegistry);
        reputationRegistry = IReputationRegistry(_reputationRegistry);
        swapRouter = ISwapRouter(_swapRouter);
        nativeToken = _nativeToken;
    }

    // --- Modifiers ---

    modifier onlyAuthorised(address user) {
        if (msg.sender != user) {
            _checkAuthorised(user, msg.sender);
        }
        _;
    }

    // =====================================================================
    // Trust policy management
    // =====================================================================

    function setTrustPolicy(bool requireRegistered, uint256 minReputation) external {
        trustPolicies[msg.sender] = TrustPolicy(requireRegistered, minReputation);
        emit TrustPolicyUpdated(msg.sender, requireRegistered, minReputation);
    }

    // =====================================================================
    // Agent management
    // =====================================================================

    function authoriseAgent(address agent) external {
        authorisedAgents[msg.sender][agent] = true;
        emit AgentAuthorised(msg.sender, agent);
    }

    function revokeAgent(address agent) external {
        authorisedAgents[msg.sender][agent] = false;
        emit AgentRevoked(msg.sender, agent);
    }

    function authoriseAgentId(uint256 agentId) external {
        authorisedAgentIds[msg.sender][agentId] = true;
        emit AgentIdAuthorised(msg.sender, agentId);
    }

    function revokeAgentId(uint256 agentId) external {
        authorisedAgentIds[msg.sender][agentId] = false;
        emit AgentIdRevoked(msg.sender, agentId);
    }

    function linkAgentId(uint256 agentId) external {
        if (identityRegistry.balanceOf(msg.sender) == 0) revert AgentNotRegistered();
        agentIdOf[msg.sender] = agentId;
        hasLinkedId[msg.sender] = true;
        emit AgentLinked(msg.sender, agentId);
    }

    // =====================================================================
    // Core actions — fee-bearing
    // =====================================================================

    function deposit(address user, address token, uint256 amount) external onlyAuthorised(user) {
        if (amount == 0) revert ZeroAmount();

        IERC20(token).transferFrom(user, address(this), amount);

        uint256 fee = _collectFee(user, token, amount);
        uint256 net = amount - fee;

        positions[user][token].deposited += net;
        emit Deposit(user, token, net);
    }

    function withdraw(address user, address token, uint256 amount) external onlyAuthorised(user) {
        if (amount == 0) revert ZeroAmount();
        if (positions[user][token].deposited < amount) revert InsufficientBalance();

        positions[user][token].deposited -= amount;

        uint256 fee = _collectFee(user, token, amount);
        uint256 net = amount - fee;

        IERC20(token).transfer(user, net);
        emit Withdraw(user, token, net);
    }

    function borrow(address user, address token, uint256 amount) external onlyAuthorised(user) {
        if (amount == 0) revert ZeroAmount();

        positions[user][token].borrowed += amount;

        uint256 fee = _collectFee(user, token, amount);
        uint256 net = amount - fee;

        IERC20(token).transfer(user, net);
        emit Borrow(user, token, net);
    }

    function repay(address user, address token, uint256 amount) external onlyAuthorised(user) {
        if (amount == 0) revert ZeroAmount();
        if (positions[user][token].borrowed < amount) revert InsufficientBalance();

        IERC20(token).transferFrom(user, address(this), amount);

        uint256 fee = _collectFee(user, token, amount);
        uint256 net = amount - fee;

        positions[user][token].borrowed -= net;
        emit Repay(user, token, net);
    }

    // =====================================================================
    // Success criteria — simple dispute mechanism
    // =====================================================================

    /// @notice User flags a bad operation. Increments the agent's opsReverted counter.
    ///         A high revert ratio is a signal for other users to avoid this agent.
    function disputeAgent(address agent) external {
        agentScores[msg.sender][agent].opsReverted += 1;
        emit OpDisputed(msg.sender, agent);
    }

    /// @notice View helper: success rate in bps (0-10000). Returns 10000 if no ops yet.
    function agentSuccessRate(address user, address agent) external view returns (uint256) {
        AgentScore memory s = agentScores[user][agent];
        if (s.opsSettled == 0) return BPS;
        return ((s.opsSettled - s.opsReverted) * BPS) / s.opsSettled;
    }

    // =====================================================================
    // Fee claims & swap-to-native
    // =====================================================================

    /// @notice Agent claims accumulated fees in a specific token.
    function claimFees(address token) external {
        uint256 amount = agentFees[msg.sender][token];
        if (amount == 0) revert NoFeesToClaim();

        agentFees[msg.sender][token] = 0;
        IERC20(token).transfer(msg.sender, amount);

        emit FeesClaimed(msg.sender, token, amount);
    }

    /// @notice Agent swaps accumulated fees directly to CELO via Uniswap V3
    ///         so it can pay for its own gas (self-funding loop).
    /// @param token       The fee token to swap.
    /// @param poolFee     Uniswap V3 pool fee tier (e.g. 3000 = 0.3%).
    /// @param minAmountOut Minimum CELO to receive (slippage protection).
    function claimFeesAsNative(
        address token,
        uint24 poolFee,
        uint256 minAmountOut
    ) external returns (uint256 amountOut) {
        uint256 amount = agentFees[msg.sender][token];
        if (amount == 0) revert NoFeesToClaim();

        agentFees[msg.sender][token] = 0;

        // Approve router to spend the fee tokens
        IERC20(token).approve(address(swapRouter), amount);

        amountOut = swapRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: token,
                tokenOut: nativeToken,
                fee: poolFee,
                recipient: msg.sender,
                deadline: block.timestamp,
                amountIn: amount,
                amountOutMinimum: minAmountOut,
                sqrtPriceLimitX96: 0
            })
        );

        emit FeesSwappedToNative(msg.sender, token, amount, amountOut);
    }

    // =====================================================================
    // Internal
    // =====================================================================

    /// @dev Collects fee from the operation amount. Fee stays in the contract,
    ///      credited to the calling agent. Returns the fee amount.
    ///      When the user calls for themselves (no agent), no fee is charged.
    function _collectFee(address user, address token, uint256 amount) internal returns (uint256 fee) {
        if (msg.sender == user) return 0; // user acting for themselves — no fee

        fee = (amount * FEE_BPS) / BPS;
        agentFees[msg.sender][token] += fee;
        agentScores[user][msg.sender].opsSettled += 1;
        agentScores[user][msg.sender].feesEarned += fee;

        emit FeeCollected(msg.sender, token, fee);
    }

    function _checkAuthorised(address user, address caller) internal view {
        if (authorisedAgents[user][caller]) return;

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
