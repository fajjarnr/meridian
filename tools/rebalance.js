import { getMyPositions, closePosition, deployPosition, getActiveBin } from "./dlmm.js";
import { analyzeRange } from "./range-analysis.js";
import { getTrackedPosition } from "../state.js";
import { log } from "../logger.js";
import { config } from "../config.js";
import { getWalletBalances } from "./wallet.js";

/**
 * Rebalance an out-of-range position in-place:
 * 1. Find the position metadata (pool address, token info, original size, etc.).
 * 2. Close the position (liquidate, claim fees, auto-swap base to SOL).
 * 3. Fetch current active bin price and run Multi-Technique Range Analysis consensus.
 * 4. Deploy a fresh centered position in the same pool using the newly freed SOL.
 *
 * @param {object} params
 * @param {string} params.position_address - The public key of the DLMM position to rebalance
 * @param {number} [params.bins_below] - Optional override for bin sizing. If omitted, uses multi-technique consensus.
 * @returns {Promise<object>} rebalance outcome report
 */
export async function rebalancePosition({ position_address, bins_below = null }) {
  log("rebalance", `Initiating in-place rebalance for position: ${position_address}`);

  // Step 1: Find the target position and its metadata
  const livePositions = await getMyPositions({ force: true });
  const position = livePositions?.positions?.find(p => p.position === position_address);
  const tracked = getTrackedPosition(position_address);

  if (!position) {
    throw new Error(`Position ${position_address} not found or already closed`);
  }

  const poolAddress = position.pool;
  const poolName = position.pair || tracked?.pool_name || poolAddress.slice(0, 8);
  const baseMint = position.base_mint;
  const binStep = position.bin_step || tracked?.bin_step || 100;
  const volatility = position.volatility || tracked?.volatility || 0.0;
  const organicScore = position.organic_score || tracked?.organic_score || 0;
  const feeTvlRatio = position.fee_per_tvl_24h || position.fee_tvl_ratio || tracked?.fee_tvl_ratio || 0.0;

  log("rebalance", `Position mapped to pool ${poolAddress} (${poolName}), base_mint: ${baseMint}`);

  // Step 2: Close the position
  log("rebalance", `Step 1/3: Closing position ${position_address}...`);
  const closeResult = await closePosition({
    position_address,
    reason: "rebalance: out of range",
  });

  if (!closeResult.success && !closeResult.dry_run) {
    throw new Error(`Close position failed: ${closeResult.error || "unknown error"}`);
  }

  // Handle DRY_RUN mode gracefully
  if (closeResult.dry_run) {
    log("rebalance", `[DRY RUN] Would close ${position_address} and deploy a fresh centered position in ${poolAddress}`);
    return {
      success: true,
      dry_run: true,
      pool: poolAddress,
      pool_name: poolName,
      message: `DRY RUN — Would rebalance position ${position_address} in pool ${poolName}`,
    };
  }

  // Wait for transactions to confirm and balances to settle
  await new Promise(r => setTimeout(r, 6000));

  // Step 3: Run Range Analysis to find the new optimal bin size centering on the active price
  let targetBins = bins_below;
  let analysis = null;

  if (targetBins == null) {
    log("rebalance", `Step 2/3: Calculating new bin range using range analysis consensus...`);
    try {
      analysis = await analyzeRange(poolAddress, binStep, baseMint);
      targetBins = analysis?.consensus?.binsBelow;
    } catch (e) {
      log("rebalance_warn", `Range analysis failed during rebalance: ${e.message}. Falling back to default.`);
    }
  }

  if (targetBins == null) {
    // Ultimate fallback to default/clamped bins
    targetBins = config.strategy?.defaultBinsBelow || 35;
  }

  log("rebalance", `Optimal bin range resolved to: ${targetBins} bins below active bin`);

  // Step 4: Fetch fresh balances and deploy the new position
  log("rebalance", `Step 3/3: Deploying new position in pool ${poolAddress}...`);
  const balanceInfo = await getWalletBalances({});
  const solBalance = balanceInfo.sol || 0;

  // Gas reserve calculation
  const reserve = config.management.gasReserve ?? 0.2;
  const deploySolAmount = Math.max(0, solBalance - reserve);

  if (deploySolAmount < (config.management.minSolToOpen ?? 0.55)) {
    throw new Error(`Insufficient SOL balance to redeploy: ${solBalance.toFixed(4)} SOL (min required after reserve: ${config.management.minSolToOpen} SOL)`);
  }

  log("rebalance", `Deploying ${deploySolAmount.toFixed(4)} SOL into ${poolName} with range: ${targetBins} bins below active bin`);

  const deployResult = await deployPosition({
    pool_address: poolAddress,
    amount_y: deploySolAmount,
    amount_x: 0,
    strategy: "bid_ask",
    bins_below: targetBins,
    bins_above: 0,
    pool_name: poolName,
    base_mint: baseMint,
    bin_step: binStep,
    volatility: volatility,
    fee_tvl_ratio: feeTvlRatio,
    organic_score: organicScore,
    initial_value_usd: deploySolAmount * (balanceInfo.solPriceUsd || 150),
  });

  if (!deployResult.success) {
    throw new Error(`Redeploy failed: ${deployResult.error || "unknown error"}`);
  }

  // Increment rebalance count in the new position's state note or state log if needed.
  try {
    const { addPoolNote } = await import("../pool-memory.js");
    await addPoolNote({
      pool_address: poolAddress,
      note: `In-place rebalanced: shifted range to ${targetBins} bins below at active price.`,
    });
  } catch (_) {}

  log("rebalance", `SUCCESS: In-place rebalance completed for pool ${poolName}. New position: ${deployResult.position}`);

  return {
    success: true,
    rebalanced: true,
    pool: poolAddress,
    pool_name: poolName,
    old_position: position_address,
    new_position: deployResult.position,
    bins_below: targetBins,
    amount_sol: deploySolAmount,
    close_txs: closeResult.close_txs || closeResult.txs,
    deploy_txs: deployResult.txs || [deployResult.tx],
  };
}
