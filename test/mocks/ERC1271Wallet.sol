// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271Wallet} from "../../src/EscrowLink.sol";

/**
 * @notice A contract wallet: it signs the way an EOA does (one key) but
 *         answers {isValidSignature} instead of ever producing an `ecrecover`
 *         target. Proves the handshake accepts Safe-style wallets, not just
 *         externally owned accounts.
 */
contract ERC1271Wallet is IERC1271Wallet {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4 magicValue) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == owner) {
            return IERC1271Wallet.isValidSignature.selector;
        }
        return 0xffffffff;
    }
}
