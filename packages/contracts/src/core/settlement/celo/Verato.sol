// SPDX-License-Identifier: MIT

pragma solidity 0.8.34;

import {IERC20} from "lib/forge-std/src/interfaces/IERC20.sol";
import {MorphoFlashLoans} from "../flash-loan/Morpho.sol";
import {MorphoSettlementCallback} from "../flash-loan/MorphoSettlementCallback.sol";
import {EIP712OrderVerifier} from "../EIP712OrderVerifier.sol";
import {SwapVerifier} from "../oracle/SwapVerifier.sol";
import {HealthFactorChecker} from "../conditions/HealthFactorChecker.sol";
import {LenderIds} from "../lending/DeltaEnums.sol";
import {SettlementForwarder} from "../SettlementForwarder.sol";
import {SettlementExecutor} from "../SettlementExecutor.sol";
import {IIdentityRegistry} from "../../../interfaces/IIdentityRegistry.sol";
import {IReputationRegistry} from "../../../interfaces/IReputationRegistry.sol";
import {ISwapRouter} from "../../../interfaces/ISwapRouter.sol";

/**
 * @title Verato
 * @notice Unified Celo contract for autonomous agent-managed lending positions.
 *         Combines EIP-712 settlement (flash loans, oracle-verified swaps,
 *         multi-protocol lending) with agent permissioning, fee collection,
 *         and ERC-8004 reputation gating.
 *
 *  ════════════════════════════════════════════════════════════════════════════
 *   AGENT PERMISSIONING
 *  ════════════════════════════════════════════════════════════════════════════
 *
 *  Users grant agents permission to manage their positions via:
 *    - Direct address trust: authoriseAgent(address)
 *    - ERC-8004 identity trust: authoriseAgentId(uint256) + trust policy
 *
 *  Agents earn fees (0.10%) on operations and can swap them to CELO
 *  via Uniswap V3 to self-fund gas.
 *
 *  ════════════════════════════════════════════════════════════════════════════
 *   REPUTATION-GATED SETTLEMENT
 *  ════════════════════════════════════════════════════════════════════════════
 *
 *  Solvers executing EIP-712 signed orders must meet on-chain reputation
 *  thresholds from the Celo ERC-8004 registries before any settlement runs.
 */
contract Verato is
    MorphoFlashLoans,
    MorphoSettlementCallback,
    EIP712OrderVerifier,
    SwapVerifier,
    HealthFactorChecker
{
    // ═════════════════════════════════════════════════════════════════════════
    //  Types
    // ═════════════════════════════════════════════════════════════════════════

    struct Position {
        uint256 deposited;
        uint256 borrowed;
    }

    struct TrustPolicy {
        bool requireRegistered;
        uint256 minReputation;
    }

    struct AgentScore {
        uint256 opsSettled;
        uint256 opsReverted;
        uint256 feesEarned;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Constants
    // ═════════════════════════════════════════════════════════════════════════

    uint256 public constant FEE_BPS = 10; // 0.10%
    uint256 public constant BPS = 10_000;

    /// @dev Morpho Blue canonical CREATE2 address.
    ///      Verify on Celo: https://celoscan.io/address/0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
    address internal constant MORPHO_BLUE = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

    // ═════════════════════════════════════════════════════════════════════════
    //  Immutables
    // ═════════════════════════════════════════════════════════════════════════

    SettlementForwarder public immutable forwarder;
    IIdentityRegistry public immutable identityRegistry;
    IReputationRegistry public immutable reputationRegistry;
    ISwapRouter public immutable swapRouter;
    address public immutable nativeToken; // CELO ERC-20

    // ═════════════════════════════════════════════════════════════════════════
    //  State — ownership
    // ═════════════════════════════════════════════════════════════════════════

    address public owner;

    // ═════════════════════════════════════════════════════════════════════════
    //  State — agent permissioning (user-facing)
    // ═════════════════════════════════════════════════════════════════════════

    mapping(address => mapping(address => bool)) public authorisedAgents;
    mapping(address => mapping(uint256 => bool)) public authorisedAgentIds;
    mapping(address => TrustPolicy) public trustPolicies;
    mapping(address => uint256) public agentIdOf;
    mapping(address => bool) public hasLinkedId;
    mapping(address => mapping(address => Position)) public positions;
    mapping(address => mapping(address => uint256)) public agentFees;
    mapping(address => mapping(address => AgentScore)) public agentScores;

    // ═════════════════════════════════════════════════════════════════════════
    //  State — solver reputation gating (settlement-facing)
    // ═════════════════════════════════════════════════════════════════════════

    uint256 public minReputation;
    mapping(address => uint256) public solverAgentId;
    mapping(address => bool) public solverLinked;
    mapping(address => mapping(address => bool)) public userDirectTrust;
    mapping(address => uint256) public userMinReputation;

    // ═════════════════════════════════════════════════════════════════════════
    //  Events
    // ═════════════════════════════════════════════════════════════════════════

    event OwnershipTransferred(address indexed prev, address indexed next);
    event MinReputationUpdated(uint256 newMin);
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
    event SolverLinked(address indexed solver, uint256 indexed agentId);
    event UserDirectTrustSet(address indexed user, address indexed solver, bool trusted);
    event UserMinReputationSet(address indexed user, uint256 minRep);

    // ═════════════════════════════════════════════════════════════════════════
    //  Errors
    // ═════════════════════════════════════════════════════════════════════════

    error Unauthorised();
    error InsufficientBalance();
    error ZeroAmount();
    error AgentNotRegistered();
    error ReputationTooLow();
    error NoFeesToClaim();
    error ConversionMismatch();
    error UnsupportedConditionLender();
    error OnlyOwner();
    error SolverNotRegistered();
    error SolverReputationTooLow();
    error SolverNotLinked();

    // ═════════════════════════════════════════════════════════════════════════
    //  Constructor
    // ═════════════════════════════════════════════════════════════════════════

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
        owner = msg.sender;
        forwarder = new SettlementForwarder(address(this));
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Morpho Blue
    // ═════════════════════════════════════════════════════════════════════════

    function _morphoPool() internal pure override returns (address) {
        return MORPHO_BLUE;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Owner management
    // ═════════════════════════════════════════════════════════════════════════

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert OnlyOwner();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setMinReputation(uint256 _minReputation) external {
        if (msg.sender != owner) revert OnlyOwner();
        minReputation = _minReputation;
        emit MinReputationUpdated(_minReputation);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Agent permissioning (user-facing)
    // ═════════════════════════════════════════════════════════════════════════

    modifier onlyAuthorised(address user) {
        if (msg.sender != user) {
            _checkAuthorised(user, msg.sender);
        }
        _;
    }

    function setTrustPolicy(bool requireRegistered, uint256 _minReputation) external {
        trustPolicies[msg.sender] = TrustPolicy(requireRegistered, _minReputation);
        emit TrustPolicyUpdated(msg.sender, requireRegistered, _minReputation);
    }

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

    // ═════════════════════════════════════════════════════════════════════════
    //  Position management — fee-bearing (agent-facing)
    // ═════════════════════════════════════════════════════════════════════════

    function deposit(address user, address token, uint256 amount) external onlyAuthorised(user) {
        if (amount == 0) revert ZeroAmount();
        IERC20(token).transferFrom(user, address(this), amount);
        uint256 fee = _collectFee(user, token, amount);
        positions[user][token].deposited += (amount - fee);
        emit Deposit(user, token, amount - fee);
    }

    function withdraw(address user, address token, uint256 amount) external onlyAuthorised(user) {
        if (amount == 0) revert ZeroAmount();
        if (positions[user][token].deposited < amount) revert InsufficientBalance();
        positions[user][token].deposited -= amount;
        uint256 fee = _collectFee(user, token, amount);
        IERC20(token).transfer(user, amount - fee);
        emit Withdraw(user, token, amount - fee);
    }

    function borrow(address user, address token, uint256 amount) external onlyAuthorised(user) {
        if (amount == 0) revert ZeroAmount();
        positions[user][token].borrowed += amount;
        uint256 fee = _collectFee(user, token, amount);
        IERC20(token).transfer(user, amount - fee);
        emit Borrow(user, token, amount - fee);
    }

    function repay(address user, address token, uint256 amount) external onlyAuthorised(user) {
        if (amount == 0) revert ZeroAmount();
        if (positions[user][token].borrowed < amount) revert InsufficientBalance();
        IERC20(token).transferFrom(user, address(this), amount);
        uint256 fee = _collectFee(user, token, amount);
        positions[user][token].borrowed -= (amount - fee);
        emit Repay(user, token, amount - fee);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Success criteria — dispute mechanism
    // ═════════════════════════════════════════════════════════════════════════

    function disputeAgent(address agent) external {
        agentScores[msg.sender][agent].opsReverted += 1;
        emit OpDisputed(msg.sender, agent);
    }

    function agentSuccessRate(address user, address agent) external view returns (uint256) {
        AgentScore memory s = agentScores[user][agent];
        if (s.opsSettled == 0) return BPS;
        return ((s.opsSettled - s.opsReverted) * BPS) / s.opsSettled;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Fee claims & swap-to-native
    // ═════════════════════════════════════════════════════════════════════════

    function claimFees(address token) external {
        uint256 amount = agentFees[msg.sender][token];
        if (amount == 0) revert NoFeesToClaim();
        agentFees[msg.sender][token] = 0;
        IERC20(token).transfer(msg.sender, amount);
        emit FeesClaimed(msg.sender, token, amount);
    }

    function claimFeesAsNative(
        address token, uint24 poolFee, uint256 minAmountOut
    ) external returns (uint256 amountOut) {
        uint256 amount = agentFees[msg.sender][token];
        if (amount == 0) revert NoFeesToClaim();
        agentFees[msg.sender][token] = 0;
        IERC20(token).approve(address(swapRouter), amount);
        amountOut = swapRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: token, tokenOut: nativeToken, fee: poolFee,
                recipient: msg.sender, deadline: block.timestamp,
                amountIn: amount, amountOutMinimum: minAmountOut, sqrtPriceLimitX96: 0
            })
        );
        emit FeesSwappedToNative(msg.sender, token, amount, amountOut);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Solver trust configuration (settlement-facing)
    // ═════════════════════════════════════════════════════════════════════════

    function linkSolverAgentId(uint256 agentId) external {
        if (identityRegistry.balanceOf(msg.sender) == 0) revert SolverNotRegistered();
        solverAgentId[msg.sender] = agentId;
        solverLinked[msg.sender] = true;
        emit SolverLinked(msg.sender, agentId);
    }

    function setUserSolverTrust(address solver, bool trusted) external {
        userDirectTrust[msg.sender][solver] = trusted;
        emit UserDirectTrustSet(msg.sender, solver, trusted);
    }

    function setUserMinReputation(uint256 _minReputation) external {
        userMinReputation[msg.sender] = _minReputation;
        emit UserMinReputationSet(msg.sender, _minReputation);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Settlement entry points (reputation-gated)
    // ═════════════════════════════════════════════════════════════════════════

    function settle(
        uint256 maxFeeBps, address solver, uint48 deadline,
        bytes calldata signature, bytes calldata orderData,
        bytes calldata executionData, bytes calldata fillerCalldata
    ) external {
        (address user,) = _verifyAndExtract(maxFeeBps, solver, deadline, signature, orderData);
        _checkSolverReputation(user, msg.sender);
        _executeSettlement(user, maxFeeBps, orderData, executionData, fillerCalldata);
    }

    function settleWithFlashLoan(
        address flashLoanAsset, uint256 flashLoanAmount, address flashLoanPool, uint8 poolId,
        uint256 maxFeeBps, address solver, uint48 deadline,
        bytes calldata signature, bytes calldata orderData,
        bytes calldata executionData, bytes calldata fillerCalldata
    ) external {
        (address user,) = _verifyAndExtract(maxFeeBps, solver, deadline, signature, orderData);
        _checkSolverReputation(user, msg.sender);
        uint256 paramsLen = 1 + 8 + 2 + orderData.length + 2 + fillerCalldata.length + executionData.length;
        bytes memory fullData = abi.encodePacked(
            flashLoanPool, uint16(paramsLen), poolId, uint64(maxFeeBps),
            uint16(orderData.length), orderData,
            uint16(fillerCalldata.length), fillerCalldata, executionData
        );
        morphoFlashLoan(flashLoanAsset, flashLoanAmount, user, fullData);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Order verification
    // ═════════════════════════════════════════════════════════════════════════

    function _verifyAndExtract(
        uint256 maxFeeBps, address solver, uint48 deadline,
        bytes calldata signature, bytes calldata orderData
    ) internal view returns (address user, bytes32 merkleRoot) {
        bytes memory settlementData;
        assembly {
            merkleRoot := calldataload(orderData.offset)
            let sLen := shr(240, calldataload(add(orderData.offset, 32)))
            let fmp := mload(0x40)
            settlementData := fmp
            mstore(fmp, sLen)
            calldatacopy(add(fmp, 0x20), add(orderData.offset, 34), sLen)
            mstore(0x40, add(add(fmp, 0x20), and(add(sLen, 31), not(31))))
        }
        user = _recoverOrderSigner(merkleRoot, deadline, maxFeeBps, solver, settlementData, signature);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Intent: oracle-verified swaps
    // ═════════════════════════════════════════════════════════════════════════

    function _executeIntent(
        address, bytes memory settlementData, bytes memory fillerCalldata,
        AssetDelta[] memory deltas, uint256 deltaCount
    ) internal override returns (uint256 newDeltaCount) {
        if (fillerCalldata.length == 0) return deltaCount;
        newDeltaCount = deltaCount;
        uint256 numConversions;
        assembly { numConversions := shr(248, mload(add(settlementData, 0x20))) }
        uint256 sdOffset = 1;
        uint256 fcOffset;
        for (uint256 i; i < numConversions;) {
            uint256 fcLen;
            (newDeltaCount, fcLen) = _executeSwap(settlementData, sdOffset, fillerCalldata, fcOffset, deltas, newDeltaCount);
            sdOffset += 68;
            fcOffset += fcLen;
            unchecked { ++i; }
        }
    }

    function _executeSwap(
        bytes memory settlementData, uint256 sdOffset,
        bytes memory fillerCalldata, uint256 fcOffset,
        AssetDelta[] memory deltas, uint256 deltaCount
    ) private returns (uint256 newDeltaCount, uint256 fcConsumed) {
        address sdAssetIn; address sdAssetOut; address oracle; uint256 swapTolerance;
        assembly {
            let sd := add(add(settlementData, 0x20), sdOffset)
            sdAssetIn := shr(96, mload(sd))
            sdAssetOut := shr(96, mload(add(sd, 20)))
            oracle := shr(96, mload(add(sd, 40)))
            swapTolerance := shr(192, mload(add(sd, 60)))
        }
        address fcAssetIn; address fcAssetOut; uint256 amountIn; address target; uint256 swapCalldataLen;
        assembly {
            let fc := add(add(fillerCalldata, 0x20), fcOffset)
            fcAssetIn := shr(96, mload(fc))
            fcAssetOut := shr(96, mload(add(fc, 20)))
            amountIn := shr(144, mload(add(fc, 40)))
            target := shr(96, mload(add(fc, 54)))
            swapCalldataLen := and(0xffff, shr(240, mload(add(fc, 74))))
        }
        if (fcAssetIn != sdAssetIn || fcAssetOut != sdAssetOut) revert ConversionMismatch();
        if (amountIn == 0) {
            assembly {
                let ptr := mload(0x40)
                mstore(ptr, 0x70a0823100000000000000000000000000000000000000000000000000000000)
                mstore(add(ptr, 4), address())
                if iszero(staticcall(gas(), fcAssetIn, ptr, 0x24, ptr, 0x20)) { returndatacopy(0, 0, returndatasize()) revert(0, returndatasize()) }
                amountIn := mload(ptr)
            }
            if (amountIn == 0) { return (deltaCount, 76 + swapCalldataLen); }
        }
        uint256 amountOut = _forwardSwap(fcAssetIn, fcAssetOut, amountIn, target, fillerCalldata, fcOffset, swapCalldataLen);
        _verifySwapOutput(oracle, fcAssetIn, fcAssetOut, amountIn, amountOut, swapTolerance);
        newDeltaCount = _updateDelta(deltas, deltaCount, fcAssetIn, -int256(amountIn), 0);
        newDeltaCount = _updateDelta(deltas, newDeltaCount, fcAssetOut, int256(amountOut), 0);
        fcConsumed = 76 + swapCalldataLen;
    }

    function _forwardSwap(
        address assetIn, address assetOut, uint256 amountIn, address target,
        bytes memory fillerCalldata, uint256 fcOffset, uint256 swapCalldataLen
    ) private returns (uint256 amountOut) {
        address payable fwd = payable(address(forwarder));
        uint256 balBefore;
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x70a0823100000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 4), address())
            if iszero(staticcall(gas(), assetOut, ptr, 0x24, ptr, 0x20)) { returndatacopy(0, 0, returndatasize()) revert(0, returndatasize()) }
            balBefore := mload(ptr)
        }
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 4), fwd)
            mstore(add(ptr, 0x24), amountIn)
            if iszero(call(gas(), assetIn, 0, ptr, 0x44, 0, 0x20)) { returndatacopy(0, 0, returndatasize()) revert(0, returndatasize()) }
        }
        bytes memory swapCalldata = new bytes(swapCalldataLen);
        assembly {
            let src := add(add(fillerCalldata, 0x20), add(fcOffset, 76))
            let dest := add(swapCalldata, 0x20)
            for { let j := 0 } lt(j, swapCalldataLen) { j := add(j, 32) } { mstore(add(dest, j), mload(add(src, j))) }
        }
        SettlementForwarder(fwd).execute(target, swapCalldata);
        SettlementForwarder(fwd).sweep(assetOut);
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x70a0823100000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 4), address())
            if iszero(staticcall(gas(), assetOut, ptr, 0x24, ptr, 0x20)) { returndatacopy(0, 0, returndatasize()) revert(0, returndatasize()) }
            amountOut := sub(mload(ptr), balBefore)
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Post-settlement conditions
    // ═════════════════════════════════════════════════════════════════════════

    function _postSettlementCheck(
        address orderSigner, bytes memory settlementData, uint256 riskyLenderMask
    ) internal view override {
        uint256 numConversions;
        assembly { numConversions := shr(248, mload(add(settlementData, 0x20))) }
        uint256 conditionsOffset = 1 + numConversions * 68;
        if (settlementData.length <= conditionsOffset) return;
        uint256 numConditions;
        assembly { numConditions := shr(248, mload(add(add(settlementData, 0x20), conditionsOffset))) }
        uint256 cursor = conditionsOffset + 1;
        for (uint256 i; i < numConditions;) {
            uint256 lenderId;
            assembly { lenderId := and(0xffff, shr(240, mload(add(add(settlementData, 0x20), cursor)))) }
            if (lenderId < LenderIds.UP_TO_AAVE_V2) {
                if (riskyLenderMask & 1 != 0) {
                    address pool; uint256 minHF;
                    assembly { let ptr := add(add(settlementData, 0x20), cursor) pool := shr(96, mload(add(ptr, 2))) minHF := shr(144, mload(add(ptr, 22))) }
                    _checkAaveHealthFactor(pool, orderSigner, minHF);
                }
                cursor += 36;
            } else if (lenderId < LenderIds.UP_TO_COMPOUND_V3) {
                if (riskyLenderMask & 2 != 0) {
                    address comet; uint256 assetBitmap; uint256 minHF;
                    assembly { let ptr := add(add(settlementData, 0x20), cursor) comet := shr(96, mload(add(ptr, 2))) assetBitmap := and(0xffff, shr(240, mload(add(ptr, 22)))) minHF := shr(144, mload(add(ptr, 24))) }
                    _checkCompoundV3HealthFactor(comet, orderSigner, assetBitmap, minHF);
                }
                cursor += 38;
            } else if (lenderId < LenderIds.UP_TO_COMPOUND_V2) {
                if (riskyLenderMask & 4 != 0) {
                    address comptroller;
                    assembly { let ptr := add(add(settlementData, 0x20), cursor) comptroller := shr(96, mload(add(ptr, 2))) }
                    _checkCompoundV2Solvency(comptroller, orderSigner);
                }
                cursor += 36;
            } else if (lenderId < LenderIds.UP_TO_MORPHO) {
                if (riskyLenderMask & 8 != 0) {
                    address morpho; bytes32 marketId; uint256 minHF;
                    assembly { let ptr := add(add(settlementData, 0x20), cursor) morpho := shr(96, mload(add(ptr, 2))) marketId := mload(add(ptr, 22)) minHF := shr(144, mload(add(ptr, 54))) }
                    _checkMorphoHealthFactor(morpho, marketId, orderSigner, minHF);
                }
                cursor += 68;
            } else {
                revert UnsupportedConditionLender();
            }
            unchecked { ++i; }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Internal — agent auth
    // ═════════════════════════════════════════════════════════════════════════

    function _checkAuthorised(address user, address caller) internal view {
        if (authorisedAgents[user][caller]) return;
        if (hasLinkedId[caller]) {
            uint256 agentId = agentIdOf[caller];
            if (authorisedAgentIds[user][agentId]) {
                _enforceTrustPolicy(trustPolicies[user], caller, agentId);
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

    function _collectFee(address user, address token, uint256 amount) internal returns (uint256 fee) {
        if (msg.sender == user) return 0;
        fee = (amount * FEE_BPS) / BPS;
        agentFees[msg.sender][token] += fee;
        agentScores[user][msg.sender].opsSettled += 1;
        agentScores[user][msg.sender].feesEarned += fee;
        emit FeeCollected(msg.sender, token, fee);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Internal — solver reputation
    // ═════════════════════════════════════════════════════════════════════════

    function _checkSolverReputation(address user, address solver) internal view {
        if (userDirectTrust[user][solver]) return;
        if (!solverLinked[solver]) revert SolverNotLinked();
        if (identityRegistry.balanceOf(solver) == 0) revert SolverNotRegistered();
        uint256 required = userMinReputation[user];
        if (required == 0) required = minReputation;
        if (required > 0) {
            uint256 agentId = solverAgentId[solver];
            IReputationRegistry.Summary memory summary = reputationRegistry.getSummary(agentId);
            if (summary.averageScore < required) revert SolverReputationTooLow();
        }
    }
}
