// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {IReputationRegistry} from "../../src/interfaces/IReputationRegistry.sol";

/// @notice Mock ERC-8004 Reputation Registry.
///         Implements the full IReputationRegistry interface so it can be used
///         as a drop-in test double for the Celo mainnet contract.
contract MockReputationRegistry is IReputationRegistry {
    mapping(uint256 => Feedback[]) private _feedback;

    // --- IReputationRegistry ---

    function giveFeedback(
        uint256 agentId,
        uint256 score,
        uint256, /* extra */
        string calldata tag,
        string calldata, /* comment */
        string calldata, /* endpoint */
        string calldata uri,
        bytes32 /* feedbackHash */
    ) external {
        _feedback[agentId].push(
            Feedback({
                reviewer: msg.sender,
                score: score,
                timestamp: block.timestamp,
                tag: tag,
                uri: uri
            })
        );
    }

    function revokeFeedback(uint256 agentId, uint256 feedbackIndex) external {
        Feedback[] storage entries = _feedback[agentId];
        require(feedbackIndex < entries.length, "index out of bounds");
        // Swap-and-pop
        entries[feedbackIndex] = entries[entries.length - 1];
        entries.pop();
    }

    function readAllFeedback(uint256 agentId) external view returns (Feedback[] memory) {
        return _feedback[agentId];
    }

    function getSummary(uint256 agentId) external view returns (Summary memory) {
        Feedback[] storage entries = _feedback[agentId];
        uint256 len = entries.length;
        if (len == 0) return Summary(0, 0);

        uint256 total;
        for (uint256 i; i < len; i++) {
            total += entries[i].score;
        }
        return Summary(total / len, len);
    }

    // --- Test helpers ---

    /// @notice Directly set an agent's reputation summary without submitting individual feedback.
    ///         Pushes a single synthetic feedback entry that produces the desired average.
    function setReputation(uint256 agentId, uint256 averageScore, uint256 totalFeedback) external {
        // Clear existing entries
        delete _feedback[agentId];
        // Push `totalFeedback` entries each with `averageScore` so getSummary returns the desired values.
        for (uint256 i; i < totalFeedback; i++) {
            _feedback[agentId].push(
                Feedback({
                    reviewer: msg.sender,
                    score: averageScore,
                    timestamp: block.timestamp,
                    tag: "synthetic",
                    uri: ""
                })
            );
        }
    }
}
