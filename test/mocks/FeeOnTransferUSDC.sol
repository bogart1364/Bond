// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice Malicious/broken token that skims 1% on every transfer — used to
 *         prove the escrow refuses to accept under-collateralized funding.
 * @dev Overrides `_update` (OZ 5.x hook) because `transferFrom` calls it
 *      directly, so fee skimming is applied on every movement.
 */
contract FeeOnTransferUSDC is ERC20 {
    constructor() ERC20("Fee On Transfer USD", "fUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        bool isTransfer = from != address(0) && to != address(0);
        if (isTransfer && amount >= 100) {
            uint256 fee = amount / 100;
            super._update(from, address(0), fee); // burn the skim
            super._update(from, to, amount - fee);
            return;
        }
        super._update(from, to, amount);
    }
}
