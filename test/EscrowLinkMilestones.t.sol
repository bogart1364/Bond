// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EscrowLink} from "../src/EscrowLink.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {ERC1271Wallet} from "./mocks/ERC1271Wallet.sol";

/**
 * @notice v3: milestone escrows, evidence anchoring, gasless (EIP-712)
 *         release. The v2 suite (EscrowLink.t.sol) must stay green against
 *         this contract unchanged — plain escrows reduce exactly to v2, and
 *         these tests prove the milestone paths on top of that base.
 */
contract EscrowLinkMilestonesTest is Test {
    EscrowLink internal escrow;
    MockUSDC internal usdc;

    // A payer with a known key — the gasless release tests sign as the payer.
    uint256 internal constant PAYER_KEY = 0xA11CE;
    address internal payer;
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal payee = makeAddr("payee");
    address internal arbiter = makeAddr("arbiter");
    address internal stranger = makeAddr("stranger");

    uint16 internal constant FEE_BPS = 50; // 0.5%

    // 100 + 200 + 200 = 500 USDC, the same principal as the v2 suite.
    uint256 internal constant M0 = 100_000_000;
    uint256 internal constant M1 = 200_000_000;
    uint256 internal constant M2 = 200_000_000;
    uint256 internal constant TOTAL = 500_000_000;

    event MilestoneSettled(uint256 indexed id, uint256 indexed index, uint256 payeeAmount, uint256 fee);
    event MilestoneAdded(uint256 indexed id, uint256 indexed index, uint256 amount, uint64 due, string title);
    event EvidenceSubmitted(uint256 indexed id, address indexed by, bytes32 indexed evidenceHash, string note);
    event EscrowConfirmed(uint256 indexed id, uint256 payeeAmount, uint256 fee);
    event DisputeResolved(uint256 indexed id, uint256 payeeAmount, uint256 payerAmount, uint256 fee);
    event EscrowRefunded(uint256 indexed id, bool byTimeout);

    function setUp() public {
        payer = vm.addr(PAYER_KEY);
        usdc = new MockUSDC();
        escrow = new EscrowLink(IERC20(address(usdc)), treasury, FEE_BPS, owner);

        usdc.mint(payer, 1_000_000_000); // 1,000 USDC
        vm.prank(payer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------

    function _deadline() internal view returns (uint256) {
        return block.timestamp + 1 days;
    }

    function _milestoneArgs()
        internal
        view
        returns (uint256[] memory amounts, uint64[] memory dues, string[] memory titles)
    {
        amounts = new uint256[](3);
        amounts[0] = M0;
        amounts[1] = M1;
        amounts[2] = M2;

        dues = new uint64[](3);
        dues[0] = uint64(block.timestamp + 2 hours);
        dues[1] = uint64(block.timestamp + 12 hours);
        dues[2] = uint64(_deadline()); // due exactly at the deadline is legal

        titles = new string[](3);
        titles[0] = "Wireframes";
        titles[1] = "Build";
        titles[2] = "Handover";
    }

    function _createMilestones() internal returns (uint256 id) {
        (uint256[] memory amounts, uint64[] memory dues, string[] memory titles) = _milestoneArgs();
        vm.prank(payer);
        id = escrow.createEscrowMilestones(payee, amounts, dues, titles, _deadline(), "Milestone build", arbiter);
    }

    function _createAndFundMilestones() internal returns (uint256 id) {
        id = _createMilestones();
        vm.prank(payer);
        escrow.fund(id);
    }

    function _fee(uint256 gross) internal pure returns (uint256) {
        return (gross * FEE_BPS) / 10_000;
    }

    // ---------------------------------------------------------------
    // createEscrowMilestones — validation
    // ---------------------------------------------------------------

    function test_CreateMilestones_StoresSumAndSlices() public {
        (uint256[] memory amounts, uint64[] memory dues, string[] memory titles) = _milestoneArgs();

        vm.expectEmit(true, true, true, true, address(escrow));
        emit MilestoneAdded(1, 0, M0, dues[0], titles[0]);

        vm.prank(payer);
        uint256 id =
            escrow.createEscrowMilestones(payee, amounts, dues, titles, _deadline(), "Milestone build", arbiter);
        assertEq(id, 1);

        // Escrow amount is the SUM — funding locks the whole contract.
        EscrowLink.Escrow memory e = escrow.getEscrow(id);
        assertEq(e.amount, TOTAL, "escrow amount = sum of milestone amounts");
        assertEq(e.payer, payer);
        assertEq(e.payee, payee);
        assertEq(e.arbiter, arbiter);
        assertEq(uint8(e.state), uint8(EscrowLink.State.Created));

        EscrowLink.Milestone[] memory ms = escrow.getMilestones(id);
        assertEq(ms.length, 3);
        assertEq(ms[0].amount, M0);
        assertEq(ms[1].amount, M1);
        assertEq(ms[2].amount, M2);
        assertEq(ms[0].due, dues[0]);
        assertEq(ms[2].due, _deadline());
        assertFalse(ms[0].settled, "fresh slice starts unsettled");
        assertEq(ms[0].title, "Wireframes");
        assertEq(ms[2].title, "Handover");
    }

    function test_CreateMilestones_RevertsOnLengthMismatch() public {
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = M0;
        amounts[1] = M1;
        amounts[2] = M2;
        uint64[] memory dues = new uint64[](2); // wrong length
        string[] memory titles = new string[](3);
        titles[0] = "a";
        titles[1] = "b";
        titles[2] = "c";

        vm.prank(payer);
        vm.expectRevert(EscrowLink.MilestonesMismatch.selector);
        escrow.createEscrowMilestones(payee, amounts, dues, titles, _deadline(), "d", arbiter);
    }

    function test_CreateMilestones_RevertsOnEmpty() public {
        uint256[] memory amounts = new uint256[](0);
        uint64[] memory dues = new uint64[](0);
        string[] memory titles = new string[](0);

        vm.prank(payer);
        vm.expectRevert(EscrowLink.NoMilestones.selector);
        escrow.createEscrowMilestones(payee, amounts, dues, titles, _deadline(), "d", arbiter);
    }

    function test_CreateMilestones_RevertsOnTooMany() public {
        uint256[] memory amounts = new uint256[](13);
        uint64[] memory dues = new uint64[](13);
        string[] memory titles = new string[](13);
        for (uint256 i = 0; i < 13; ++i) {
            amounts[i] = 1_000_000;
        }

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(EscrowLink.TooManyMilestones.selector, 13));
        escrow.createEscrowMilestones(payee, amounts, dues, titles, _deadline(), "d", arbiter);
    }

    function test_CreateMilestones_RevertsOnZeroAmountSlice() public {
        (uint256[] memory amounts, uint64[] memory dues, string[] memory titles) = _milestoneArgs();
        amounts[1] = 0;

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(EscrowLink.MilestoneAmountZero.selector, 1));
        escrow.createEscrowMilestones(payee, amounts, dues, titles, _deadline(), "d", arbiter);
    }

    function test_CreateMilestones_RevertsOnDueAfterDeadline() public {
        (uint256[] memory amounts, uint64[] memory dues, string[] memory titles) = _milestoneArgs();
        dues[2] = uint64(_deadline() + 1); // one second past the deadline

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(EscrowLink.MilestoneDueAfterDeadline.selector, 2));
        escrow.createEscrowMilestones(payee, amounts, dues, titles, _deadline(), "d", arbiter);
    }

    function test_CreateMilestones_RevertsOnLongTitle() public {
        (uint256[] memory amounts, uint64[] memory dues, string[] memory titles) = _milestoneArgs();
        bytes memory long = new bytes(97); // limit is 96
        for (uint256 i = 0; i < 97; ++i) {
            long[i] = "x";
        }
        titles[0] = string(long);

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(EscrowLink.MilestoneTitleTooLong.selector, 0));
        escrow.createEscrowMilestones(payee, amounts, dues, titles, _deadline(), "d", arbiter);
    }

    function test_GetMilestones_EmptyForPlainEscrowAndRevertsOnUnknown() public {
        vm.prank(payer);
        uint256 id = escrow.createEscrow(payee, TOTAL, _deadline(), "plain", arbiter);
        assertEq(escrow.getMilestones(id).length, 0, "a plain escrow has no slices");

        vm.expectRevert(abi.encodeWithSelector(EscrowLink.EscrowNotFound.selector, 99));
        escrow.getMilestones(99);
    }

    // ---------------------------------------------------------------
    // confirmMilestone — per-slice release
    // ---------------------------------------------------------------

    function test_ConfirmMilestone_ReleasesOneSliceAndStaysFunded() public {
        uint256 id = _createAndFundMilestones();

        uint256 expectedFee = _fee(M0);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit MilestoneSettled(id, 0, M0 - expectedFee, expectedFee);

        vm.prank(payer);
        escrow.confirmMilestone(id, 0);

        assertEq(usdc.balanceOf(payee), M0 - expectedFee, "slice 0 net paid to payee");
        assertEq(escrow.accruedFees(), expectedFee, "slice 0 fee accrued");
        assertEq(usdc.balanceOf(address(escrow)), TOTAL - (M0 - expectedFee), "principal minus payout remains");

        EscrowLink.Milestone[] memory ms = escrow.getMilestones(id);
        assertTrue(ms[0].settled, "slice 0 settled");
        assertFalse(ms[1].settled, "slice 1 untouched");
        // Partial release must NOT close the escrow.
        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Funded));
    }

    function test_ConfirmMilestone_LastSliceCompletesWithCumulativeTotals() public {
        uint256 id = _createAndFundMilestones();

        vm.startPrank(payer);
        escrow.confirmMilestone(id, 0);
        escrow.confirmMilestone(id, 1);
        vm.stopPrank();

        // The final slice's EscrowConfirmed reports the WHOLE escrow's
        // totals — same shape a single v2 confirm would have produced.
        uint256 totalFee = _fee(M0) + _fee(M1) + _fee(M2);
        uint256 totalNet = TOTAL - totalFee;
        vm.expectEmit(true, false, false, true, address(escrow));
        emit EscrowConfirmed(id, totalNet, totalFee);

        vm.prank(payer);
        escrow.confirmMilestone(id, 2);

        assertEq(usdc.balanceOf(payee), totalNet, "payee ends with amount minus fee, no double count");
        assertEq(escrow.accruedFees(), totalFee);
        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Completed));
        assertEq(usdc.balanceOf(address(escrow)), totalFee, "contract retains exactly the fees");
    }

    function test_ConfirmMilestone_RevertsOnUnknownIndex() public {
        uint256 id = _createAndFundMilestones();

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(EscrowLink.MilestoneNotFound.selector, id, 3));
        escrow.confirmMilestone(id, 3);
    }

    function test_ConfirmMilestone_RevertsOnAlreadySettled() public {
        uint256 id = _createAndFundMilestones();
        vm.prank(payer);
        escrow.confirmMilestone(id, 0);

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(EscrowLink.MilestoneAlreadySettled.selector, id, 0));
        escrow.confirmMilestone(id, 0);
    }

    function test_ConfirmMilestone_RevertsIfNotPayer() public {
        uint256 id = _createAndFundMilestones();

        vm.prank(stranger);
        vm.expectRevert(EscrowLink.NotPayer.selector);
        escrow.confirmMilestone(id, 0);

        vm.prank(payee);
        vm.expectRevert(EscrowLink.NotPayer.selector);
        escrow.confirmMilestone(id, 0);
    }

    function test_ConfirmMilestone_RevertsIfNotFunded() public {
        uint256 id = _createMilestones(); // created, not funded

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(EscrowLink.InvalidState.selector, EscrowLink.State.Funded, EscrowLink.State.Created)
        );
        escrow.confirmMilestone(id, 0);
    }

    // ---------------------------------------------------------------
    // confirm — batch release of every remaining slice
    // ---------------------------------------------------------------

    function test_Confirm_BatchSettlesRemainingSlicesWithCumulativeTotals() public {
        uint256 id = _createAndFundMilestones();

        // Release slice 0 on its own first.
        vm.prank(payer);
        escrow.confirmMilestone(id, 0);

        // Batch confirm pays ONLY what remains; the event reports totals.
        uint256 totalFee = _fee(M0) + _fee(M1) + _fee(M2);
        uint256 totalNet = TOTAL - totalFee;

        vm.expectEmit(true, true, false, true, address(escrow));
        emit MilestoneSettled(id, 1, M1 - _fee(M1), _fee(M1));
        vm.expectEmit(true, true, false, true, address(escrow));
        emit MilestoneSettled(id, 2, M2 - _fee(M2), _fee(M2));
        vm.expectEmit(true, false, false, true, address(escrow));
        emit EscrowConfirmed(id, totalNet, totalFee);

        vm.prank(payer);
        escrow.confirm(id);

        assertEq(usdc.balanceOf(payee), totalNet, "one payout on top of the earlier slice");
        assertEq(escrow.accruedFees(), totalFee);
        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Completed));
        assertEq(usdc.balanceOf(address(escrow)), totalFee);
    }

    function test_Confirm_OnPlainEscrowStillPaysExactlyOnce() public {
        vm.prank(payer);
        uint256 id = escrow.createEscrow(payee, TOTAL, _deadline(), "plain", arbiter);
        vm.prank(payer);
        escrow.fund(id);

        uint256 fee = _fee(TOTAL);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit EscrowConfirmed(id, TOTAL - fee, fee);

        vm.prank(payer);
        escrow.confirm(id);

        assertEq(usdc.balanceOf(payee), TOTAL - fee, "v2 path unchanged");
        assertEq(escrow.accruedFees(), fee);
    }

    // ---------------------------------------------------------------
    // claimTimeout — refunds only the unsettled remainder
    // ---------------------------------------------------------------

    function test_Timeout_RefundsOnlyUnsettledRemainder() public {
        uint256 id = _createAndFundMilestones();

        // Payer already released slice 0 (99.5 USDC net + 0.5 fee).
        vm.prank(payer);
        escrow.confirmMilestone(id, 0);

        vm.warp(_deadline() + escrow.TIMEOUT_GRACE() + 1);

        uint256 payerBefore = usdc.balanceOf(payer);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit EscrowRefunded(id, true);

        escrow.claimTimeout(id); // permissionless

        assertEq(usdc.balanceOf(payer) - payerBefore, TOTAL - M0, "payer recovers the unsettled remainder only");
        assertEq(usdc.balanceOf(payee), M0 - _fee(M0), "confirmed slice stays with the payee");
        assertEq(usdc.balanceOf(address(escrow)), _fee(M0), "only the accrued fee remains");
        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Refunded));
    }

    function test_Timeout_OnPlainEscrowRefundsFullAmount() public {
        vm.prank(payer);
        uint256 id = escrow.createEscrow(payee, TOTAL, _deadline(), "plain", arbiter);
        vm.prank(payer);
        escrow.fund(id);

        vm.warp(_deadline() + escrow.TIMEOUT_GRACE() + 1);
        escrow.claimTimeout(id);

        assertEq(usdc.balanceOf(payer), 1_000_000_000, "plain escrow refunds everything (v2)");
    }

    // ---------------------------------------------------------------
    // resolveDispute — splits only the unsettled remainder
    // ---------------------------------------------------------------

    function test_ResolveDispute_SplitsRemainderAndReportsCumulativeTotals() public {
        uint256 id = _createAndFundMilestones();

        vm.prank(payer);
        escrow.confirmMilestone(id, 0); // 100 USDC gross already with the payee
        vm.prank(payee);
        escrow.openDispute(id);

        // Remainder = 400. Split 50/50: payee gross 200, payer 200.
        uint256 settledNet = M0 - _fee(M0);
        uint256 settledFee = _fee(M0);
        uint256 payeeGross = (TOTAL - M0) / 2;
        uint256 payeeNet = payeeGross - _fee(payeeGross);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit DisputeResolved(id, settledNet + payeeNet, TOTAL - M0 - payeeGross, settledFee + _fee(payeeGross));

        vm.prank(arbiter);
        escrow.resolveDispute(id, 5000);

        // Invariant: the three event numbers always sum to the principal.
        assertEq(settledNet + payeeNet + (TOTAL - M0 - payeeGross) + settledFee + _fee(payeeGross), TOTAL);

        assertEq(usdc.balanceOf(payee), settledNet + payeeNet, "payee keeps settled slice + ruled share");
        assertEq(usdc.balanceOf(payer), 1_000_000_000 - TOTAL + (TOTAL - M0 - payeeGross), "payer gets remainder back");
        assertEq(escrow.accruedFees(), settledFee + _fee(payeeGross));
        assertEq(usdc.balanceOf(address(escrow)), settledFee + _fee(payeeGross), "contract holds exactly the fees");
        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Completed));
    }

    function test_ResolveDispute_PayerTakesRemainder_ConfirmedSliceStaysPut() public {
        uint256 id = _createAndFundMilestones();

        vm.prank(payer);
        escrow.confirmMilestone(id, 0);
        vm.prank(payee);
        escrow.openDispute(id);

        uint256 settledNet = M0 - _fee(M0);
        uint256 settledFee = _fee(M0);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit DisputeResolved(id, settledNet, TOTAL - M0, settledFee);

        vm.prank(arbiter);
        escrow.resolveDispute(id, 0); // payer wins the whole remainder

        assertEq(usdc.balanceOf(payee), settledNet, "confirmed slice cannot be clawed back");
        assertEq(usdc.balanceOf(payer), 1_000_000_000 - TOTAL + (TOTAL - M0));
        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Refunded));
    }

    // ---------------------------------------------------------------
    // Gasless release — EIP-712 signatures, anybody relays
    // ---------------------------------------------------------------

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_ReleaseAllSig_FilesWithAnyoneRelaying() public {
        uint256 id = _createAndFundMilestones();

        bytes memory sig = _sign(PAYER_KEY, escrow.releaseAllDigest(id));

        uint256 totalFee = _fee(M0) + _fee(M1) + _fee(M2);
        // The payee — not the payer — submits and pays the gas.
        vm.prank(payee);
        escrow.confirmWithSig(id, sig);

        assertEq(usdc.balanceOf(payee), TOTAL - totalFee, "release executed without the payer's transaction");
        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Completed));
        assertEq(escrow.releaseNonces(id, type(uint256).max), 1, "ReleaseAll nonce consumed");
    }

    function test_ReleaseAllSig_ReplayRejected() public {
        uint256 id = _createAndFundMilestones();
        bytes memory sig = _sign(PAYER_KEY, escrow.releaseAllDigest(id));

        vm.prank(payee);
        escrow.confirmWithSig(id, sig);

        // The escrow is Completed now, so a second filing dies at the state
        // check before the signature is even looked at — no double payout.
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                EscrowLink.InvalidState.selector, EscrowLink.State.Funded, EscrowLink.State.Completed
            )
        );
        escrow.confirmWithSig(id, sig);
    }

    function test_ReleaseMilestoneSig_ReplayRejectedByNonce() public {
        uint256 id = _createAndFundMilestones();
        bytes memory sig = _sign(PAYER_KEY, escrow.releaseDigest(id, 0));

        vm.prank(payee);
        escrow.confirmMilestoneWithSig(id, 0, sig);

        // Escrow is still Funded, so this replay reaches the signature check
        // and dies there: the nonce moved, the bytes are spent.
        vm.prank(stranger);
        vm.expectRevert(EscrowLink.InvalidReleaseSignature.selector);
        escrow.confirmMilestoneWithSig(id, 0, sig);
    }

    function test_ReleaseAllSig_RevertsOnWrongSigner() public {
        uint256 id = _createAndFundMilestones();
        uint256 mallorKey = 0xBAD;
        bytes memory sig = _sign(mallorKey, escrow.releaseAllDigest(id));

        vm.prank(stranger);
        vm.expectRevert(EscrowLink.InvalidReleaseSignature.selector);
        escrow.confirmWithSig(id, sig);
    }

    function test_ReleaseMilestoneSig_ReleasesOnlyThatSlice() public {
        uint256 id = _createAndFundMilestones();

        bytes memory sig = _sign(PAYER_KEY, escrow.releaseDigest(id, 0));

        vm.prank(stranger);
        escrow.confirmMilestoneWithSig(id, 0, sig);

        EscrowLink.Milestone[] memory ms = escrow.getMilestones(id);
        assertTrue(ms[0].settled, "signed slice released");
        assertFalse(ms[1].settled, "sibling untouched");
        assertEq(usdc.balanceOf(payee), M0 - _fee(M0));
        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Funded), "escrow still open");
        assertEq(escrow.releaseNonces(id, 0), 1, "index-0 nonce consumed");
        assertEq(escrow.releaseNonces(id, type(uint256).max), 0, "ReleaseAll slot untouched");
    }

    function test_ReleaseMilestoneSig_IndexBoundIntoDigest() public {
        uint256 id = _createAndFundMilestones();

        // Signature for slice 0 submitted against slice 1 must not pass.
        bytes memory sig = _sign(PAYER_KEY, escrow.releaseDigest(id, 0));

        vm.prank(stranger);
        vm.expectRevert(EscrowLink.InvalidReleaseSignature.selector);
        escrow.confirmMilestoneWithSig(id, 1, sig);
    }

    function test_ReleaseSig_SlotsAreIndependentAcrossMilestones() public {
        uint256 id = _createAndFundMilestones();

        // Pre-sign releases for slice 0 AND the whole escrow ahead of time:
        // distinct nonce slots, so both digests are stable simultaneously.
        bytes memory sig0 = _sign(PAYER_KEY, escrow.releaseDigest(id, 0));
        bytes memory sigAll = _sign(PAYER_KEY, escrow.releaseAllDigest(id));

        vm.prank(payee);
        escrow.confirmMilestoneWithSig(id, 0, sig0);
        assertEq(escrow.releaseNonces(id, 0), 1);
        assertEq(escrow.releaseNonces(id, type(uint256).max), 0, "ReleaseAll slot unaffected by milestone release");

        // The pre-signed ReleaseAll still files and sweeps the rest.
        vm.prank(stranger);
        escrow.confirmWithSig(id, sigAll);

        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Completed));
        assertEq(usdc.balanceOf(payee), TOTAL - (_fee(M0) + _fee(M1) + _fee(M2)));
        assertEq(escrow.releaseNonces(id, type(uint256).max), 1);
    }

    function test_ReleaseAllSig_RevertsWhenNotFunded() public {
        uint256 id = _createMilestones(); // not funded
        bytes memory sig = _sign(PAYER_KEY, escrow.releaseAllDigest(id));

        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(EscrowLink.InvalidState.selector, EscrowLink.State.Funded, EscrowLink.State.Created)
        );
        escrow.confirmWithSig(id, sig);
    }

    function test_ReleaseSig_AcceptsERC1271ContractWalletPayer() public {
        uint256 ownerKey = uint256(keccak256("wallet-owner-key"));
        ERC1271Wallet wallet = new ERC1271Wallet(vm.addr(ownerKey));

        usdc.mint(address(wallet), TOTAL);
        vm.prank(address(wallet));
        usdc.approve(address(escrow), type(uint256).max);

        (uint256[] memory amounts, uint64[] memory dues, string[] memory titles) = _milestoneArgs();
        vm.prank(address(wallet));
        uint256 id = escrow.createEscrowMilestones(payee, amounts, dues, titles, _deadline(), "wallet deal", arbiter);
        vm.prank(address(wallet));
        escrow.fund(id);

        bytes memory sig = _sign(ownerKey, escrow.releaseAllDigest(id));

        // Relayed by a third party; the wallet answers via ERC-1271.
        vm.prank(stranger);
        escrow.confirmWithSig(id, sig);

        uint256 totalFee = _fee(M0) + _fee(M1) + _fee(M2);
        assertEq(usdc.balanceOf(payee), TOTAL - totalFee, "contract wallet release paid out");
        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Completed));
    }

    function test_ReleaseSig_RevertsWhenContractWalletRejects() public {
        ERC1271Wallet wallet = new ERC1271Wallet(makeAddr("wallet owner"));

        usdc.mint(address(wallet), TOTAL);
        vm.prank(address(wallet));
        usdc.approve(address(escrow), type(uint256).max);

        (uint256[] memory amounts, uint64[] memory dues, string[] memory titles) = _milestoneArgs();
        vm.prank(address(wallet));
        uint256 id = escrow.createEscrowMilestones(payee, amounts, dues, titles, _deadline(), "wallet deal", arbiter);
        vm.prank(address(wallet));
        escrow.fund(id);

        // Signed by a key the wallet does not recognize.
        bytes memory sig = _sign(0xDEAD, escrow.releaseAllDigest(id));

        vm.prank(stranger);
        vm.expectRevert(EscrowLink.InvalidReleaseSignature.selector);
        escrow.confirmWithSig(id, sig);
    }

    // ---------------------------------------------------------------
    // submitEvidence — event-only anchoring
    // ---------------------------------------------------------------

    bytes32 internal constant EVIDENCE = keccak256("delivery-receipt.pdf");

    function test_Evidence_PartyFilesAndEventCarriesHashAndNote() public {
        uint256 id = _createAndFundMilestones();

        vm.expectEmit(true, true, true, true, address(escrow));
        emit EvidenceSubmitted(id, payee, EVIDENCE, "receipt.pdf anchored");

        vm.prank(payee);
        escrow.submitEvidence(id, EVIDENCE, "receipt.pdf anchored");
    }

    function test_Evidence_RevertsForNonParty() public {
        uint256 id = _createAndFundMilestones();

        vm.prank(stranger);
        vm.expectRevert(EscrowLink.NotEscrowParty.selector);
        escrow.submitEvidence(id, EVIDENCE, "not mine to file");
    }

    function test_Evidence_AllowedInAnyStateIncludingTerminal() public {
        uint256 id = _createAndFundMilestones();
        vm.prank(payer);
        escrow.confirm(id); // Completed
        assertEq(uint8(escrow.getEscrow(id).state), uint8(EscrowLink.State.Completed));

        // The record outlives the deal: parties may still anchor evidence.
        vm.prank(payee);
        escrow.submitEvidence(id, EVIDENCE, "post-completion note");

        // Arbiter too.
        vm.prank(arbiter);
        escrow.submitEvidence(id, keccak256("ruling.pdf"), "arbiter ruling archived");
    }

    function test_Evidence_RevertsOnZeroHash() public {
        uint256 id = _createAndFundMilestones();

        vm.prank(payer);
        vm.expectRevert(EscrowLink.EmptyEvidenceHash.selector);
        escrow.submitEvidence(id, bytes32(0), "anchors nothing");
    }

    function test_Evidence_RevertsOnOverlongNote() public {
        uint256 id = _createAndFundMilestones();
        bytes memory long = new bytes(257); // limit is MAX_DESCRIPTION_BYTES = 256
        for (uint256 i = 0; i < 257; ++i) {
            long[i] = "x";
        }

        vm.prank(payer);
        vm.expectRevert(EscrowLink.DescriptionTooLong.selector);
        escrow.submitEvidence(id, EVIDENCE, string(long));
    }
}
