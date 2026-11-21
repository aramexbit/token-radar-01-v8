// main.ts — token-radar-01 v8.
// Reads the sealed snapshot, builds the ranked board with a farm plan per
// row, prices every farm, and writes the output directory the gate reads:
//   board.json     the ranked board (the oracle-checked artifact)
//   data.js        the dashboard's data payload
//   dashboard/     the page (copied from this repo)
//   screenshots/   the three screenshots (copied from this repo)
//   dossier.json   the judge's dossier, built by vendor/makefun-board.ts
//
// Run from the repository root:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot>
// In the grading sandbox the snapshot is /input/snapshot.json and the
// output directory is /output. Node 22, stdlib only.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import {
  ageMult,
  blindSplit,
  buildBoard,
  categoryOffsets,
  curveValue,
  growthMult,
  looPredict,
  nearestComps,
  ols,
  selectComps,
  selectRawComps,
  tokenOdds,
  walkForward,
  walkForwardOffset,
  AS_OF,
  type Protocol,
  type Snapshot,
} from './lib/model.ts';
import { farmSteps, playOf } from './lib/plan.ts';
import { bandFromValues, bootstrapFits, bootstrapValues, netFor, rankRange } from './lib/netting.ts';

const ROOT = dirname(fileURLToPath(import.meta.url));

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function money(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US');
}

function main(): void {
  const inputPath = resolve(arg('--input', '/input/snapshot.json'));
  const outDir = resolve(process.env.MAKEFUN_OUTPUT_DIR || '/output');
  const snapBuf = readFileSync(inputPath);
  const snapshotSha = sha256Hex(snapBuf);
  const snap = JSON.parse(snapBuf.toString('utf8')) as Snapshot;
  const protocols: Protocol[] = snap.protocols;

  // --- model ---
  const comps = selectComps(protocols);
  const rawComps = selectRawComps(protocols);
  const fit = ols(comps);
  const rawFit = ols(rawComps);
  const { rows, setAside } = buildBoard(protocols, fit);
  const bySlug = new Map(protocols.map((p) => [p.slug, p]));

  // Farm plans (the generator rebuilds all 198x8 steps from the snapshot).
  for (const r of rows) r.farm_steps = farmSteps(bySlug.get(r.slug)!);

  // --- netting (bootstrap band, one shared set of refits) ---
  const fits = bootstrapFits(comps);
  const impliedBySlug = new Map(rows.map((r) => [r.slug, r.implied_value_usd]));
  const nets = new Map<string, ReturnType<typeof netFor>>();
  for (const r of rows) {
    const p = bySlug.get(r.slug)!;
    const values = bootstrapValues(p, fits);
    const band = bandFromValues(values);
    const others = rows.filter((x) => x.slug !== r.slug).map((x) => x.implied_value_usd);
    const rr = rankRange(values, others);
    nets.set(r.slug, netFor(p, r.implied_value_usd, band.low, band.high, rr.low, rr.high));
  }
  const verdictCounts = { farm: 0, thin: 0, skip: 0 };
  for (const n of nets.values()) verdictCounts[n.verdict]++;
  const bestNet = [...nets.values()].sort((a, b) => b.netPerHour - a.netPerHour)[0];

  // --- validation (recomputed from this implementation) ---
  const loo = {
    flat: looPredict(comps, 'flat'),
    curve: looPredict(comps, 'curve'),
    growth: looPredict(comps, 'growth'),
    age: looPredict(comps, 'age'),
    full: looPredict(comps, 'full'),
  };
  const blind = blindSplit(comps);
  const wf = walkForward(comps, 'curve');
  const wfFull = walkForward(comps, 'full');
  const wfOffsetK4 = walkForwardOffset(comps, 'curve');
  const wfOffsetFull = walkForwardOffset(comps, 'full');
  const odds = tokenOdds(protocols);

  // LOO scatter points (actual vs predicted, full model) for the Method tab.
  const looPoints: [number, number][] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const f = ols(train);
    const p = comps[i];
    const pred = curveValue(f, p.tvl_usd) * growthMult(p.change_7d) * ageMult(p.listed_at);
    looPoints.push([p.mcap_usd as number, Math.round(pred)]);
  }
  // Comp scatter points (log TVL vs log mcap) for the hero scatter.
  const compPoints = comps.map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    x: Math.log10(p.tvl_usd),
    y: Math.log10(p.mcap_usd as number),
  }));
  // The curve itself, sampled across the TVL range.
  const curvePoints: [number, number][] = [];
  for (let lt = 6.5; lt <= 10.6; lt += 0.1) {
    curvePoints.push([lt, fit.intercept + fit.slope * lt]);
  }

  // --- counts ---
  const watchlist = snap.watchlist || [];
  const watchCovered = watchlist.filter((s) => impliedBySlug.has(s)).length;
  const tokened = protocols.filter((p) => p.symbol != null).length;
  const preToken = protocols.length - tokened;
  const setAsideCount = setAside.reduce((s, g) => s + g.slugs.length, 0);

  // --- board.json (the oracle-checked artifact) ---
  const board = {
    as_of: AS_OF,
    rows: rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      rank: r.rank,
      implied_value_usd: r.implied_value_usd,
      farm_steps: r.farm_steps,
    })),
  };
  const boardJson = JSON.stringify(board, null, 2) + '\n';
  const boardSha = sha256Hex(Buffer.from(boardJson, 'utf8'));

  // --- data.js (the dashboard payload) ---
  const enrichedRows = rows.map((r) => {
    const p = bySlug.get(r.slug)!;
    const n = nets.get(r.slug)!;
    const curve = curveValue(fit, p.tvl_usd);
    const near = nearestComps(p, comps, fit, 4);
    return {
      slug: r.slug,
      name: r.name,
      category: p.category,
      chains: p.chains,
      rank: r.rank,
      implied: r.implied_value_usd,
      tvl: p.tvl_usd,
      change7d: p.change_7d,
      listedAt: p.listed_at,
      play: playOf(p),
      chain: n.chain,
      deposit: n.deposit,
      gas: n.gas,
      gasPerTx: n.gasPerTx,
      tx: n.tx,
      fees: n.fees,
      expected: n.expected,
      net: n.net,
      netPerHour: n.netPerHour,
      verdict: n.verdict,
      bandLow: n.bandLow,
      bandHigh: n.bandHigh,
      breakEven: n.breakEven,
      rankLow: n.rankLow,
      rankHigh: n.rankHigh,
      curve: Math.round(curve),
      growth: growthMult(p.change_7d),
      age: ageMult(p.listed_at),
      rawOls: Math.round(curveValue(rawFit, p.tvl_usd)),
      farmSteps: r.farm_steps,
      near,
      raw: {
        slug: p.slug,
        name: p.name,
        category: p.category,
        chains: p.chains,
        tvl_usd: p.tvl_usd,
        change_7d: p.change_7d,
        mcap_usd: p.mcap_usd,
        listed_at: p.listed_at,
        gecko_id: p.gecko_id,
        symbol: p.symbol,
      },
    };
  });
  const setAsideNamed = setAside.map((g) => ({
    reason: g.reason,
    label: g.label,
    rows: g.slugs.map((s) => ({ slug: s, name: bySlug.get(s)?.name || s, category: bySlug.get(s)?.category || '' })),
  }));
  const payload = {
    asOf: AS_OF,
    snapshotSha,
    boardSha,
    source: snap.source,
    fetchedAt: snap.fetched_at,
    model: {
      slope: fit.slope,
      intercept: fit.intercept,
      nComps: comps.length,
      nRaw: rawComps.length,
      rawSlope: rawFit.slope,
      rawIntercept: rawFit.intercept,
      loo,
      blind: { train: blind.train, test: blind.test, ...blind.metric },
      wf: { pooled: wf.pooled, folds: wf.folds },
      wfFull: { pooled: wfFull.pooled },
      wfOffsetK4: { pooled: wfOffsetK4 },
      wfOffsetFull: { pooled: wfOffsetFull },
      tokenOdds: odds,
    },
    live: {
      watchlist: watchlist.length,
      watchCovered,
      total: protocols.length,
      tokened,
      preToken,
      board: rows.length,
      setAside: setAsideCount,
      farm: verdictCounts.farm,
      thin: verdictCounts.thin,
      skip: verdictCounts.skip,
      bestNetHour: { slug: bestNet.slug, name: bySlug.get(bestNet.slug)!.name, value: bestNet.netPerHour },
      topImplied: rows[0].implied_value_usd,
    },
    rows: enrichedRows,
    compPoints,
    curvePoints,
    looPoints,
    setAside: setAsideNamed,
    chains: [...new Set(protocols.flatMap((p) => p.chains))].sort(),
  };

  // --- write the output directory ---
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, 'dashboard'), { recursive: true });
  mkdirSync(join(outDir, 'screenshots'), { recursive: true });
  writeFileSync(join(outDir, 'board.json'), boardJson, 'utf8');
  writeFileSync(join(outDir, 'data.js'), 'window.TOKEN_RADAR = ' + JSON.stringify(payload) + ';\n', 'utf8');
  // The page and its screenshots come from this repository.
  for (const f of readdirSync(join(ROOT, 'dashboard'))) {
    cpSync(join(ROOT, 'dashboard', f), join(outDir, 'dashboard', f));
  }
  if (existsSync(join(ROOT, 'screenshots'))) {
    for (const f of readdirSync(join(ROOT, 'screenshots'))) {
      cpSync(join(ROOT, 'screenshots', f), join(outDir, 'screenshots', f));
    }
  }
  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, 'dossier.json'), dossier);

  // --- report ---
  const dossierJson = JSON.parse(Buffer.from(dossier).toString('utf8')) as { text?: string };
  const textBytes = dossierJson.text ? Buffer.byteLength(dossierJson.text, 'utf8') : 0;
  console.log(`snapshot ${snapshotSha.slice(0, 12)}… ${protocols.length} protocols, ${comps.length} comps (raw ${rawComps.length})`);
  console.log(`OLS slope ${fit.slope.toFixed(3)} intercept ${fit.intercept.toFixed(3)}`);
  console.log(`board ${rows.length} rows, watchlist ${watchCovered}/${watchlist.length}, set aside ${setAsideCount}`);
  console.log(`verdicts farm ${verdictCounts.farm} / thin ${verdictCounts.thin} / skip ${verdictCounts.skip}; best net/h ${money(bestNet.netPerHour)}/h (${bestNet.slug})`);
  console.log(
    `LOO ${loo.curve.medErr.toFixed(1)}% / ${loo.curve.in2.toFixed(1)}% in-2x; blind ${blind.metric.medErr.toFixed(1)}% / ${blind.metric.in2.toFixed(1)}%; WF ${wf.pooled.medErr.toFixed(1)}% / ${wf.pooled.in2.toFixed(1)}%`,
  );
  console.log(`top ${rows[0].name} ${money(rows[0].implied_value_usd)}; last ${rows[rows.length - 1].name} ${money(rows[rows.length - 1].implied_value_usd)}`);
  console.log(`dossier text ${textBytes} bytes; wrote ${outDir}`);
}

main();
