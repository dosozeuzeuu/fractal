// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {Poseidon2Yul_BN254} from "poseidon2-evm/bn254/yul/Poseidon2Yul.sol";

import {PrivateVault} from "../src/PrivateVault.sol";
import {FeeCollector} from "../src/FeeCollector.sol";
import {Poseidon2Sponge} from "../src/Poseidon2Sponge.sol";
import {HonkVerifier} from "../src/verifier/HonkVerifier.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";
import {IPoseidon2, IPoseidon2Sponge} from "../src/interfaces/IPoseidon2.sol";
import {UniswapV3Adapter, ISwapRouter02, IWETH} from "../src/adapters/UniswapV3Adapter.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";
import {MockSwapAdapter} from "../test/mocks/MockSwapAdapter.sol";
import {MockWETH, MockSpokePool} from "../test/mocks/MockAcross.sol";
import {AcrossBridgeAdapter} from "../src/adapters/AcrossBridgeAdapter.sol";
import {AcrossDepositHandler, IWETH9, IShieldVault} from "../src/AcrossDepositHandler.sol";
import {IAcrossSpokePool} from "../src/interfaces/IAcrossSpokePool.sol";

/// @notice Deploys fractal.
///
///   Robinhood Chain testnet:  forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast
///   Robinhood Chain mainnet:  forge script script/Deploy.s.sol --rpc-url robinhood --broadcast
///   Local anvil:              forge script script/Deploy.s.sol --rpc-url local --broadcast
///
/// Env: PRIVATE_KEY (deployer), ADMIN, TEAM, BUYBACK_SINK (default TEAM), ENTRY_POINT (default the
/// canonical v0.8 EntryPoint), ETH_LARGE_EXIT (wei, default 10 ETH), ETH_CAP (wei, default 50 ETH,
/// 0 = none), SWAP_FEE_BPS (default 30 = 0.3%), SWAP_ROUTER and WETH (Uniswap; default the Robinhood
/// Chain mainnet addresses on chain 4663, none elsewhere), ACROSS_SPOKE_POOL (default Across's SpokePool
/// on chain 4663), AUTO_LIST (default true: tokens bought privately are listed on first buy).
///
/// The private bridge (AcrossBridgeAdapter out, AcrossDepositHandler in) is deployed wherever a
/// SpokePool and WETH are known; on a local chain against a mock SpokePool.
///
/// On a local chain (31337) it also deploys two test tokens (tUSD, tGOLD) and a fixed-price mock
/// DEX adapter so the app's swap screen works without a real DEX.
contract Deploy is Script {
    address constant CANONICAL_ENTRY_POINT_V08 = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;
    address constant ROBINHOOD_SWAP_ROUTER02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant ROBINHOOD_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant ROBINHOOD_ACROSS_SPOKE_POOL = 0xD29C85F15DF544bA632C9E25829fd29d767d7978;
    uint256 constant LOCAL_CHAIN_ID = 31337;
    uint256 constant ROBINHOOD_CHAIN_ID = 4663;

    struct Out {
        address vault;
        address implementation;
        address entryPoint;
        address feeCollector;
        address adapter;
        address tokenA;
        address tokenB;
        address tokenC;
        address bridgeAdapter;
        address depositHandler;
        address spokePool;
        address weth;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address admin = vm.envOr("ADMIN", vm.addr(pk));
        address team = vm.envOr("TEAM", admin);
        bool local = block.chainid == LOCAL_CHAIN_ID;

        // Refuse a verifier built on a CRS with a public secret anywhere but a local chain.
        bool devVerifier =
            vm.indexOf(vm.readFile("src/verifier/HonkVerifier.sol"), "DEV-ONLY VERIFIER") != type(uint256).max;
        if (devVerifier && !local) {
            revert("DEV-ONLY verifier: rebuild the circuit with Aztec's CRS (circuits/scripts/build.sh)");
        }

        vm.startBroadcast(pk);
        Out memory o;

        o.entryPoint = vm.envOr("ENTRY_POINT", CANONICAL_ENTRY_POINT_V08);
        if (o.entryPoint.code.length == 0) {
            require(local, "no EntryPoint at ENTRY_POINT on this chain");
            o.entryPoint = address(new EntryPoint());
        }

        o.feeCollector = address(new FeeCollector(admin, team, vm.envOr("BUYBACK_SINK", team)));
        PrivateVault impl = new PrivateVault(
            IVerifier(address(new HonkVerifier())),
            IPoseidon2(address(new Poseidon2Yul_BN254())),
            IPoseidon2Sponge(address(new Poseidon2Sponge())),
            IEntryPoint(o.entryPoint)
        );
        o.implementation = address(impl);
        // The deployer initializes as admin so it can list tokens and adapters, then hands over.
        address deployer = vm.addr(pk);
        o.vault = address(
            new ERC1967Proxy(
                address(impl),
                abi.encodeCall(
                    PrivateVault.initialize,
                    (
                        deployer,
                        o.feeCollector,
                        uint128(vm.envOr("ETH_LARGE_EXIT", uint256(10 ether))),
                        uint128(vm.envOr("ETH_CAP", uint256(50 ether))),
                        vm.envOr("SWAP_FEE_BPS", uint256(30))
                    )
                )
            )
        );
        PrivateVault vault = PrivateVault(payable(o.vault));

        address router = vm.envOr("SWAP_ROUTER", block.chainid == ROBINHOOD_CHAIN_ID ? ROBINHOOD_SWAP_ROUTER02 : address(0));
        address weth = vm.envOr("WETH", block.chainid == ROBINHOOD_CHAIN_ID ? ROBINHOOD_WETH : address(0));
        if (router != address(0) && weth != address(0)) {
            o.adapter = address(new UniswapV3Adapter(ISwapRouter02(router), IWETH(weth), o.vault));
            vault.setSwapAdapter(o.adapter, true, false);
        } else if (local) {
            MockERC20 a = new MockERC20("Test Dollar", "tUSD", 6);
            MockERC20 b = new MockERC20("Test Gold", "tGOLD", 18);
            MockSwapAdapter m = new MockSwapAdapter();
            m.setPrice(address(0), address(a), 3000e6, 1 ether); // 1 ETH = 3000 tUSD
            m.setPrice(address(a), address(0), 1 ether, 3000e6);
            m.setPrice(address(a), address(b), 1 ether, 2000e6); // 1 tGOLD = 2000 tUSD
            m.setPrice(address(b), address(a), 2000e6, 1 ether);
            m.setPrice(address(0), address(b), 3, 2); // 1 ETH = 1.5 tGOLD
            m.setPrice(address(b), address(0), 2, 3);
            payable(address(m)).transfer(5 ether);
            // tMEME is left unlisted: the private terminal lists it on its first buy.
            MockERC20 c = new MockERC20("Test Meme", "tMEME", 18);
            m.setPrice(address(0), address(c), 1_000_000, 1); // 1 ETH = 1,000,000 tMEME
            m.setPrice(address(c), address(0), 1, 1_000_000);
            o.tokenC = address(c);
            vault.setToken(address(a), true, 50_000e6, 0);
            vault.setToken(address(b), true, 20 ether, 0);
            vault.setSwapAdapter(address(m), true, false);
            o.adapter = address(m);
            o.tokenA = address(a);
            o.tokenB = address(b);
        }

        // Private bridge through Across.
        o.weth = weth;
        o.spokePool = vm.envOr("ACROSS_SPOKE_POOL", block.chainid == ROBINHOOD_CHAIN_ID ? ROBINHOOD_ACROSS_SPOKE_POOL : address(0));
        if (local && o.spokePool == address(0)) {
            MockWETH w = new MockWETH();
            o.weth = address(w);
            o.spokePool = address(new MockSpokePool(w));
        }
        if (o.spokePool != address(0) && o.weth != address(0)) {
            require(o.spokePool.code.length != 0, "no Across SpokePool at ACROSS_SPOKE_POOL");
            o.bridgeAdapter = address(new AcrossBridgeAdapter(IAcrossSpokePool(o.spokePool), o.weth, o.vault));
            o.depositHandler =
                address(new AcrossDepositHandler(o.spokePool, IWETH9(o.weth), IShieldVault(o.vault)));
            vault.setSwapAdapter(o.bridgeAdapter, true, true);
        }
        if (vm.envOr("AUTO_LIST", true)) vault.setSwapAdapter(address(0), true, false);
        if (admin != deployer) {
            vault.grantRole(vault.DEFAULT_ADMIN_ROLE(), admin);
            vault.grantRole(vault.UPGRADER_ROLE(), admin);
            vault.grantRole(vault.GUARDIAN_ROLE(), admin);
            vault.renounceRole(vault.GUARDIAN_ROLE());
            vault.renounceRole(vault.UPGRADER_ROLE());
            vault.renounceRole(vault.DEFAULT_ADMIN_ROLE());
        }
        vm.stopBroadcast();

        string memory j = "deployment";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeUint(j, "startBlock", block.number);
        vm.serializeAddress(j, "implementation", o.implementation);
        vm.serializeAddress(j, "feeCollector", o.feeCollector);
        vm.serializeAddress(j, "entryPoint", o.entryPoint);
        vm.serializeAddress(j, "swapAdapter", o.adapter);
        vm.serializeAddress(j, "tokenA", o.tokenA);
        vm.serializeAddress(j, "tokenB", o.tokenB);
        vm.serializeAddress(j, "tokenC", o.tokenC);
        vm.serializeAddress(j, "bridgeAdapter", o.bridgeAdapter);
        vm.serializeAddress(j, "depositHandler", o.depositHandler);
        vm.serializeAddress(j, "spokePool", o.spokePool);
        vm.serializeAddress(j, "weth", o.weth);
        vm.serializeBool(j, "devVerifier", devVerifier);
        string memory json = vm.serializeAddress(j, "vault", o.vault);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
        console2.log("vault (proxy)", o.vault);
    }
}
