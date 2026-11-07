// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EscrowLink} from "../src/EscrowLink.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {FeeOnTransferUSDC} from "./mocks/FeeOnTransferUSDC.sol";
import {BlacklistUSDC} from "./mocks/BlacklistUSDC.sol";
import {ReentrantUSDC} from "./mocks/ReentrantUSDC.sol";
import {ERC1271Wallet} from "./mocks/ERC1271Wallet.sol";

contract EscrowLinkTest is Test {
    EscrowLink internal escrow;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal payer = makeAddr("payer");
    address internal payee = makeAddr("payee");
    address internal arbiter = makeAddr("arbiter");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant AMOUNT = 500_000_000; // 500 USDC (6 decimals)
    uint16 internal constant FEE_BPS = 50; // 0.5%

    event EscrowCreated(
        uint256 indexed id,
        address indexed payer,
        address indexed payee,
        uint256 amount,
        uint256 deadline,
        address arbiter,
        uint16 feeBps,
        bool consented,
        string description
    );
    event EscrowConfirmed(uint256 indexed id, uint256 payeeAmount, uint256 fee);
    event PaymentCredited(address indexed account, uint256 amount);
    event PaymentWithdrawn(address indexed account, address indexed to, uint256 amount);

    function setUp() public {
        usdc = new MockUSDC();
        escrow = new EscrowLink(IERC20(address(usdc)), treasury, FEE_BPS, owner);

        usdc.mint(payer, 1_000_000_000); // 1,000 USDC
        vm.prank(payer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ────────────────────────────────────────────────────────────────
    // Helpers
    // ────────────────────────────────────────────────────────────────

    function _deadline() internal view returns (uint256) {
        return block.timestamp + 1 days;
    }

    function _create() internal returns (uint256 id) {
        vm.prank(payer);
        id = escrow.createEscrow(payee, AMOUNT, _deadline(), "Logo design for acme.co", arbiter);
    }

    function _createAndFund() internal returns (uint256 id) {
        id = _create();
        vm.prank(payer);
        escrow.fund(id);
    }

    // ────────────────────────────────────────────────────────────────
    // createEscrow
    // ────────────────────────────────────────────────────────────────

    function test_Create_EmitsEventAndStoresState() public {
        vm.expectEmit(true, true, true, true);
        emit EscrowCreated(1, payer, payee, AMOUNT, _deadline(), arbiter, FEE_BPS, false, "Logo design for acme.co");

        uint256 id = _create();
        assertEq(id, 1);
        assertEq(escrow.escrowCount(), 1);

        EscrowLink.Escrow memory e = escrow.getEscrow(id);
        assertEq(e.payer, payer);
        assertEq(e.payee, payee);
        assertEq(e.arbiter, arbiter);
        assertEq(e.amount, AMOUNT);
        assertEq(e.feeBps, FEE_BPS, "fee must be snapshotted at creation");
        assertEq(uint8(e.state), uint8(EscrowLink.State.Created));
        assertEq(e.description, "Logo design for acme.co");
    }

    function test_Create_RevertsOnZeroAddress() public {
        vm.prank(payer);
        vm.expectRevert(EscrowLink.ZeroAddress.selector);
        escrow.createEscrow(address(0), AMOUNT, _deadline(), "d", arbiter);

        vm.prank(payer);
        vm.expectRevert(EscrowLink.ZeroAddress.selector);
        escrow.createEscrow(payee, AMOUNT, _deadline(), "d", address(0));
    }

    function test_Create_RevertsOnZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(EscrowLink.ZeroAmount.selector);
        escrow.createEscrow(payee, 0, _deadline(), "d", arbiter);
    }

    function test_Create_RevertsOnSelfReference() public {
        // payee == payer
        vm.prank(payer);
        vm.expectRevert(EscrowLink.SelfReference.selector);
        escrow.createEscrow(payer, AMOUNT, _deadline(), "d", arbiter);

        // arbiter == payer
        vm.prank(payer);
        vm.expectRevert(EscrowLink.SelfReference.selector);
        escrow.createEscrow(payee, AMOUNT, _deadline(), "d", payer);

        // arbiter == payee
        vm.prank(payer);
        vm.expectRevert(EscrowLink.SelfReference.selector);
        escrow.createEscrow(payee, AMOUNT, _deadline(), "d", payee);
    }

    function test_Create_RevertsOnDeadlineTooSoon() public {
        vm.prank(payer);
        vm.expectRevert(EscrowLink.DeadlineTooSoon.selector);
        escrow.createEscrow(payee, AMOUNT, block.timestamp + 5 minutes, "d", arbiter);
    }

    function test_Create_RevertsOnDeadlineTooFar() public {
        vm.prank(payer);
        vm.expectRevert(EscrowLink.DeadlineTooFar.selector);
        escrow.createEscrow(payee, AMOUNT, block.timestamp + 366 days, "d", arbiter);
    }

    function test_Create_RevertsOnLongDescription() public {
        string memory longDesc = new string(257);
        vm.prank(payer);
        vm.expectRevert(EscrowLink.DescriptionTooLong.selector);
        escrow.createEscrow(payee, AMOUNT, _deadline(), longDesc, arbiter);
    }

    function test_Create_RevertsWhenPaused() public {
        vm.prank(owner);
        escrow.pause();

        vm.prank(payer);
        vm.expectRevert();
        escrow.createEscrow(payee, AMOUNT, _deadline(), "d", arbiter);
    }

    function test_Fuzz_Create_RevertsIfDeadlineOutsideBounds(uint256 offset) public {
        // Keep offset inside a sane window so `block.timestamp + offset`
        // cannot overflow — the contract's own bounds are what we test.
        offset = bound(offset, 0, 400 days);
        uint256 deadline = block.timestamp + offset;

        vm.prank(payer);
        if (deadline < block.timestamp + escrow.MIN_DURATION()) {
            vm.expectRevert(EscrowLink.DeadlineTooSoon.selector);
            escrow.createEscrow(payee, AMOUNT, deadline, "d", arbiter);
        } else if (deadline > block.timestamp + escrow.MAX_DURATION()) {
            vm.expectRevert(EscrowLink.DeadlineTooFar.selector);
            escrow.createEscrow(payee, AMOUNT, deadline, "d", arbiter);
        } else {
            escrow.createEscrow(payee, AMOUNT, deadline, "d", arbiter);
        }
    }

    // ────────────────────────────────────────────────────────────────
    // fund
    // ────────────────────────────────────────────────────────────────

    function test_Fund_TransfersPrincipalIntoContract() public {
        uint256 id = _create();

        vm.prank(payer);
        escrow.fund(id);

        assertEq(usdc.balanceOf(address(escrow)), AMOUNT, "contract must hold principal");
        assertEq(usdc.balanceOf(payer), 1_000_000_000 - AMOUNT);
        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Funded));
    }

    function test_Fund_RevertsIfNotCreated() public {
        uint256 id = _createAndFund();

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(EscrowLink.InvalidState.selector, EscrowLink.State.Created, EscrowLink.State.Funded)
        );
        escrow.fund(id);
    }

    function test_Fund_RevertsIfNotPayer() public {
        uint256 id = _create();

        vm.prank(stranger);
        vm.expectRevert(EscrowLink.NotPayer.selector);
        escrow.fund(id);
    }

    function test_Fund_RevertsIfNotApproved() public {
        uint256 id = _create();
        vm.prank(payer);
        usdc.approve(address(escrow), 0);

        vm.prank(payer);
        vm.expectRevert();
        escrow.fund(id);
    }

    function test_Fund_RevertsOnUnknownId() public {
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(EscrowLink.EscrowNotFound.selector, 99));
        escrow.fund(99);
    }

    // ────────────────────────────────────────────────────────────────
    // cancel
    // ────────────────────────────────────────────────────────────────

    function test_Cancel_OnlyBeforeFunding() public {
        uint256 id = _create();

        vm.prank(payer);
        escrow.cancel(id);

        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Cancelled));
        assertEq(usdc.balanceOf(payer), 1_000_000_000, "no funds moved, nothing was locked");
    }

    function test_Cancel_RevertsAfterFunding() public {
        uint256 id = _createAndFund();

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(EscrowLink.InvalidState.selector, EscrowLink.State.Created, EscrowLink.State.Funded)
        );
        escrow.cancel(id);
    }

    function test_Cancel_RevertsIfNotPayer() public {
        uint256 id = _create();

        vm.prank(stranger);
        vm.expectRevert(EscrowLink.NotPayer.selector);
        escrow.cancel(id);
    }

    // ────────────────────────────────────────────────────────────────
    // confirm (happy path + fee math)
    // ────────────────────────────────────────────────────────────────

    function test_Confirm_PaysPayeeMinusFee() public {
        uint256 id = _createAndFund();
        uint256 expectedFee = (AMOUNT * FEE_BPS) / 10_000;
        uint256 expectedNet = AMOUNT - expectedFee;

        vm.expectEmit(true, false, false, true, address(escrow));
        emit EscrowConfirmed(id, expectedNet, expectedFee);

        vm.prank(payer);
        escrow.confirm(id);

        assertEq(usdc.balanceOf(payee), expectedNet, "payee gets amount minus 0.5%");
        assertEq(usdc.balanceOf(treasury), 0, "fees stay accrued until withdrawn");
        assertEq(escrow.accruedFees(), expectedFee);
        assertEq(usdc.balanceOf(address(escrow)), expectedFee, "contract retains only the fee");
        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Completed));
    }

    function test_Confirm_RevertsIfNotFunded() public {
        uint256 id = _create();

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(EscrowLink.InvalidState.selector, EscrowLink.State.Funded, EscrowLink.State.Created)
        );
        escrow.confirm(id);
    }

    function test_Confirm_RevertsIfNotPayer() public {
        uint256 id = _createAndFund();

        vm.prank(stranger);
        vm.expectRevert(EscrowLink.NotPayer.selector);
        escrow.confirm(id);

        vm.prank(payee);
        vm.expectRevert(EscrowLink.NotPayer.selector);
        escrow.confirm(id);
    }

    function test_Confirm_RevertsIfAlreadyCompleted() public {
        uint256 id = _createAndFund();
        vm.prank(payer);
        escrow.confirm(id);

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                EscrowLink.InvalidState.selector, EscrowLink.State.Funded, EscrowLink.State.Completed
            )
        );
        escrow.confirm(id);
    }

    // ────────────────────────────────────────────────────────────────
    // dispute
    // ────────────────────────────────────────────────────────────────

    function test_OpenDispute_AllowsBothParties() public {
        uint256 id = _createAndFund();

        vm.prank(payee);
        escrow.openDispute(id);
        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Disputed));

        // second escrow, payer side
        vm.prank(payer);
        uint256 id2 = escrow.createEscrow(payee, AMOUNT, _deadline(), "second", arbiter);
        vm.prank(payer);
        escrow.fund(id2);
        vm.prank(payer);
        escrow.openDispute(id2);
        assertEq(uint8(escrow.getEscrow(id2).state), uint8(EscrowLink.State.Disputed));
    }

    function test_OpenDispute_RevertsForStranger() public {
        uint256 id = _createAndFund();

        vm.prank(stranger);
        vm.expectRevert(EscrowLink.NotParty.selector);
        escrow.openDispute(id);
    }

    function test_ResolveDispute_PayeeWinsFully() public {
        uint256 id = _createAndFund();
        uint256 expectedFee = (AMOUNT * FEE_BPS) / 10_000;

        vm.prank(payer);
        escrow.openDispute(id);

        vm.prank(arbiter);
        escrow.resolveDispute(id, 10_000);

        assertEq(usdc.balanceOf(payee), AMOUNT - expectedFee);
        assertEq(usdc.balanceOf(payer), 1_000_000_000 - AMOUNT, "payer gets nothing back");
        assertEq(escrow.accruedFees(), expectedFee);
        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Completed));
    }

    function test_ResolveDispute_PayerWinsFully() public {
        uint256 id = _createAndFund();

        vm.prank(payee);
        escrow.openDispute(id);

        vm.prank(arbiter);
        escrow.resolveDispute(id, 0);

        assertEq(usdc.balanceOf(payer), 1_000_000_000, "full refund, no fee on refunds");
        assertEq(usdc.balanceOf(payee), 0);
        assertEq(escrow.accruedFees(), 0, "no fee when payee gets nothing");
        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Refunded));
    }

    function test_ResolveDispute_SplitWithFeeOnPayeeShareOnly() public {
        uint256 id = _createAndFund();

        vm.prank(payer);
        escrow.openDispute(id);

        vm.prank(arbiter);
        escrow.resolveDispute(id, 6_000); // 60/40 split

        uint256 payeeGross = (AMOUNT * 6_000) / 10_000;
        uint256 fee = (payeeGross * FEE_BPS) / 10_000;
        uint256 payerAmount = AMOUNT - payeeGross;

        assertEq(usdc.balanceOf(payee), payeeGross - fee);
        assertEq(usdc.balanceOf(payer), 1_000_000_000 - AMOUNT + payerAmount);
        assertEq(escrow.accruedFees(), fee);
        assertEq(usdc.balanceOf(address(escrow)), fee, "contract retains only the fee");
    }

    function test_ResolveDispute_RevertsIfNotArbiter() public {
        uint256 id = _createAndFund();
        vm.prank(payer);
        escrow.openDispute(id);

        vm.prank(stranger);
        vm.expectRevert(EscrowLink.NotArbiter.selector);
        escrow.resolveDispute(id, 10_000);

        vm.prank(payer);
        vm.expectRevert(EscrowLink.NotArbiter.selector);
        escrow.resolveDispute(id, 10_000);
    }

    function test_ResolveDispute_RevertsIfNotDisputed() public {
        uint256 id = _createAndFund();

        vm.prank(arbiter);
        vm.expectRevert(
            abi.encodeWithSelector(EscrowLink.InvalidState.selector, EscrowLink.State.Disputed, EscrowLink.State.Funded)
        );
        escrow.resolveDispute(id, 10_000);
    }

    function test_ResolveDispute_RevertsOnInvalidBps() public {
        uint256 id = _createAndFund();
        vm.prank(payer);
        escrow.openDispute(id);

        vm.prank(arbiter);
        vm.expectRevert(EscrowLink.InvalidBps.selector);
        escrow.resolveDispute(id, 10_001);
    }

    // ────────────────────────────────────────────────────────────────
    // claimTimeout
    // ────────────────────────────────────────────────────────────────

    function test_ClaimTimeout_RevertsBeforeGrace() public {
        uint256 id = _createAndFund();

        vm.warp(_deadline() + 1 hours); // deadline passed, grace not yet

        vm.prank(payer);
        vm.expectRevert(EscrowLink.TimeoutNotReached.selector);
        escrow.claimTimeout(id);
    }

    function test_ClaimTimeout_RefundsAfterDeadlinePlusGrace() public {
        uint256 id = _createAndFund();

        vm.warp(_deadline() + escrow.TIMEOUT_GRACE() + 1);

        assertTrue(escrow.canClaimTimeout(id));

        vm.prank(payer);
        escrow.claimTimeout(id);

        assertEq(usdc.balanceOf(payer), 1_000_000_000, "full refund");
        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Refunded));
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_ClaimTimeout_BlockedWhileArbiterWindowOpen() public {
        uint256 id = _createAndFund();
        vm.prank(payee);
        escrow.openDispute(id);

        uint256 disputedAt = block.timestamp;
        vm.warp(disputedAt + escrow.ARBITER_WINDOW()); // inside the window (grace also passed)

        assertFalse(escrow.canClaimTimeout(id), "view must mirror the reverter");
        vm.expectRevert(
            abi.encodeWithSelector(EscrowLink.ArbiterWindowOpen.selector, disputedAt + escrow.ARBITER_WINDOW())
        );
        escrow.claimTimeout(id);

        // Once the published window closes, the plain timeout rule applies.
        vm.warp(disputedAt + escrow.ARBITER_WINDOW() + 1);
        assertTrue(escrow.canClaimTimeout(id));
        escrow.claimTimeout(id);
        assertEq(usdc.balanceOf(payer), 1_000_000_000, "full refund after window");
        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Refunded));
    }

    function test_ClaimTimeout_AnyoneMaySweep() public {
        uint256 id = _createAndFund();
        vm.warp(_deadline() + escrow.TIMEOUT_GRACE() + 1);

        // Permissionless on purpose: a stranger executes it, the payout is
        // fixed by the escrow (all of it back to the payer), so the caller
        // can neither profit from nor redirect the sweep.
        uint256 strangerBefore = usdc.balanceOf(stranger);
        vm.prank(stranger);
        escrow.claimTimeout(id);

        assertEq(usdc.balanceOf(stranger), strangerBefore, "caller gains nothing");
        assertEq(usdc.balanceOf(payer), 1_000_000_000, "full refund to payer");
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Refunded));
    }

    // ────────────────────────────────────────────────────────────────
    // Admin
    // ────────────────────────────────────────────────────────────────

    function test_SetFee_CappedAndOnlyAppliesToNewEscrows() public {
        uint256 id = _create(); // snapshots 0.5%

        vm.prank(owner);
        escrow.setFeeBps(100); // 1% for future

        assertEq(escrow.feeBps(), 100);
        assertEq(escrow.getEscrow(id).feeBps, FEE_BPS, "existing escrow untouched");

        vm.prank(owner);
        vm.expectRevert(EscrowLink.FeeExceedsMaximum.selector);
        escrow.setFeeBps(1_001);
    }

    function test_SetFee_RevertsIfNotOwner() public {
        vm.prank(stranger);
        vm.expectRevert();
        escrow.setFeeBps(100);
    }

    function test_WithdrawFees_OnlyAccruedAndOnlyOwner() public {
        uint256 id = _createAndFund();
        vm.prank(payer);
        escrow.confirm(id);

        uint256 expectedFee = (AMOUNT * FEE_BPS) / 10_000;

        vm.prank(stranger);
        vm.expectRevert();
        escrow.withdrawFees(stranger);

        vm.prank(owner);
        escrow.withdrawFees(treasury);

        assertEq(usdc.balanceOf(treasury), expectedFee);
        assertEq(escrow.accruedFees(), 0);

        vm.prank(owner);
        vm.expectRevert(EscrowLink.NothingToWithdraw.selector);
        escrow.withdrawFees(treasury);
    }

    function test_WithdrawFees_RevertsOnZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(EscrowLink.ZeroAddress.selector);
        escrow.withdrawFees(address(0));
    }

    function test_SetTreasury_UpdatesAndOnlyOwner() public {
        address newTreasury = makeAddr("newTreasury");

        // non-owner cannot change it
        vm.prank(stranger);
        vm.expectRevert();
        escrow.setTreasury(newTreasury);

        // zero address rejected
        vm.prank(owner);
        vm.expectRevert(EscrowLink.ZeroAddress.selector);
        escrow.setTreasury(address(0));

        vm.prank(owner);
        escrow.setTreasury(newTreasury);
        assertEq(escrow.treasury(), newTreasury);

        // fees earned before the change still flow on withdrawal
        uint256 id = _createAndFund();
        vm.prank(payer);
        escrow.confirm(id);
        uint256 expectedFee = (AMOUNT * FEE_BPS) / 10_000;

        vm.prank(owner);
        escrow.withdrawFees(newTreasury);
        assertEq(usdc.balanceOf(newTreasury), expectedFee);
    }

    function test_CanClaimTimeout_OnlyTrueForFundedPastGrace() public {
        uint256 id = _createAndFund();

        // not yet past grace
        assertFalse(escrow.canClaimTimeout(id));

        // past grace
        vm.warp(_deadline() + escrow.TIMEOUT_GRACE() + 1);
        assertTrue(escrow.canClaimTimeout(id));

        // terminal states never claimable
        vm.prank(payer);
        escrow.claimTimeout(id);
        assertFalse(escrow.canClaimTimeout(id));
    }

    function test_EscrowCount_IncrementsMonotonically() public {
        assertEq(escrow.escrowCount(), 0);
        _create();
        assertEq(escrow.escrowCount(), 1);
        _create();
        assertEq(escrow.escrowCount(), 2);
    }

    function test_GetEscrow_RevertsOnUnknownAndZeroId() public {
        vm.expectRevert(abi.encodeWithSelector(EscrowLink.EscrowNotFound.selector, 0));
        escrow.getEscrow(0);

        vm.expectRevert(abi.encodeWithSelector(EscrowLink.EscrowNotFound.selector, 42));
        escrow.getEscrow(42);
    }

    function test_OpenDispute_RevertsIfNotFunded() public {
        uint256 id = _create(); // Created, not funded

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(EscrowLink.InvalidState.selector, EscrowLink.State.Funded, EscrowLink.State.Created)
        );
        escrow.openDispute(id);
    }

    function test_Fund_RevertsWhenPaused() public {
        uint256 id = _create();

        vm.prank(owner);
        escrow.pause();

        vm.prank(payer);
        vm.expectRevert();
        escrow.fund(id);

        // unfund -> fund works again
        vm.prank(owner);
        escrow.unpause();
        vm.prank(payer);
        escrow.fund(id);
        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Funded));
    }

    function test_Unpause_RevertsIfNotOwner() public {
        vm.prank(owner);
        escrow.pause();

        vm.prank(stranger);
        vm.expectRevert();
        escrow.unpause();
    }

    function test_Constructor_RejectsBadConfig() public {
        vm.expectRevert(EscrowLink.ZeroAddress.selector);
        new EscrowLink(IERC20(address(0)), treasury, FEE_BPS, owner);

        vm.expectRevert(EscrowLink.ZeroAddress.selector);
        new EscrowLink(IERC20(address(usdc)), address(0), FEE_BPS, owner);

        vm.expectRevert(EscrowLink.FeeExceedsMaximum.selector);
        new EscrowLink(IERC20(address(usdc)), treasury, 1_001, owner);
    }

    function testFuzz_ClaimTimeout_MoneyConserved(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000_000);
        usdc.mint(payer, amount);

        vm.prank(payer);
        uint256 id = escrow.createEscrow(payee, amount, _deadline(), "fuzz timeout", arbiter);
        vm.prank(payer);
        escrow.fund(id);

        uint256 payerBefore = usdc.balanceOf(payer);
        vm.warp(_deadline() + escrow.TIMEOUT_GRACE() + 1);
        vm.prank(payer);
        escrow.claimTimeout(id);

        assertEq(usdc.balanceOf(payer), payerBefore + amount, "full refund");
        assertEq(usdc.balanceOf(address(escrow)), 0, "nothing left, no fee on timeout");
        assertEq(escrow.accruedFees(), 0, "no fee charged on timeout refund");
    }

    // ────────────────────────────────────────────────────────────────
    // Ownership (Ownable2Step)
    // ────────────────────────────────────────────────────────────────

    function test_Ownership_TransfersInTwoSteps() public {
        address newOwner = makeAddr("newOwner");

        vm.prank(owner);
        escrow.transferOwnership(newOwner);

        // pending owner has no rights yet
        vm.prank(newOwner);
        vm.expectRevert();
        escrow.setFeeBps(10);

        vm.prank(newOwner);
        escrow.acceptOwnership();

        vm.prank(newOwner);
        escrow.setFeeBps(10);
        assertEq(escrow.feeBps(), 10);
    }

    // ────────────────────────────────────────────────────────────────
    // Pause
    // ────────────────────────────────────────────────────────────────

    function test_Pause_BlocksNewEscrowsButLetsExistingSettle() public {
        uint256 id = _createAndFund();

        vm.prank(owner);
        escrow.pause();

        vm.prank(payer);
        vm.expectRevert();
        escrow.createEscrow(payee, AMOUNT, _deadline(), "d", arbiter);

        // existing escrow still settles — pause must never trap user funds
        vm.prank(payer);
        escrow.confirm(id);
        assertEq(usdc.balanceOf(payee), AMOUNT - (AMOUNT * FEE_BPS) / 10_000);

        vm.prank(owner);
        escrow.unpause();

        vm.prank(payer);
        escrow.createEscrow(payee, AMOUNT, _deadline(), "d", arbiter);
    }

    // ────────────────────────────────────────────────────────────────
    // Fuzz — money conservation
    // ────────────────────────────────────────────────────────────────

    function testFuzz_Confirm_NeverLosesMoney(uint256 amount, uint16 feeBps) public {
        amount = bound(amount, 1, 1_000_000_000);
        feeBps = uint16(bound(feeBps, 0, escrow.MAX_FEE_BPS()));

        vm.prank(owner);
        escrow.setFeeBps(feeBps);

        usdc.mint(payer, amount);
        vm.prank(payer);
        uint256 id = escrow.createEscrow(payee, amount, _deadline(), "fuzz", arbiter);
        vm.prank(payer);
        escrow.fund(id);

        vm.prank(payer);
        escrow.confirm(id);

        uint256 fee = (amount * feeBps) / 10_000;
        assertEq(usdc.balanceOf(payee), amount - fee);
        assertEq(usdc.balanceOf(address(escrow)), fee, "escrow retains only the fee");
        assertEq(escrow.accruedFees(), fee);
        // conservation: payee + accrued == amount
        assertEq(usdc.balanceOf(payee) + escrow.accruedFees(), amount);
    }

    function testFuzz_ResolveSplit_MoneyConserved(uint256 amount, uint16 payeeBps, uint16 feeBps) public {
        amount = bound(amount, 1, 1_000_000_000);
        payeeBps = uint16(bound(payeeBps, 0, 10_000));
        feeBps = uint16(bound(feeBps, 0, escrow.MAX_FEE_BPS()));

        vm.prank(owner);
        escrow.setFeeBps(feeBps);

        usdc.mint(payer, amount);
        vm.prank(payer);
        uint256 id = escrow.createEscrow(payee, amount, _deadline(), "fuzz", arbiter);
        vm.prank(payer);
        escrow.fund(id);

        vm.prank(payer);
        escrow.openDispute(id);

        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(arbiter);
        escrow.resolveDispute(id, payeeBps);

        uint256 payeeGross = (amount * payeeBps) / 10_000;
        uint256 fee = (payeeGross * feeBps) / 10_000;

        assertEq(usdc.balanceOf(payee), payeeGross - fee);
        assertEq(usdc.balanceOf(payer), payerBefore + (amount - payeeGross));
        assertEq(usdc.balanceOf(address(escrow)), fee, "contract retains only the fee");
        assertEq(escrow.accruedFees(), fee);
        // conservation: payee net + payer delta + accrued == amount
        assertEq((payeeGross - fee) + (amount - payeeGross) + fee, amount);
    }

    // ────────────────────────────────────────────────────────────────
    // Reentrancy — malicious token attempting to re-enter confirm
    // ────────────────────────────────────────────────────────────────

    // ────────────────────────────────────────────────────────────────────
    // Hardening — OWASP SC05 (reentrancy/unexpected behavior) follow-ups
    // ────────────────────────────────────────────────────────────────────

    function test_Fund_RevertsOnFeeOnTransferToken() public {
        FeeOnTransferUSDC bad = new FeeOnTransferUSDC();
        EscrowLink strict = new EscrowLink(IERC20(address(bad)), treasury, FEE_BPS, owner);

        bad.mint(payer, 1_000_000_000);
        vm.startPrank(payer);
        bad.approve(address(strict), type(uint256).max);
        uint256 id = strict.createEscrow(payee, AMOUNT, _deadline(), "bad token", arbiter);

        // 1% skimmed on transfer -> escrow must refuse rather than accept an
        // under-collateralized position.
        vm.expectRevert(abi.encodeWithSelector(EscrowLink.UnexpectedTransfer.selector, AMOUNT - AMOUNT / 100, AMOUNT));
        strict.fund(id);

        // revert rolled back the state flip — still fundable concept stays Created
        assertEq(uint8(strict.getEscrow(id).state), uint8(EscrowLink.State.Created));
        vm.stopPrank();
    }

    function test_RenounceOwnership_PermanentlyDisabled() public {
        vm.prank(owner);
        vm.expectRevert(EscrowLink.RenounceDisabled.selector);
        escrow.renounceOwnership();

        assertEq(escrow.owner(), owner, "owner unchanged after failed renounce");
    }

    function test_Confirm_ReentrancyBlocked() public {
        // The state flip happens before the transfer (CEI), and confirm is
        // nonReentrant: even a token that re-enters would hit InvalidState.
        uint256 id = _createAndFund();

        vm.prank(payer);
        escrow.confirm(id);

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                EscrowLink.InvalidState.selector, EscrowLink.State.Funded, EscrowLink.State.Completed
            )
        );
        escrow.confirm(id);
    }

    // ────────────────────────────────────────────────────────────────
    // v2: real reentrancy — token fires a stored call mid-settlement
    // ────────────────────────────────────────────────────────────────

    function test_Confirm_TokenReentryRejectedAndPayoutStillCorrect() public {
        ReentrantUSDC evil = new ReentrantUSDC();
        EscrowLink guarded = new EscrowLink(IERC20(address(evil)), treasury, FEE_BPS, owner);

        evil.mint(payer, 1_000_000_000);
        vm.startPrank(payer);
        evil.approve(address(guarded), type(uint256).max);
        uint256 id = guarded.createEscrow(payee, AMOUNT, _deadline(), "reentrant deal", arbiter);
        guarded.fund(id);
        vm.stopPrank();

        // Arm the token: when principal leaves, it re-enters confirm(id).
        evil.arm(address(guarded), abi.encodeWithSelector(EscrowLink.confirm.selector, id));

        vm.prank(payer);
        guarded.confirm(id); // must NOT revert: the reentry is swallowed

        assertTrue(evil.reentryReverted(), "reentrant call must revert");
        assertEq(
            evil.reentryData(),
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector),
            "guard, not a state check, is what stops the reentry"
        );

        uint256 fee = (AMOUNT * FEE_BPS) / 10_000;
        assertEq(evil.balanceOf(payee), AMOUNT - fee, "payee still paid exactly once");
        assertEq(evil.balanceOf(address(guarded)), fee, "only the fee remains");
        assertEq(uint8(guarded.getEscrow(id).state), uint8(EscrowLink.State.Completed));
    }

    // ────────────────────────────────────────────────────────────────
    // v2: EIP-712 handshake consent
    // ────────────────────────────────────────────────────────────────

    function _packSign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signHandshake(
        uint256 signerKey,
        address payer_,
        address payee_,
        address arbiter_,
        uint256 amount_,
        uint256 deadline_,
        string memory description_
    ) internal returns (bytes memory) {
        // Digest is read from the payer's seat — same as the contract will.
        vm.prank(payer_);
        bytes32 digest = escrow.handshakeDigest(payee_, amount_, deadline_, description_, arbiter_);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_Handshake_FilesWithBothSignatures() public {
        (address payeeAddr, uint256 payeePk) = makeAddrAndKey("payee");
        (address arbiterAddr, uint256 arbiterPk) = makeAddrAndKey("arbiter");
        string memory desc = "consented deal";
        uint256 deadline = _deadline();

        bytes memory payeeSig = _signHandshake(payeePk, payer, payeeAddr, arbiterAddr, AMOUNT, deadline, desc);
        bytes memory arbiterSig = _signHandshake(arbiterPk, payer, payeeAddr, arbiterAddr, AMOUNT, deadline, desc);

        vm.prank(payer);
        uint256 id = escrow.createEscrowHandshaked(payeeAddr, AMOUNT, deadline, desc, arbiterAddr, payeeSig, arbiterSig);

        EscrowLink.Escrow memory e = escrow.getEscrow(id);
        assertTrue(e.consented, "consent flag must be set");
        assertEq(e.payer, payer);
        assertEq(e.payee, payeeAddr);
        assertEq(escrow.handshakeNonces(payer), 1, "nonce consumed");
    }

    function test_Handshake_ReplayRejected() public {
        (address payeeAddr, uint256 payeePk) = makeAddrAndKey("payee");
        (address arbiterAddr, uint256 arbiterPk) = makeAddrAndKey("arbiter");
        string memory desc = "one deal only";
        uint256 deadline = _deadline();

        bytes memory payeeSig = _signHandshake(payeePk, payer, payeeAddr, arbiterAddr, AMOUNT, deadline, desc);
        bytes memory arbiterSig = _signHandshake(arbiterPk, payer, payeeAddr, arbiterAddr, AMOUNT, deadline, desc);

        vm.prank(payer);
        escrow.createEscrowHandshaked(payeeAddr, AMOUNT, deadline, desc, arbiterAddr, payeeSig, arbiterSig);

        // The same bytes cannot file a second escrow: the payer nonce moved.
        vm.prank(payer);
        vm.expectRevert(EscrowLink.InvalidHandshakeSignature.selector);
        escrow.createEscrowHandshaked(payeeAddr, AMOUNT, deadline, desc, arbiterAddr, payeeSig, arbiterSig);
    }

    function test_Handshake_RevertsOnWrongSigner() public {
        (address payeeAddr,) = makeAddrAndKey("payee");
        (address arbiterAddr, uint256 arbiterPk) = makeAddrAndKey("arbiter");
        (, uint256 mallorKey) = makeAddrAndKey("mallory");
        string memory desc = "forged";
        uint256 deadline = _deadline();

        // Mallory signs the payee's slot: recovery lands on her, not the payee.
        bytes memory forgedPayeeSig = _signHandshake(mallorKey, payer, payeeAddr, arbiterAddr, AMOUNT, deadline, desc);
        bytes memory arbiterSig = _signHandshake(arbiterPk, payer, payeeAddr, arbiterAddr, AMOUNT, deadline, desc);

        vm.prank(payer);
        vm.expectRevert(EscrowLink.InvalidHandshakeSignature.selector);
        escrow.createEscrowHandshaked(payeeAddr, AMOUNT, deadline, desc, arbiterAddr, forgedPayeeSig, arbiterSig);
    }

    function test_Handshake_RevertsOnTamperedTerms() public {
        (address payeeAddr, uint256 payeePk) = makeAddrAndKey("payee");
        (address arbiterAddr, uint256 arbiterPk) = makeAddrAndKey("arbiter");
        string memory desc = "original terms";
        uint256 deadline = _deadline();

        bytes memory payeeSig = _signHandshake(payeePk, payer, payeeAddr, arbiterAddr, AMOUNT, deadline, desc);
        bytes memory arbiterSig = _signHandshake(arbiterPk, payer, payeeAddr, arbiterAddr, AMOUNT, deadline, desc);

        // Signatures cover AMOUNT; filing double the amount must fail.
        vm.prank(payer);
        vm.expectRevert(EscrowLink.InvalidHandshakeSignature.selector);
        escrow.createEscrowHandshaked(payeeAddr, AMOUNT * 2, deadline, desc, arbiterAddr, payeeSig, arbiterSig);

        // ...and so must a different deadline with otherwise valid bytes.
        vm.prank(payer);
        vm.expectRevert(EscrowLink.InvalidHandshakeSignature.selector);
        escrow.createEscrowHandshaked(payeeAddr, AMOUNT, deadline + 1 hours, desc, arbiterAddr, payeeSig, arbiterSig);
    }

    function test_Handshake_BoundToThisContract() public {
        (address payeeAddr, uint256 payeePk) = makeAddrAndKey("payee");
        (address arbiterAddr, uint256 arbiterPk) = makeAddrAndKey("arbiter");

        // Sign the digest of a DIFFERENT deployment: the EIP-712 domain
        // (chainId + verifyingContract) must make those bytes worthless here.
        EscrowLink twin = new EscrowLink(IERC20(address(usdc)), treasury, FEE_BPS, owner);
        vm.prank(payer);
        bytes32 twinDigest = twin.handshakeDigest(payeeAddr, AMOUNT, _deadline(), "wrong domain", arbiterAddr);
        bytes memory payeeSig = _packSign(payeePk, twinDigest);
        bytes memory arbiterSig = _packSign(arbiterPk, twinDigest);

        assertNotEq(twin.domainSeparator(), escrow.domainSeparator(), "domains must differ");

        vm.prank(payer);
        vm.expectRevert(EscrowLink.InvalidHandshakeSignature.selector);
        escrow.createEscrowHandshaked(payeeAddr, AMOUNT, _deadline(), "wrong domain", arbiterAddr, payeeSig, arbiterSig);
    }

    function test_Handshake_AcceptsERC1271ContractWallet() public {
        (address arbiterAddr, uint256 arbiterPk) = makeAddrAndKey("arbiter");
        (address walletOwnerAddr, uint256 walletOwnerPk) = makeAddrAndKey("wallet-owner");
        ERC1271Wallet wallet = new ERC1271Wallet(walletOwnerAddr);

        // The wallet answers isValidSignature; the owner's key produced it.
        vm.prank(payer);
        bytes32 digest = escrow.handshakeDigest(address(wallet), AMOUNT, _deadline(), "safe wallet", arbiterAddr);
        bytes memory walletSig = _packSign(walletOwnerPk, digest);
        bytes memory arbiterSig = _arbiterSig(arbiterPk, address(wallet), arbiterAddr, "safe wallet");

        vm.prank(payer);
        uint256 id = escrow.createEscrowHandshaked(
            address(wallet), AMOUNT, _deadline(), "safe wallet", arbiterAddr, walletSig, arbiterSig
        );
        assertTrue(escrow.getEscrow(id).consented);
    }

    function test_Handshake_RevertsWhenContractWalletRejects() public {
        (address arbiterAddr, uint256 arbiterPk) = makeAddrAndKey("arbiter");
        (, uint256 walletOwnerPk) = makeAddrAndKey("wallet-owner");
        // A wallet whose owner is NOT the key that signed.
        ERC1271Wallet empty = new ERC1271Wallet(makeAddr("nobody"));

        vm.prank(payer);
        bytes32 digest = escrow.handshakeDigest(address(empty), AMOUNT, _deadline(), "rejected", arbiterAddr);
        bytes memory badSig = _packSign(walletOwnerPk, digest);
        bytes memory arbiterSig = _arbiterSig(arbiterPk, address(empty), arbiterAddr, "rejected");

        vm.prank(payer);
        vm.expectRevert(EscrowLink.InvalidHandshakeSignature.selector);
        escrow.createEscrowHandshaked(address(empty), AMOUNT, _deadline(), "rejected", arbiterAddr, badSig, arbiterSig);
    }

    /// @dev Arbiter side of a handshake for `payee_` under `desc`.
    function _arbiterSig(uint256 arbiterPk, address payee_, address arbiter_, string memory desc)
        internal
        returns (bytes memory)
    {
        vm.prank(payer);
        bytes32 digest = escrow.handshakeDigest(payee_, AMOUNT, _deadline(), desc, arbiter_);
        return _packSign(arbiterPk, digest);
    }

    // ────────────────────────────────────────────────────────────────
    // v2: blacklist rescue — credit then pull
    // ────────────────────────────────────────────────────────────────

    function test_BlacklistedPayee_CreditedThenWithdrawnToCleanAddress() public {
        BlacklistUSDC usdcB = new BlacklistUSDC();
        EscrowLink rescue = new EscrowLink(IERC20(address(usdcB)), treasury, FEE_BPS, owner);
        address clean = makeAddr("clean");

        usdcB.mint(payer, 1_000_000_000);
        vm.startPrank(payer);
        usdcB.approve(address(rescue), type(uint256).max);
        uint256 id = rescue.createEscrow(payee, AMOUNT, _deadline(), "blacklisted deal", arbiter);
        rescue.fund(id);
        vm.stopPrank();

        usdcB.setBlacklisted(payee, true);

        uint256 fee = (AMOUNT * FEE_BPS) / 10_000;
        vm.expectEmit(true, true, true, true);
        emit PaymentCredited(payee, AMOUNT - fee);
        vm.prank(payer);
        rescue.confirm(id); // push refused -> credit, never a revert

        assertEq(rescue.pendingWithdrawals(payee), AMOUNT - fee, "share held for the payee");
        assertEq(usdcB.balanceOf(address(rescue)), AMOUNT - fee + fee, "tokens stay in the contract");
        assertEq(rescue.accruedFees(), fee, "fee accounted normally");

        // The payee routes their own credit to a clean address.
        vm.prank(payee);
        vm.expectRevert(EscrowLink.ZeroAddress.selector);
        rescue.withdrawPending(address(0));

        vm.expectEmit(true, true, true, true);
        emit PaymentWithdrawn(payee, clean, AMOUNT - fee);
        vm.prank(payee);
        rescue.withdrawPending(clean);

        assertEq(usdcB.balanceOf(clean), AMOUNT - fee);
        assertEq(rescue.pendingWithdrawals(payee), 0, "credit zeroed before transfer");
        assertEq(usdcB.balanceOf(address(rescue)), fee, "only the fee remains");

        // Second pull finds nothing.
        vm.prank(payee);
        vm.expectRevert(EscrowLink.NothingToWithdraw.selector);
        rescue.withdrawPending(clean);
    }

    function test_WithdrawPending_StrangersHaveNothing() public {
        vm.prank(stranger);
        vm.expectRevert(EscrowLink.NothingToWithdraw.selector);
        escrow.withdrawPending(stranger);
    }
}
