// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice Token that attacks during settlement: while armed, `transfer` fires
 *         one stored call at the escrow in the middle of the payout, before
 *         the balance moves. The escrow must refuse it (CEI + nonReentrant)
 *         and still finish paying out correctly.
 * @dev Only `transfer` is hooked — `transferFrom` (the funding path) calls
 *      `_update` directly, so the attack starts exactly when money leaves.
 */
contract ReentrantUSDC is ERC20 {
    address public target;
    bytes public payload;
    bool public armed;
    bool public reentryReverted;
    bytes public reentryData;

    constructor() ERC20("Reentrant USD", "rUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @param target_ Contract to attack (the escrow).
    /// @param payload_ Calldata to run against it, e.g. `EscrowLink.confirm(id)`.
    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (armed) {
            armed = false;
            (bool ok, bytes memory data) = target.call(payload);
            reentryReverted = !ok;
            reentryData = data;
        }
        return super.transfer(to, value);
    }
}
