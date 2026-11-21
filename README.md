[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/aramexbit/token-radar-01-v8/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/aramexbit/token-radar-01-v8/reward.svg)](https://make.fun/bounty/token-radar-01)

# TOKEN RADAR v8

Which pre-token protocol is worth farming — priced from the snapshot's own numbers, not a list.

Entry for [token-radar-01 on make.fun](https://make.fun/bounty/token-radar-01).

## What it does

The snapshot holds 758 protocols. 416 already have a token; 342 do not. This radar
prices the 342 pre-token protocols and ranks the 198 that are genuine launch
candidates, each with a concrete 8-step farm plan, a net dollar value after gas
and fees, and a verdict.

**The model — one global curve, two multipliers:**

- **Curve:** OLS of log10(market cap) on log10(TVL) over the 127 traded
  protocols (deduped by ticker). Slope **0.508**, intercept **3.146**.
- **Growth:** ×0.8–1.2 from the protocol's 7-day TVL change.
- **Age:** ×0.85–1.0 from time without a token (floored at five years).
- **Cap:** 10× TVL (never binds).

**The farm:** each row gets an 8-step plan (Day 1–56) generated from its
category, chains, TVL tier, 7-day move and listing age, with a deposit, gas
on the cheapest chain, and a stop rule. Netting prices the farm off the **low
end** of a 2,000-refit bootstrap value band, minus gas and a 0.5% fee, over
2 hours of hands-on work. Farm = clears $25 net; skip = a dollar or less;
everything else is thin.

**Validation (recomputed from this build):** leave-one-out 84.1% median miss /
33.9% in-2× / 42.5% in-3× (n=127); blind split 88.0% / 35.4% (47 train /
48 test); walk-forward pooled 84.4% / 36.8% / 54.4% (n=57). Category offsets
were computed and rejected on the walk-forward — see the Method tab.

**Honesty:** the curve explains a fifth of the variance (R² ≈ 0.19). The model
ranks; it does not price to the dollar. Every detail view carries a case
against its own row.

## Top of the board

| # | Protocol | Implied | × TVL |
|---|----------|---------|-------|
| 1 | Sentora | $84.2M | 0.03× |
| 2 | Steakhouse | $79.3M | 0.03× |
| 3 | Gauntlet | $64.5M | 0.03× |
| 4 | Veda | $55.3M | 0.03× |
| 5 | USDD | $48.1M | 0.03× |

Verdicts: **23 farm / 151 thin / 24 skip**. Best net per hour: Valos, +$17.75/h.

## Run it

Node 22, stdlib only. No dependencies to install.

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path/to/snapshot.json>
```

This writes `out/board.json` (the ranked board), `out/data.js` (the
dashboard payload), `out/dashboard/` (the page), `out/screenshots/` and
`out/dossier.json`. In the grading sandbox the snapshot is
`/input/snapshot.json` and the output directory is `/output`.

## Layout

- `main.ts` — entry point: reads the snapshot, builds the board, writes the output.
- `lib/model.ts` — comps, OLS, growth/age multipliers, implied value, set-aside, validation, token odds.
- `lib/plan.ts` — the farm-step generator (13 plays by category) and the gas table.
- `lib/netting.ts` — bootstrap value band, net, verdicts, break-even.
- `dashboard/` — the page (`index.html`, `app.css`, `app.js`).
- `vendor/makefun-board.ts` — the kit's dossier builder (copied from the kit starter, as the kit instructs).

## License

MIT — see [LICENSE](LICENSE).
