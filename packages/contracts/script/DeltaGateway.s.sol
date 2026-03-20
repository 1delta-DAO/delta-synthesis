// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Script} from "forge-std/Script.sol";
import {DeltaGateway} from "../src/DeltaGateway.sol";

contract DeltaGatewayScript is Script {
    function run() public {
        vm.startBroadcast();
        new DeltaGateway();
        vm.stopBroadcast();
    }
}
