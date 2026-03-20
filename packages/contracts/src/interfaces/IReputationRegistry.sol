// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

/// @notice Interface for the ERC-8004 Reputation Registry.
interface IReputationRegistry {
    struct Summary {
        uint256 averageScore;
        uint256 totalFeedback;
    }

    struct Feedback {
        address reviewer;
        uint256 score;
        uint256 timestamp;
        string tag;
        string uri;
    }

    function giveFeedback(
        uint256 agentId,
        uint256 score,
        uint256 extra,
        string calldata tag,
        string calldata comment,
        string calldata endpoint,
        string calldata uri,
        bytes32 feedbackHash
    ) external;

    function revokeFeedback(uint256 agentId, uint256 feedbackIndex) external;
    function readAllFeedback(uint256 agentId) external view returns (Feedback[] memory);
    function getSummary(uint256 agentId) external view returns (Summary memory);
}
