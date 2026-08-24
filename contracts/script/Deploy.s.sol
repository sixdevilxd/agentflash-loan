// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {FlashExecutor} from "../src/FlashExecutor.sol";

/**
 * Deploy with an explicit admin/guardian split. Do NOT reuse the operator key.
 *
 *   forge script script/Deploy.s.sol:Deploy \\
 *     --rpc-url $RPC_URL --broadcast --verify
 */
contract Deploy is Script {
    function run() external returns (FlashExecutor exec) {
        address aave = vm.envAddress("AAVE_V3_POOL");
        address balancer = vm.envAddress("BALANCER_VAULT");
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address guardian = vm.envAddress("GUARDIAN_ADDRESS");

        require(admin != guardian, "admin and guardian must differ");

        vm.startBroadcast();
        exec = new FlashExecutor(aave, balancer, admin, guardian);
        vm.stopBroadcast();

        console.log("FlashExecutor:", address(exec));
        console.log("Next: setMaxLoan + setTarget for every router, then grant OPERATOR_ROLE.");
    }
}
