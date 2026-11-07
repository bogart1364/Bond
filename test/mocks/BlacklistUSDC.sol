// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice USDC stand-in with Circle's blacklist behaviour: a blocked address
 *         can neither send nor receive. This is the failure mode that used to
 *         wedge escrow settlement — one frozen counterparty broke every payout
 *         path that touched them.
 */
contract BlacklistUSDC is ERC20 {
    error Blacklisted(address account);

    mapping(address account => bool) public blacklisted;

    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlacklisted(address account, bool blocked) external {
        blacklisted[account] = blocked;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && blacklisted[from]) revert Blacklisted(from);
        if (to != address(0) && blacklisted[to]) revert Blacklisted(to);
        super._update(from, to, amount);
    }
}
