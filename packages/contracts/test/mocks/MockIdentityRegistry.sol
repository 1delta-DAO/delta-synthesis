// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {IIdentityRegistry} from "../../src/interfaces/IIdentityRegistry.sol";

/// @notice Mock ERC-8004 Identity Registry.
///         Implements the full IIdentityRegistry interface so it can be used
///         as a drop-in test double for the Celo mainnet contract.
contract MockIdentityRegistry is IIdentityRegistry {
    uint256 private _nextTokenId = 1;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => string) private _tokenURIs;

    // --- Events (ERC-721 subset) ---
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    // --- Errors ---
    error TokenDoesNotExist();

    // --- IIdentityRegistry ---

    /// @notice Register a new agent identity. Returns the minted tokenId.
    function register(string calldata uri) external returns (uint256 tokenId) {
        tokenId = _nextTokenId++;
        _owners[tokenId] = msg.sender;
        _balances[msg.sender] += 1;
        _tokenURIs[tokenId] = uri;
        emit Transfer(address(0), msg.sender, tokenId);
    }

    function balanceOf(address owner) external view returns (uint256) {
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address owner = _owners[tokenId];
        if (owner == address(0)) revert TokenDoesNotExist();
        return owner;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_owners[tokenId] == address(0)) revert TokenDoesNotExist();
        return _tokenURIs[tokenId];
    }

    // --- Test helpers ---

    /// @notice Mint an identity NFT to an arbitrary address (test-only convenience).
    function mint(address to) external returns (uint256 tokenId) {
        tokenId = _nextTokenId++;
        _owners[tokenId] = to;
        _balances[to] += 1;
        emit Transfer(address(0), to, tokenId);
    }

    /// @notice Burn an identity NFT (simulates revocation / loss of identity).
    function burn(uint256 tokenId) external {
        address owner = _owners[tokenId];
        if (owner == address(0)) revert TokenDoesNotExist();
        _balances[owner] -= 1;
        delete _owners[tokenId];
        delete _tokenURIs[tokenId];
        emit Transfer(owner, address(0), tokenId);
    }

    /// @notice Transfer an identity NFT between addresses (test-only).
    function transferFrom(address from, address to, uint256 tokenId) external {
        if (_owners[tokenId] != from) revert TokenDoesNotExist();
        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }
}
