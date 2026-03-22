// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.34;

import {Script, console} from "forge-std/Script.sol";
import {AaveOracleAdapter} from "../src/core/settlement/oracle/AaveOracleAdapter.sol";

contract DeployOracleScript is Script {
    // Celo mainnet — Aave V3 Oracle
    address constant AAVE_V3_ORACLE = 0x1e693D088ceFD1E95ba4c4a5F7EeA41a1Ec37e8b;

    function run() public {
        vm.startBroadcast();

        AaveOracleAdapter adapter = new AaveOracleAdapter(AAVE_V3_ORACLE);

        console.log("AaveOracleAdapter deployed at:", address(adapter));
        console.log("Wraps Aave Oracle at:", AAVE_V3_ORACLE);

        vm.stopBroadcast();
    }
}
