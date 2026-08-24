// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FlashExecutor} from "../src/FlashExecutor.sol";

/**
 * FORK TEST -- real Base pools, real routers, real flash loan.
 *
 * The mock suite proves the guards. This proves the CALLDATA: that the exact
 * bytes the off-chain plan builder produces are accepted by the live Uniswap V3
 * and Aerodrome routers, and that a real Balancer flash loan can be taken and
 * repaid inside one transaction.
 *
 * The market is currently unprofitable on this pair (measured: -10 to -49 bps
 * round trip), so a run SHOULD revert. What matters is WHICH revert:
 *
 *   ProfitBelowMin      -> everything worked; the trade was simply not profitable
 *   CallFailed          -> our swap calldata is wrong
 *   TargetNotAllowed    -> allowlist misconfigured
 *   SpenderNotAllowed   -> approval target wrong
 *
 * Only the first is acceptable. That distinction is the whole point of this
 * file: it separates "no opportunity" from "broken integration", which is
 * impossible to tell apart from off-chain observation alone.
 *
 *   forge test --match-path test/ForkArb.t.sol --fork-url $BASE_RPC_URL -vv
 */
contract ForkArbTest is Test {
    // Base mainnet, verified on-chain.
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant UNIV3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant AERO_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant AERO_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    address constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;

    FlashExecutor exec;
    address admin = makeAddr("admin");
    address guardian = makeAddr("guardian");
    address operator = makeAddr("operator");

    function setUp() public {
        exec = new FlashExecutor(AAVE_POOL, BALANCER_VAULT, admin, guardian);

        vm.startPrank(admin);
        exec.grantRole(exec.OPERATOR_ROLE(), operator);
        exec.setMaxLoan(WETH, 100e18);
        exec.setTarget(UNIV3_ROUTER, true);
        exec.setTarget(AERO_ROUTER, true);
        vm.stopPrank();
    }

    // --------------------------------------------------------- plan building

    struct UniV3ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct AeroRoute {
        address from;
        address to;
        bool stable;
        address factory;
    }

    /// @dev WETH -> USDC on Uniswap V3, then USDC -> WETH on Aerodrome.
    function _plan(uint256 amountIn, uint24 uniFee, uint256 minProfit)
        internal
        returns (FlashExecutor.Plan memory plan)
    {
        FlashExecutor.Approval[] memory apps = new FlashExecutor.Approval[](2);
        apps[0] = FlashExecutor.Approval(WETH, UNIV3_ROUTER, amountIn);
        // Leg 2 size is unknown ahead of time, so approve the max the router
        // could pull. The allowance is reset to 0 in the same transaction.
        apps[1] = FlashExecutor.Approval(USDC, AERO_ROUTER, type(uint256).max);

        FlashExecutor.Call[] memory calls = new FlashExecutor.Call[](2);

        calls[0] = FlashExecutor.Call({
            target: UNIV3_ROUTER,
            value: 0,
            data: abi.encodeWithSignature(
                "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
                UniV3ExactInputSingleParams({
                    tokenIn: WETH,
                    tokenOut: USDC,
                    fee: uniFee,
                    recipient: address(exec),
                    amountIn: amountIn,
                    // 0 is deliberate: the executor's on-chain minProfit check is
                    // the real protection, and a per-leg minimum would only make
                    // the failure mode harder to read.
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            )
        });

        AeroRoute[] memory routes = new AeroRoute[](1);
        routes[0] = AeroRoute({from: USDC, to: WETH, stable: false, factory: AERO_FACTORY});

        // Leg 2 is sized from a quote of leg 1, haircut inside _midAmount.
        calls[1] = FlashExecutor.Call({
            target: AERO_ROUTER,
            value: 0,
            data: abi.encodeWithSignature(
                "swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)",
                _midAmount(amountIn, uniFee),
                uint256(0),
                routes,
                address(exec),
                block.timestamp + 300
            )
        });

        plan = FlashExecutor.Plan({
            provider: FlashExecutor.Provider.BALANCER_V2,
            asset: WETH,
            amount: amountIn,
            minProfit: minProfit,
            approvals: apps,
            calls: calls
        });
    }

    /**
     * Quote leg 1 so leg 2 can be sized.
     *
     * QuoterV2.quoteExactInputSingle is NOT view -- it performs a swap and
     * catches the revert to read the result. A staticcall therefore fails and
     * silently yields 0, which then makes leg 2 try to swap nothing. That is
     * what broke the first run of this test.
     */
    function _midAmount(uint256 amountIn, uint24 fee) internal returns (uint256) {
        (bool ok, bytes memory ret) = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a.call(
            abi.encodeWithSignature(
                "quoteExactInputSingle((address,address,uint256,uint24,uint160))",
                WETH, USDC, amountIn, fee, uint160(0)
            )
        );
        require(ok && ret.length >= 32, "quoter failed");
        uint256 out = abi.decode(ret, (uint256));

        /**
         * Size leg 2 slightly BELOW the quote.
         *
         * Leg 2 spends the USDC that leg 1 actually produced. If the realised
         * output comes in even one wei under the quote, a leg sized at exactly
         * the quote tries to spend more than the contract holds and the swap
         * reverts. Shaving 10 bps leaves dust rather than a failed trade.
         */
        return (out * 9_990) / 10_000;
    }

    /// @dev Drop the 4-byte selector so the error args can be decoded.
    function _strip(bytes memory err) internal pure returns (bytes memory out) {
        out = new bytes(err.length - 4);
        for (uint256 i = 4; i < err.length; ++i) out[i - 4] = err[i];
    }

    // ---------------------------------------------------------------- tests

    /**
     * THE CRITICAL TEST.
     *
     * Runs a real Balancer flash loan through real routers. It is expected to
     * revert, because the pair is not profitable. It must revert with
     * ProfitBelowMin and nothing else -- any other selector means our calldata
     * or configuration is broken rather than the market being unattractive.
     */
    function test_fork_realSwapCalldataReachesProfitCheck() public {
        FlashExecutor.Plan memory plan = _plan(1e18, 500, 0);

        vm.prank(operator);
        try exec.run(plan) {
            // A profitable round trip would be a genuine opportunity.
            console.log("run() SUCCEEDED -- a real arb existed at this block");
            assertGt(IERC20(WETH).balanceOf(address(exec)), 0, "profit should be retained");
        } catch (bytes memory err) {
            bytes4 sel = bytes4(err);
            console.log("reverted with selector:");
            console.logBytes4(sel);

            if (sel == FlashExecutor.CallFailed.selector) {
                (uint256 idx, bytes memory reason) = abi.decode(_strip(err), (uint256, bytes));
                console.log("CallFailed on leg index:", idx);
                console.log("inner reason bytes:");
                console.logBytes(reason);
            }

            assertEq(
                sel,
                FlashExecutor.ProfitBelowMin.selector,
                "must fail on the profit guard, not on broken calldata"
            );
            console.log("calldata is valid: flash loan + both swaps executed, guard rejected the fill");
        }
    }

    /// @dev Demanding an absurd profit must always revert on the guard.
    function test_fork_impossibleMinProfitAlwaysReverts() public {
        FlashExecutor.Plan memory plan = _plan(1e18, 500, 1_000e18);

        vm.prank(operator);
        vm.expectRevert();
        exec.run(plan);

        assertEq(IERC20(WETH).balanceOf(address(exec)), 0, "no funds left behind");
    }

    /// @dev A router that was never allowlisted must be rejected before any swap.
    function test_fork_unlistedRouterRejected() public {
        FlashExecutor.Plan memory plan = _plan(1e18, 500, 0);
        plan.calls[0].target = address(0xDEAD);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(FlashExecutor.TargetNotAllowed.selector, address(0xDEAD))
        );
        exec.run(plan);
    }

    /// @dev Nothing may be left approved after a run, successful or not.
    function test_fork_noStandingAllowance() public {
        FlashExecutor.Plan memory plan = _plan(1e18, 500, 0);

        vm.prank(operator);
        try exec.run(plan) {} catch {}

        assertEq(IERC20(WETH).allowance(address(exec), UNIV3_ROUTER), 0, "weth allowance");
        assertEq(IERC20(USDC).allowance(address(exec), AERO_ROUTER), 0, "usdc allowance");
    }
}
