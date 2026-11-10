// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Minimal ERC-1271 surface: a contract wallet approves the same typed
///      data an EOA does, by returning the magic value from a staticcall.
interface IERC1271Wallet {
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4 magicValue);
}

/**
 * @title Bond — EscrowLink
 * @notice Link-based escrow on Base: create a link, fund it, release on confirmation.
 *
 * Design notes (see ARCHITECTURE.md):
 *  - Explicit state machine: every mutating function pins its expected state.
 *  - Custom errors (not require-strings) so the frontend can decode and
 *    render localized messages without string matching.
 *  - Fee is snapshotted per-escrow at creation: changing the global fee can
 *    never affect escrows that already exist (no rug vector).
 *  - Non-custodial: funds live in this contract only. No admin can move
 *    escrowed principal — only accrued protocol fees.
 *  - Pull-style fee accounting: accruedFees accumulates, owner withdraws.
 *
 * v2 additions:
 *  - Optional EIP-712 handshake: the payee and the arbiter can sign the exact
 *    terms (payer, parties, amount, deadline, description) before the escrow
 *    is filed. Consent is single-use (payer nonce) and bound to this chain and
 *    this contract by the EIP-712 domain. Escrows without signatures behave
 *    exactly like v1 — the handshake is a consent layer, not a new requirement.
 *  - Permissionless timeout sweep: after deadline + grace, anyone may execute
 *    the timeout. Funds only ever return to the payer, so the caller gains
 *    nothing but a gas bill — an abandoned escrow can never stay locked.
 *  - Arbiter window: opening a dispute pauses the timeout path for
 *    ARBITER_WINDOW so the arbiter has a fixed, published window to rule. If
 *    the arbiter goes silent, the escrow falls back to the plain timeout rule;
 *    waiting never invents a new distribution of the money.
 *  - Blacklist rescue: settlement pushes first; if the token refuses the
 *    recipient (USDC blacklist, a rejecting contract) the share is credited to
 *    `pendingWithdrawals`, which the credit's owner can move to any address
 *    they choose. One bad recipient can never wedge settlement for everyone.
 */
contract EscrowLink is ReentrancyGuard, Pausable, Ownable2Step {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------

    enum State {
        None, // 0 — does not exist
        Created, // 1 — awaiting funding
        Funded, // 2 — principal locked
        Disputed, // 3 — under arbiter review
        Completed, // 4 — terminal: paid out to payee
        Cancelled, // 5 — terminal: never funded
        Refunded // 6 — terminal: returned to payer
    }

    struct Escrow {
        address payer;
        address payee;
        address arbiter;
        uint256 amount;
        uint256 feeBps; // snapshot at creation
        uint256 deadline; // delivery deadline (unix seconds)
        uint256 createdAt;
        uint64 disputedAt; // 0 until a dispute opens; starts the arbiter window
        bool consented; // true when payee + arbiter signed the EIP-712 terms
        State state;
        string description;
    }

    /// @dev A slice of an escrow's principal. Milestones live in a parallel
    ///      mapping rather than inside {Escrow}, so the escrow struct keeps
    ///      the exact deployed v2 ABI — one frontend, both generations.
    ///      `due` is a target for the payer's confirmation, not a chain
    ///      deadline: the escrow-level deadline and its 48-hour grace remain
    ///      the only timeout, exactly as in v2.
    struct Milestone {
        uint256 amount; // principal slice; the sum over all == escrow amount
        uint64 due; // delivery target (unix seconds, 0 = none)
        bool settled; // true once released to the payee
        string title; // short label shown in the milestone table
    }

    // ---------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------

    uint256 public constant MIN_DURATION = 10 minutes;
    uint256 public constant MAX_DURATION = 365 days;
    /// @notice After the deadline, the timeout path opens once this grace has
    ///         elapsed — gives the payee time to open a dispute first.
    uint256 public constant TIMEOUT_GRACE = 48 hours;
    /// @notice How long an opened dispute waits for the arbiter before the
    ///         timeout path reopens. A published review window instead of
    ///         letting a silent arbiter lock funds forever.
    uint256 public constant ARBITER_WINDOW = 7 days;
    uint16 public constant MAX_FEE_BPS = 1_000; // hard cap: 10%
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_DESCRIPTION_BYTES = 256;
    /// @notice Upper bound on milestones per escrow — bounds the settlement
    ///         loop's gas and keeps a single confirmation transaction cheap.
    uint256 public constant MAX_MILESTONES = 12;
    uint256 public constant MAX_MILESTONE_TITLE_BYTES = 96;

    /// @dev EIP-712 type of the off-chain consent signed by payee + arbiter.
    bytes32 private constant _HANDSHAKE_TYPEHASH = keccak256(
        "Handshake(address payer,address payee,address arbiter,uint256 amount,uint256 deadline,uint256 nonce,bytes32 descriptionHash)"
    );

    /// @dev EIP-712 types of the gasless release: the payer signs off-chain,
    ///      anybody may submit the signature and pay the gas — typically the
    ///      payee, who is the one waiting on the money. `Release` names one
    ///      milestone; `ReleaseAll` sweeps every unsettled slice.
    bytes32 private constant _RELEASE_TYPEHASH = keccak256("Release(uint256 id,uint256 index,uint256 nonce)");
    bytes32 private constant _RELEASE_ALL_TYPEHASH = keccak256("ReleaseAll(uint256 id,uint256 nonce)");

    // The domain and the digest are written out here instead of inheriting
    // OpenZeppelin's EIP712 module: in v5.7 that module targets the Osaka EVM
    // (it compiles the `clz` opcode), which no OP Stack chain guarantees yet.
    // The bytecode here must run on Cancun, which Base has run since 2024.
    // Only hashing is hand-written; signature checking stays audited ECDSA.
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("Bond EscrowLink");
    bytes32 private constant _VERSION_HASH = keccak256("1");

    // ---------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------

    /// @notice The single settlement token (USDC on Base).
    IERC20 public immutable token;

    /// @notice Where protocol fees accrue.
    address public treasury;

    /// @notice Current protocol fee in basis points — applies to NEW escrows only.
    uint16 public feeBps;

    /// @notice Total fees accrued but not yet withdrawn.
    uint256 public accruedFees;

    /// @notice Per-payer handshake nonce. Signing binds to the current value
    ///         and the value moves on use, so one signature files one deal.
    mapping(address payer => uint256 nonce) public handshakeNonces;

    /// @notice Shares whose push transfer failed (blacklisted recipient, or a
    ///         contract that refuses tokens). Pull them out with
    ///         {withdrawPending} to an address of your choosing.
    mapping(address account => uint256 amount) public pendingWithdrawals;

    uint256 private _nextId = 1;
    mapping(uint256 id => Escrow) private _escrows;

    /// @notice Milestone slices per escrow. Empty for a plain escrow, so a
    ///         v2-era escrow reads back with zero milestones and every
    ///         existing path behaves exactly as before.
    mapping(uint256 id => Milestone[] milestones) private _milestones;

    /// @notice Per-escrow, per-slot nonce for the gasless release signatures.
    ///         `Release` signs slot `index`, `ReleaseAll` signs slot
    ///         `type(uint256).max`. The digest binds the current value and
    ///         the value moves on use, so one signature files one release
    ///         and never replays — while different milestones stay
    ///         independently pre-signable.
    mapping(uint256 id => mapping(uint256 slot => uint256 nonce)) public releaseNonces;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

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
    event EscrowFunded(uint256 indexed id);
    event EscrowCancelled(uint256 indexed id);
    event EscrowConfirmed(uint256 indexed id, uint256 payeeAmount, uint256 fee);
    event DisputeOpened(uint256 indexed id, address indexed by);
    event DisputeResolved(uint256 indexed id, uint256 payeeAmount, uint256 payerAmount, uint256 fee);
    event EscrowRefunded(uint256 indexed id, bool byTimeout);
    event MilestoneSettled(uint256 indexed id, uint256 indexed index, uint256 payeeAmount, uint256 fee);
    event MilestoneAdded(uint256 indexed id, uint256 indexed index, uint256 amount, uint64 due, string title);
    event EvidenceSubmitted(uint256 indexed id, address indexed by, bytes32 indexed evidenceHash, string note);
    event PaymentCredited(address indexed account, uint256 amount);
    event PaymentWithdrawn(address indexed account, address indexed to, uint256 amount);
    event FeeUpdated(uint16 oldFeeBps, uint16 newFeeBps);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event FeesWithdrawn(address indexed to, uint256 amount);

    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    error EscrowNotFound(uint256 id);
    error InvalidState(State expected, State actual);
    error NotPayer();
    error NotPayee();
    error NotArbiter();
    error NotParty();
    error ZeroAddress();
    error ZeroAmount();
    error SelfReference();
    error DeadlineTooSoon();
    error DeadlineTooFar();
    error DescriptionTooLong();
    error FeeExceedsMaximum();
    error InvalidBps();
    error NothingToWithdraw();
    error TimeoutNotReached();
    /// @param availableAt Unix time when the arbiter window closes.
    error ArbiterWindowOpen(uint256 availableAt);
    error InvalidHandshakeSignature();
    error InvalidReleaseSignature();
    error UnexpectedTransfer(uint256 received, uint256 expected);
    error RenounceDisabled();
    // Milestones
    error MilestonesMismatch();
    error TooManyMilestones(uint256 count);
    error NoMilestones();
    error MilestoneAmountZero(uint256 index);
    error MilestoneNotFound(uint256 id, uint256 index);
    error MilestoneAlreadySettled(uint256 id, uint256 index);
    error MilestoneDueAfterDeadline(uint256 index);
    error MilestoneTitleTooLong(uint256 index);
    // Evidence
    error NotEscrowParty();
    error EmptyEvidenceHash();

    // ---------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------

    /// @param usdc_      Settlement token (USDC on Base).
    /// @param treasury_  Fee collection address.
    /// @param feeBps_    Initial protocol fee (e.g. 50 = 0.5%).
    /// @param owner_     Initial owner (recommend a multisig on mainnet).
    constructor(IERC20 usdc_, address treasury_, uint16 feeBps_, address owner_) Ownable(owner_) {
        if (address(usdc_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeExceedsMaximum();

        token = usdc_;
        treasury = treasury_;
        feeBps = feeBps_;
    }

    // ---------------------------------------------------------------
    // User actions
    // ---------------------------------------------------------------

    /**
     * @notice Create an escrow. `msg.sender` becomes the payer.
     * @dev Fee is snapshotted here — later global fee changes don't apply.
     * @return id Handle used in the shareable link.
     */
    function createEscrow(
        address payee_,
        uint256 amount_,
        uint256 deadline_,
        string calldata description_,
        address arbiter_
    ) external whenNotPaused returns (uint256 id) {
        _validate(payee_, amount_, deadline_, description_, arbiter_);
        id = _store(payee_, amount_, deadline_, description_, arbiter_, false);
    }

    /**
     * @notice Create an escrow whose terms the payee AND the arbiter have
     *         already signed off-chain (EIP-712, no gas for them).
     *
     * The signatures cover exactly these terms plus the payer's current
     * {handshakeNonces} value, this chain and this contract (EIP-712 domain),
     * so they cannot be replayed for another deal, another chain, or twice.
     *
     * @param payeeSig   EIP-712 `Handshake` signature from `payee_`.
     * @param arbiterSig EIP-712 `Handshake` signature from `arbiter_`.
     * @return id Handle used in the shareable link.
     */
    function createEscrowHandshaked(
        address payee_,
        uint256 amount_,
        uint256 deadline_,
        string calldata description_,
        address arbiter_,
        bytes calldata payeeSig,
        bytes calldata arbiterSig
    ) external whenNotPaused returns (uint256 id) {
        _validate(payee_, amount_, deadline_, description_, arbiter_);

        bytes32 digest = _handshakeDigest(
            msg.sender,
            payee_,
            arbiter_,
            amount_,
            deadline_,
            handshakeNonces[msg.sender],
            keccak256(bytes(description_))
        );
        if (!_isValidSignature(payee_, digest, payeeSig)) revert InvalidHandshakeSignature();
        if (!_isValidSignature(arbiter_, digest, arbiterSig)) revert InvalidHandshakeSignature();

        handshakeNonces[msg.sender] += 1;
        id = _store(payee_, amount_, deadline_, description_, arbiter_, true);
    }

    /**
     * @notice Create an escrow split into milestones. The escrow amount is
     *         the SUM of the milestone amounts; funding locks the whole sum,
     *         and the payer releases slice by slice ({confirmMilestone}) or
     *         all at once ({confirm}).
     *
     * Milestone `due` dates are targets for the payer's confirmation, not
     * chain-enforced deadlines — the escrow-level deadline and its 48-hour
     * grace remain the only timeout, so a missed milestone can never strand
     * funds that the plain timeout rule would have freed.
     *
     * @param amounts_ One positive amount per milestone; sum becomes the
     *                 escrow amount. Length 1..MAX_MILESTONES.
     * @param dues_    Parallel delivery targets (unix seconds, 0 = none).
     *                 Each must be <= the escrow deadline.
     * @param titles_  Parallel short labels, <= MAX_MILESTONE_TITLE_BYTES.
     * @return id Handle used in the shareable link.
     */
    function createEscrowMilestones(
        address payee_,
        uint256[] calldata amounts_,
        uint64[] calldata dues_,
        string[] calldata titles_,
        uint256 deadline_,
        string calldata description_,
        address arbiter_
    ) external whenNotPaused returns (uint256 id) {
        uint256 total = _checkMilestones(amounts_, dues_, titles_, deadline_);
        _validate(payee_, total, deadline_, description_, arbiter_);

        id = _store(payee_, total, deadline_, description_, arbiter_, false);
        _storeMilestones(id, amounts_, dues_, titles_);
    }

    /// @dev Shape + per-slice validation; returns the escrow amount (sum).
    function _checkMilestones(
        uint256[] calldata amounts_,
        uint64[] calldata dues_,
        string[] calldata titles_,
        uint256 deadline_
    ) private pure returns (uint256 total) {
        uint256 count = amounts_.length;
        if (count != dues_.length || count != titles_.length) revert MilestonesMismatch();
        if (count == 0) revert NoMilestones();
        if (count > MAX_MILESTONES) revert TooManyMilestones(count);

        for (uint256 i = 0; i < count; ++i) {
            if (amounts_[i] == 0) revert MilestoneAmountZero(i);
            if (dues_[i] > deadline_) revert MilestoneDueAfterDeadline(i);
            if (bytes(titles_[i]).length > MAX_MILESTONE_TITLE_BYTES) revert MilestoneTitleTooLong(i);
            total += amounts_[i];
        }
    }

    function _storeMilestones(
        uint256 id,
        uint256[] calldata amounts_,
        uint64[] calldata dues_,
        string[] calldata titles_
    ) private {
        Milestone[] storage ms = _milestones[id];
        uint256 count = amounts_.length;
        for (uint256 i = 0; i < count; ++i) {
            ms.push(Milestone({amount: amounts_[i], due: dues_[i], settled: false, title: titles_[i]}));
            emit MilestoneAdded(id, i, amounts_[i], dues_[i], titles_[i]);
        }
    }

    /**
     * @notice Lock `amount` into the escrow. Requires a prior ERC-20 approval.
     */
    function fund(uint256 id) external nonReentrant whenNotPaused {
        Escrow storage e = _get(id);
        if (e.state != State.Created) revert InvalidState(State.Created, e.state);
        if (msg.sender != e.payer) revert NotPayer();

        // Effects before interactions.
        e.state = State.Funded;

        // Exact-received check: rejects fee-on-transfer / rebasing tokens that
        // would otherwise leave the escrow under-collateralized.
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), e.amount);
        uint256 received = token.balanceOf(address(this)) - balanceBefore;
        if (received != e.amount) revert UnexpectedTransfer(received, e.amount);

        emit EscrowFunded(id);
    }

    /**
     * @notice Abort an escrow that was never funded.
     */
    function cancel(uint256 id) external {
        Escrow storage e = _get(id);
        if (e.state != State.Created) revert InvalidState(State.Created, e.state);
        if (msg.sender != e.payer) revert NotPayer();

        e.state = State.Cancelled;

        emit EscrowCancelled(id);
    }

    /**
     * @notice Payer confirms delivery — releases principal to payee minus fee.
     *         On a milestone escrow this settles EVERY remaining slice at
     *         once; slice-by-slice release goes through {confirmMilestone}.
     */
    function confirm(uint256 id) external nonReentrant {
        Escrow storage e = _get(id);
        if (e.state != State.Funded) revert InvalidState(State.Funded, e.state);
        if (msg.sender != e.payer) revert NotPayer();

        _confirmAll(id, e);
    }

    /**
     * @notice Gasless {confirm}: the payer signs the EIP-712 `ReleaseAll`
     *         digest off-chain and ANYBODY may submit it, paying the gas —
     *         typically the payee who is waiting on the money. The signature
     *         binds this escrow, this chain, this contract and the escrow's
     *         `ReleaseAll` nonce; the nonce moves on use, so one signature
     *         files exactly one release and never replays.
     */
    function confirmWithSig(uint256 id, bytes calldata sig) external nonReentrant {
        Escrow storage e = _get(id);
        if (e.state != State.Funded) revert InvalidState(State.Funded, e.state);
        if (!_isValidSignature(e.payer, releaseAllDigest(id), sig)) revert InvalidReleaseSignature();

        releaseNonces[id][type(uint256).max] += 1;
        _confirmAll(id, e);
    }

    /**
     * @notice Payer confirms delivery of ONE milestone — releases that slice
     *         to the payee minus fee. When the last unsettled slice settles,
     *         the escrow completes and {EscrowConfirmed} reports the
     *         cumulative totals for the whole escrow.
     * @dev Plain escrows hold no slices: use {confirm}.
     */
    function confirmMilestone(uint256 id, uint256 index) external nonReentrant {
        Escrow storage e = _get(id);
        if (e.state != State.Funded) revert InvalidState(State.Funded, e.state);
        if (msg.sender != e.payer) revert NotPayer();

        _settleMilestone(id, e, index);
    }

    /**
     * @notice Gasless {confirmMilestone} — same signature rules as
     *         {confirmWithSig}, with `index` bound into the digest so a
     *         signature for slice 0 can never settle slice 1, and its own
     *         nonce slot so releases of different milestones can be signed
     *         independently ahead of time.
     */
    function confirmMilestoneWithSig(uint256 id, uint256 index, bytes calldata sig) external nonReentrant {
        Escrow storage e = _get(id);
        if (e.state != State.Funded) revert InvalidState(State.Funded, e.state);
        if (!_isValidSignature(e.payer, releaseDigest(id, index), sig)) revert InvalidReleaseSignature();

        releaseNonces[id][index] += 1;
        _settleMilestone(id, e, index);
    }

    /**
     * @notice Either party can escalate a funded escrow to the arbiter.
     * @dev Opening the dispute starts {ARBITER_WINDOW}: the timeout path is
     *      paused for that long so the arbiter has a fixed window to rule.
     */
    function openDispute(uint256 id) external {
        Escrow storage e = _get(id);
        if (e.state != State.Funded) revert InvalidState(State.Funded, e.state);
        if (msg.sender != e.payer && msg.sender != e.payee) revert NotParty();

        e.state = State.Disputed;
        e.disputedAt = uint64(block.timestamp);

        emit DisputeOpened(id, msg.sender);
    }

    /**
     * @notice Arbiter splits the principal. `payeeBps` of the amount goes to
     *         the payee; the remainder returns to the payer. Fee applies only
     *         to the payee's share.
     *
     * On a milestone escrow the ruling applies to the UNSETTLED remainder
     * only — slices the payer already confirmed are final and stay with the
     * payee. A plain escrow holds no settled slices, so the remainder IS the
     * amount and the behavior is identical to v2. The event reports
     * CUMULATIVE totals, so `payeeAmount + payerAmount + fee == amount`
     * holds for every escrow, milestone or not.
     *
     * @param payeeBps Share for the payee, 0–10000. 10000 = payee takes all.
     */
    function resolveDispute(uint256 id, uint16 payeeBps) external nonReentrant {
        Escrow storage e = _get(id);
        if (e.state != State.Disputed) revert InvalidState(State.Disputed, e.state);
        if (msg.sender != e.arbiter) revert NotArbiter();
        if (payeeBps > BPS_DENOMINATOR) revert InvalidBps();

        e.state = payeeBps == 0 ? State.Refunded : State.Completed;

        (uint256 settled, uint256 settledNet, uint256 settledFee) = _settledTotals(id, e.feeBps);
        uint256 remainder = e.amount - settled;

        uint256 payeeGross = (remainder * payeeBps) / BPS_DENOMINATOR;
        uint256 payerAmount = remainder - payeeGross;
        (uint256 payeeNet, uint256 fee) = _split(payeeGross, e.feeBps);

        if (payeeNet > 0) _deliver(e.payee, payeeNet);
        if (payerAmount > 0) _deliver(e.payer, payerAmount);
        if (fee > 0) {
            accruedFees += fee;
        }

        emit DisputeResolved(id, settledNet + payeeNet, payerAmount, settledFee + fee);
    }

    /**
     * @notice Timeout sweep — permissionless on purpose.
     *
     * Once the deadline and its grace have passed (and, for a disputed escrow,
     * once the arbiter's window has closed too), anybody may execute the
     * timeout. The payout is fixed by the escrow itself — everything returns
     * to the payer — so a caller can neither profit from it nor redirect it.
     * This is what keeps an abandoned link from staying locked forever.
     */
    function claimTimeout(uint256 id) external nonReentrant {
        Escrow storage e = _get(id);
        if (e.state != State.Funded && e.state != State.Disputed) {
            revert InvalidState(State.Funded, e.state);
        }
        if (block.timestamp <= e.deadline + TIMEOUT_GRACE) revert TimeoutNotReached();
        if (e.state == State.Disputed && block.timestamp <= uint256(e.disputedAt) + ARBITER_WINDOW) {
            revert ArbiterWindowOpen(uint256(e.disputedAt) + ARBITER_WINDOW);
        }

        e.state = State.Refunded;

        // Milestone escrow: only the UNSETTLED remainder returns — slices
        // the payer already confirmed stay with the payee. A plain escrow
        // has no settled slices, so this refunds the full amount (v2).
        (uint256 settled,,) = _settledTotals(id, e.feeBps);
        _deliver(e.payer, e.amount - settled);

        emit EscrowRefunded(id, true);
    }

    /**
     * @notice Withdraw a share that could not be pushed to you earlier
     *         (USDC blacklist, a contract that rejects tokens).
     * @param to Where the tokens go. A blacklisted account routes its own
     *           credit to any clean address — the contract holds the tokens,
     *           never the blacklisted one.
     */
    function withdrawPending(address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        // Effects before interactions: a re-entrant call finds zero credit.
        pendingWithdrawals[msg.sender] = 0;
        token.safeTransfer(to, amount);

        emit PaymentWithdrawn(msg.sender, to, amount);
    }

    /**
     * @notice Anchor a piece of evidence to this escrow: emit its hash on
     *         chain. The artifact itself never touches the chain — only
     *         `keccak256(artifact)` and a short note do — so anyone can
     *         later prove the file existed at that moment by hashing it
     *         again and matching the log. Discovery stays log-based: no
     *         server stores the evidence, and the event is append-only.
     *
     * @param evidenceHash keccak256 of the artifact (file, message log,
     *                     delivery receipt). Zero hash is rejected — it
     *                     would anchor nothing.
     * @param note         Short label for the timeline (<= 256 bytes).
     * @dev Any party (payer, payee, arbiter) may file evidence, in ANY
     *      state — including terminal ones: the record outlives the deal.
     */
    function submitEvidence(uint256 id, bytes32 evidenceHash, string calldata note) external {
        Escrow storage e = _get(id);
        if (msg.sender != e.payer && msg.sender != e.payee && msg.sender != e.arbiter) revert NotEscrowParty();
        if (evidenceHash == bytes32(0)) revert EmptyEvidenceHash();
        if (bytes(note).length > MAX_DESCRIPTION_BYTES) revert DescriptionTooLong();

        emit EvidenceSubmitted(id, msg.sender, evidenceHash, note);
    }

    // ---------------------------------------------------------------
    // Admin (fees only — never escrowed principal)
    // ---------------------------------------------------------------

    /**
     * @notice Emergency stop for NEW escrow creation and funding only.
     *         Settlement never pauses: pause must never trap user funds.
     */
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Update protocol fee for future escrows. Capped at MAX_FEE_BPS.
    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeExceedsMaximum();
        emit FeeUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    /**
     * @dev Permanently disabled. An accidental renounce would strand accrued
     *      fees forever (withdrawFees is onlyOwner). Transferring to a
     *      multisig via Ownable2Step is the supported path.
     */
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Withdraw accrued protocol fees to `to`.
    function withdrawFees(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = accruedFees;
        if (amount == 0) revert NothingToWithdraw();

        accruedFees = 0;
        token.safeTransfer(to, amount);

        emit FeesWithdrawn(to, amount);
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    /// @notice Full escrow record including description (auto-getter omits it).
    function getEscrow(uint256 id) external view returns (Escrow memory) {
        if (id == 0 || id >= _nextId) revert EscrowNotFound(id);
        return _escrows[id];
    }

    function escrowCount() external view returns (uint256) {
        return _nextId - 1;
    }

    /// @notice True when the timeout path may be executed right now — by
    ///         anyone. Mirrors {claimTimeout} exactly, so a UI button and the
    ///         chain can never disagree.
    function canClaimTimeout(uint256 id) external view returns (bool) {
        Escrow storage e = _escrows[id];
        if (e.state != State.Funded && e.state != State.Disputed) return false;
        if (block.timestamp <= e.deadline + TIMEOUT_GRACE) return false;
        if (e.state == State.Disputed && block.timestamp <= uint256(e.disputedAt) + ARBITER_WINDOW) return false;
        return true;
    }

    /// @notice EIP-712 domain this contract's handshakes are signed under.
    ///         Wallets rebuild the same domain from its parts; auditors can
    ///         compare it against an independent EIP-712 implementation.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this)));
    }

    /**
     * @notice Digest a `Handshake` signature must cover, from the payer's
     *         seat. The UI shows it and the signers rebuild the same typed
     *         data independently — neither side has to trust the other's UI.
     * @dev Reads {handshakeNonces} for `msg.sender` (the payer).
     */
    function handshakeDigest(
        address payee_,
        uint256 amount_,
        uint256 deadline_,
        string calldata description_,
        address arbiter_
    ) external view returns (bytes32) {
        return _handshakeDigest(
            msg.sender,
            payee_,
            arbiter_,
            amount_,
            deadline_,
            handshakeNonces[msg.sender],
            keccak256(bytes(description_))
        );
    }

    /// @notice Milestone slices of `id` — empty for a plain escrow, so the
    ///         same view serves both shapes. Reverts for unknown ids.
    function getMilestones(uint256 id) external view returns (Milestone[] memory) {
        if (id == 0 || id >= _nextId) revert EscrowNotFound(id);
        return _milestones[id];
    }

    /**
     * @notice Digest a `Release` signature must cover, releasing milestone
     *         `index` of escrow `id`. The UI shows it and the payer rebuilds
     *         the same typed data independently — neither side has to trust
     *         the other's UI.
     * @dev Reads {releaseNonces} for this escrow's `index` slot.
     */
    function releaseDigest(uint256 id, uint256 index) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(_RELEASE_TYPEHASH, id, index, releaseNonces[id][index]));
        return keccak256(abi.encode("\x19\x01", domainSeparator(), structHash));
    }

    /**
     * @notice Digest a `ReleaseAll` signature must cover — releases every
     *         remaining slice (or the whole principal of a plain escrow).
     *         Uses its own nonce slot so it never collides with a milestone
     *         release signed for the same escrow.
     */
    function releaseAllDigest(uint256 id) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(_RELEASE_ALL_TYPEHASH, id, releaseNonces[id][type(uint256).max]));
        return keccak256(abi.encode("\x19\x01", domainSeparator(), structHash));
    }

    // ---------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------

    function _validate(
        address payee_,
        uint256 amount_,
        uint256 deadline_,
        string calldata description_,
        address arbiter_
    ) private view {
        if (payee_ == address(0) || arbiter_ == address(0)) revert ZeroAddress();
        if (amount_ == 0) revert ZeroAmount();
        if (payee_ == msg.sender || arbiter_ == msg.sender || arbiter_ == payee_) {
            revert SelfReference();
        }
        if (deadline_ < block.timestamp + MIN_DURATION) revert DeadlineTooSoon();
        if (deadline_ > block.timestamp + MAX_DURATION) revert DeadlineTooFar();
        if (bytes(description_).length > MAX_DESCRIPTION_BYTES) revert DescriptionTooLong();
    }

    function _store(
        address payee_,
        uint256 amount_,
        uint256 deadline_,
        string calldata description_,
        address arbiter_,
        bool consented_
    ) private returns (uint256 id) {
        id = _nextId++;
        _escrows[id] = Escrow({
            payer: msg.sender,
            payee: payee_,
            arbiter: arbiter_,
            amount: amount_,
            feeBps: feeBps,
            deadline: deadline_,
            createdAt: block.timestamp,
            disputedAt: 0,
            consented: consented_,
            state: State.Created,
            description: description_
        });

        emit EscrowCreated(id, msg.sender, payee_, amount_, deadline_, arbiter_, feeBps, consented_, description_);
    }

    function _get(uint256 id) private view returns (Escrow storage e) {
        if (id == 0 || id >= _nextId) revert EscrowNotFound(id);
        e = _escrows[id];
    }

    /**
     * @dev Release everything still outstanding: the whole principal for a
     *      plain escrow, every unsettled slice for a milestone one. Called
     *      by {confirm} and {confirmWithSig} — one code path, so a direct
     *      call and a signed call can never diverge. Sets the terminal state
     *      before any transfer (effects before interactions).
     */
    function _confirmAll(uint256 id, Escrow storage e) private {
        e.state = State.Completed;

        Milestone[] storage ms = _milestones[id];
        if (ms.length == 0) {
            // Plain escrow: identical to v2 — one split, one transfer.
            (uint256 payeeAmount, uint256 fee) = _split(e.amount, e.feeBps);
            _deliver(e.payee, payeeAmount);
            if (fee > 0) {
                accruedFees += fee;
            }
            emit EscrowConfirmed(id, payeeAmount, fee);
            return;
        }

        // Milestone escrow: settle each remaining slice, one transfer for
        // the batch (gas), one event per slice (the ledger stays per-milestone),
        // then the cumulative EscrowConfirmed the timeline already expects.
        uint256 released;
        uint256 releasedFee;
        for (uint256 i = 0; i < ms.length; ++i) {
            if (ms[i].settled) continue;
            ms[i].settled = true;
            (uint256 net, uint256 fee) = _split(ms[i].amount, e.feeBps);
            released += net;
            releasedFee += fee;
            emit MilestoneSettled(id, i, net, fee);
        }

        if (released > 0) _deliver(e.payee, released);
        if (releasedFee > 0) accruedFees += releasedFee;

        (uint256 totalNet, uint256 totalFee) = _totals(id, e.feeBps);
        emit EscrowConfirmed(id, totalNet, totalFee);
    }

    /**
     * @dev Release ONE milestone slice. Sets the terminal state before the
     *      transfer when this was the last unsettled slice, so a completed
     *      milestone escrow reports the same cumulative {EscrowConfirmed}
     *      totals as a batch {confirm}.
     */
    function _settleMilestone(uint256 id, Escrow storage e, uint256 index) private {
        Milestone[] storage ms = _milestones[id];
        if (index >= ms.length) revert MilestoneNotFound(id, index);
        if (ms[index].settled) revert MilestoneAlreadySettled(id, index);

        ms[index].settled = true;
        (uint256 net, uint256 fee) = _split(ms[index].amount, e.feeBps);

        // Was that the last one? Close the escrow before moving money.
        bool complete = true;
        for (uint256 i = 0; i < ms.length; ++i) {
            if (!ms[i].settled) {
                complete = false;
                break;
            }
        }
        if (complete) e.state = State.Completed;

        _deliver(e.payee, net);
        if (fee > 0) accruedFees += fee;

        emit MilestoneSettled(id, index, net, fee);
        if (complete) {
            (uint256 totalNet, uint256 totalFee) = _totals(id, e.feeBps);
            emit EscrowConfirmed(id, totalNet, totalFee);
        }
    }

    /// @dev Cumulative (net, fee) across ALL slices — the totals an
    ///      {EscrowConfirmed} on a milestone escrow must report, whether the
    ///      escrow closed one slice at a time or in a batch.
    function _totals(uint256 id, uint256 feeBps_) private view returns (uint256 net, uint256 fee) {
        Milestone[] storage ms = _milestones[id];
        for (uint256 i = 0; i < ms.length; ++i) {
            (uint256 n, uint256 f) = _split(ms[i].amount, feeBps_);
            net += n;
            fee += f;
        }
    }

    /// @dev (already settled gross, its net to payee, its fee) across the
    ///      slices released so far. A plain escrow reports (0, 0, 0), so the
    ///      timeout refund and the dispute split reduce exactly to v2.
    function _settledTotals(uint256 id, uint256 feeBps_)
        private
        view
        returns (uint256 gross, uint256 net, uint256 fee)
    {
        Milestone[] storage ms = _milestones[id];
        for (uint256 i = 0; i < ms.length; ++i) {
            if (!ms[i].settled) continue;
            gross += ms[i].amount;
            (uint256 n, uint256 f) = _split(ms[i].amount, feeBps_);
            net += n;
            fee += f;
        }
    }

    /**
     * @dev Push `amount` to `to`; if the token refuses, credit instead of
     *      reverting. A low-level call (rather than a typed one) also accepts
     *      non-standard tokens that return no data, and any malformed return
     *      is treated as failure — the credit path is always safe.
     */
    function _deliver(address to, uint256 amount) private {
        if (amount == 0) return;

        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        bool sent = ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
        if (sent) return;

        pendingWithdrawals[to] += amount;
        emit PaymentCredited(to, amount);
    }

    function _handshakeDigest(
        address payer_,
        address payee_,
        address arbiter_,
        uint256 amount_,
        uint256 deadline_,
        uint256 nonce_,
        bytes32 descriptionHash_
    ) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(_HANDSHAKE_TYPEHASH, payer_, payee_, arbiter_, amount_, deadline_, nonce_, descriptionHash_)
        );
        return keccak256(abi.encode("\x19\x01", domainSeparator(), structHash));
    }

    /**
     * @dev EOA signatures go through OpenZeppelin's audited ECDSA (rejects
     *      wrong length, high `s`, bad `v`); contract wallets answer the
     *      ERC-1271 staticcall with the magic value. One code path, two
     *      wallet types, no trust in either caller.
     */
    function _isValidSignature(address signer, bytes32 digest, bytes calldata sig) private view returns (bool) {
        if (signer.code.length == 0) {
            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, sig);
            return err == ECDSA.RecoverError.NoError && recovered == signer;
        }

        (bool ok, bytes memory ret) = signer.staticcall(abi.encodeCall(IERC1271Wallet.isValidSignature, (digest, sig)));
        return ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == IERC1271Wallet.isValidSignature.selector;
    }

    /// @return net Amount sent to the payee.
    /// @return fee  Protocol fee retained.
    function _split(uint256 gross, uint256 feeBps_) private pure returns (uint256 net, uint256 fee) {
        fee = (gross * feeBps_) / BPS_DENOMINATOR;
        net = gross - fee;
    }
}
