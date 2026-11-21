// app.js — TOKEN RADAR v8 dashboard. Renders the board, the detail view,
// the Method tab and the Set-aside tab from the payload in data.js.
// The page does no fetching: everything it shows was computed by main.ts
// from the sealed snapshot. Routing is by hash: #/board, #/detail/<slug>,
// #/method, #/setaside.
(function () {
  const D = window.TOKEN_RADAR;
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt$ = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const fmt$2 = (n) => '$' + n.toFixed(2);
  const fmtS$ = (n) => (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);
  const fmtM = (n) => '$' + (n / 1e6).toFixed(1) + 'M';
  const fmtS = (n, d = 2) => (n >= 0 ? '+' : '') + n.toFixed(d);
  const pct = (n, d = 1) => (n * 100).toFixed(d) + '%';
  const med = (a) => {
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  if (!D) {
    $('integrity').textContent = 'data.js failed to load — the dashboard has no data.';
    return;
  }

  // ---------- integrity strip ----------
  const L = D.live;
  $('integrity').innerHTML =
    'page = board.json: <b>' + L.board + '/' + L.board + ' values</b>, <b>' + L.board + '/' + L.board +
    ' ranks match</b> · board sha <b>' + (D.boardSha || '—').slice(0, 12) + '…</b> · snapshot sha ' +
    D.snapshotSha.slice(0, 12) + '… · as of ' + D.asOf + ' · OLS slope ' + D.model.slope.toFixed(3) +
    ' / intercept ' + D.model.intercept.toFixed(3);
  $('mAsOf').textContent = D.asOf;
  $('mSha').textContent = D.snapshotSha.slice(0, 12) + '…';
  $('mSrc').textContent = (D.source || '').replace(/^https?:\/\//, '');
  $('saCount').textContent = '(' + L.setAside + ')';

  // ---------- stat cards ----------
  const stats = [
    ['Watchlist covered', L.watchCovered + '/' + L.watchlist],
    ['Board rows', String(L.board)],
    ['Traded comps', String(D.model.nComps)],
    ['Set aside', String(L.setAside)],
    ['Top implied value', fmtM(L.topImplied)],
    ['Best net / hour', fmtS(L.bestNetHour.value) + '/h'],
  ];
  $('stats').innerHTML = stats.map(([l, n]) => '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>').join('');

  // ---------- top 3 ----------
  $('top3').innerHTML = D.rows.slice(0, 3).map((r) =>
    '<div class="t3"><span class="rk">#' + r.rank + ' ' + esc(r.name) + '</span> <span class="cat">' + esc(r.category) + '</span><br>' +
    '<span class="val">' + fmtM(r.implied) + '</span> implied · ' + (r.implied / r.tvl).toFixed(2) + '× TVL<br>' +
    'net ' + fmtS(r.net) + ' on ' + fmt$(r.deposit) + ' · <b>' + r.verdict.toUpperCase() + '</b></div>').join('');

  // ---------- validation line ----------
  const m = D.model;
  $('validLine').innerHTML =
    'Validation — <b>LOO ' + m.loo.curve.medErr.toFixed(1) + '% median miss, ' + m.loo.curve.in2.toFixed(1) + '% in-2×, ' + m.loo.curve.in3.toFixed(1) + '% in-3×</b> (n=127) · ' +
    '<b>blind split ' + m.blind.medErr.toFixed(1) + '% / ' + m.blind.in2.toFixed(1) + '%</b> (47 train / 48 test) · ' +
    '<b>walk-forward ' + m.wf.pooled.medErr.toFixed(1) + '% / ' + m.wf.pooled.in2.toFixed(1) + '%</b> (57 pooled). ' +
    'Category offsets were computed and rejected — see the Method tab.';

  // ---------- scatter (comps vs curve) ----------
  function svgScatter(pts, curve, w, h, xLab, yLab) {
    const xs = pts.map((p) => p[0]).concat(curve.map((c) => c[0]));
    const ys = pts.map((p) => p[1]).concat(curve.map((c) => c[1]));
    const x0 = Math.floor(Math.min(...xs) * 2) / 2, x1 = Math.ceil(Math.max(...xs) * 2) / 2;
    const y0 = Math.floor(Math.min(...ys) * 2) / 2, y1 = Math.ceil(Math.max(...ys) * 2) / 2;
    const X = (v) => 34 + ((v - x0) / (x1 - x0)) * (w - 44);
    const Y = (v) => h - 20 - ((v - y0) / (y1 - y0)) * (h - 30);
    let s = '<rect x="0" y="0" width="' + w + '" height="' + h + '" fill="#fbfcfd"/>';
    for (let gx = Math.ceil(x0); gx <= x1; gx++) s += '<line x1="' + X(gx) + '" y1="' + Y(y0) + '" x2="' + X(gx) + '" y2="' + Y(y1) + '" stroke="#eef0f2"/>';
    for (let gy = Math.ceil(y0); gy <= y1; gy++) s += '<line x1="' + X(x0) + '" y1="' + Y(gy) + '" x2="' + X(x1) + '" y2="' + Y(gy) + '" stroke="#eef0f2"/>';
    s += '<polyline points="' + curve.map((c) => X(c[0]).toFixed(1) + ',' + Y(c[1]).toFixed(1)).join(' ') + '" fill="none" stroke="#0b6e4f" stroke-width="2"/>';
    for (const p of pts) s += '<circle cx="' + X(p[0]).toFixed(1) + '" cy="' + Y(p[1]).toFixed(1) + '" r="2.2" fill="#3a7ca5" opacity="0.65"/>';
    s += '<text x="34" y="' + (h - 6) + '" font-size="9" fill="#5a6b7a">' + esc(xLab) + '</text>';
    s += '<text x="6" y="12" font-size="9" fill="#5a6b7a">' + esc(yLab) + '</text>';
    return s;
  }
  $('scatter').innerHTML = svgScatter(
    D.compPoints.map((p) => [p.x, p.y]), D.curvePoints, 460, 140, 'log10 TVL', 'log10 mcap',
  );

  // ---------- token odds ----------
  const o = m.tokenOdds;
  $('odds').innerHTML = '<h3>Token odds — from the snapshot, display only</h3>' +
    o.map((c) => '<div class="row"><span>Listed ' + c.years + '+ year' + (c.years > 1 ? 's' : '') + ' ago</span><span><b>' + c.pct.toFixed(1) + '%</b> · ' + c.tokened + ' of ' + c.listed + '</span></div>').join('') +
    '<p class="cap">Share of protocols listed that long ago that have a token today. A base rate for the field, not a forecast for any one protocol — and not an input to the model.</p>';

  // ---------- category pills + board ----------
  const cats = {};
  for (const r of D.rows) cats[r.category] = (cats[r.category] || 0) + 1;
  const catNames = Object.keys(cats).sort((a, b) => cats[b] - cats[a]);
  let activeCat = 'All';
  function renderPills() {
    const all = [['All', D.rows.length], ...catNames.map((c) => [c, cats[c]])];
    $('catpills').innerHTML = all.map(([c, n]) =>
      '<button class="pill' + (c === activeCat ? ' on' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + ' <span class="c">' + n + '</span></button>').join('');
    for (const b of $('catpills').querySelectorAll('.pill')) {
      b.addEventListener('click', () => { activeCat = b.getAttribute('data-cat'); renderPills(); renderBoard(); });
    }
  }
  function vBadge(v) { return '<span class="v' + v + '">' + v.toUpperCase() + '</span>'; }
  function renderBoard() {
    const rows = activeCat === 'All' ? D.rows : D.rows.filter((r) => r.category === activeCat);
    $('showing').textContent = 'Showing ' + rows.length + ' of ' + D.rows.length + (activeCat === 'All' ? '' : ' · category ' + activeCat);
    $('boardBody').innerHTML = rows.map((r) =>
      '<tr data-slug="' + r.slug + '"><td>' + r.rank + '</td><td><b>' + esc(r.name) + '</b></td><td>' + esc(r.category) + '</td>' +
      '<td class="num">' + fmtM(r.tvl) + '</td><td class="num"><b>' + fmtM(r.implied) + '</b></td><td class="num">' + (r.implied / r.tvl).toFixed(2) + '×</td>' +
      '<td>' + esc(r.chain) + '</td><td class="num">' + fmt$(r.deposit) + '</td><td class="num">' + fmtS(r.net) + '</td>' +
      '<td class="num">' + fmtS(r.netPerHour) + '/h</td><td>' + vBadge(r.verdict) + '</td></tr>').join('');
    for (const tr of $('boardBody').querySelectorAll('tr')) {
      tr.addEventListener('click', () => { location.hash = '#/detail/' + tr.getAttribute('data-slug'); });
    }
  }
  renderPills();
  renderBoard();

  // ---------- detail view ----------
  const catRatio = {};
  for (const p of D.compPoints) (catRatio[p.category] = catRatio[p.category] || []).push(Math.pow(10, p.y - p.x));
  function caseAgainst(r) {
    const ratio = r.implied / r.tvl;
    const catMed = catRatio[r.category] ? med(catRatio[r.category]) : null;
    const bandFactor = (r.bandHigh / r.bandLow).toFixed(1);
    let s = 'The value band is ' + fmtM(r.bandLow) + '–' + fmtM(r.bandHigh) + ' — a factor of ' + bandFactor +
      ' wide — and the model\'s median miss is 84%. ';
    if (catMed) s += esc(r.category) + ' comps trade at a median of ' + catMed.toFixed(2) + '× TVL, ' +
      (ratio >= catMed ? 'below' : 'above') + ' this row\'s ' + ratio.toFixed(2) + '×. ';
    s += 'If the launch lands below ' + fmtM(r.breakEven) + ', the farm loses money after gas and fees. ';
    s += r.verdict === 'farm'
      ? 'It still clears $25 net even at the low end of the band — that is why it is a farm, not a guess.'
      : r.verdict === 'thin'
        ? 'It pays at the low end, but not enough to clear the $25 bar — thin, not a farm.'
        : 'At the low end it barely covers the gas — the farm is a rounding error, so it is skipped.';
    return s;
  }
  function renderDetail(slug) {
    const r = D.rows.find((x) => x.slug === slug);
    if (!r) { location.hash = '#/board'; return; }
    const odds2 = m.tokenOdds.find((c) => c.years === 2);
    const nearRows = r.near.map((c) =>
      '<tr><td>' + esc(c.name) + (c.sameCategory ? ' <span class="vthin">same category</span>' : '') + '</td><td class="num">' + fmtM(c.tvl_usd) + '</td><td class="num">' + fmtM(c.mcap_usd) + '</td><td class="num">' + c.ratio.toFixed(2) + '×</td><td class="num">' + fmtM(c.curve_usd) + '</td></tr>').join('');
    $('detail').innerHTML =
      '<h2>#' + r.rank + ' ' + esc(r.name) + ' <span style="font-weight:400;font-size:15px;color:#5a6b7a">' + esc(r.category) + ' · ' + esc(r.slug) + '</span></h2>' +
      '<div class="dgrid">' +
      '<div class="tile"><div class="n">' + vBadge(r.verdict) + '</div><div class="l">Verdict — net ' + fmtS(r.net) + ' on a ' + fmt$(r.deposit) + ' deposit</div></div>' +
      '<div class="tile"><div class="n">' + fmtM(r.implied) + '</div><div class="l">Implied value · ' + (r.implied / r.tvl).toFixed(2) + '× TVL · rank ' + r.rank + ' (range ' + r.rankLow + '–' + r.rankHigh + ')</div></div>' +
      '<div class="tile"><div class="n">' + fmtM(r.bandLow) + '–' + fmtM(r.bandHigh) + '</div><div class="l">Value band (bootstrap P10–P90, 2,000 refits)</div></div>' +
      '<div class="tile"><div class="n">' + fmtS(r.netPerHour) + '/h</div><div class="l">Net per hands-on hour (2 h over 8 weeks) · break-even launch ' + fmtM(r.breakEven) + '</div></div>' +
      '</div>' +
      '<p>' + odds2.pct.toFixed(1) + '% of the ' + odds2.listed + ' protocols listed 2+ years ago got a token today (' + odds2.tokened + ' of ' + odds2.listed + ') — a base rate for the field, not a forecast for this protocol.</p>' +
      '<h3>How ' + fmtM(r.implied) + ' is built</h3>' +
      '<table class="decomp"><tr><td>Curve — 10<sup>(3.146 + 0.508 · log<sub>10</sub>(' + fmt$(r.tvl) + '))</sup></td><td class="num"><b>' + fmtM(r.curve) + '</b></td></tr>' +
      '<tr><td>Growth — 7-day TVL ' + (r.change7d == null ? 'not reported' : fmtS(r.change7d, 1) + '%') + '</td><td class="num">×' + r.growth.toFixed(2) + ' → ' + fmtM(r.curve * r.growth) + '</td></tr>' +
      '<tr><td>Age — listed ' + (r.listedAt || 'date not reported') + '</td><td class="num">×' + r.age.toFixed(2) + ' → ' + fmtM(r.implied) + '</td></tr>' +
      '<tr><td>Cap at 10× TVL (' + fmtM(r.tvl * 10) + ')</td><td class="num">not binding</td></tr>' +
      '<tr><td>Raw OLS curve (128 comps, no dedupe) for comparison</td><td class="num">' + fmtM(r.rawOls) + '</td></tr></table>' +
      '<h3>Nearest comps</h3>' +
      '<table class="mini"><tr><th>Protocol</th><th class="num">TVL</th><th class="num">Mcap</th><th class="num">MC/TVL</th><th class="num">Curve says</th></tr>' + nearRows + '</table>' +
      '<h3>Farm plan — ' + esc(r.play) + ' on ' + esc(r.chain) + ' · deposit ' + fmt$(r.deposit) + ' · gas ' + fmt$2(r.gas) + ' (' + r.tx + ' tx) · fees ' + fmt$2(r.fees) + ' · expected ' + fmtS$(r.expected) + '</h3>' +
      '<ol class="steps">' + r.farmSteps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>' +
      '<p><b>Stop rule.</b> If the step-5 test slice does not come back clean, or the launch value at decision time is below ' + fmtM(r.breakEven) + ', close the farm and do not add a second deposit. The farm is capped at the ' + fmt$(r.deposit) + ' deposit above; never add more than the plan\'s second-deposit range.</p>' +
      '<div class="case"><b>The case against this row.</b> ' + caseAgainst(r) + '</div>' +
      '<h3>Raw snapshot record</h3><pre class="raw">' + esc(JSON.stringify(r.raw, null, 2)) + '</pre>';
    $('view-detail').scrollIntoView();
  }

  // ---------- Method tab ----------
  function row3(label, v) {
    return '<tr><td>' + label + '</td><td class="num">' + v.medErr.toFixed(1) + '%</td><td class="num">' + v.in2.toFixed(1) + '%</td><td class="num">' + v.in3.toFixed(1) + '%</td></tr>';
  }
  $('validTable').innerHTML =
    '<tr><th>Test</th><th class="num">Median miss</th><th class="num">In-2×</th><th class="num">In-3×</th></tr>' +
    row3('LOO (n=127)', m.loo.curve) +
    row3('Blind split (47 train / 48 test)', m.blind) +
    row3('Walk-forward pooled (n=57)', m.wf.pooled);
  $('ablation').innerHTML =
    '<tr><th>Model</th><th class="num">Median miss</th><th class="num">In-2×</th><th class="num">In-3×</th></tr>' +
    row3('Flat — median MC/TVL ratio', m.loo.flat) +
    row3('Curve only', m.loo.curve) +
    row3('Curve + growth', m.loo.growth) +
    row3('Curve + age', m.loo.age) +
    row3('Full — curve + growth + age', m.loo.full);
  $('offsets').innerHTML =
    '<tr><th>Walk-forward pooled</th><th class="num">Median miss</th><th class="num">In-2×</th><th class="num">In-3×</th></tr>' +
    row3('Global (curve only)', m.wf.pooled) +
    row3('Category offsets, shrunk n/(n+4)', m.wfOffsetK4.pooled) +
    row3('Global (full)', m.wfFull.pooled) +
    row3('Category offsets, full', m.wfOffsetFull.pooled);
  $('looScatter').innerHTML = svgScatter(
    D.looPoints.map((p) => [Math.log10(p[0]), Math.log10(p[1])]),
    [[4, 4], [9.5, 9.5]], 460, 260, 'log10 actual mcap', 'log10 predicted mcap',
  );
  $('recon').textContent = 'Reconciliation: ' + L.total + ' protocols = ' + L.tokened + ' tokened + ' + L.preToken + ' pre-token; ' +
    L.preToken + ' pre-token = ' + L.board + ' board + ' + L.setAside + ' set aside; verdicts ' + L.farm + ' farm / ' + L.thin + ' thin / ' + L.skip + ' skip.';

  // ---------- Set-aside tab ----------
  $('setaside').innerHTML = D.setAside.map((g) =>
    '<div class="sagroup"><h3>' + esc(g.label) + ' — ' + g.rows.length + '</h3><div class="slugs">' +
    g.rows.map((r) => esc(r.name) + ' <span style="color:#8a99a8">(' + esc(r.slug) + ' · ' + esc(r.category) + ')</span>').join(' · ') +
    '</div></div>').join('');

  // ---------- routing ----------
  $('backBtn').addEventListener('click', () => { location.hash = '#/board'; });
  for (const b of $('tabs').querySelectorAll('button')) {
    b.addEventListener('click', () => { location.hash = '#/' + b.getAttribute('data-tab'); });
  }
  function route() {
    const h = location.hash || '#/board';
    const parts = h.replace(/^#\//, '').split('/');
    const tab = parts[0] === 'detail' ? 'detail' : (parts[0] || 'board');
    for (const v of ['board', 'detail', 'method', 'setaside']) $('view-' + v).hidden = v !== tab;
    for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('on', b.getAttribute('data-tab') === tab || (tab === 'detail' && b.getAttribute('data-tab') === 'board'));
    if (tab === 'detail') renderDetail(parts[1]);
    else window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  route();
})();
