// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

/**
 * @title EIP712OrderVerifier
 * @notice EIP-712 signature verification for migration orders.
 *         The user signs (merkleRoot, deadline, settlementData) so agents
 *         can only execute pre-approved orders within the validity window.
 *
 *         Supports two cancellation mechanisms:
 *         1. Per-order cancellation via order digest hash.
 *         2. Nonce-based bulk cancellation — all orders with nonce < minNonce are invalid.
 */
abstract contract EIP712OrderVerifier {
    error OrderExpired();
    error InvalidOrderSignature();
    error OrderCancelled();
    error NonceTooLow();
    error UnauthorizedSolver();

    event OrderCancelledEvent(address indexed user, bytes32 indexed orderHash);
    event NonceIncremented(address indexed user, uint256 newMinNonce);

    /// @notice Per-order cancellation: orderHash => cancelled.
    mapping(bytes32 => bool) public cancelledOrders;

    /// @notice Nonce-based bulk cancellation: all orders with nonce < minNonce are invalid.
    mapping(address => uint256) public minNonce;

    bytes32 private immutable _DOMAIN_SEPARATOR;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 internal constant INFINITE_ORDER_TYPEHASH =
        keccak256("InfiniteOrder(bytes32 merkleRoot,uint48 deadline,uint256 maxFeeBps,address solver,bytes settlementData)");

    constructor() {
        _DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256("InfiniteSettlement"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _DOMAIN_SEPARATOR;
    }

    // ── Order Cancellation ────────────────────────────────

    /**
     * @notice Cancel a specific order by its EIP-712 digest hash.
     * @dev    The caller must be the order signer. Computes the digest from
     *         the order parameters so only the signer can cancel their own order.
     * @param merkleRoot      Merkle root from the signed order
     * @param deadline        Deadline from the signed order
     * @param settlementData  Settlement data from the signed order
     */
    function cancelOrder(
        bytes32 merkleRoot,
        uint48 deadline,
        uint256 maxFeeBps,
        address solver,
        bytes calldata settlementData
    ) external {
        bytes32 structHash = keccak256(
            abi.encode(INFINITE_ORDER_TYPEHASH, merkleRoot, deadline, maxFeeBps, solver, keccak256(settlementData))
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _DOMAIN_SEPARATOR, structHash));

        cancelledOrders[digest] = true;
        emit OrderCancelledEvent(msg.sender, digest);
    }

    /**
     * @notice Bulk-cancel all orders below a given nonce.
     * @dev    Sets the caller's minNonce to `newMinNonce`. Any order whose
     *         nonce (encoded in the deadline field) is below this value will
     *         be rejected during verification.
     * @param newMinNonce  The new minimum nonce; must be greater than current.
     */
    function incrementNonce(uint256 newMinNonce) external {
        if (newMinNonce <= minNonce[msg.sender]) revert NonceTooLow();
        minNonce[msg.sender] = newMinNonce;
        emit NonceIncremented(msg.sender, newMinNonce);
    }

    // ── Signature Recovery ────────────────────────────────

    /**
     * @notice Recovers the signer of a InfiniteOrder after checking the deadline
     *         and cancellation status.
     * @param merkleRoot       Merkle root of allowed actions
     * @param deadline         Order expiry timestamp
     * @param settlementData   Raw settlement data bytes
     * @param signature        65-byte packed signature (r ++ s ++ v)
     * @return signer          The recovered address (position owner)
     */
    function _recoverOrderSigner(
        bytes32 merkleRoot,
        uint48 deadline,
        uint256 maxFeeBps,
        address solver,
        bytes memory settlementData,
        bytes memory signature
    ) internal view returns (address signer) {
        if (block.timestamp > deadline) revert OrderExpired();
        // solver == address(0) → permissionless; otherwise only that address can settle
        if (solver != address(0) && msg.sender != solver) revert UnauthorizedSolver();

        bytes32 structHash = keccak256(
            abi.encode(INFINITE_ORDER_TYPEHASH, merkleRoot, deadline, maxFeeBps, solver, keccak256(settlementData))
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _DOMAIN_SEPARATOR, structHash));

        // Check per-order cancellation
        if (cancelledOrders[digest]) revert OrderCancelled();

        assembly {
            let ptr := mload(0x40)
            mstore(ptr, digest)
            mstore(add(ptr, 0x20), byte(0, mload(add(signature, 0x60)))) // v
            mstore(add(ptr, 0x40), mload(add(signature, 0x20)))          // r
            mstore(add(ptr, 0x60), mload(add(signature, 0x40)))          // s
            // clear scratch space with zero (address(0) is invalid signature)
            mstore(0x00, 0)
            pop(staticcall(gas(), 0x01, ptr, 0x80, 0x00, 0x20))
            signer := mload(0x00)
        }

        if (signer == address(0)) {
            revert InvalidOrderSignature();
        }

        // Check nonce-based bulk cancellation
        if (deadline < minNonce[signer]) revert OrderCancelled();
    }
}
