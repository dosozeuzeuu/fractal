// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAccount} from "@account-abstraction/contracts/interfaces/IAccount.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";

import {NoteTree} from "./NoteTree.sol";
import {IPoseidon2, IPoseidon2Sponge} from "./interfaces/IPoseidon2.sol";
import {IVerifier} from "./interfaces/IVerifier.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";

/// @title PrivateVault (fractal)
/// @notice A shielded pool for ETH and listed ERC-20 tokens. Deposits become encrypted notes only
///         their owner's keys can read. Notes are spent with a zero-knowledge proof of the `transact`
///         circuit, which also checks the owner's wallet signature. A spend can pay another user
///         privately, withdraw to a public address, or swap privately through an allowlisted DEX
///         adapter (the vault creates the output note). The vault is also its own ERC-4337 account,
///         so private actions pay gas from the notes and the user's address never appears on-chain.
contract PrivateVault is
    Initializable,
    NoteTree,
    UUPSUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    IAccount
{
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types

    struct ExtData {
        address recipient; // receives the withdrawal, less the exit fee
        address caller; // if non-zero, the only allowed submitter (the vault itself for ERC-4337)
        bytes data; // ERC-4337: abi.encode(minCallGasLimit)
        address swapTokenOut; // swap: token the output note is in (address(0) = ETH)
        uint256 swapMinOut; // swap: minimum output, else the swap is refunded as a note
        address swapAdapter; // swap: allowlisted DEX adapter
        bytes swapData; // swap: adapter route data (e.g. Uniswap fee tier or path)
        bytes ciphertext0;
        bytes ciphertext1;
        bytes ciphertext2;
        bytes ciphertextSwap; // encrypted secrets of the swap output note
    }

    struct Transaction {
        uint256 root;
        uint256[3] nullifiers;
        uint256[3] commitments;
        address token; // main-lane token (address(0) = ETH)
        uint256 exitAmount; // main-lane token paid out publicly (before the exit fee)
        uint256 swapAmount; // main-lane token sent to the swap
        uint256 swapOutStub; // stub of the swap output note
        uint256 gasFee; // ETH paying for the ERC-4337 operation (zero on the direct path)
        ExtData ext;
    }

    struct TokenInfo {
        bool listed;
        uint128 largeExitThreshold; // exits above this wait LARGE_EXIT_DELAY
        uint128 cap; // max backing in the vault; 0 = no cap
    }

    struct Exit {
        address token;
        address recipient;
        uint128 amount; // net, after the exit fee
        uint64 payableAt; // 0 = not yet scheduled
        bool stopped;
    }

    struct PendingSwap {
        address tokenIn;
        address tokenOut;
        address adapter;
        uint128 amountIn;
        uint128 minOut;
        uint256 stub;
        bytes data;
    }

    // -------------------------------------------------------------- constants

    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    address public constant ETH = address(0);
    uint256 public constant EXIT_FEE_BPS = 100; // 1%
    uint256 public constant MAX_SWAP_FEE_BPS = 100; // 1%
    uint256 public constant LARGE_EXIT_DELAY = 24 hours;
    uint256 public constant MAX_AMOUNT = 1 << 120;
    uint256 public constant MAX_CIPHERTEXT = 512;
    uint256 public constant NUM_PUBLIC_INPUTS = 15;

    uint256 internal constant SIG_VALIDATION_FAILED = 1;

    // -------------------------------------------------------------- immutables

    IVerifier public immutable verifier;
    IEntryPoint public immutable entryPoint;
    IPoseidon2Sponge internal immutable sponge;

    // ------------------------------------------------------------------ state

    mapping(bytes32 => mapping(address => bool)) internal _roles;
    mapping(uint256 => bool) public nullifierSpent;
    mapping(address => uint256) internal _opk;
    mapping(address => bytes32) internal _viewKey;
    mapping(address => TokenInfo) public tokens;
    mapping(address => bool) public swapAdapters;
    mapping(bytes32 => Exit) public exits;
    mapping(bytes32 => PendingSwap) public pendingSwaps;

    mapping(address => uint256) public backing; // per token: value behind unspent notes
    mapping(address => uint256) public pendingExitTotal; // per token: owed to recorded exits
    mapping(address => uint256) public pendingSwapTotal; // per token: waiting to be swapped
    mapping(address => uint256) public feesAccrued; // per token: exit and swap fees not yet swept

    address public feeCollector;
    uint256 public swapFeeBps;
    bool public entriesPaused;
    bool public autoList; // a token bought privately is listed on its first buy (no hold, no cap)
    mapping(address => bool) public bridgeAdapters; // routes a private amount out to another chain

    uint256[39] private __vaultGap;

    // ----------------------------------------------------------------- events

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
    event KeysRegistered(address indexed owner, uint256 opk, bytes32 viewKey);
    event Shielded(address indexed from, address indexed token, uint32 indexed index, uint256 amount);
    event NoteAdded(uint32 indexed index, uint256 commitment, bytes ciphertext);
    event NullifierSpent(uint256 indexed nullifier);
    event ExitCreated(bytes32 indexed exitId, address indexed token, address indexed recipient, uint256 amount, uint256 fee);
    event ExitHeld(bytes32 indexed exitId, uint256 payableAt);
    event ExitPaid(bytes32 indexed exitId, address indexed recipient, uint256 amount);
    event ExitPayoutFailed(bytes32 indexed exitId);
    event ExitStopped(bytes32 indexed exitId);
    event ExitResumed(bytes32 indexed exitId);
    event GasPaid(bytes32 indexed id, uint256 gasFee);
    event SwapRequested(
        bytes32 indexed swapId, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 minOut, bytes ciphertext
    );
    event SwapSettled(bytes32 indexed swapId, uint32 indexed index, address token, uint256 amount, uint256 fee, bool refunded);
    event FeesSwept(address indexed token, uint256 fees, uint256 unusedGas);
    event TokenSet(address indexed token, bool listed, uint256 largeExitThreshold, uint256 cap);
    event SwapAdapterSet(address indexed adapter, bool allowed, bool bridge);
    event BridgedOut(bytes32 indexed swapId, uint256 amount, uint256 fee); // ETH sent to the bridge, exit fee
    event SwapFeeSet(uint256 bps);
    event EntriesPaused(bool paused);
    event FeeCollectorSet(address collector);

    // ----------------------------------------------------------------- errors

    error Unauthorized(bytes32 role);
    error ZeroAddress();
    error ZeroAmount();
    error AmountTooLarge();
    error EntriesArePaused();
    error CapReached();
    error TokenNotListed();
    error FeeOnTransferToken();
    error CiphertextTooLong();
    error UnknownRoot();
    error DuplicateNullifier();
    error NullifierAlreadySpent();
    error GasFeeNotAllowed();
    error GasFeeBelowCost();
    error WrongCaller();
    error InvalidProof();
    error NotEntryPoint();
    error BadUserOp();
    error BadSwap();
    error UnknownExit();
    error ExitNotDue();
    error FeeTooHigh();
    error TransferFailed();

    // ------------------------------------------------------------ construction

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(IVerifier verifier_, IPoseidon2 hasher_, IPoseidon2Sponge sponge_, IEntryPoint entryPoint_)
        NoteTree(hasher_)
    {
        if (
            address(verifier_) == address(0) || address(hasher_) == address(0) || address(sponge_) == address(0)
                || address(entryPoint_) == address(0)
        ) revert ZeroAddress();
        verifier = verifier_;
        sponge = sponge_;
        entryPoint = entryPoint_;
        _disableInitializers();
    }

    function initialize(
        address admin,
        address feeCollector_,
        uint128 ethLargeExitThreshold,
        uint128 ethCap,
        uint256 swapFeeBps_
    ) external initializer {
        if (admin == address(0) || feeCollector_ == address(0)) revert ZeroAddress();
        if (swapFeeBps_ > MAX_SWAP_FEE_BPS) revert FeeTooHigh();
        __Pausable_init();
        __ReentrancyGuard_init();
        _initTree();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
        feeCollector = feeCollector_;
        swapFeeBps = swapFeeBps_;
        tokens[ETH] = TokenInfo(true, ethLargeExitThreshold, ethCap);
        emit TokenSet(ETH, true, ethLargeExitThreshold, ethCap);
    }

    // ------------------------------------------------------------------ roles

    modifier onlyRole(bytes32 role) {
        if (!_roles[role][msg.sender]) revert Unauthorized(role);
        _;
    }

    function hasRole(bytes32 role, address account) public view returns (bool) {
        return _roles[role][account];
    }

    function grantRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(role, account);
    }

    function revokeRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _roles[role][account] = false;
        emit RoleRevoked(role, account, msg.sender);
    }

    function renounceRole(bytes32 role) external {
        _roles[role][msg.sender] = false;
        emit RoleRevoked(role, msg.sender, msg.sender);
    }

    function _grantRole(bytes32 role, address account) internal {
        if (account == address(0)) revert ZeroAddress();
        _roles[role][account] = true;
        emit RoleGranted(role, account, msg.sender);
    }

    // ------------------------------------------------------------------- keys

    /// @notice Publishes the caller's owner key and X25519 viewing key so others can pay them privately.
    function register(uint256 opk, bytes32 viewKey) external {
        if (opk == 0 || opk >= FIELD) revert NotAFieldElement();
        _opk[msg.sender] = opk;
        _viewKey[msg.sender] = viewKey;
        emit KeysRegistered(msg.sender, opk, viewKey);
    }

    function keysOf(address owner) external view returns (uint256 opk, bytes32 viewKey) {
        return (_opk[owner], _viewKey[owner]);
    }

    // ----------------------------------------------------------------- shield

    /// @notice Deposits ETH as a new note. `stub = H(opk, rho, r)` comes from the depositor's app;
    ///         the vault completes the commitment with the amount it actually received.
    function shield(uint256 stub, bytes calldata ciphertext) external payable whenNotPaused nonReentrant {
        _shield(ETH, msg.value, stub, ciphertext);
    }

    /// @notice Deposits a listed ERC-20 token as a new note (approve the vault first).
    function shieldToken(address token, uint256 amount, uint256 stub, bytes calldata ciphertext)
        external
        whenNotPaused
        nonReentrant
    {
        if (token == ETH) revert TokenNotListed();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert FeeOnTransferToken();
        _shield(token, amount, stub, ciphertext);
    }

    function _shield(address token, uint256 amount, uint256 stub, bytes calldata ciphertext) internal {
        if (entriesPaused) revert EntriesArePaused();
        TokenInfo memory info = tokens[token];
        if (!info.listed) revert TokenNotListed();
        if (stub >= FIELD) revert NotAFieldElement();
        if (amount == 0) revert ZeroAmount();
        if (amount >= MAX_AMOUNT) revert AmountTooLarge();
        if (ciphertext.length > MAX_CIPHERTEXT) revert CiphertextTooLong();
        uint256 b = backing[token] + amount;
        if (info.cap != 0 && b > info.cap) revert CapReached();
        backing[token] = b;

        uint256 cm = sponge.hash_4(1, stub, amount, uint160(token));
        uint32 index = _insertPair(cm, 0);
        emit Shielded(msg.sender, token, index, amount);
        emit NoteAdded(index, cm, ciphertext);
        emit NoteAdded(index + 1, 0, "");
    }

    // ---------------------------------------------------- private transactions

    /// @notice Direct path: any account submits a proof and pays its own gas (that account is visible).
    function transact(Transaction calldata t, bytes calldata proof) external whenNotPaused nonReentrant {
        if (t.ext.caller != address(0) && t.ext.caller != msg.sender) revert WrongCaller();
        if (t.ext.caller == address(this)) revert WrongCaller();
        if (t.gasFee != 0) revert GasFeeNotAllowed();
        Transaction memory m = t;
        _check(m);
        if (!_verify(proof, _publicInputs(m))) revert InvalidProof();
        bytes32 id = _apply(m);
        _finish(id);
    }

    /// @notice ERC-4337 validation: the proof is the signature. Spends the notes, records the exit or
    ///         swap and deposits the gas fee with the EntryPoint. No external calls but the verifier,
    ///         the hashers and EntryPoint.depositTo, and no banned opcodes.
    function validateUserOp(PackedUserOperation calldata userOp, bytes32, uint256)
        external
        override
        whenNotPaused
        returns (uint256 validationData)
    {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
        if (userOp.initCode.length != 0 || userOp.paymasterAndData.length != 0) revert BadUserOp();

        (Transaction memory t, bytes memory proof) = abi.decode(userOp.signature, (Transaction, bytes));
        bytes32 id = bytes32(t.nullifiers[0]);

        // Shape: one operation per first nullifier, calling execute4337(id).
        if (keccak256(userOp.callData) != keccak256(abi.encodeCall(this.execute4337, (id)))) revert BadUserOp();
        if (userOp.nonce != uint256(uint192(uint256(id))) << 64) revert BadUserOp();
        if (t.ext.caller != address(this)) revert WrongCaller();

        // Gas: the operation's maximum cost must be covered by the proven gas fee, and the bundler
        // may not starve the execution step (exit payout or swap) below the signed minimum.
        uint256 verificationGasLimit = uint128(bytes16(userOp.accountGasLimits));
        uint256 callGasLimit = uint128(uint256(userOp.accountGasLimits));
        uint256 maxFeePerGas = uint128(uint256(userOp.gasFees));
        if (t.ext.data.length != 32) revert BadUserOp();
        if (callGasLimit < abi.decode(t.ext.data, (uint256))) revert BadUserOp();
        if (t.gasFee < (verificationGasLimit + callGasLimit + userOp.preVerificationGas) * maxFeePerGas) {
            revert GasFeeBelowCost();
        }

        _check(t);
        if (!_verify(proof, _publicInputs(t))) return SIG_VALIDATION_FAILED;

        _apply(t);
        entryPoint.depositTo{value: t.gasFee}(address(this));
        emit GasPaid(id, t.gasFee);
        return 0;
    }

    /// @notice ERC-4337 execution: pays (or schedules) the exit and runs the swap recorded in validation.
    function execute4337(bytes32 id) external whenNotPaused nonReentrant {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
        _finish(id);
    }

    function _finish(bytes32 id) internal {
        if (exits[id].recipient != address(0)) _settle(id);
        if (pendingSwaps[id].adapter != address(0)) _executeSwap(id);
    }

    // ------------------------------------------------------------------ swaps

    /// @notice Runs a recorded swap whose execution step did not happen (e.g. it ran out of gas).
    function executeSwap(bytes32 swapId) external whenNotPaused nonReentrant {
        if (pendingSwaps[swapId].adapter == address(0)) revert BadSwap();
        _executeSwap(swapId);
    }

    function _executeSwap(bytes32 id) internal {
        PendingSwap memory s = pendingSwaps[id];
        delete pendingSwaps[id];
        pendingSwapTotal[s.tokenIn] -= s.amountIn;

        bool bridge = bridgeAdapters[s.adapter];
        uint256 fee = uint256(s.amountIn) * (bridge ? EXIT_FEE_BPS : swapFeeBps) / 10_000;
        uint256 amountOut;
        bool ok;
        if (bridge) {
            try this.bridgeStep(s.adapter, s.amountIn - fee, s.data) {
                feesAccrued[s.tokenIn] += fee;
                emit BridgedOut(id, s.amountIn - fee, fee);
                return;
            } catch {}
        } else if (
            swapAdapters[s.adapter]
                && (tokens[s.tokenOut].listed || (autoList && s.tokenOut != ETH && s.tokenOut != s.tokenIn))
        ) {
            try this.swapStep(s.tokenIn, s.tokenOut, s.adapter, s.amountIn - fee, s.minOut, s.data) returns (
                uint256 out
            ) {
                amountOut = out;
                ok = true;
                // First successful buy of an unlisted token lists it: no 24-hour hold, no cap.
                if (!tokens[s.tokenOut].listed) {
                    tokens[s.tokenOut] = TokenInfo(true, type(uint128).max, 0);
                    emit TokenSet(s.tokenOut, true, type(uint128).max, 0);
                }
            } catch {}
        }

        address noteToken;
        uint256 noteAmount;
        if (ok) {
            feesAccrued[s.tokenIn] += fee;
            noteToken = s.tokenOut;
            noteAmount = amountOut;
        } else {
            // Refund the full amount (no fee) as a note to the same owner.
            fee = 0;
            noteToken = s.tokenIn;
            noteAmount = s.amountIn;
        }
        backing[noteToken] += noteAmount;
        uint256 cm = sponge.hash_4(1, s.stub, noteAmount, uint160(noteToken));
        uint32 index = _insertPair(cm, 0);
        emit SwapSettled(id, index, noteToken, noteAmount, fee, !ok);
        emit NoteAdded(index, cm, "");
        emit NoteAdded(index + 1, 0, "");
    }

    /// @dev External so a failed swap reverts only this step. Callable by the vault itself only.
    function swapStep(
        address tokenIn,
        address tokenOut,
        address adapter,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata data
    ) external returns (uint256 amountOut) {
        if (msg.sender != address(this)) revert WrongCaller();
        uint256 inBefore = _balance(tokenIn);
        uint256 outBefore = _balance(tokenOut);
        if (tokenIn == ETH) {
            ISwapAdapter(adapter).swap{value: amountIn}(tokenIn, tokenOut, amountIn, minOut, data);
        } else {
            IERC20(tokenIn).safeTransfer(adapter, amountIn);
            ISwapAdapter(adapter).swap(tokenIn, tokenOut, amountIn, minOut, data);
        }
        amountOut = _balance(tokenOut) - outBefore;
        if (amountOut < minOut || amountOut == 0 || amountOut >= MAX_AMOUNT) revert BadSwap();
        if (inBefore - _balance(tokenIn) > amountIn) revert BadSwap();
    }

    /// @dev Sends exactly `amount` ETH out through a bridge adapter. Callable by the vault itself only.
    function bridgeStep(address adapter, uint256 amount, bytes calldata data) external {
        if (msg.sender != address(this)) revert WrongCaller();
        uint256 before = address(this).balance;
        ISwapAdapter(adapter).swap{value: amount}(ETH, ETH, amount, 0, data);
        if (before - address(this).balance != amount) revert BadSwap();
    }

    function _balance(address token) internal view returns (uint256) {
        return token == ETH ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    // ------------------------------------------------------------------ exits

    /// @notice Pays an exit that was held for 24 hours, or one whose payout failed. Anyone may call.
    function releaseExit(bytes32 exitId) external whenNotPaused nonReentrant {
        Exit storage e = exits[exitId];
        if (e.recipient == address(0)) revert UnknownExit();
        if (e.payableAt != 0 && block.timestamp < e.payableAt) revert ExitNotDue();
        _settle(exitId);
    }

    function _settle(bytes32 exitId) internal {
        Exit storage e = exits[exitId];
        if (e.stopped || e.recipient == address(0)) return;
        if (e.payableAt == 0) {
            if (e.amount > tokens[e.token].largeExitThreshold) {
                uint64 due = uint64(block.timestamp + LARGE_EXIT_DELAY);
                e.payableAt = due;
                emit ExitHeld(exitId, due);
                return;
            }
        } else if (block.timestamp < e.payableAt) {
            return;
        }

        Exit memory x = e;
        delete exits[exitId];
        pendingExitTotal[x.token] -= x.amount;
        if (_send(x.token, x.recipient, x.amount)) {
            emit ExitPaid(exitId, x.recipient, x.amount);
        } else {
            // Keep it recorded; anyone can retry with releaseExit.
            exits[exitId] = Exit(x.token, x.recipient, x.amount, uint64(block.timestamp), false);
            pendingExitTotal[x.token] += x.amount;
            emit ExitPayoutFailed(exitId);
        }
    }

    function _send(address token, address to, uint256 amount) internal returns (bool ok) {
        if (token == ETH) {
            (ok,) = to.call{value: amount}("");
        } else {
            bytes memory ret;
            (ok, ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
            ok = ok && (ret.length == 0 ? token.code.length != 0 : abi.decode(ret, (bool)));
        }
    }

    // ------------------------------------------------------------------- fees

    /// @notice Sends a token's accrued fees (and, for ETH, gas the EntryPoint did not use) to the collector.
    function sweepFees(address token) external nonReentrant {
        uint256 unused;
        if (token == ETH) {
            unused = entryPoint.balanceOf(address(this));
            if (unused != 0) entryPoint.withdrawTo(payable(address(this)), unused);
        }
        uint256 fees = feesAccrued[token];
        feesAccrued[token] = 0;
        uint256 total = fees + unused;
        if (total != 0 && !_send(token, feeCollector, total)) revert TransferFailed();
        emit FeesSwept(token, fees, unused);
    }

    /// @dev Accepts ETH from the EntryPoint (withdrawTo) and from allowlisted swap adapters only.
    receive() external payable {
        if (msg.sender != address(entryPoint) && !swapAdapters[msg.sender]) revert WrongCaller();
    }

    // ------------------------------------------------------------- internals

    /// @dev The generated verifier reverts on most malformed proofs; treat any revert as invalid.
    function _verify(bytes memory proof, bytes32[] memory inputs) internal view returns (bool) {
        try verifier.verify(proof, inputs) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function _check(Transaction memory t) internal view {
        if (!isKnownRoot(t.root)) revert UnknownRoot();
        uint256[3] memory nf = t.nullifiers;
        if (nf[0] == nf[1] || nf[0] == nf[2] || nf[1] == nf[2]) revert DuplicateNullifier();
        for (uint256 i = 0; i < 3; i++) {
            if (nf[i] >= FIELD || t.commitments[i] >= FIELD) revert NotAFieldElement();
            if (nullifierSpent[nf[i]]) revert NullifierAlreadySpent();
        }
        // Spending is allowed for delisted tokens too, so holders can always withdraw.
        if (t.exitAmount >= MAX_AMOUNT || t.swapAmount >= MAX_AMOUNT || t.gasFee >= MAX_AMOUNT) {
            revert AmountTooLarge();
        }
        if (t.exitAmount != 0 && t.ext.recipient == address(0)) revert ZeroAddress();
        if (t.swapAmount != 0) {
            address out = t.ext.swapTokenOut;
            // A bridge-out is ETH only, names ETH as the output (the refund note) and stays under the
            // large-exit threshold, so it can't skip the 24-hour hold.
            bool bad = bridgeAdapters[t.ext.swapAdapter]
                ? out != ETH || t.token != ETH || t.swapAmount > tokens[ETH].largeExitThreshold
                : !swapAdapters[t.ext.swapAdapter] || out == t.token
                    || !(tokens[out].listed || (autoList && out != ETH));
            if (
                bad || t.swapOutStub == 0 || t.swapOutStub >= FIELD || t.ext.swapMinOut >= MAX_AMOUNT
                    || t.ext.swapData.length > MAX_CIPHERTEXT
            ) revert BadSwap();
        }
        ExtData memory e = t.ext;
        if (
            e.ciphertext0.length > MAX_CIPHERTEXT || e.ciphertext1.length > MAX_CIPHERTEXT
                || e.ciphertext2.length > MAX_CIPHERTEXT || e.ciphertextSwap.length > MAX_CIPHERTEXT
        ) revert CiphertextTooLong();
    }

    /// @dev Spends the nullifiers, inserts the outputs, takes the exit fee and records exit and swap.
    function _apply(Transaction memory t) internal returns (bytes32 id) {
        id = bytes32(t.nullifiers[0]);
        for (uint256 i = 0; i < 3; i++) {
            nullifierSpent[t.nullifiers[i]] = true;
            emit NullifierSpent(t.nullifiers[i]);
        }
        uint32 index = _insertPair(t.commitments[0], t.commitments[1]);
        emit NoteAdded(index, t.commitments[0], t.ext.ciphertext0);
        emit NoteAdded(index + 1, t.commitments[1], t.ext.ciphertext1);
        index = _insertPair(t.commitments[2], 0);
        emit NoteAdded(index, t.commitments[2], t.ext.ciphertext2);
        emit NoteAdded(index + 1, 0, "");

        backing[t.token] -= t.exitAmount + t.swapAmount;
        backing[ETH] -= t.gasFee;

        if (t.exitAmount != 0) {
            uint256 fee = t.exitAmount * EXIT_FEE_BPS / 10_000;
            uint256 net = t.exitAmount - fee;
            feesAccrued[t.token] += fee;
            exits[id] = Exit(t.token, t.ext.recipient, uint128(net), 0, false);
            pendingExitTotal[t.token] += net;
            emit ExitCreated(id, t.token, t.ext.recipient, net, fee);
        }
        if (t.swapAmount != 0) {
            pendingSwaps[id] = PendingSwap(
                t.token,
                t.ext.swapTokenOut,
                t.ext.swapAdapter,
                uint128(t.swapAmount),
                uint128(t.ext.swapMinOut),
                t.swapOutStub,
                t.ext.swapData
            );
            pendingSwapTotal[t.token] += t.swapAmount;
            emit SwapRequested(id, t.token, t.ext.swapTokenOut, t.swapAmount, t.ext.swapMinOut, t.ext.ciphertextSwap);
        }
    }

    function _publicInputs(Transaction memory t) internal view returns (bytes32[] memory inputs) {
        bytes32 domain = domainSeparator();
        inputs = new bytes32[](NUM_PUBLIC_INPUTS);
        inputs[0] = bytes32(t.root);
        inputs[1] = bytes32(t.nullifiers[0]);
        inputs[2] = bytes32(t.nullifiers[1]);
        inputs[3] = bytes32(t.nullifiers[2]);
        inputs[4] = bytes32(t.commitments[0]);
        inputs[5] = bytes32(t.commitments[1]);
        inputs[6] = bytes32(t.commitments[2]);
        inputs[7] = bytes32(uint256(uint160(t.token)));
        inputs[8] = bytes32(t.exitAmount);
        inputs[9] = bytes32(t.swapAmount);
        inputs[10] = bytes32(t.swapOutStub);
        inputs[11] = bytes32(t.gasFee);
        inputs[12] = bytes32(_extDataHash(t.ext));
        inputs[13] = bytes32(uint256(domain) >> 128);
        inputs[14] = bytes32(uint256(uint128(uint256(domain))));
    }

    /// @dev keccak256(abi.encode(ext)) reduced into the BN254 scalar field (apps compute it the same way).
    function _extDataHash(ExtData memory ext) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(ext))) % FIELD;
    }

    /// @notice EIP-712 domain: name "fractal", version "1", this chain, this vault (the proxy).
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("fractal"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    // ------------------------------------------------------------------ admin

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
    }

    function setEntriesPaused(bool paused_) external onlyRole(GUARDIAN_ROLE) {
        entriesPaused = paused_;
        emit EntriesPaused(paused_);
    }

    function stopExit(bytes32 exitId) external onlyRole(GUARDIAN_ROLE) {
        if (exits[exitId].recipient == address(0)) revert UnknownExit();
        exits[exitId].stopped = true;
        emit ExitStopped(exitId);
    }

    function resumeExit(bytes32 exitId) external onlyRole(GUARDIAN_ROLE) {
        if (exits[exitId].recipient == address(0)) revert UnknownExit();
        exits[exitId].stopped = false;
        emit ExitResumed(exitId);
    }

    /// @notice Lists, updates or delists a token. Delisting stops new deposits and swaps into it;
    ///         existing notes can still be sent and withdrawn.
    function setToken(address token, bool listed, uint128 largeExitThreshold, uint128 cap)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        tokens[token] = TokenInfo(listed, largeExitThreshold, cap);
        emit TokenSet(token, listed, largeExitThreshold, cap);
    }

    /// @notice Allowlists a swap adapter (`bridge` false) or a bridge-out adapter (`bridge` true).
    ///         `adapter` = address(0) instead switches auto-listing of bought tokens to `allowed`.
    function setSwapAdapter(address adapter, bool allowed, bool bridge) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (adapter == address(0)) autoList = allowed;
        else if (bridge) bridgeAdapters[adapter] = allowed;
        else swapAdapters[adapter] = allowed;
        emit SwapAdapterSet(adapter, allowed, bridge);
    }

    function setSwapFee(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_SWAP_FEE_BPS) revert FeeTooHigh();
        swapFeeBps = bps;
        emit SwapFeeSet(bps);
    }

    function setFeeCollector(address collector) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (collector == address(0)) revert ZeroAddress();
        feeCollector = collector;
        emit FeeCollectorSet(collector);
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
