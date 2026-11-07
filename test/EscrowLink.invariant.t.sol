// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EscrowLink} from "../src/EscrowLink.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/**
 * @notice Handler that drives random escrow operations so the invariant
 *         fuzzer can explore the full state machine.
 */
contract EscrowHandler is Test {
    EscrowLink public escrow;
    MockUSDC public usdc;

    address public payer;
    address public payee;
    address public arbiter;

    uint256[] public ids;

    constructor(EscrowLink escrow_, MockUSDC usdc_, address payer_, address payee_, address arbiter_) {
        escrow = escrow_;
        usdc = usdc_;
        payer = payer_;
        payee = payee_;
        arbiter = arbiter_;
    }

    function createAndMaybeFund(uint256 amount, uint256 deadlineOffset) external {
        amount = bound(amount, 1, 1_000_000_000);
        deadlineOffset = bound(deadlineOffset, 11 minutes, 365 days);

        usdc.mint(payer, amount);
        vm.startPrank(payer);
        uint256 id = escrow.createEscrow(payee, amount, block.timestamp + deadlineOffset, "invariant", arbiter);
        // fund ~50% of the time based on block entropy
        if (block.number % 2 == 0) {
            escrow.fund(id);
        }
        vm.stopPrank();
        ids.push(id);
    }

    function confirm(uint256 index) external {
        if (ids.length == 0) return;
        index = bound(index, 0, ids.length - 1);
        uint256 id = ids[index];
        vm.prank(payer);
        try escrow.confirm(id) {} catch {}
    }

    function openDispute(uint256 index) external {
        if (ids.length == 0) return;
        index = bound(index, 0, ids.length - 1);
        uint256 id = ids[index];
        vm.prank(payer);
        try escrow.openDispute(id) {} catch {}
    }

    function resolveDispute(uint256 index, uint16 payeeBps) external {
        if (ids.length == 0) return;
        index = bound(index, 0, ids.length - 1);
        payeeBps = uint16(bound(payeeBps, 0, 10_000));
        vm.prank(arbiter);
        try escrow.resolveDispute(ids[index], payeeBps) {} catch {}
    }

    function claimTimeout(uint256 index) external {
        if (ids.length == 0) return;
        index = bound(index, 0, ids.length - 1);
        // jump past deadline + grace so the path is reachable (never backwards)
        EscrowLink.Escrow memory e = escrow.getEscrow(ids[index]);
        uint256 readyAt = e.deadline + escrow.TIMEOUT_GRACE() + 1;
        if (readyAt > block.timestamp) vm.warp(readyAt);
        vm.prank(payer);
        try escrow.claimTimeout(ids[index]) {} catch {}
    }

    /// @notice Pull any share that a settlement had to credit instead of push.
    function withdrawPending(uint256 which) external {
        address to = payer;
        if (which % 3 == 1) to = payee;
        else if (which % 3 == 2) to = arbiter;
        // Round-trip the credit to a fresh clean address: the point of the
        // rescue path is that a credit is always movable.
        address clean = address(uint160(uint256(keccak256(abi.encode(which, block.number))) | 1));
        vm.prank(to);
        try escrow.withdrawPending(clean) {} catch {}
    }

    function cancel(uint256 index) external {
        if (ids.length == 0) return;
        index = bound(index, 0, ids.length - 1);
        vm.prank(payer);
        try escrow.cancel(ids[index]) {} catch {}
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }
}

contract EscrowLinkInvariantTest is StdInvariant, Test {
    EscrowLink internal escrow;
    MockUSDC internal usdc;
    EscrowHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal payer = makeAddr("payer");
    address internal payee = makeAddr("payee");
    address internal arbiter = makeAddr("arbiter");

    function setUp() public {
        usdc = new MockUSDC();
        escrow = new EscrowLink(IERC20(address(usdc)), treasury, 50, owner);
        handler = new EscrowHandler(escrow, usdc, payer, payee, arbiter);
        targetContract(address(handler));
    }

    /// @notice The contract's USDC balance always equals the sum of all
    ///         still-locked principal plus accrued (unwithdrawn) fees plus
    ///         every share that had to be credited instead of pushed.
    ///         No path may mint or burn user money.
    function invariant_BalanceEqualsLiabilities() public view {
        uint256 lockedPrincipal = 0;
        uint256 count = escrow.escrowCount();
        for (uint256 i = 1; i <= count; i++) {
            EscrowLink.Escrow memory e = escrow.getEscrow(i);
            if (e.state == EscrowLink.State.Funded || e.state == EscrowLink.State.Disputed) {
                lockedPrincipal += e.amount;
            }
        }
        uint256 credited =
            escrow.pendingWithdrawals(payer) + escrow.pendingWithdrawals(payee) + escrow.pendingWithdrawals(arbiter);
        assertEq(
            usdc.balanceOf(address(escrow)),
            lockedPrincipal + escrow.accruedFees() + credited,
            "contract balance must equal locked principal + accrued fees + pending credits"
        );
    }

    /// @notice Fee accounting never exceeds what was actually collected.
    function invariant_AccruedFeesNeverExceedBalance() public view {
        assertLe(escrow.accruedFees(), usdc.balanceOf(address(escrow)), "accrued fees backed by balance");
    }

    /// @notice The fee global can never exceed the hard cap.
    function invariant_FeeCapEnforced() public view {
        assertLe(escrow.feeBps(), escrow.MAX_FEE_BPS(), "fee never above hard cap");
    }
}
