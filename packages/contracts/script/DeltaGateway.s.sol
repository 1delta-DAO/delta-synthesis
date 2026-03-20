// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Script} from "forge-std/Script.sol";
import {DeltaGateway} from "../src/DeltaGateway.sol";

contract DeltaGatewayScript is Script {
    // Celo mainnet ERC-8004 registry addresses
    address constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant REPUTATION_REGISTRY = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    function run() public {
        vm.startBroadcast();
        new DeltaGateway(IDENTITY_REGISTRY, REPUTATION_REGISTRY);
        vm.stopBroadcast();
    }
}
