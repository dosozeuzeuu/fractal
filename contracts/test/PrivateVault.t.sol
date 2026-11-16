// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {Poseidon2Yul_BN254} from "poseidon2-evm/bn254/yul/Poseidon2Yul.sol";

import {PrivateVault} from "../src/PrivateVault.sol";
import {FeeCollector} from "../src/FeeCollector.sol";
import {Poseidon2Sponge} from "../src/Poseidon2Sponge.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";
import {IPoseidon2, IPoseidon2Sponge} from "../src/interfaces/IPoseidon2.sol";
import {HonkVerifier} from "../src/verifier/HonkVerifier.sol";
import {MockERC20, FeeOnTransferToken} from "./mocks/MockERC20.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";
import {MockWETH, MockSpokePool} from "./mocks/MockAcross.sol";
import {AcrossBridgeAdapter} from "../src/adapters/AcrossBridgeAdapter.sol";
import {AcrossDepositHandler, IWETH9, IShieldVault} from "../src/AcrossDepositHandler.sol";
import {IAcrossSpokePool} from "../src/interfaces/IAcrossSpokePool.sol";

/// @dev Accepts or rejects every proof, or reverts, so vault logic can be tested on its own.
///      Real proofs are covered by packages/sdk/test/e2e.ts.
contract MockVerifier is IVerifier {
    enum Mode { Accept, Reject, Revert }
    Mode public mode;
    function set(Mode m) external { mode = m; }
    function verify(bytes calldata, bytes32[] calldata) external view returns (bool) {
        if (mode == Mode.Revert) revert("bad proof");
        return mode == Mode.Accept;
    }
}

contract RefusesEth {
    receive() external payable { revert("no"); }
}

contract PrivateVaultTest is Test {
    PrivateVault vault;
    MockVerifier verifier;
    FeeCollector collector;
    EntryPoint entryPoint;
    IPoseidon2 hasher;
    IPoseidon2Sponge sponge;
    MockERC20 usd;
    MockERC20 gold;
    MockSwapAdapter dex;

    address constant ETH = address(0);
    address admin = makeAddr("admin");
    address team = makeAddr("team");
    address sink = makeAddr("sink");
    address user = makeAddr("user");
    address carol = makeAddr("carol");
    address stranger = makeAddr("stranger");
    uint256 seed = 1;

    function setUp() public {
        verifier = new MockVerifier();
        hasher = IPoseidon2(address(new Poseidon2Yul_BN254()));
        sponge = IPoseidon2Sponge(address(new Poseidon2Sponge()));
        entryPoint = new EntryPoint();
        collector = new FeeCollector(admin, team, sink);
        PrivateVault impl = new PrivateVault(verifier, hasher, sponge, IEntryPoint(address(entryPoint)));
        vault = PrivateVault(
            payable(
                address(
                    new ERC1967Proxy(
                        address(impl),
                        abi.encodeCall(PrivateVault.initialize, (admin, address(collector), 10 ether, 50 ether, 30))
                    )
                )
            )
        );
        usd = new MockERC20("Test Dollar", "tUSD", 6);
        gold = new MockERC20("Test Gold", "tGOLD", 18);
        dex = new MockSwapAdapter();
        dex.setPrice(ETH, address(usd), 3000e6, 1 ether);
        dex.setPrice(address(usd), address(gold), 1 ether, 2000e6);
        dex.setPrice(address(usd), ETH, 1 ether, 3000e6);
        vm.deal(address(dex), 100 ether);
        vm.startPrank(admin);
        vault.setToken(address(usd), true, 50_000e6, 0);
        vault.setToken(address(gold), true, 20 ether, 0);
        vault.setSwapAdapter(address(dex), true, false);
        vm.stopPrank();
        vm.deal(user, 1_000 ether);
        usd.mint(user, 1_000_000e6);
        vm.prank(user);
        usd.approve(address(vault), type(uint256).max);
    }

    // ----------------------------------------------------------------- helpers

    function _shield(uint256 amount) internal {
        vm.prank(user);
        vault.shield{value: amount}(123, "");
    }

    function _shieldUsd(uint256 amount) internal {
        vm.prank(user);
        vault.shieldToken(address(usd), amount, 456, "");
    }

    function _ext() internal pure returns (PrivateVault.ExtData memory e) {}

    function _tx(address token, uint256 exitAmount, address recipient)
        internal
        returns (PrivateVault.Transaction memory t)
    {
        t.root = vault.getLastRoot();
        uint256 f = vault.FIELD();
        t.nullifiers = [
            uint256(keccak256(abi.encode("a", seed))) % f,
            uint256(keccak256(abi.encode("b", seed))) % f,
            uint256(keccak256(abi.encode("c", seed))) % f
        ];
        t.commitments = [seed * 7, seed * 11, seed * 13];
        seed++;
        t.token = token;
        t.exitAmount = exitAmount;
        t.ext.recipient = recipient;
    }

    function _swapTx(address tokenIn, uint256 amount, address tokenOut, uint256 minOut)
        internal
        returns (PrivateVault.Transaction memory t)
    {
        t = _tx(tokenIn, 0, address(0));
        t.swapAmount = amount;
        t.swapOutStub = 999;
        t.ext.swapTokenOut = tokenOut;
        t.ext.swapMinOut = minOut;
        t.ext.swapAdapter = address(dex);
    }

    function _bal(address token) internal view returns (uint256) {
        return token == ETH ? address(vault).balance : MockERC20(token).balanceOf(address(vault));
    }

    function _solvent(address token) internal view {
        assertEq(
            _bal(token),
            vault.backing(token) + vault.pendingExitTotal(token) + vault.pendingSwapTotal(token) + vault.feesAccrued(token),
            "solvency"
        );
    }

    function _solventAll() internal view {
        _solvent(ETH);
        _solvent(address(usd));
        _solvent(address(gold));
    }

    // ---------------------------------------------------------- initialization

    function test_initialState() public view {
        assertTrue(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(vault.hasRole(vault.GUARDIAN_ROLE(), admin));
        assertTrue(vault.hasRole(vault.UPGRADER_ROLE(), admin));
        (bool listed, uint128 threshold, uint128 cap) = vault.tokens(ETH);
        assertTrue(listed);
        assertEq(threshold, 10 ether);
        assertEq(cap, 50 ether);
        assertEq(vault.swapFeeBps(), 30);
        assertTrue(vault.isKnownRoot(vault.getLastRoot()));
        assertFalse(vault.isKnownRoot(0));
    }

    function test_cannotReinitialize() public {
        vm.expectRevert();
        vault.initialize(stranger, stranger, 1 ether, 0, 0);
    }

    function test_domainSeparatorMatchesEip712() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("fractal"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        assertEq(vault.domainSeparator(), expected);
    }

    function test_spongeMatchesNoir() public view {
        // Reference value from Noir / bb.js: H(1, 2, 3, 4)
        assertEq(sponge.hash_4(1, 2, 3, 4), 0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9);
    }

    // ------------------------------------------------------------------ shield

    function test_shieldEthAndToken() public {
        _shield(1 ether);
        _shieldUsd(500e6);
        assertEq(vault.backing(ETH), 1 ether);
        assertEq(vault.backing(address(usd)), 500e6);
        assertEq(vault.nextIndex(), 4);
        _solventAll();
    }

    function test_shieldRejectsUnlistedAndFeeOnTransfer() public {
        MockERC20 other = new MockERC20("x", "x", 18);
        other.mint(user, 10);
        vm.startPrank(user);
        other.approve(address(vault), 10);
        vm.expectRevert(PrivateVault.TokenNotListed.selector);
        vault.shieldToken(address(other), 10, 1, "");
        vm.stopPrank();

        FeeOnTransferToken fot = new FeeOnTransferToken();
        vm.prank(admin);
        vault.setToken(address(fot), true, 1 ether, 0);
        fot.mint(user, 1000);
        vm.startPrank(user);
        fot.approve(address(vault), 1000);
        vm.expectRevert(PrivateVault.FeeOnTransferToken.selector);
        vault.shieldToken(address(fot), 1000, 1, "");
        vm.stopPrank();
    }

    function test_shieldBoundsAndCap() public {
        vm.startPrank(user);
        vm.expectRevert(PrivateVault.ZeroAmount.selector);
        vault.shield{value: 0}(1, "");
        uint256 f = vault.FIELD();
        vm.expectRevert(abi.encodeWithSignature("NotAFieldElement()"));
        vault.shield{value: 1}(f, "");
        vm.expectRevert(PrivateVault.CiphertextTooLong.selector);
        vault.shield{value: 1}(1, new bytes(513));
        vault.shield{value: 50 ether}(1, "");
        vm.expectRevert(PrivateVault.CapReached.selector);
        vault.shield{value: 1}(1, "");
        vm.stopPrank();
    }

    function test_entriesPaused() public {
        vm.prank(admin);
        vault.setEntriesPaused(true);
        vm.prank(user);
        vm.expectRevert(PrivateVault.EntriesArePaused.selector);
        vault.shield{value: 1 ether}(1, "");
    }

    // ------------------------------------------------------------- withdrawals

    function test_ethWithdrawPaysNetAndTakesFee() public {
        _shield(5 ether);
        vault.transact(_tx(ETH, 2 ether, carol), "");
        assertEq(carol.balance, 1.98 ether);
        assertEq(vault.feesAccrued(ETH), 0.02 ether);
        assertEq(vault.backing(ETH), 3 ether);
        _solventAll();
    }

    function test_tokenWithdraw() public {
        _shieldUsd(1000e6);
        vault.transact(_tx(address(usd), 400e6, carol), "");
        assertEq(usd.balanceOf(carol), 396e6);
        assertEq(vault.feesAccrued(address(usd)), 4e6);
        _solventAll();
    }

    function testFuzz_exitFee(uint96 amount) public {
        vm.assume(amount > 0 && amount <= 10 ether);
        _shield(uint256(amount));
        vault.transact(_tx(ETH, amount, carol), "");
        assertEq(carol.balance, uint256(amount) - uint256(amount) / 100);
        _solventAll();
    }

    function test_privateSendMovesNoValue() public {
        _shield(1 ether);
        vault.transact(_tx(ETH, 0, address(0)), "");
        assertEq(vault.backing(ETH), 1 ether);
        assertEq(vault.nextIndex(), 6); // shield pair + 2 output pairs
        _solventAll();
    }

    function test_delistedTokenCanStillBeWithdrawn() public {
        _shieldUsd(100e6);
        vm.prank(admin);
        vault.setToken(address(usd), false, 50_000e6, 0);
        vault.transact(_tx(address(usd), 100e6, carol), "");
        assertEq(usd.balanceOf(carol), 99e6);
    }

    function test_rejectsInvalidAndRevertingProofs() public {
        _shield(1 ether);
        PrivateVault.Transaction memory t = _tx(ETH, 0.5 ether, carol);
        verifier.set(MockVerifier.Mode.Reject);
        vm.expectRevert(PrivateVault.InvalidProof.selector);
        vault.transact(t, "");
        verifier.set(MockVerifier.Mode.Revert);
        vm.expectRevert(PrivateVault.InvalidProof.selector);
        vault.transact(t, "");
    }

    function test_rejectsDoubleSpendAndDuplicates() public {
        _shield(2 ether);
        PrivateVault.Transaction memory t = _tx(ETH, 0.5 ether, carol);
        vault.transact(t, "");
        t.root = vault.getLastRoot();
        vm.expectRevert(PrivateVault.NullifierAlreadySpent.selector);
        vault.transact(t, "");

        t = _tx(ETH, 0, address(0));
        t.nullifiers[2] = t.nullifiers[0];
        vm.expectRevert(PrivateVault.DuplicateNullifier.selector);
        vault.transact(t, "");

        t = _tx(ETH, 0, address(0));
        t.root = 42;
        vm.expectRevert(PrivateVault.UnknownRoot.selector);
        vault.transact(t, "");
    }

    function test_directPathRules() public {
        _shield(2 ether);
        PrivateVault.Transaction memory t = _tx(ETH, 1 ether, carol);
        t.gasFee = 0.1 ether;
        vm.expectRevert(PrivateVault.GasFeeNotAllowed.selector);
        vault.transact(t, "");

        t = _tx(ETH, 1 ether, carol);
        t.ext.caller = stranger;
        vm.expectRevert(PrivateVault.WrongCaller.selector);
        vault.transact(t, "");
        vm.prank(stranger);
        vault.transact(t, ""); // the named caller may submit

        t = _tx(ETH, 1 ether, address(0));
        vm.expectRevert(PrivateVault.ZeroAddress.selector);
        vault.transact(t, "");
    }

    function test_cannotOverdrawBacking() public {
        _shield(1 ether);
        PrivateVault.Transaction memory t = _tx(ETH, 2 ether, carol);
        vm.expectRevert(); // underflow: the circuit makes this unreachable, the vault still refuses
        vault.transact(t, "");
    }

    // ----------------------------------------------------------------- swaps

    function test_privateSwapEthToToken() public {
        _shield(2 ether);
        PrivateVault.Transaction memory t = _swapTx(ETH, 1 ether, address(usd), 2900e6);
        vault.transact(t, "");
        // 0.3% swap fee on 1 ETH, rest swapped at 3000 tUSD/ETH
        assertEq(vault.feesAccrued(ETH), 0.003 ether);
        assertEq(vault.backing(address(usd)), 2991e6);
        assertEq(vault.backing(ETH), 1 ether);
        (,,address adapter,,,,) = vault.pendingSwaps(bytes32(t.nullifiers[0]));
        assertEq(adapter, address(0), "swap settled");
        _solventAll();
    }

    function test_privateSwapTokenToToken() public {
        _shieldUsd(4000e6);
        vault.transact(_swapTx(address(usd), 2000e6, address(gold), 0.9 ether), "");
        assertEq(vault.backing(address(gold)), 0.997 ether);
        assertEq(vault.feesAccrued(address(usd)), 6e6);
        _solventAll();
    }

    function test_swapToEth() public {
        _shieldUsd(3000e6);
        vault.transact(_swapTx(address(usd), 3000e6, ETH, 0.99 ether), "");
        assertEq(vault.backing(ETH), 0.997 ether);
        _solventAll();
    }

    function test_swapBelowMinOutIsRefundedAsNote() public {
        _shield(2 ether);
        PrivateVault.Transaction memory t = _swapTx(ETH, 1 ether, address(usd), 3500e6);
        vm.recordLogs();
        vault.transact(t, "");
        assertEq(vault.backing(ETH), 2 ether, "full amount back as a note");
        assertEq(vault.feesAccrued(ETH), 0, "no fee on a refund");
        assertEq(vault.backing(address(usd)), 0);
        _solventAll();
    }

    function test_brokenAdapterIsRefunded() public {
        _shieldUsd(1000e6);
        dex.setBroken(true);
        vault.transact(_swapTx(address(usd), 1000e6, address(gold), 1), "");
        assertEq(vault.backing(address(usd)), 1000e6);
        _solventAll();
    }

    function test_swapValidation() public {
        _shield(2 ether);
        PrivateVault.Transaction memory t = _swapTx(ETH, 1 ether, address(usd), 1);
        t.ext.swapAdapter = stranger;
        vm.expectRevert(PrivateVault.BadSwap.selector);
        vault.transact(t, "");

        t = _swapTx(ETH, 1 ether, ETH, 1);
        vm.expectRevert(PrivateVault.BadSwap.selector);
        vault.transact(t, "");

        t = _swapTx(ETH, 1 ether, address(usd), 1);
        t.swapOutStub = 0;
        vm.expectRevert(PrivateVault.BadSwap.selector);
        vault.transact(t, "");

        MockERC20 other = new MockERC20("x", "x", 18);
        t = _swapTx(ETH, 1 ether, address(other), 1);
        vm.expectRevert(PrivateVault.BadSwap.selector);
        vault.transact(t, "");
    }

    function test_swapStepIsSelfOnly() public {
        vm.expectRevert(PrivateVault.WrongCaller.selector);
        vault.swapStep(ETH, address(usd), address(dex), 1, 0, "");
    }

    function test_swapFeeBounds() public {
        vm.startPrank(admin);
        vm.expectRevert(PrivateVault.FeeTooHigh.selector);
        vault.setSwapFee(101);
        vault.setSwapFee(0);
        vm.stopPrank();
        _shield(1 ether);
        vault.transact(_swapTx(ETH, 1 ether, address(usd), 1), "");
        assertEq(vault.backing(address(usd)), 3000e6);
    }

    // -------------------------------------------------------------- large exits

    function test_largeExitHeldStoppedResumedReleased() public {
        _shield(20 ether);
        PrivateVault.Transaction memory t = _tx(ETH, 15 ether, carol);
        vault.transact(t, "");
        bytes32 id = bytes32(t.nullifiers[0]);
        assertEq(carol.balance, 0);
        vm.expectRevert(PrivateVault.ExitNotDue.selector);
        vault.releaseExit(id);

        vm.prank(stranger);
        vm.expectRevert();
        vault.stopExit(id);
        vm.prank(admin);
        vault.stopExit(id);
        vm.warp(block.timestamp + 2 days);
        vault.releaseExit(id);
        assertEq(carol.balance, 0, "stopped");
        vm.prank(admin);
        vault.resumeExit(id);
        vm.prank(stranger);
        vault.releaseExit(id);
        assertEq(carol.balance, 14.85 ether);
        _solventAll();
    }

    function test_tokenLargeExitUsesTokenThreshold() public {
        _shieldUsd(100_000e6);
        PrivateVault.Transaction memory t = _tx(address(usd), 60_000e6, carol);
        vault.transact(t, "");
        assertEq(usd.balanceOf(carol), 0, "held");
        vm.warp(block.timestamp + 1 days);
        vault.releaseExit(bytes32(t.nullifiers[0]));
        assertEq(usd.balanceOf(carol), 59_400e6);
        _solventAll();
    }

    function test_refusedPayoutStaysRecorded() public {
        RefusesEth bad = new RefusesEth();
        _shield(2 ether);
        PrivateVault.Transaction memory t = _tx(ETH, 1 ether, address(bad));
        vault.transact(t, "");
        (, address r, uint128 amount,,) = vault.exits(bytes32(t.nullifiers[0]));
        assertEq(r, address(bad));
        assertEq(amount, 0.99 ether);
        _solventAll();
    }

    // ---------------------------------------------------------- pause & admin

    function test_pauseStopsSpends() public {
        _shield(2 ether);
        vm.prank(stranger);
        vm.expectRevert();
        vault.pause();
        vm.prank(admin);
        vault.pause();
        PrivateVault.Transaction memory t = _tx(ETH, 1 ether, carol);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        vault.transact(t, "");
        vm.prank(admin);
        vault.unpause();
        vault.transact(t, "");
    }

    function test_roles() public {
        bytes32 guardian = vault.GUARDIAN_ROLE();
        vm.startPrank(stranger);
        vm.expectRevert();
        vault.setToken(address(usd), false, 0, 0);
        vm.expectRevert();
        vault.setSwapAdapter(stranger, true, false);
        vm.expectRevert();
        vault.grantRole(guardian, stranger);
        vm.stopPrank();

        vm.prank(admin);
        vault.grantRole(guardian, stranger);
        assertTrue(vault.hasRole(guardian, stranger));
        vm.prank(stranger);
        vault.pause();
        vm.prank(admin);
        vault.revokeRole(guardian, stranger);
        assertFalse(vault.hasRole(guardian, stranger));
    }

    function test_onlyUpgraderUpgrades() public {
        PrivateVault next = new PrivateVault(verifier, hasher, sponge, IEntryPoint(address(entryPoint)));
        vm.prank(stranger);
        vm.expectRevert();
        vault.upgradeToAndCall(address(next), "");
        _shield(1 ether);
        uint256 root = vault.getLastRoot();
        vm.prank(admin);
        vault.upgradeToAndCall(address(next), "");
        assertEq(vault.getLastRoot(), root, "state survives upgrade");
        assertEq(vault.backing(ETH), 1 ether);
    }

    function test_rejectsStrayEth() public {
        vm.prank(user);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // -------------------------------------------------------------- fees

    function test_sweepAndCollectTokenFees() public {
        _shieldUsd(1000e6);
        vault.transact(_tx(address(usd), 1000e6, carol), "");
        vault.sweepFees(address(usd));
        collector.collect(address(usd));
        assertEq(usd.balanceOf(team), 5e6);
        assertEq(usd.balanceOf(sink), 5e6);
        _solventAll();
    }

    // ------------------------------------------------------------ ERC-4337

    function _userOp(PrivateVault.Transaction memory t, uint256 vgl, uint256 cgl, uint256 pvg, uint256 fee)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        bytes32 id = bytes32(t.nullifiers[0]);
        op.sender = address(vault);
        op.nonce = uint256(uint192(uint256(id))) << 64;
        op.callData = abi.encodeCall(PrivateVault.execute4337, (id));
        op.accountGasLimits = bytes32((vgl << 128) | cgl);
        op.preVerificationGas = pvg;
        op.gasFees = bytes32((uint256(1) << 128) | fee);
        op.signature = abi.encode(t, bytes(""));
    }

    function _handle(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(stranger, stranger);
        entryPoint.handleOps(ops, payable(stranger));
    }

    uint256 constant VGL = 2_000_000;
    uint256 constant CGL = 1_500_000;
    uint256 constant PVG = 50_000;
    uint256 constant FEE = 1 gwei;
    uint256 constant GAS = (VGL + CGL + PVG) * FEE;

    function _4337(PrivateVault.Transaction memory t) internal pure returns (PrivateVault.Transaction memory) {
        t.gasFee = GAS;
        t.ext.caller = address(0); // set below by caller
        t.ext.data = abi.encode(CGL);
        return t;
    }

    function test_4337TokenWithdrawPaysGasInEth() public {
        _shield(1 ether);
        _shieldUsd(1000e6);
        PrivateVault.Transaction memory t = _4337(_tx(address(usd), 500e6, carol));
        t.ext.caller = address(vault);
        vm.txGasPrice(FEE);
        _handle(_userOp(t, VGL, CGL, PVG, FEE));
        assertEq(usd.balanceOf(carol), 495e6);
        assertEq(vault.backing(ETH), 1 ether - GAS);
        assertGt(stranger.balance, 0, "bundler paid from notes");
        _solventAll();

        uint256 deposit = entryPoint.balanceOf(address(vault));
        vault.sweepFees(ETH);
        assertEq(address(collector).balance, deposit);
    }

    function test_4337PrivateSwap() public {
        _shield(3 ether);
        PrivateVault.Transaction memory t = _4337(_swapTx(ETH, 1 ether, address(usd), 2900e6));
        t.ext.caller = address(vault);
        vm.txGasPrice(FEE);
        _handle(_userOp(t, VGL, CGL, PVG, FEE));
        assertEq(vault.backing(address(usd)), 2991e6);
        assertEq(vault.backing(ETH), 2 ether - GAS);
        _solventAll();
    }

    function test_4337Rejections() public {
        _shield(5 ether);
        // Gas fee below the operation's maximum cost.
        PrivateVault.Transaction memory t = _4337(_tx(ETH, 0, address(0)));
        t.ext.caller = address(vault);
        t.gasFee = GAS - 1;
        PackedUserOperation memory op = _userOp(t, VGL, CGL, PVG, FEE);
        vm.expectRevert();
        _handle(op);

        // Bundler starves the execution step.
        t = _4337(_tx(ETH, 0, address(0)));
        t.ext.caller = address(vault);
        t.ext.data = abi.encode(CGL + 1);
        op = _userOp(t, VGL, CGL, PVG, FEE);
        vm.expectRevert();
        _handle(op);

        // Proof made for the direct path.
        t = _4337(_tx(ETH, 0, address(0)));
        op = _userOp(t, VGL, CGL, PVG, FEE);
        vm.expectRevert();
        _handle(op);

        // Wrong nonce key.
        t = _4337(_tx(ETH, 0, address(0)));
        t.ext.caller = address(vault);
        op = _userOp(t, VGL, CGL, PVG, FEE);
        op.nonce += 1 << 64;
        vm.expectRevert();
        _handle(op);

        // Invalid proof: nothing is written.
        verifier.set(MockVerifier.Mode.Reject);
        t = _4337(_tx(ETH, 0, address(0)));
        t.ext.caller = address(vault);
        op = _userOp(t, VGL, CGL, PVG, FEE);
        vm.expectRevert();
        _handle(op);
        assertFalse(vault.nullifierSpent(t.nullifiers[0]));
    }

    function test_onlyEntryPointCallsAccountFunctions() public {
        PackedUserOperation memory op;
        vm.expectRevert(PrivateVault.NotEntryPoint.selector);
        vault.validateUserOp(op, bytes32(0), 0);
        vm.expectRevert(PrivateVault.NotEntryPoint.selector);
        vault.execute4337(bytes32(0));
    }

    // ------------------------------------------------------------ verifier

    function test_realVerifierRejectsGarbage() public {
        HonkVerifier real = new HonkVerifier();
        bytes32[] memory inputs = new bytes32[](15);
        vm.expectRevert();
        real.verify(new bytes(9152), inputs);
    }

    // ------------------------------------------------- terminal: any token

    function _meme() internal returns (MockERC20 meme) {
        meme = new MockERC20("Meme", "MEME", 18);
        dex.setPrice(ETH, address(meme), 1_000_000 ether, 1 ether);
        dex.setPrice(address(meme), ETH, 1 ether, 1_000_000 ether);
    }

    function test_unlistedTokenNeedsAutoList() public {
        MockERC20 meme = _meme();
        _shield(2 ether);
        PrivateVault.Transaction memory t = _swapTx(ETH, 1 ether, address(meme), 1);
        vm.expectRevert(PrivateVault.BadSwap.selector);
        vault.transact(t, "");
    }

    function test_autoListBuyThenSellAnyToken() public {
        MockERC20 meme = _meme();
        vm.prank(admin);
        vault.setSwapAdapter(address(0), true, false);
        assertTrue(vault.autoList());
        _shield(2 ether);

        vault.transact(_swapTx(ETH, 1 ether, address(meme), 990_000 ether), "");
        (bool listed, uint128 threshold, uint128 cap) = vault.tokens(address(meme));
        assertTrue(listed, "listed on first buy");
        assertEq(threshold, type(uint128).max, "no hold");
        assertEq(cap, 0, "no cap");
        assertEq(vault.backing(address(meme)), 997_000 ether);
        _solvent(address(meme));
        _solvent(ETH);

        // Sell it all back: 0.3% fee in MEME, the rest at the mock price.
        vault.transact(_swapTx(address(meme), 997_000 ether, ETH, 0.99 ether), "");
        assertEq(vault.backing(address(meme)), 0);
        assertEq(vault.backing(ETH), 1 ether + 0.994009 ether);
        assertEq(vault.feesAccrued(address(meme)), 2_991 ether);
        _solvent(address(meme));
        _solvent(ETH);
    }

    function test_autoListSkipsFailedBuys() public {
        vm.prank(admin);
        vault.setSwapAdapter(address(0), true, false);
        _shield(2 ether);
        address notAToken = makeAddr("eoa");
        vault.transact(_swapTx(ETH, 1 ether, notAToken, 1), "");
        (bool listed,,) = vault.tokens(notAToken);
        assertFalse(listed, "a failed buy lists nothing");
        assertEq(vault.backing(ETH), 2 ether, "refunded in full");
        _solvent(ETH);
    }

    function test_autoListNeverForEth() public {
        vm.prank(admin);
        vault.setSwapAdapter(address(0), true, false);
        _shieldUsd(1000e6);
        vm.prank(admin);
        vault.setToken(ETH, false, 10 ether, 50 ether);
        PrivateVault.Transaction memory t = _swapTx(address(usd), 1000e6, ETH, 1);
        vm.expectRevert(PrivateVault.BadSwap.selector);
        vault.transact(t, "");
    }

    // ---------------------------------------------------- private bridge

    MockWETH weth;
    MockSpokePool spoke;
    AcrossBridgeAdapter bridge;

    function _bridgeSetup() internal {
        weth = new MockWETH();
        spoke = new MockSpokePool(weth);
        bridge = new AcrossBridgeAdapter(IAcrossSpokePool(address(spoke)), address(weth), address(vault));
        vm.prank(admin);
        vault.setSwapAdapter(address(bridge), true, true);
    }

    function _bridgeTx(uint256 amount, uint256 outputAmount) internal returns (PrivateVault.Transaction memory t) {
        t = _swapTx(ETH, amount, ETH, 0);
        t.ext.swapAdapter = address(bridge);
        uint256 net = amount - amount * vault.EXIT_FEE_BPS() / 10_000;
        t.ext.swapData = abi.encode(
            carol, carol, address(weth), address(0xBA5E), net, outputAmount, uint256(8453), address(0),
            uint32(block.timestamp), uint32(block.timestamp + 6 hours), uint32(0)
        );
    }

    function test_bridgeOutPaysAcross() public {
        _bridgeSetup();
        _shield(3 ether);
        PrivateVault.Transaction memory t = _bridgeTx(2 ether, 1.97 ether);
        vm.expectEmit(true, false, false, true, address(vault));
        emit PrivateVault.BridgedOut(bytes32(t.nullifiers[0]), 1.98 ether, 0.02 ether);
        vault.transact(t, "");
        assertEq(spoke.lastValue(), 1.98 ether, "amount less the 1% exit fee");
        assertEq(spoke.arg(0), uint160(carol), "refunds go to the chosen address, never the vault");
        assertEq(spoke.arg(1), uint160(carol), "recipient");
        assertEq(spoke.arg(2), uint160(address(weth)), "input token");
        assertEq(spoke.arg(3), 0xBA5E, "output token");
        assertEq(spoke.arg(4), 1.98 ether, "input amount");
        assertEq(spoke.arg(5), 1.97 ether, "output amount");
        assertEq(spoke.arg(6), 8453, "destination");
        assertEq(spoke.arg(11), 0x180, "message offset");
        assertEq(spoke.arg(12), 0, "empty message");
        // The calldata decodes as a real depositV3 call.
        bytes memory c = spoke.lastCall();
        assertEq(c.length, 4 + 13 * 32);
        assertEq(vault.backing(ETH), 1 ether);
        assertEq(vault.feesAccrued(ETH), 0.02 ether);
        (,, address adapter,,,,) = vault.pendingSwaps(bytes32(t.nullifiers[0]));
        assertEq(adapter, address(0), "settled");
        _solvent(ETH);
    }

    function test_bridgeOutFailureRefundsNote() public {
        _bridgeSetup();
        _shield(3 ether);
        spoke.setBroken(true);
        vault.transact(_bridgeTx(2 ether, 1.97 ether), "");
        assertEq(vault.backing(ETH), 3 ether, "full refund as a note");
        assertEq(vault.feesAccrued(ETH), 0);
        _solvent(ETH);

        // A quote asking for more than it sends is refused by the adapter, also refunded.
        spoke.setBroken(false);
        vault.transact(_bridgeTx(1 ether, 2 ether), "");
        assertEq(vault.backing(ETH), 3 ether);
        _solvent(ETH);
    }

    function test_bridgeOutRules() public {
        _bridgeSetup();
        _shield(20 ether);
        _shieldUsd(1000e6);

        PrivateVault.Transaction memory t = _bridgeTx(11 ether, 10 ether);
        vm.expectRevert(PrivateVault.BadSwap.selector); // above the 10 ETH large-exit threshold
        vault.transact(t, "");

        t = _bridgeTx(1 ether, 0.9 ether);
        t.ext.swapTokenOut = address(usd);
        vm.expectRevert(PrivateVault.BadSwap.selector); // output must be ETH (the refund note)
        vault.transact(t, "");

        t = _swapTx(address(usd), 1000e6, address(usd), 0);
        t.ext.swapAdapter = address(bridge);
        vm.expectRevert(PrivateVault.BadSwap.selector); // ETH only
        vault.transact(t, "");

        vm.prank(admin);
        vault.setSwapAdapter(address(bridge), false, true);
        t = _bridgeTx(1 ether, 0.9 ether);
        vm.expectRevert(PrivateVault.BadSwap.selector); // not allowlisted
        vault.transact(t, "");
    }

    function test_bridgeAdapterAndStepAreGuarded() public {
        _bridgeSetup();
        vm.expectRevert(PrivateVault.WrongCaller.selector);
        vault.bridgeStep(address(bridge), 1, "");
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(AcrossBridgeAdapter.OnlyVault.selector);
        bridge.swap{value: 1 ether}(ETH, ETH, 1 ether, 0, "");
    }

    function test_acrossFillShieldsStraightIntoVault() public {
        _bridgeSetup();
        AcrossDepositHandler handler =
            new AcrossDepositHandler(address(spoke), IWETH9(address(weth)), IShieldVault(address(vault)));
        vm.deal(stranger, 5 ether);
        vm.expectEmit(true, true, true, true, address(vault));
        emit PrivateVault.Shielded(address(handler), ETH, 0, 1.5 ether);
        vm.prank(stranger);
        spoke.fill{value: 1.5 ether}(address(handler), 1.5 ether, abi.encode(uint256(777), bytes("ct")));
        assertEq(vault.backing(ETH), 1.5 ether);
        assertEq(address(handler).balance, 0);
        assertEq(weth.balanceOf(address(handler)), 0);
        _solvent(ETH);

        // Only the SpokePool may call it, and a paused vault makes the fill fail (Across refunds the origin).
        vm.expectRevert(AcrossDepositHandler.OnlySpokePool.selector);
        handler.handleV3AcrossMessage(address(weth), 1, address(0), "");
        vm.prank(admin);
        vault.setEntriesPaused(true);
        vm.prank(stranger);
        vm.expectRevert();
        spoke.fill{value: 1 ether}(address(handler), 1 ether, abi.encode(uint256(778), bytes("")));
    }
}
