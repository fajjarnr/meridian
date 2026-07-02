/**
 * Multi-Technique Range Analysis for DLMM LP
 *
 * Combines 6 techniques to produce a consensus-based bin range recommendation:
 *   1. Fibonacci Retracement — support/resistance from swing high/low
 *   2. ATR (Average True Range) — volatility-adaptive range sizing
 *   3. Bollinger Bands — statistical deviation boundaries
 *   4. Volume Profile — volume-weighted price distribution
 *   5. VWAP Bands — volume-weighted average price ± deviation
 *   6. Pivot Points — classic S/R from daily OHLC
 *
 * Data sources:
 *   - DexScreener API: price, price changes, volume, liquidity
 *   - Agent Meridian chart-indicators API: BB, RSI (when base_mint available)
 */

import { config } from "../config.js";
import { log } from "../logger.js";

const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex";

// ═══════════════════════════════════════════════════════════════
//  DATA FETCHING
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch comprehensive price data from DexScreener.
 * Returns current price, derived historical prices, volume, and OHLC estimates.
 */
async function fetchDexScreenerData(poolAddress) {
  const resp = await fetch(`${DEXSCREENER_API}/pairs/solana/${poolAddress}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`DexScreener API error: ${resp.status}`);

  const data = await resp.json();
  const pair = data.pair || {};

  if (!pair.priceUsd) throw new Error("No price data available from DexScreener");

  const currentPrice = parseFloat(pair.priceUsd);
  const change5m  = parseFloat(pair.priceChange?.m5)  || 0;
  const change1h  = parseFloat(pair.priceChange?.h1)  || 0;
  const change6h  = parseFloat(pair.priceChange?.h6)  || 0;
  const change24h = parseFloat(pair.priceChange?.h24) || 0;

  // Derive approximate prices at each interval
  const price5mAgo  = currentPrice / (1 + change5m  / 100);
  const price1hAgo  = currentPrice / (1 + change1h  / 100);
  const price6hAgo  = currentPrice / (1 + change6h  / 100);
  const price24hAgo = currentPrice / (1 + change24h / 100);

  // Estimate 24h high/low from known price points + volatility buffer
  const knownPrices = [currentPrice, price5mAgo, price1hAgo, price6hAgo, price24hAgo];
  const maxKnown = Math.max(...knownPrices);
  const minKnown = Math.min(...knownPrices);

  // Add a volatility-based wick estimate (intraday extremes are typically
  // 10-30% beyond the known close-to-close range for memecoins)
  const knownRange = maxKnown - minKnown;
  const wickFactor = 0.15; // 15% wick extension estimate
  const estimatedHigh = maxKnown + knownRange * wickFactor;
  const estimatedLow  = Math.max(minKnown - knownRange * wickFactor, minKnown * 0.5);

  return {
    currentPrice,
    prices: { price5mAgo, price1hAgo, price6hAgo, price24hAgo },
    changes: { change5m, change1h, change6h, change24h },
    volume: {
      m5:  parseFloat(pair.volume?.m5)  || 0,
      h1:  parseFloat(pair.volume?.h1)  || 0,
      h6:  parseFloat(pair.volume?.h6)  || 0,
      h24: parseFloat(pair.volume?.h24) || 0,
    },
    ohlc24h: {
      open:  price24hAgo,
      high:  estimatedHigh,
      low:   estimatedLow,
      close: currentPrice,
    },
    tvl: parseFloat(pair.liquidity?.usd) || 0,
    pairName: (pair.baseToken?.symbol || "?") + "-SOL",
  };
}

/**
 * Fetch Bollinger Band data from chart-indicators API (when base_mint available).
 * Returns { upper, middle, lower, close } or null on failure.
 */
async function fetchChartIndicatorsBB(baseMint) {
  if (!baseMint) return null;
  try {
    const { agentMeridianJson, getAgentMeridianHeaders } = await import("./agent-meridian.js");
    const payload = await agentMeridianJson(`/chart-indicators/${baseMint}?interval=15_MINUTE&candles=100&rsiLength=14`, {
      headers: getAgentMeridianHeaders(),
    });
    const latest = payload?.latest || {};
    const bollinger = latest?.bollinger || {};
    const candle = latest?.candle || {};
    const upper  = parseFloat(bollinger.upper);
    const middle = parseFloat(bollinger.middle);
    const lower  = parseFloat(bollinger.lower);
    const close  = parseFloat(candle.close);
    if (!Number.isFinite(upper) || !Number.isFinite(lower) || !Number.isFinite(close)) return null;
    return { upper, middle, lower, close };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  UTILITY: price-to-bins conversion
// ═══════════════════════════════════════════════════════════════

/**
 * Convert a price drop percentage to number of bins below current price.
 * @param {number} priceDropPct  – positive number (e.g. 35 = 35% below)
 * @param {number} binStepBps   – bin step in basis points (e.g. 100 = 1%)
 * @returns {number} bins below
 */
function priceToBins(priceDropPct, binStepBps) {
  const binStepPct = binStepBps / 100; // 100 bps → 1%
  if (binStepPct <= 0) return 35;
  return Math.max(1, Math.round(priceDropPct / binStepPct));
}

// ═══════════════════════════════════════════════════════════════
//  TECHNIQUE 1: FIBONACCI RETRACEMENT
// ═══════════════════════════════════════════════════════════════

function computeFibonacci(ds, binStep) {
  const { currentPrice, ohlc24h } = ds;
  const swingHigh = Math.max(currentPrice, ohlc24h.high);
  const swingLow  = Math.min(currentPrice, ohlc24h.low);
  const range = swingHigh - swingLow;

  if (range <= 0) {
    return { binsBelow: null, confidence: 0, levels: {}, reasoning: "No price range — Fibonacci inapplicable" };
  }

  const levels = {
    "23.6%": swingHigh - 0.236 * range,
    "38.2%": swingHigh - 0.382 * range,
    "50.0%": swingHigh - 0.500 * range,
    "61.8%": swingHigh - 0.618 * range,
    "78.6%": swingHigh - 0.786 * range,
  };

  // Target: 61.8% retracement (golden pocket) as lower bound
  const target618 = levels["61.8%"];
  const dropPct = ((currentPrice - target618) / currentPrice) * 100;
  const binsBelow = priceToBins(Math.abs(dropPct), binStep);

  // Confidence: higher when we have a meaningful range (>5% swing)
  const swingPct = (range / swingHigh) * 100;
  const confidence = Math.min(85, 40 + swingPct * 3);

  return {
    binsBelow,
    confidence: Math.round(confidence),
    levels,
    reasoning: `61.8% Fib support at $${target618.toFixed(8)} (${dropPct.toFixed(1)}% below current). 24h swing: ${swingPct.toFixed(1)}%.`,
  };
}

// ═══════════════════════════════════════════════════════════════
//  TECHNIQUE 2: ATR (Average True Range)
// ═══════════════════════════════════════════════════════════════

function computeATR(ds, binStep) {
  const cfg = config.strategy?.rangeAnalysis || {};
  const multiplier = cfg.atrMultiplier ?? 2.0;
  const { currentPrice, changes, ohlc24h } = ds;

  // Approximate ATR from multiple timeframe changes:
  // True Range ≈ max(|high-low|, |high-prevClose|, |low-prevClose|)
  // We don't have real candles, so approximate from available price changes
  const absChanges = [
    Math.abs(changes.change1h),
    Math.abs(changes.change6h) / 6,  // normalize to per-hour
    Math.abs(changes.change24h) / 24, // normalize to per-hour
  ].filter(v => Number.isFinite(v) && v > 0);

  if (absChanges.length === 0) {
    return { binsBelow: null, confidence: 0, reasoning: "No price change data for ATR" };
  }

  // Average hourly volatility in percent
  const avgHourlyVol = absChanges.reduce((a, b) => a + b, 0) / absChanges.length;

  // ATR over ~6 hours (typical LP hold period for memecoins) in percent
  const atrPct = avgHourlyVol * Math.sqrt(6) * multiplier;

  // Also cross-check with the actual 24h range
  const range24hPct = ((ohlc24h.high - ohlc24h.low) / currentPrice) * 100;
  const combinedAtrPct = Math.max(atrPct, range24hPct * 0.5);

  const binsBelow = priceToBins(combinedAtrPct, binStep);

  // Confidence: higher when multiple timeframes agree
  const stdDev = Math.sqrt(
    absChanges.reduce((sum, v) => sum + (v - avgHourlyVol) ** 2, 0) / absChanges.length
  );
  const cv = avgHourlyVol > 0 ? stdDev / avgHourlyVol : 1;
  const confidence = Math.min(80, 60 - cv * 20);

  return {
    binsBelow,
    confidence: Math.max(10, Math.round(confidence)),
    atrPct: +combinedAtrPct.toFixed(2),
    avgHourlyVol: +avgHourlyVol.toFixed(3),
    reasoning: `ATR-based range: ${combinedAtrPct.toFixed(1)}% (${multiplier}× multiplier). Avg hourly vol: ${avgHourlyVol.toFixed(2)}%.`,
  };
}

// ═══════════════════════════════════════════════════════════════
//  TECHNIQUE 3: BOLLINGER BANDS
// ═══════════════════════════════════════════════════════════════

function computeBollingerBands(ds, binStep, chartBB) {
  const { currentPrice, prices, changes } = ds;

  let lower, upper, middle;
  let source = "derived";

  if (chartBB && Number.isFinite(chartBB.lower) && Number.isFinite(chartBB.upper)) {
    // Use real BB from chart-indicators API
    // Normalize units in case of currency/unit mismatch (e.g. SOL price vs USD price)
    const refPrice = chartBB.close && chartBB.close > 0 ? chartBB.close : currentPrice;
    const normFactor = currentPrice / refPrice;
    lower  = chartBB.lower * normFactor;
    upper  = chartBB.upper * normFactor;
    middle = chartBB.middle * normFactor;
    source = "chart-api";
  } else {
    // Derive BB from price change data:
    // Approximate standard deviation from multiple timeframe changes
    const pricePoints = [
      currentPrice,
      prices.price5mAgo,
      prices.price1hAgo,
      prices.price6hAgo,
      prices.price24hAgo,
    ].filter(v => Number.isFinite(v) && v > 0);

    if (pricePoints.length < 3) {
      return { binsBelow: null, confidence: 0, reasoning: "Insufficient data for Bollinger Bands" };
    }

    middle = pricePoints.reduce((a, b) => a + b, 0) / pricePoints.length;
    const stdDev = Math.sqrt(
      pricePoints.reduce((sum, p) => sum + (p - middle) ** 2, 0) / pricePoints.length
    );
    const numStdDev = config.strategy?.rangeAnalysis?.bbStdDev ?? 2.0;
    lower = middle - numStdDev * stdDev;
    upper = middle + numStdDev * stdDev;
  }

  if (!Number.isFinite(lower) || lower <= 0 || lower >= currentPrice) {
    return { binsBelow: null, confidence: 0, reasoning: "Bollinger lower band invalid or above current price" };
  }

  const dropPct = ((currentPrice - lower) / currentPrice) * 100;
  const binsBelow = priceToBins(dropPct, binStep);

  // Confidence: higher when using real API data
  const confidence = source === "chart-api" ? 85 : 55;

  return {
    binsBelow,
    confidence,
    source,
    bands: {
      upper: +upper.toFixed(10),
      middle: +middle.toFixed(10),
      lower: +lower.toFixed(10),
    },
    reasoning: `BB lower band at $${lower.toFixed(8)} (${dropPct.toFixed(1)}% below). Source: ${source}.`,
  };
}

// ═══════════════════════════════════════════════════════════════
//  TECHNIQUE 4: VOLUME PROFILE (approximate)
// ═══════════════════════════════════════════════════════════════

function computeVolumeProfile(ds, binStep) {
  const { currentPrice, prices, volume, ohlc24h } = ds;
  const cfg = config.strategy?.rangeAnalysis || {};
  const numBuckets = cfg.volumeProfileBins ?? 50;

  const high = ohlc24h.high;
  const low  = ohlc24h.low;
  const priceRange = high - low;

  if (priceRange <= 0 || !Number.isFinite(priceRange)) {
    return { binsBelow: null, confidence: 0, reasoning: "No price range for Volume Profile" };
  }

  // Create price buckets and distribute volume based on proximity to known prices
  const bucketSize = priceRange / numBuckets;
  const buckets = new Array(numBuckets).fill(0);

  // Weight known price levels by their associated volume
  const volumeWeights = [
    { price: currentPrice,        vol: volume.h1 * 0.5 },  // recent activity
    { price: prices.price1hAgo,   vol: volume.h1 * 0.5 },
    { price: prices.price6hAgo,   vol: (volume.h6 - volume.h1) * 0.3 },
    { price: prices.price24hAgo,  vol: (volume.h24 - volume.h6) * 0.2 },
  ].filter(w => Number.isFinite(w.price) && Number.isFinite(w.vol) && w.vol > 0);

  if (volumeWeights.length === 0) {
    return { binsBelow: null, confidence: 0, reasoning: "No volume data for Volume Profile" };
  }

  // Distribute volume across buckets using Gaussian weighting around each price point
  for (const { price, vol } of volumeWeights) {
    for (let i = 0; i < numBuckets; i++) {
      const bucketMid = low + (i + 0.5) * bucketSize;
      const distance = Math.abs(price - bucketMid) / priceRange;
      // Gaussian kernel: more volume near the known price
      const weight = Math.exp(-distance * distance * 8);
      buckets[i] += vol * weight;
    }
  }

  // Find Point of Control (POC) — bucket with highest volume
  let pocIndex = 0;
  let maxVol = 0;
  for (let i = 0; i < numBuckets; i++) {
    if (buckets[i] > maxVol) {
      maxVol = buckets[i];
      pocIndex = i;
    }
  }

  const pocPrice = low + (pocIndex + 0.5) * bucketSize;

  // Value Area: 70% of total volume (buckets around POC)
  const totalVol = buckets.reduce((a, b) => a + b, 0);
  const vaThreshold = totalVol * 0.7;
  let vaLow = pocIndex;
  let vaHigh = pocIndex;
  let vaVol = buckets[pocIndex];

  while (vaVol < vaThreshold && (vaLow > 0 || vaHigh < numBuckets - 1)) {
    const lowCandidate  = vaLow > 0              ? buckets[vaLow - 1]  : 0;
    const highCandidate = vaHigh < numBuckets - 1 ? buckets[vaHigh + 1] : 0;
    if (lowCandidate >= highCandidate && vaLow > 0) {
      vaLow--;
      vaVol += buckets[vaLow];
    } else if (vaHigh < numBuckets - 1) {
      vaHigh++;
      vaVol += buckets[vaHigh];
    } else {
      break;
    }
  }

  const vaLowPrice = low + vaLow * bucketSize;
  const dropPct = ((currentPrice - vaLowPrice) / currentPrice) * 100;
  const binsBelow = priceToBins(Math.max(dropPct, 0), binStep);

  // Confidence: lower because we're approximating from limited data
  const confidence = Math.min(60, 30 + volumeWeights.length * 8);

  return {
    binsBelow,
    confidence,
    poc: +pocPrice.toFixed(10),
    valueAreaLow: +vaLowPrice.toFixed(10),
    reasoning: `POC at $${pocPrice.toFixed(8)}. Value Area Low at $${vaLowPrice.toFixed(8)} (${dropPct.toFixed(1)}% below). Approximated from ${volumeWeights.length} price-volume points.`,
  };
}

// ═══════════════════════════════════════════════════════════════
//  TECHNIQUE 5: VWAP BANDS
// ═══════════════════════════════════════════════════════════════

function computeVWAP(ds, binStep) {
  const cfg = config.strategy?.rangeAnalysis || {};
  const numStdDev = cfg.vwapStdDev ?? 2.0;
  const { currentPrice, prices, volume } = ds;

  // Approximate VWAP from known price-volume pairs
  // VWAP = Σ(typical_price × volume) / Σ(volume)
  const segments = [
    { price: currentPrice,       vol: volume.h1 },
    { price: prices.price1hAgo,  vol: volume.h1 },
    { price: prices.price6hAgo,  vol: Math.max(0, volume.h6 - volume.h1) },
    { price: prices.price24hAgo, vol: Math.max(0, volume.h24 - volume.h6) },
  ].filter(s => Number.isFinite(s.price) && Number.isFinite(s.vol) && s.vol > 0);

  if (segments.length < 2) {
    return { binsBelow: null, confidence: 0, reasoning: "Insufficient data for VWAP calculation" };
  }

  const totalVol = segments.reduce((sum, s) => sum + s.vol, 0);
  if (totalVol <= 0) {
    return { binsBelow: null, confidence: 0, reasoning: "Zero total volume for VWAP" };
  }

  const vwap = segments.reduce((sum, s) => sum + s.price * s.vol, 0) / totalVol;

  // Standard deviation of price around VWAP (volume-weighted)
  const variance = segments.reduce((sum, s) => {
    return sum + s.vol * (s.price - vwap) ** 2;
  }, 0) / totalVol;
  const stdDev = Math.sqrt(variance);

  const lowerBand = vwap - numStdDev * stdDev;

  if (!Number.isFinite(lowerBand) || lowerBand <= 0) {
    return { binsBelow: null, confidence: 0, reasoning: "VWAP lower band invalid" };
  }

  const dropPct = ((currentPrice - lowerBand) / currentPrice) * 100;
  const binsBelow = priceToBins(Math.max(dropPct, 0), binStep);

  const confidence = Math.min(70, 35 + segments.length * 10);

  return {
    binsBelow,
    confidence,
    vwap: +vwap.toFixed(10),
    lowerBand: +lowerBand.toFixed(10),
    stdDev: +stdDev.toFixed(10),
    reasoning: `VWAP at $${vwap.toFixed(8)}, lower band (-${numStdDev}σ) at $${lowerBand.toFixed(8)} (${dropPct.toFixed(1)}% below).`,
  };
}

// ═══════════════════════════════════════════════════════════════
//  TECHNIQUE 6: PIVOT POINTS
// ═══════════════════════════════════════════════════════════════

function computePivotPoints(ds, binStep) {
  const { currentPrice, ohlc24h } = ds;
  const { high, low, close } = ohlc24h;

  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
    return { binsBelow: null, confidence: 0, reasoning: "Invalid OHLC data for Pivot Points" };
  }

  const pivot = (high + low + close) / 3;
  const s1 = 2 * pivot - high;          // Support 1
  const s2 = pivot - (high - low);       // Support 2
  const s3 = low - 2 * (high - pivot);   // Support 3
  const r1 = 2 * pivot - low;            // Resistance 1
  const r2 = pivot + (high - low);       // Resistance 2

  // Use S2 as the primary target (stronger support level)
  const target = s2;
  if (!Number.isFinite(target) || target <= 0) {
    return { binsBelow: null, confidence: 0, reasoning: "Pivot Points S2 invalid" };
  }

  const dropPct = ((currentPrice - target) / currentPrice) * 100;
  const binsBelow = priceToBins(Math.max(dropPct, 0), binStep);

  // Confidence: Pivot Points are reliable with a clear 24h range
  const rangePct = ((high - low) / currentPrice) * 100;
  const confidence = Math.min(75, 40 + rangePct * 2);

  return {
    binsBelow,
    confidence: Math.max(15, Math.round(confidence)),
    levels: {
      pivot: +pivot.toFixed(10),
      s1: +s1.toFixed(10),
      s2: +s2.toFixed(10),
      s3: +s3.toFixed(10),
      r1: +r1.toFixed(10),
      r2: +r2.toFixed(10),
    },
    reasoning: `Pivot at $${pivot.toFixed(8)}. S1=$${s1.toFixed(8)}, S2=$${s2.toFixed(8)} (${dropPct.toFixed(1)}% below). 24h range: ${rangePct.toFixed(1)}%.`,
  };
}

// ═══════════════════════════════════════════════════════════════
//  CONSENSUS ENGINE
// ═══════════════════════════════════════════════════════════════

function buildConsensus(results, binStep) {
  const cfg = config.strategy || {};
  const minBins = Math.max(35, Number(cfg.minBinsBelow ?? 35));
  const maxBins = Number(cfg.maxBinsBelow ?? 69);

  // Collect valid results
  const valid = Object.entries(results)
    .filter(([, r]) => r.binsBelow != null && Number.isFinite(r.binsBelow) && r.confidence > 0)
    .map(([technique, r]) => ({
      technique,
      binsBelow: r.binsBelow,
      confidence: r.confidence,
    }));

  if (valid.length === 0) {
    return {
      binsBelow: cfg.defaultBinsBelow ?? maxBins,
      confidence: 0,
      agreement: "none",
      reasoning: "No techniques returned valid data. Using default bins_below.",
      weights: [],
    };
  }

  // Weighted average by confidence
  const totalWeight = valid.reduce((sum, v) => sum + v.confidence, 0);
  const weightedBins = valid.reduce((sum, v) => sum + v.binsBelow * v.confidence, 0) / totalWeight;
  const consensusBins = Math.max(minBins, Math.min(maxBins, Math.round(weightedBins)));

  // Calculate agreement level
  const bins = valid.map(v => v.binsBelow);
  const median = bins.sort((a, b) => a - b)[Math.floor(bins.length / 2)];
  const avgDeviation = bins.reduce((sum, b) => sum + Math.abs(b - median) / median, 0) / bins.length;

  let agreement;
  if (avgDeviation < 0.15) agreement = "strong";
  else if (avgDeviation < 0.30) agreement = "moderate";
  else agreement = "weak";

  // Overall confidence: average of technique confidences, boosted by agreement
  const avgConfidence = totalWeight / valid.length;
  const agreementBonus = agreement === "strong" ? 15 : agreement === "moderate" ? 5 : -5;
  const overallConfidence = Math.min(95, Math.max(10, Math.round(avgConfidence + agreementBonus)));

  return {
    binsBelow: consensusBins,
    confidence: overallConfidence,
    agreement,
    rawWeightedAvg: +weightedBins.toFixed(1),
    clamped: consensusBins !== Math.round(weightedBins),
    reasoning: `${valid.length} techniques agree → ${consensusBins} bins (${agreement} agreement, ${overallConfidence}% confidence). Range: [${Math.min(...bins)}, ${Math.max(...bins)}].`,
    weights: valid.map(v => ({
      technique: v.technique,
      binsBelow: v.binsBelow,
      confidence: v.confidence,
      weight: +((v.confidence / totalWeight) * 100).toFixed(1),
    })),
  };
}

// ═══════════════════════════════════════════════════════════════
//  MAIN EXPORT: analyzeRange
// ═══════════════════════════════════════════════════════════════

/**
 * Run all range analysis techniques and return consensus recommendation.
 *
 * @param {string} poolAddress – DLMM pool address
 * @param {number} binStep    – pool bin step in bps (e.g. 100 = 1%)
 * @param {string} [baseMint] – base token mint (enables chart-indicators API)
 * @returns {Promise<Object>} analysis results + consensus
 */
export async function analyzeRange(poolAddress, binStep = 100, baseMint = null) {
  const enabledTechniques = config.strategy?.rangeAnalysis?.enabledTechniques ?? [
    "fibonacci", "atr", "bollinger", "volume_profile", "vwap", "pivot_points",
  ];
  const enabled = new Set(enabledTechniques);

  // Fetch data in parallel
  const [ds, chartBB] = await Promise.all([
    fetchDexScreenerData(poolAddress),
    enabled.has("bollinger") ? fetchChartIndicatorsBB(baseMint) : null,
  ]);

  // Run all enabled techniques
  const techniques = {};

  if (enabled.has("fibonacci")) {
    try { techniques.fibonacci = computeFibonacci(ds, binStep); }
    catch (e) { techniques.fibonacci = { binsBelow: null, confidence: 0, reasoning: `Error: ${e.message}` }; }
  }

  if (enabled.has("atr")) {
    try { techniques.atr = computeATR(ds, binStep); }
    catch (e) { techniques.atr = { binsBelow: null, confidence: 0, reasoning: `Error: ${e.message}` }; }
  }

  if (enabled.has("bollinger")) {
    try { techniques.bollinger = computeBollingerBands(ds, binStep, chartBB); }
    catch (e) { techniques.bollinger = { binsBelow: null, confidence: 0, reasoning: `Error: ${e.message}` }; }
  }

  if (enabled.has("volume_profile")) {
    try { techniques.volume_profile = computeVolumeProfile(ds, binStep); }
    catch (e) { techniques.volume_profile = { binsBelow: null, confidence: 0, reasoning: `Error: ${e.message}` }; }
  }

  if (enabled.has("vwap")) {
    try { techniques.vwap = computeVWAP(ds, binStep); }
    catch (e) { techniques.vwap = { binsBelow: null, confidence: 0, reasoning: `Error: ${e.message}` }; }
  }

  if (enabled.has("pivot_points")) {
    try { techniques.pivot_points = computePivotPoints(ds, binStep); }
    catch (e) { techniques.pivot_points = { binsBelow: null, confidence: 0, reasoning: `Error: ${e.message}` }; }
  }

  // Build consensus
  const consensus = buildConsensus(techniques, binStep);

  // Log summary
  const validCount = Object.values(techniques).filter(t => t.binsBelow != null).length;
  log("range_analysis", `${ds.pairName}: ${validCount}/${Object.keys(techniques).length} techniques → consensus ${consensus.binsBelow} bins (${consensus.agreement}, ${consensus.confidence}% conf)`);

  return {
    success: true,
    pool: poolAddress,
    token: ds.pairName,
    binStep,
    priceData: {
      current: +ds.currentPrice.toFixed(10),
      change1h: ds.changes.change1h,
      change6h: ds.changes.change6h,
      change24h: ds.changes.change24h,
      volume24h: ds.volume.h24,
      volume1h: ds.volume.h1,
      tvl: ds.tvl,
    },
    techniques,
    consensus,
    // Backward compatibility: expose fibonacci results at top level
    fibonacci: techniques.fibonacci ? {
      recommended: { binsBelow: techniques.fibonacci.binsBelow },
      levels: techniques.fibonacci.levels,
      reasoning: techniques.fibonacci.reasoning,
    } : null,
  };
}

/**
 * Compute Fibonacci retracement levels from ATH for AST strategy.
 * Unlike computeFibonacci (24h swing), this uses the all-time high price.
 *
 * @param {number} currentPrice - Current token price in USD
 * @param {number} athPrice - All-time high price in USD
 * @param {number} binStep - Pool bin step in bps (default 100)
 * @returns {Object} Fib levels + entry zone assessment
 */
export function computeAthFibonacci(currentPrice, athPrice, binStep = 100) {
  if (!currentPrice || !athPrice || athPrice <= 0 || currentPrice <= 0) {
    return { valid: false, reason: "Missing price or ATH data" };
  }

  const retracePct = ((athPrice - currentPrice) / athPrice) * 100;

  const levels = {
    "0.236": athPrice * (1 - 0.236),
    "0.382": athPrice * (1 - 0.382),
    "0.500": athPrice * (1 - 0.500),
    "0.618": athPrice * (1 - 0.618),
    "0.702": athPrice * (1 - 0.702),
    "0.786": athPrice * (1 - 0.786),
  };

  let currentZone = "above_0.236";
  if (currentPrice <= levels["0.786"]) currentZone = "below_0.786";
  else if (currentPrice <= levels["0.702"]) currentZone = "0.702_to_0.786";
  else if (currentPrice <= levels["0.618"]) currentZone = "0.618_to_0.702";
  else if (currentPrice <= levels["0.500"]) currentZone = "0.500_to_0.618";
  else if (currentPrice <= levels["0.382"]) currentZone = "0.382_to_0.500";
  else if (currentPrice <= levels["0.236"]) currentZone = "0.236_to_0.382";

  let entryAssessment;
  if (retracePct < 20) entryAssessment = "TOO_EARLY";
  else if (retracePct <= 40) entryAssessment = "IDEAL";
  else if (retracePct <= 62) entryAssessment = "GOOD";
  else if (retracePct <= 70) entryAssessment = "LATE";
  else entryAssessment = "REJECT";

  const dropTo786 = ((currentPrice - levels["0.786"]) / currentPrice) * 100;
  const binsTo786 = Math.max(1, Math.round(Math.max(0, dropTo786) / (binStep / 100)));

  return {
    valid: true,
    ath: athPrice,
    current_price: currentPrice,
    retrace_from_ath_pct: parseFloat(retracePct.toFixed(1)),
    current_zone: currentZone,
    entry_assessment: entryAssessment,
    levels: Object.fromEntries(
      Object.entries(levels).map(([k, v]) => [k, parseFloat(v.toFixed(10))])
    ),
    bins_to_786_fib: binsTo786,
    reasoning: `Price at ${retracePct.toFixed(1)}% retrace from ATH ($${athPrice.toFixed(8)}). Zone: ${currentZone}. Entry: ${entryAssessment}. Need ${binsTo786} bins to cover down to 0.786 Fib.`,
  };
}

// Also export for backward compatibility with fibonacci.js
export async function calculateFibonacciRange(poolAddress, binStep = 100) {
  return analyzeRange(poolAddress, binStep);
}
