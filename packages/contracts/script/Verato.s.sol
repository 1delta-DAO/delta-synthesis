// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

import {Script, console} from "forge-std/Script.sol";
import {Verato} from "../src/core/settlement/celo/Verato.sol";

contract VeratoScript is Script {
    // Celo mainnet — ERC-8004 registries
    address constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant REPUTATION_REGISTRY = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    // Celo mainnet — Uniswap V3 + native token
    address constant UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address constant CELO_TOKEN = 0x471EcE3750Da237f93B8E339c536989b8978a438;

    function run() public {
        vm.startBroadcast();

        Verato verato = new Verato(
            IDENTITY_REGISTRY,
            REPUTATION_REGISTRY,
            UNISWAP_V3_ROUTER,
            CELO_TOKEN
        );

        console.log("Verato deployed at:", address(verato));

        vm.stopBroadcast();
    }
}
