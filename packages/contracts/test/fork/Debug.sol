// // SPDX-License-Identifier: UNLICENSED
// pragma solidity ^0.8.19;

// import {IERC20All} from "test/shared/interfaces/IERC20All.sol";
// import {BaseTest} from "test/shared/BaseTest.sol";
// import {Chains, Tokens, Lenders} from "test/data/LenderRegistry.sol";
// import "contracts/utils/CalldataLib.sol";
// import {console} from "forge-std/console.sol";

// contract ForkTestArb is BaseTest {
//     IComposerLike oneDV2;

//     address admin = 0x492d53456Cc219A755Ac5a2d8598fFd6F47A9fD1;
//     address owner = 0x999999833d965c275A2C102a4Ebf222ca938546f;
//     address proxy = 0x05f3f58716a88A52493Be45aA0871c55b3748f18;

//     address mockSender = 0xbadA9c382165b31419F4CC0eDf0Fa84f80A3C8E5;
//     // address mockSender = 0xdFF70A71618739f4b8C81B11254BcE855D02496B;

//     uint256 internal constant forkBlock = 0;

//     function setUp() public virtual {
//         // initialize the chain
//         string memory chainName = Chains.ARBITRUM_ONE;

//         _init(chainName, forkBlock, true);

//         oneDV2 = ComposerPlugin.getComposer(chainName);

//         vm.prank(owner);
//         IA(admin).upgradeAndCall(proxy, address(oneDV2), hex"");

//         labelAddresses();
//     }

//     function labelAddresses() internal {
//         vm.label(owner, "owner");
//         vm.label(admin, "admin");
//         vm.label(proxy, "proxy");
//         vm.label(address(oneDV2), "Composer");
//         vm.label(mockSender, "MeMeMeMe");
//     }

//     // function test_fork_raw_arb_swap() external {
//     //     vm.prank(mockSender);
//     //     address(proxy).call{value: 0.0e18}(getData());
//     // }

//     function test_fork_raw_arb_perm() external {
//         address a;
//         bytes memory data;
//         (data, a) = getDataPrepPerm();
//         deal(a, mockSender, 3e18);
//         // prep
//         vm.prank(mockSender);
//         address(a).call{value: 0.0e18}(data);
//         (data, a) = getDataPrep();
//         vm.prank(mockSender);
//         address(a).call{value: 0.0e18}(data);

//         // txn
//         (data, a) = getDataPerm();
//         vm.prank(mockSender);
//         address(a).call{value: 0.0e18}(data);
//         (data, a) = getData();
//         vm.prank(mockSender);
//         address(a).call{value: 0.0e18}(data);
//     }
// }