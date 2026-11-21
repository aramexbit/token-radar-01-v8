// lib/model.ts — the value model for token-radar-01 v8.
// Reads the sealed snapshot, fits one global OLS curve of log10(market cap)
// on log10(TVL) over the traded comps, and prices every pre-token protocol
// as curve x growth x age, capped at 10x TVL. No external data, stdlib only.
//
// The model is deliberately the snapshot's own OLS: the top-10 entries of
// this competition all sit near it (slope 0.386-0.555), and every richer
// variant tried (category multiples, per-chain curves, random forest, ridge)
// failed to beat it out of sample. See the Method tab for the evidence.

export interface Protocol {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  fetched_at: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface OlsFit {
  intercept: number;
  slope: number;
  n: number;
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

export const AS_OF = '2026-11-14';
const AS_OF_MS = Date.parse(AS_OF + 'T00:00:00Z');
const DAYS = 86400000;

// ---------- helpers ----------
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 === 1 ? s[Math.floor(n / 2)] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

export function log10(x: number): number {
  return Math.log10(x);
}

// ---------- comps ----------
// A comp is a protocol whose token is already traded: it has a market cap
// and a TVL. Deduped by ticker (case-insensitive, first in slug order) so
// one token counted twice cannot bend the curve.
export function selectComps(protocols: Protocol[]): Protocol[] {
  const seen = new Map<string, Protocol>();
  const sorted = [...protocols].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of sorted) {
    if (p.mcap_usd == null || p.mcap_usd <= 0) continue;
    const key = (p.symbol || '').toLowerCase();
    if (!seen.has(key)) seen.set(key, p);
  }
  return [...seen.values()];
}

// The raw (undeduplicated) comp set, used only for the "vs raw OLS" ratios
// the detail view shows, so a reader can see the dedupe changed nothing.
export function selectRawComps(protocols: Protocol[]): Protocol[] {
  return protocols.filter((p) => p.mcap_usd != null && p.mcap_usd > 0);
}

// ---------- OLS ----------
export function ols(comps: Protocol[]): OlsFit {
  const xs = comps.map((p) => log10(p.tvl_usd));
  const ys = comps.map((p) => log10(p.mcap_usd as number));
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
  return { intercept: my - slope * mx, slope, n };
}

export function curveValue(fit: OlsFit, tvl: number): number {
  return Math.pow(10, fit.intercept + fit.slope * log10(tvl));
}

// ---------- multipliers ----------
// Growth: the 7-day TVL change, clamped to x0.8-x1.2 so a single wild week
// cannot dominate the price. No 7-day change reported -> x1.0.
export function growthMult(change7d: number | null): number {
  if (change7d == null) return 1.0;
  return Math.min(1.2, Math.max(0.8, 1 + change7d / 100));
}

// Age: the longer a protocol has waited without a token, the less its
// launch is worth — a slow logarithmic decay, floored at x0.85, reaching
// the floor at five years. No listing date reported -> x1.0.
export function ageMult(listedAt: string | null): number {
  if (!listedAt) return 1.0;
  const ageDays = (AS_OF_MS - Date.parse(listedAt)) / DAYS;
  return Math.max(0.85, 1 - (0.15 * Math.log(1 + ageDays / 365.25)) / Math.log(6));
}

export function ageDays(listedAt: string | null): number | null {
  if (!listedAt) return null;
  return Math.round((AS_OF_MS - Date.parse(listedAt)) / DAYS);
}

// ---------- implied value ----------
export function impliedValue(p: Protocol, fit: OlsFit): number {
  const curve = curveValue(fit, p.tvl_usd);
  const value = Math.round(curve * growthMult(p.change_7d) * ageMult(p.listed_at));
  return Math.min(value, 10 * p.tvl_usd);
}

// ---------- set-aside ----------
// Pre-token protocols that are not launch candidates: exchanges and bridges
// and liquid-staking wrappers already have a token elsewhere, versioned
// names are a second deployment of a tokened protocol, and wrapped/staked
// names are a derivative of one. Priority: category, then version marker,
// then wrapped/staked word, then exchange name.
const SET_ASIDE_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const VERSION_RE = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_RE = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_RE = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

export type SetAsideReason = 'category' | 'versioned' | 'wrapped' | 'exchange';

export function setAsideReason(p: Protocol): SetAsideReason | null {
  if (SET_ASIDE_CATEGORIES.has(p.category)) return 'category';
  if (VERSION_RE.test(p.name)) return 'versioned';
  if (WRAPPED_RE.test(p.name)) return 'wrapped';
  if (EXCHANGE_RE.test(p.name)) return 'exchange';
  return null;
}

export interface SetAsideGroup {
  reason: SetAsideReason;
  label: string;
  slugs: string[];
}

export function buildBoard(protocols: Protocol[], fit: OlsFit): { rows: BoardRow[]; setAside: SetAsideGroup[] } {
  const rows: BoardRow[] = [];
  const groups = new Map<SetAsideReason, string[]>();
  for (const p of protocols) {
    if (p.symbol != null) continue; // already has a token
    const reason = setAsideReason(p);
    if (reason) {
      if (!groups.has(reason)) groups.set(reason, []);
      groups.get(reason)!.push(p.slug);
      continue;
    }
    rows.push({ slug: p.slug, name: p.name, rank: 0, implied_value_usd: impliedValue(p, fit), farm_steps: [] });
  }
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : 1));
  rows.forEach((r, i) => (r.rank = i + 1));
  const labels: Record<SetAsideReason, string> = {
    category: 'Category already tokened elsewhere (CEX, bridge, liquid staking)',
    versioned: 'Versioned redeploy of a tokened protocol',
    wrapped: 'Wrapped / staked derivative of a tokened protocol',
    exchange: 'Named after an exchange',
  };
  const setAside: SetAsideGroup[] = (['category', 'versioned', 'wrapped', 'exchange'] as SetAsideReason[])
    .filter((r) => groups.has(r))
    .map((r) => ({ reason: r, label: labels[r], slugs: groups.get(r)!.sort() }));
  return { rows, setAside };
}

// ---------- validation ----------
export interface Metric {
  n: number;
  medErr: number; // median |pred - actual| / actual, in percent
  in2: number; // % of predictions within 2x of actual
  in3: number; // % of predictions within 3x of actual
}

export function summarize(preds: number[], actuals: number[]): Metric {
  const errs = preds.map((pr, i) => Math.abs(pr - actuals[i]) / actuals[i]);
  const ratios = preds.map((pr, i) => pr / actuals[i]);
  return {
    n: preds.length,
    medErr: median(errs) * 100,
    in2: (ratios.filter((r) => r >= 0.5 && r <= 2).length / ratios.length) * 100,
    in3: (ratios.filter((r) => r >= 1 / 3 && r <= 3).length / ratios.length) * 100,
  };
}

export type LooMode = 'flat' | 'curve' | 'growth' | 'age' | 'full';

export function looPredict(comps: Protocol[], mode: LooMode): Metric {
  const preds: number[] = [];
  const actuals: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const p = comps[i];
    let pred: number;
    if (mode === 'flat') {
      // A flat MC/TVL ratio: the median ratio of the training comps.
      pred = median(train.map((q) => (q.mcap_usd as number) / q.tvl_usd)) * p.tvl_usd;
    } else {
      const fit = ols(train);
      pred = curveValue(fit, p.tvl_usd);
      if (mode === 'growth' || mode === 'full') pred *= growthMult(p.change_7d);
      if (mode === 'age' || mode === 'full') pred *= ageMult(p.listed_at);
    }
    preds.push(pred);
    actuals.push(p.mcap_usd as number);
  }
  return summarize(preds, actuals);
}

// Blind time split: fit on protocols listed before 2024-02-18, test on the
// rest. The cutoff is the median listing date of the dated comps.
export function blindSplit(comps: Protocol[]): { train: number; test: number; metric: Metric } {
  const cutoff = Date.parse('2024-02-18');
  const dated = comps.filter((p) => p.listed_at);
  const train = dated.filter((p) => Date.parse(p.listed_at as string) < cutoff);
  const test = dated.filter((p) => Date.parse(p.listed_at as string) >= cutoff);
  const fit = ols(train);
  const preds = test.map((p) => curveValue(fit, p.tvl_usd));
  return { train: train.length, test: test.length, metric: summarize(preds, test.map((p) => p.mcap_usd as number)) };
}

// Walk-forward: the dated comps in listing order, expanding windows at
// 40/60/80%, each tested on the next 20%. Pooled over the three folds.
export function walkForward(comps: Protocol[], mode: 'curve' | 'full'): { pooled: Metric; folds: Metric[] } {
  const dated = [...comps.filter((p) => p.listed_at)].sort(
    (a, b) => Date.parse(a.listed_at as string) - Date.parse(b.listed_at as string),
  );
  const allP: number[] = [];
  const allA: number[] = [];
  const folds: Metric[] = [];
  for (const c of [0.4, 0.6, 0.8]) {
    const k = Math.floor(dated.length * c);
    const train = dated.slice(0, k);
    const test = dated.slice(k, Math.floor(dated.length * (c + 0.2)));
    const fit = ols(train);
    const preds = test.map((p) => {
      let pr = curveValue(fit, p.tvl_usd);
      if (mode === 'full') pr *= growthMult(p.change_7d) * ageMult(p.listed_at);
      return pr;
    });
    const actuals = test.map((p) => p.mcap_usd as number);
    folds.push(summarize(preds, actuals));
    allP.push(...preds);
    allA.push(...actuals);
  }
  return { pooled: summarize(allP, allA), folds };
}

// Category offsets: each category's median log-residual from the training
// fit, shrunk by n/(n+4) pseudo-observations so thin categories stay near
// neutral. k=4 is the shrinkage that was tested and rejected.
export function categoryOffsets(train: Protocol[]): Map<string, number> {
  const fit = ols(train);
  const byCat = new Map<string, number[]>();
  for (const p of train) {
    const resid = log10(p.mcap_usd as number) - (fit.intercept + fit.slope * log10(p.tvl_usd));
    if (!byCat.has(p.category)) byCat.set(p.category, []);
    byCat.get(p.category)!.push(resid);
  }
  const out = new Map<string, number>();
  for (const [cat, rs] of byCat) {
    out.set(cat, median(rs) * (rs.length / (rs.length + 4)));
  }
  return out;
}

export function walkForwardOffset(comps: Protocol[], mode: 'curve' | 'full'): Metric {
  const dated = [...comps.filter((p) => p.listed_at)].sort(
    (a, b) => Date.parse(a.listed_at as string) - Date.parse(b.listed_at as string),
  );
  const allP: number[] = [];
  const allA: number[] = [];
  for (const c of [0.4, 0.6, 0.8]) {
    const k = Math.floor(dated.length * c);
    const train = dated.slice(0, k);
    const test = dated.slice(k, Math.floor(dated.length * (c + 0.2)));
    const fit = ols(train);
    const off = categoryOffsets(train);
    for (const p of test) {
      let pr = curveValue(fit, p.tvl_usd);
      if (mode === 'full') pr *= growthMult(p.change_7d) * ageMult(p.listed_at);
      pr *= Math.pow(10, off.get(p.category) || 0);
      allP.push(pr);
      allA.push(p.mcap_usd as number);
    }
  }
  return summarize(allP, allA);
}

// ---------- token odds (display only, never a model input) ----------
// Of the protocols listed at least N years ago (as of 2026-11-12), what
// share has a token today? Counted live from the snapshot.
export interface TokenOdds {
  years: number;
  listed: number;
  tokened: number;
  pct: number;
}

export function tokenOdds(protocols: Protocol[]): TokenOdds[] {
  // Cohorts as of 2026-11-12, counted in whole calendar years (365 days):
  // a protocol listed on 2025-11-12 is exactly 1 year old on 2026-11-12.
  // (The age multiplier in the model uses 365.25 days/year; the cohorts
  // use calendar years. They are different questions.)
  const asOf = Date.parse('2026-11-12T00:00:00Z');
  const out: TokenOdds[] = [];
  for (const years of [1, 2, 3]) {
    const cutoff = asOf - years * 365 * DAYS;
    let listed = 0;
    let tokened = 0;
    for (const p of protocols) {
      if (!p.listed_at) continue;
      if (Date.parse(p.listed_at) <= cutoff) {
        listed++;
        if (p.symbol != null) tokened++;
      }
    }
    out.push({ years, listed, tokened, pct: (tokened / listed) * 100 });
  }
  return out;
}

// ---------- nearest comps (detail view) ----------
// Same category first, then nearest by TVL. Honest: a comp that breaks the
// curve (e.g. a same-category protocol trading at 3x TVL) is shown as-is.
export interface NearComp {
  slug: string;
  name: string;
  category: string;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
  curve_usd: number;
  sameCategory: boolean;
}

export function nearestComps(p: Protocol, comps: Protocol[], fit: OlsFit, n = 4): NearComp[] {
  const lt = log10(p.tvl_usd);
  const scored = comps.map((q) => ({
    q,
    same: q.category === p.category,
    dist: Math.abs(log10(q.tvl_usd) - lt),
  }));
  scored.sort((a, b) => (a.same === b.same ? a.dist - b.dist : a.same ? -1 : 1));
  return scored.slice(0, n).map(({ q, same }) => ({
    slug: q.slug,
    name: q.name,
    category: q.category,
    tvl_usd: q.tvl_usd,
    mcap_usd: q.mcap_usd as number,
    ratio: (q.mcap_usd as number) / q.tvl_usd,
    curve_usd: Math.round(curveValue(fit, q.tvl_usd)),
    sameCategory: same,
  }));
}
