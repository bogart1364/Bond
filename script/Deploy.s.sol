// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EscrowLink} from "../src/EscrowLink.sol";

/**
 * @title Deploy — Bond EscrowLink
 *
 * Usage:
 *   # Base Sepolia (testnet first, always)
 *   export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
 *   export ETHERSCAN_API_KEY=...
 *   forge script script/Deploy.s.sol \
 *     --rpc-url $BASE_SEPOLIA_RPC_URL \
 *     --private-key $DEPLOYER_KEY \
 *     --broadcast --verify
 *
 *   # Base Mainnet (after testnet sign-off)
 *   forge script script/Deploy.s.sol \
 *     --rpc-url $BASE_RPC_URL \
 *     --private-key $DEPLOYER_KEY \
 *     --broadcast --verify
 *
 * Env overrides:
 *   USDC_ADDRESS    — defaults to the canonical USDC for the target chain
 *   TREASURY_ADDRESS— defaults to the deployer
 *   FEE_BPS         — defaults to 50 (0.5%)
 *   OWNER_ADDRESS   — defaults to the deployer (move to a multisig later!)
 */
contract Deploy is Script {
    // USDC: https://docs.base.org/get-started/connect-to-base
    address constant USDC_BASE_MAINNET = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant USDC_BASE_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    uint16 constant DEFAULT_FEE_BPS = 50; // 0.5%

    function run() external returns (EscrowLink escrow) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address usdc = vm.envOr("USDC_ADDRESS", _guessUsdc());
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);
        address owner = vm.envOr("OWNER_ADDRESS", deployer);
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(DEFAULT_FEE_BPS)));

        console.log("Deployer :", deployer);
        console.log("USDC     :", usdc);
        console.log("Treasury :", treasury);
        console.log("Owner    :", owner);
        console.log("Fee (bps):", feeBps);

        vm.startBroadcast(pk);
        escrow = new EscrowLink(IERC20(usdc), treasury, feeBps, owner);
        vm.stopBroadcast();

        console.log("EscrowLink deployed at:", address(escrow));
    }

    /// @dev Picks USDC by chain id so one script works on both networks.
    function _guessUsdc() private view returns (address) {
        uint256 chainId = block.chainid;
        if (chainId == 8453) return USDC_BASE_MAINNET; // Base Mainnet
        if (chainId == 84532) return USDC_BASE_SEPOLIA; // Base Sepolia
        revert("Set USDC_ADDRESS explicitly for this chain");
    }
}
