// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

/// @notice Interface for the ERC-8004 Identity Registry.
///         The on-chain registry is an ERC-721 – each agent mints an NFT
///         whose tokenId becomes its portable identity.
interface IIdentityRegistry {
    // --- ERC-721 subset used by Verato ---
    function balanceOf(address owner) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);

    // --- ERC-8004 registration ---
    function register(string calldata uri) external returns (uint256 tokenId);
    function tokenURI(uint256 tokenId) external view returns (string memory);
}
