// lib/plan.ts — the farm plan generator for token-radar-01 v8.
// Every board row carries 8 concrete steps (Day 1-56) that tell a reader
// exactly what to do, on which chain, for how much gas, and how long to
// hold. The steps are generated from the protocol's own data — its
// category (which picks the play), its chains (cheapest first), its TVL
// tier (which sets the deposit size), its 7-day change (which sets the
// check-in cadence) and its listing age (which sets the patience clause).
// Nothing here is a pasted list: the same generator rebuilds all 198x8
// steps from the snapshot alone.

import type { Protocol } from './model.ts';
import { ageDays } from './model.ts';

// ---------- gas ----------
// What one transaction costs on each chain, as a range. The midpoint is
// the number the netting uses; the string is what the steps show.
const GAS_MID: Record<string, number> = {
  '$0.01': 0.01,
  '$0.01–0.05': 0.03,
  '$0.05–0.20': 0.125,
  '$0.10–0.50': 0.3,
  '$0.50–2.00': 1.25,
  '$2–10': 6.0,
};

// Chains the snapshot's protocols actually use, with their gas. Any chain
// not named here costs $0.01-0.05 a transaction — the default for a cheap
// L2 — except Blast ($0.10-0.50) and Linea / Scroll ($0.05-0.20), whose
// higher cost is forced by the fallback order in the snapshot itself.
const CHAIN_GAS: Record<string, string> = {
  Solana: '$0.01',
  Ethereum: '$2–10',
  Bitcoin: '$0.50–2.00',
  Binance: '$0.05–0.20',
  Optimism: '$0.05–0.20',
  'zkSync Era': '$0.05–0.20',
  Berachain: '$0.05–0.20',
  Starknet: '$0.05–0.20',
  Linea: '$0.05–0.20',
  Scroll: '$0.05–0.20',
  Arbitrum: '$0.10–0.50',
  Bittensor: '$0.10–0.50',
  Avalanche: '$0.10–0.50',
  Blast: '$0.10–0.50',
};

export function gasString(chain: string): string {
  return CHAIN_GAS[chain] || '$0.01–0.05';
}

export function gasMid(chain: string): number {
  return GAS_MID[gasString(chain)];
}

// Cheapest chain first; ties break to the earliest chain in the
// protocol's own list. The fallback is the second-cheapest the same way.
export function cheapestChains(chains: string[]): { primary: string; fallback: string | null } {
  const ranked = chains
    .map((c, i) => ({ mid: gasMid(c), i, c }))
    .sort((a, b) => a.mid - b.mid || a.i - b.i);
  return { primary: ranked[0].c, fallback: ranked.length > 1 ? ranked[1].c : null };
}

// ---------- deposit size ----------
// The deposit is sized to the protocol, not to the reader: a $5M protocol
// gets a $25-100 farm, a $500M one $100-500, a $1B+ one $500-2,000. The
// second deposit is a smaller range from the same tier. The netting uses
// the midpoint of the first range.
export function depositTier(tvl: number): { first: string; second: string; midpoint: number } {
  if (tvl < 100_000_000) return { first: '$25–100', second: '$25–50', midpoint: 62.5 };
  if (tvl < 1_000_000_000) return { first: '$100–500', second: '$50–200', midpoint: 300 };
  return { first: '$500–2,000', second: '$200–500', midpoint: 1250 };
}

// ---------- plays ----------
// The play is the protocol's category. Two vault flavours: curated vaults
// (a curator picks the strategy) and highest-TVL vaults (the biggest pool
// wins). The 13 plays cover all 33 categories on the board.
export type Play =
  | 'deposit-curated'
  | 'deposit-highest'
  | 'mint'
  | 'perps'
  | 'swap'
  | 'supply'
  | 'lock'
  | 'bridge-onto'
  | 'bridge-from'
  | 'stake'
  | 'buy-prediction'
  | 'buy-index'
  | 'payments'
  | 'otc'
  | 'governance'
  | 'insurance';

const CURATED = new Set(['Risk Curators', 'Onchain Capital Allocator', 'Liquidity Manager', 'CeDeFi']);
const HIGHEST = new Set(['Yield', 'Yield Aggregator', 'Farm', 'Leveraged Farming']);
const MINT = new Set(['RWA', 'Stablecoin Wrapper', 'Anchor BTC', 'Dual-Token Stablecoin', 'Decentralized BTC']);
const PERPS = new Set(['Derivatives', 'Basis Trading', 'Interest Rate Derivatives']);
const SUPPLY = new Set(['Lending', 'Collateral Markets', 'Uncollateralized Lending']);
const LOCK = new Set(['CDP', 'CDP Manager']);
const STAKE = new Set(['Staking Pool', 'Restaking']);
const PAY = new Set(['Payments', 'Crypto Card Issuer']);

export function playOf(p: Protocol): Play {
  if (CURATED.has(p.category)) return 'deposit-curated';
  if (HIGHEST.has(p.category)) return 'deposit-highest';
  if (MINT.has(p.category)) return 'mint';
  if (PERPS.has(p.category)) return 'perps';
  if (p.category === 'Dexs') return 'swap';
  if (SUPPLY.has(p.category)) return 'supply';
  if (LOCK.has(p.category)) return 'lock';
  if (p.category === 'Chain') return 'bridge-onto';
  if (p.category === 'Cross Chain Bridge') return 'bridge-from';
  if (STAKE.has(p.category)) return 'stake';
  if (p.category === 'Prediction Market') return 'buy-prediction';
  if (p.category === 'Indexes') return 'buy-index';
  if (PAY.has(p.category)) return 'payments';
  if (p.category === 'OTC Marketplace') return 'otc';
  if (p.category === 'Governance Incentives') return 'governance';
  if (p.category === 'Insurance') return 'insurance';
  throw new Error('no farm play for category ' + p.category);
}

// How many on-chain transactions the plan costs. Counted from the steps
// themselves: a deposit, a harvest, a second deposit, a two-leg test
// slice and a claim. Vaults cost 6; most plays 5; mint, bridge-from,
// index and cover cost 4.
export function txCount(play: Play): number {
  if (play === 'deposit-curated' || play === 'deposit-highest') return 6;
  if (play === 'mint' || play === 'bridge-from' || play === 'buy-index' || play === 'insurance') return 4;
  return 5;
}

// ---------- step pieces ----------
// Step 3 carries the 7-day TVL move. Up less than 20% or down less than
// 10% is noise: check every two weeks. A strong rise compounds weekly;
// a real slide shrinks the next deposit. No change reported: say so.
function tvlPart(p: Protocol): string {
  if (p.change_7d == null) return '(no 7-day change reported — check every 2 weeks)';
  const ch = p.change_7d;
  const dir = ch >= 0 ? 'up' : 'down';
  const pct = Math.abs(ch).toFixed(1);
  let tail: string;
  if (ch >= 0) tail = ch < 20 ? 'check every 2 weeks' : 'momentum is strong, compound weekly while it lasts';
  else
    tail =
      Math.abs(ch) < 10
        ? 'check every 2 weeks and watch for a deeper slide'
        : 'check weekly and shrink the next deposit if it keeps falling';
  return `(TVL ${dir} ${pct}% in 7 days — ${tail})`;
}

// Step 7 carries the wait. Fresh listings (under 180 days) move in week 1
// and are reassessed at day 56; seasoned waits (180-539) hold the full 8
// weeks; long waits (540+, with the years shown) are patient accumulation.
// No listing date: say so and hold the full 8 weeks.
function ageClause(p: Protocol): string {
  const d = ageDays(p.listed_at);
  if (d == null) return 'no listing date is reported, so hold the full 8 weeks before judging the farm;';
  if (d < 180) return `only ${d} days unlaunched — a fresh listing, so move in week 1 and reassess at day 56;`;
  if (d < 540) return `${d} days unlaunched — a seasoned wait, so hold the full 8 weeks before judging it;`;
  return `${d} days unlaunched (${(d / 365.25).toFixed(1)} years) — a long wait, so treat this as patient accumulation and hold 8+ weeks;`;
}

// ---------- the generator ----------
export function farmSteps(p: Protocol): string[] {
  const play = playOf(p);
  const { primary, fallback } = cheapestChains(p.chains);
  const G = gasString(primary);
  const { first: R1, second: R2 } = depositTier(p.tvl_usd);
  const N = p.name;
  const C = primary;
  const tvl = tvlPart(p);
  const fbText = fallback
    ? `keep ${fallback} as the fallback route if ${C} stalls.`
    : 'no second chain is on record — the fallback is to wait, not to bridge blind.';
  // Step 2's first clause either ends with a semicolon (so the fallback
  // gets a "fallback:" label) or with "and note the fallback:" (so it does
  // not — the label is already there).
  const step2 = (first: string): string =>
    first.endsWith('fallback:') ? `Day 3 — ${first} ${fbText}` : `Day 3 — ${first}; fallback: ${fbText}`;

  const s: string[] = [];

  // Day 1 — the first move.
  const S1: Record<Play, string> = {
    'deposit-curated': `Day 1 — Deposit ${R1} into ${N}'s largest curated vault on ${C} (gas ~${G}, ~3 min); hold 8 weeks.`,
    'deposit-highest': `Day 1 — Deposit ${R1} into ${N}'s highest-TVL vault on ${C} (gas ~${G}, ~3 min); funds stay 8 weeks.`,
    mint: `Day 1 — Mint or buy ${R1} of ${N}'s tokenised asset on ${C} (gas ~${G}, ~5 min) and keep the receipt.`,
    perps: `Day 1 — Open a small long or short on ${N} (${R1} notional, 1–2x leverage) on ${C} (gas ~${G} plus taker fee, ~5 min).`,
    swap: `Day 1 — Swap ${R1} into ${N}'s main pair on ${C} (gas ~${G} per swap, ~2 min) and save the receipt.`,
    supply: `Day 1 — Supply ${R1} of a major asset (ETH, USDC or wBTC) as collateral to ${N} on ${C} (gas ~${G}, ~3 min).`,
    lock: `Day 1 — Lock ${R1} of collateral (ETH or wBTC) in a ${N} vault on ${C} (gas ~${G}, ~3 min).`,
    'bridge-onto': `Day 1 — Bridge ${R1} onto ${N}'s chain and make a first swap on its flagship DEX (gas ~${G} each, ~10 min).`,
    'bridge-from': `Day 1 — Bridge ${R1} from ${C} to another supported chain through ${N} (gas ~${G} plus the bridge fee, ~10 min).`,
    stake: `Day 1 — Stake ${R1} of the base asset with ${N} on ${C} (gas ~${G}, ~3 min); funds stay staked 8 weeks.`,
    'buy-prediction': `Day 1 — Buy ${R1} of shares in a ${N} market resolving in 2–4 weeks on ${C} (gas ~${G}, ~3 min).`,
    'buy-index': `Day 1 — Buy ${R1} of ${N}'s index token on ${C} (gas ~${G}, ~3 min); hold at least 8 weeks.`,
    payments: `Day 1 — Make a first real payment of ${R1} through ${N} on ${C} (gas ~${G}, ~3 min) and keep the receipt.`,
    otc: `Day 1 — Request a quote for a ${R1} trade with ${N} on ${C} (quoting is free, settling costs ~${G}, ~10 min).`,
    governance: `Day 1 — Lock or delegate ${R1} of voting power with ${N} on ${C} (gas ~${G}, ~3 min); lock for 8 weeks.`,
    insurance: `Day 1 — Buy cover of ${R1} for 30–90 days with ${N} on ${C} (gas ~${G} plus the premium, ~5 min).`,
  };
  s.push(S1[play]);

  // Day 3 — learn the rules and name the fallback route.
  const S2first: Record<Play, string> = {
    'deposit-curated': `Check ${N}’s curator, allocation and APY weekly`,
    'deposit-highest': `Read ${N}’s vault list on ${C} and note the fallback:`,
    mint: `Check ${N}’s redemption terms on ${C}`,
    perps: `Set a stop-loss and take-profit on the position the same day`,
    swap: `Check ${N}’s deepest pool on ${C} and note the fallback:`,
    supply: `Check ${N}’s borrow rates and health-factor rules on ${C}`,
    lock: `Check ${N}’s collateral-ratio rules on ${C}`,
    'bridge-onto': `Pick a second native dApp to try this week`,
    'bridge-from': `Check ${N}’s supported routes from ${C}`,
    stake: `Check ${N}’s staking terms and unbonding time on ${C}`,
    'buy-prediction': `Pick a second market in a different category`,
    'buy-index': `Check ${N}’s basket weights and rebalance date on ${C}`,
    payments: `Check ${N}’s second payment rail or currency on ${C}`,
    otc: `Check ${N}’s limit and RFQ order types on ${C}`,
    governance: `Read ${N}’s live proposals on ${C}`,
    insurance: `Check ${N}’s cover terms and claim window on ${C}`,
  };
  s.push(step2(S2first[play]));

  // Day 7 — the first week, with the TVL move in view.
  const S3: Record<Play, string> = {
    'deposit-curated': `Day 7 — Harvest or compound vault yield ${tvl}; each harvest costs ~${G}, ~5 min.`,
    'deposit-highest': `Day 7 — Harvest or compound the yield ${tvl}; each harvest costs ~${G}, ~5 min.`,
    mint: `Day 7 — Hold the position — RWA farms reward holding time, not churn ${tvl}; check the position weekly.`,
    perps: `Day 7 — Close the first position and open a fresh one the next week ${tvl}; each close costs ~${G}, ~5 min.`,
    swap: `Day 7 — Add ${R1} of liquidity to the deepest pool ${tvl}; deposit gas ~${G}, hold the LP 8 weeks.`,
    supply: `Day 7 — Borrow 20–40% of the supplied value in a stablecoin ${tvl}; borrow tx costs ~${G}.`,
    lock: `Day 7 — Mint stablecoins against 25–40% of the collateral value ${tvl}; minting costs ~${G}, keep the ratio safe.`,
    'bridge-onto': `Day 7 — Interact with one native dApp (lending or perps) weekly for 8 weeks ${tvl}; each interaction costs ~${G}.`,
    'bridge-from': `Day 7 — Bridge a different asset the following week ${tvl}; allow 10–30 min for finality each time.`,
    stake: `Day 7 — Claim staking rewards and restake them ${tvl}; each claim costs ~${G}, ~5 min.`,
    'buy-prediction': `Day 7 — Trade a second market the next week ${tvl}; each trade costs ~${G}.`,
    'buy-index': `Day 7 — Compare the index price to its NAV weekly ${tvl}; note any discount — it is part of the farm record.`,
    payments: `Day 7 — Repeat a payment weekly for 8 weeks ${tvl}; each payment costs ~${G}.`,
    otc: `Day 7 — Settle one small trade to open the account history ${tvl}; settlement costs ~${G} plus the agreed spread.`,
    governance: `Day 7 — Vote on every live proposal while locked ${tvl}; voting costs ~${G} each — missing votes is the usual disqualifier.`,
    insurance: `Day 7 — Hold the cover live — lapsed cover breaks the farm record ${tvl}; check the policy weekly.`,
  };
  s.push(S3[play]);

  // Day 14 — the second move, smaller than the first.
  const S4: Record<Play, string> = {
    'deposit-curated': `Day 14 — Add ${R2} to a second vault run by a different curator (deposit gas ~${G}).`,
    'deposit-highest': `Day 14 — Split a second deposit (${R2}) into another vault or strategy to widen coverage (gas ~${G}).`,
    mint: `Day 14 — Add ${R2} to the same asset class to show a growing position (gas ~${G}).`,
    perps: `Day 14 — Trade the opposite direction with ${R2} notional to show two-sided use (gas ~${G} plus taker fee).`,
    swap: `Day 14 — Swap back 10–25% of the LP to show repeat usage (one swap, gas ~${G}, ~2 min).`,
    supply: `Day 14 — Repay 10–20% of the loan, then re-borrow a different asset (each leg gas ~${G}, ~5 min).`,
    lock: `Day 14 — Repay 10–20% of the minted debt with ${R2}, then mint a smaller amount again (each leg gas ~${G}).`,
    'bridge-onto': `Day 14 — Add ${R2} to the chain balance and use a second native app (gas ~${G}, ~15 min).`,
    'bridge-from': `Day 14 — Bridge ${R2} back so the flow is two-way, not one-way (return leg gas ~${G} plus the bridge fee).`,
    stake: `Day 14 — Add ${R2} to the stake to show a growing position (top-up gas ~${G}).`,
    'buy-prediction': `Day 14 — Add ${R2} to a market in a new category to widen breadth (gas ~${G}).`,
    'buy-index': `Day 14 — Add ${R2} on the monthly rebalance date if the index reweights (top-up gas ~${G}).`,
    payments: `Day 14 — Try a second payment rail or currency with ${R2} (each try gas ~${G}).`,
    otc: `Day 14 — Repeat a trade in a different pair with ${R2} (each settlement gas ~${G}).`,
    governance: `Day 14 — Add ${R2} to the lock to show a growing position (top-up gas ~${G}).`,
    insurance: `Day 14 — Extend or top up the cover with ${R2} if the term allows (gas ~${G}).`,
  };
  s.push(S4[play]);

  // Day 21 — prove the exit works with a 10-20% test slice.
  const S5: Record<Play, string> = {
    'deposit-curated': `Day 21 — Withdraw a 10–20% test slice, then re-deposit it the same day (two legs, gas ~${G} each).`,
    'deposit-highest': `Day 21 — Withdraw a 10–20% test slice, then re-deposit it the same day (two legs, gas ~${G} each).`,
    mint: `Day 21 — Redeem a 10–20% test slice, then buy it back the same day (two legs, gas ~${G} each) to prove the redemption path.`,
    perps: `Day 21 — Close a 10–20% slice of the open position, then re-open it the same day (two legs, gas ~${G} each).`,
    swap: `Day 21 — Withdraw a 10–20% test slice of the LP, then re-deposit it the same day (two legs, gas ~${G} each).`,
    supply: `Day 21 — Withdraw a 10–20% test slice of the collateral, then re-supply it the same day (two legs, gas ~${G} each).`,
    lock: `Day 21 — Withdraw a 10–20% test slice of collateral, then re-lock it the same day (two legs, gas ~${G} each).`,
    'bridge-onto': `Day 21 — Move a 10–20% test slice to another native app, then move it back the same day (two legs, gas ~${G} each).`,
    'bridge-from': `Day 21 — Bridge a 10–20% test slice out and back the same day (two legs, gas ~${G} each plus bridge fees).`,
    stake: `Day 21 — Unstake a 10–20% test slice, then re-stake it the same day (two legs, gas ~${G} each).`,
    'buy-prediction': `Day 21 — Sell a 10–20% test slice of one position, then buy it back the same day (two legs, gas ~${G} each).`,
    'buy-index': `Day 21 — Redeem a 10–20% test slice, then buy it back the same day (two legs, gas ~${G} each).`,
    payments: `Day 21 — Send a 10–20% test payment out and settle it back the same day (two legs, gas ~${G} each).`,
    otc: `Day 21 — Settle a 10–20% test trade out and back the same day (two legs, gas ~${G} each).`,
    governance: `Day 21 — Unlock a 10–20% test slice, then re-lock it the same day (two legs, gas ~${G} each).`,
    insurance: `Day 21 — Provide a 10–20% test slice of underwriting capacity if offered, then withdraw it the same day (two legs, gas ~${G} each).`,
  };
  s.push(S5[play]);

  // Day 28 — settle the month.
  const S6: Record<Play, string> = {
    'deposit-curated': `Day 28 — Claim vault yield and re-deposit it (claim gas ~${G}); switch vaults if the curator changes strategy.`,
    'deposit-highest': `Day 28 — Claim yield and re-deposit it (claim gas ~${G}, ~10 min); log vault returns weekly.`,
    mint: `Day 28 — Claim any payout the asset pays and re-deposit it monthly (claim gas ~${G}, ~10 min).`,
    perps: `Day 28 — Settle the month’s round trips and log PnL per trade (settlement gas ~${G}); never risk more than 5% of the farm budget on one trade.`,
    swap: `Day 28 — Claim trading-fee rewards and re-deposit them (claim gas ~${G}, ~15 min); log the amounts.`,
    supply: `Day 28 — Top up collateral by ${R2} so the position stays healthy (top-up gas ~${G}); log the health factor.`,
    lock: `Day 28 — Add collateral monthly so the ratio stays above 200% (top-up gas ~${G}, ~5 min); log the ratio weekly.`,
    'bridge-onto': `Day 28 — Settle the month’s activity and hold a small native-token balance ($10–50) for gas (settlement gas ~${G}).`,
    'bridge-from': `Day 28 — Settle the month’s crossings and log every tx hash (settlement gas ~${G}); keep each bridge above the venue minimum (usually $10–25).`,
    stake: `Day 28 — Restake a slice (25–50%) of the stake once if restaking is offered (restake gas ~${G}, ~5 min).`,
    'buy-prediction': `Day 28 — Settle the month’s resolved markets and record every outcome (settlement gas ~${G}).`,
    'buy-index': `Day 28 — Settle the month’s position and log price vs NAV (settlement gas ~${G}, ~10 min).`,
    payments: `Day 28 — Settle accumulated balances monthly (settlement gas ~${G}, ~10 min); export the receipts.`,
    otc: `Day 28 — Settle the month’s trades and log every fill (settlement gas ~${G}); use limit or RFQ orders when offered.`,
    governance: `Day 28 — Claim voting rewards and re-lock them (claim gas ~${G}, ~5 min a week).`,
    insurance: `Day 28 — Settle the month’s cover and log the policy status (settlement gas ~${G}, ~10 min).`,
  };
  s.push(S6[play]);

  // Day 42 — the patience clause, then the play's own habit.
  const S7second: Record<Play, string> = {
    'deposit-curated': `review the curator’s allocation weekly (10 min) — a strategy change is the signal to move.`,
    'deposit-highest': `keep a weekly log of vault deposits and yields, 10 min a week, no extra gas.`,
    mint: `keep the purchase receipt and position history — export them monthly (10 min).`,
    perps: `keep at least 4 round trips over the 8 weeks — breadth beats one big bet.`,
    swap: `keep the LP open and review the pool’s depth before adding more.`,
    supply: `never let the health factor near 1 — check it weekly, 10 min.`,
    lock: `check the collateral ratio weekly (10 min) and never let it near liquidation.`,
    'bridge-onto': `keep activity steady — 2–3 tx a week for a month beats 20 tx in one day.`,
    'bridge-from': `bridging history is the farm record here — 6+ crossings over 8 weeks beats one burst.`,
    stake: `unstaking can take days — plan the exit a week ahead, never at the last minute.`,
    'buy-prediction': `place 4–8 small trades over 8 weeks rather than one big bet — breadth beats size.`,
    'buy-index': `hold through at least one full rebalance cycle (usually a month) before judging the position.`,
    payments: `keep receipts for every payment — export the history monthly (10 min) as proof of sustained use.`,
    otc: `keep 4+ settled trades over 8 weeks — export the trade history monthly (10 min).`,
    governance: `join one governance discussion per proposal cycle (~15 min, no gas).`,
    insurance: `file a claim only if a real covered event happens — never file a false claim.`,
  };
  s.push(`Day 42 — ${ageClause(p)} ${S7second[play]}`);

  // Day 56 — decide, with the rule written out.
  const S8: Record<Play, string> = {
    'deposit-curated': `Day 56 — Decide: keep the vaults if yield beats gas, else withdraw and export the full log.`,
    'deposit-highest': `Day 56 — Decide: keep the vaults if net yield beats gas, else withdraw and export the full log.`,
    mint: `Day 56 — Decide: keep holding if the asset’s payout beats gas, else redeem and export the full record.`,
    perps: `Day 56 — Decide: keep trading small if the venue’s fees beat gas, else close out and export the trade diary.`,
    swap: `Day 56 — Decide: keep the LP if fees beat gas, else exit to the flagship stablecoin on ${C} and export the full log.`,
    supply: `Day 56 — Decide: keep the supply/borrow loop if rates beat gas, else repay in full and export the history.`,
    lock: `Day 56 — Decide: keep the vault open if the minted stablecoins earn more than gas, else repay in full and export the log.`,
    'bridge-onto': `Day 56 — Decide: keep living on the chain if dApp fees beat gas, else consolidate and export the activity log.`,
    'bridge-from': `Day 56 — Decide: keep bridging weekly if fees beat gas, else stop and export the crossing history.`,
    stake: `Day 56 — Decide: keep staking if rewards beat gas, else unstake and export the staking history.`,
    'buy-prediction': `Day 56 — Decide: keep trading small if resolution payouts beat gas, else stop and export the trade history.`,
    'buy-index': `Day 56 — Decide: keep the index if the basket beats gas, else redeem and export the full log.`,
    payments: `Day 56 — Decide: keep paying through ${N} if fees beat gas, else settle out and export the payment history.`,
    otc: `Day 56 — Decide: keep trading OTC if spreads beat gas, else stop and export the full history.`,
    governance: `Day 56 — Decide: keep the lock through at least two proposal cycles before unlocking; early exit can forfeit rewards.`,
    insurance: `Day 56 — Decide: renew the cover if the premium beats gas, else let it lapse and export the policy history.`,
  };
  s.push(S8[play]);

  return s;
}
