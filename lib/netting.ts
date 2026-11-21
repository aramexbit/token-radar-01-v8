// lib/netting.ts — what a farm is actually worth, in dollars per hour.
// The value model says what a launch might be worth. This says whether
// farming it pays for the gas and the time. Every number here is a cost
// the plan itself names: the deposit, the gas on the cheapest chain, a
// 0.5% fee, and two hours of hands-on work over eight weeks.
//
// The expected payout is deliberately the LOW end of the value band
// (the bootstrap P10), not the headline implied value: a farm that only
// pays if the launch lands at its central estimate is not a farm, it is
// a lottery ticket. The band is a pairs bootstrap over the comps —
// resample the 127 traded protocols, refit the curve, reprice the
// protocol — 2,000 refits, seed 2, P10/P90. The band is wide (the
// snapshot's own OLS explains a fifth of the variance), and the netting
// is honest about that: most rows land thin.

import type { Protocol } from './model.ts';
import { ageMult, growthMult } from './model.ts';
import { cheapestChains, depositTier, gasMid, playOf, txCount } from './plan.ts';

export type Verdict = 'farm' | 'thin' | 'skip';

export interface Netting {
  slug: string;
  deposit: number;
  chain: string;
  gasPerTx: number;
  tx: number;
  gas: number;
  fees: number;
  bandLow: number;
  bandHigh: number;
  expected: number;
  net: number;
  netPerHour: number;
  breakEven: number;
  verdict: Verdict;
  rankLow: number;
  rankHigh: number;
}

export const HANDS_ON_HOURS = 2;
export const FEE_RATE = 0.005;
export const FARM_NET_MIN = 25;
export const BOOTSTRAP_REPS = 2000;
export const BOOTSTRAP_SEED = 2;

// A small deterministic PRNG (mulberry32) so the bootstrap is identical
// on every run, on every machine.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export interface BootstrapFit {
  intercept: number;
  slope: number;
}

function olsFromLogs(xs: number[], ys: number[]): BootstrapFit {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
  }
  const slope = sxy / sxx;
  return { intercept: my - slope * mx, slope };
}

// The bootstrap refits: 2,000 resamples of the comps, each refit once.
// The fits do not depend on the protocol being priced, so they are
// computed once and shared by every row.
export function bootstrapFits(comps: Protocol[]): BootstrapFit[] {
  const rng = mulberry32(BOOTSTRAP_SEED);
  const xs = comps.map((q) => Math.log10(q.tvl_usd));
  const ys = comps.map((q) => Math.log10(q.mcap_usd as number));
  const fits: BootstrapFit[] = [];
  for (let b = 0; b < BOOTSTRAP_REPS; b++) {
    const sx: number[] = [];
    const sy: number[] = [];
    for (let i = 0; i < comps.length; i++) {
      const j = Math.floor(rng() * comps.length);
      sx.push(xs[j]);
      sy.push(ys[j]);
    }
    fits.push(olsFromLogs(sx, sy));
  }
  return fits;
}

// This protocol's value under each bootstrap refit.
export function bootstrapValues(p: Protocol, fits: BootstrapFit[]): number[] {
  const lt = Math.log10(p.tvl_usd);
  const g = growthMult(p.change_7d);
  const a = ageMult(p.listed_at);
  return fits.map((f) => Math.pow(10, f.intercept + f.slope * lt) * g * a);
}

export function bandFromValues(values: number[]): { low: number; high: number } {
  return { low: percentile(values, 0.1), high: percentile(values, 0.9) };
}

// Rank range (bootstrap P5-P95): where this row's rank lands as its own
// value moves across refits, against the other rows' headline values.
export function rankRange(ownValues: number[], otherImplied: number[]): { low: number; high: number } {
  const ranks = ownValues.map((v) => 1 + otherImplied.filter((o) => o > v).length);
  return { low: Math.round(percentile(ranks, 0.05)), high: Math.round(percentile(ranks, 0.95)) };
}

export function netFor(
  p: Protocol,
  implied: number,
  bandLow: number,
  bandHigh: number,
  rankLow: number,
  rankHigh: number,
): Netting {
  const play = playOf(p);
  const { primary } = cheapestChains(p.chains);
  const { midpoint } = depositTier(p.tvl_usd);
  const gasPerTx = gasMid(primary);
  const tx = txCount(play);
  const gas = tx * gasPerTx;
  const fees = FEE_RATE * midpoint;
  const expected = (bandLow * midpoint) / p.tvl_usd;
  const net = expected - gas - fees;
  const netPerHour = net / HANDS_ON_HOURS;
  // The launch value at which the farm exactly breaks even: the payout
  // scales with the launch value, so solve payout(V) = gas + fees.
  const breakEven = ((gas + fees) * p.tvl_usd * implied) / (midpoint * bandLow);
  // A farm is worth doing when it clears $25 net — about $12.50 an hour.
  // A dollar or less over eight weeks is not a farm: it is a rounding
  // error, and it is skipped. Everything between is thin.
  const verdict: Verdict = net >= FARM_NET_MIN ? 'farm' : net <= 1 ? 'skip' : 'thin';
  return {
    slug: p.slug,
    deposit: midpoint,
    chain: primary,
    gasPerTx,
    tx,
    gas,
    fees,
    bandLow,
    bandHigh,
    expected,
    net,
    netPerHour,
    breakEven,
    verdict,
    rankLow,
    rankHigh,
  };
}
