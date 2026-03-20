// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice Minimal interface for fork-testing Verato without importing the full contract
///         (avoids solc via_ir stack-too-deep when the full inheritance tree is compiled
///         alongside large test functions).
interface IVerato {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function forwarder() external view returns (address);

    // Settlement
    function settle(
        uint256 maxFeeBps, address solver, uint48 deadline,
        bytes calldata signature, bytes calldata orderData,
        bytes calldata executionData, bytes calldata fillerCalldata
    ) external;

    function settleWithFlashLoan(
        address flashLoanAsset, uint256 flashLoanAmount, address flashLoanPool, uint8 poolId,
        uint256 maxFeeBps, address solver, uint48 deadline,
        bytes calldata signature, bytes calldata orderData,
        bytes calldata executionData, bytes calldata fillerCalldata
    ) external;

    // Token approvals
    function approveToken(address token, address spender, uint256 amount) external;

    // Solver trust
    function setUserSolverTrust(address solver, bool trusted) external;
    function linkSolverAgentId(uint256 agentId) external;
    function setUserMinReputation(uint256 _minReputation) external;

    // Agent management
    function authoriseAgent(address agent) external;
    function linkAgentId(uint256 agentId) external;
    function setTrustPolicy(bool requireRegistered, uint256 minReputation) external;

    // Multicall
    function multicall(bytes[] calldata data) external;
}
