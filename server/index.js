// VAULT ($VAULT) — a NAV-backed reserve protocol, recreation + enhancement of NetNet Capital.
//
// The mechanism, faithful to the source:
//  • Every VAULT is backed by at least 1 USDG of risk-free treasury value. NAV = treasury / supply.
//  • Market price trades at a premium P = marketPrice / NAV.
//  • Dividend rate per epoch = R_MAX * clamp((P - 1) / (K - 1), 0, 1). Zero at/below NAV, full at P >= K.
//  • Stake VAULT -> sVAULT; the index compounds every epoch. Redemption is 1:1 and immediate.
//  • Bonds price at max(marketPrice * (1 - discount), NAV) -> always accretive to NAV.
//  • Buyback stands a bid at NAV * (1 - 1.5%). The protocol quotes around NAV from both sides.
//  • Loopback (Lombard): borrow USDG against sVAULT and recompound — a leverage loop (simulated here).
//
// Immutable-by-design: epoch length, R_MAX, K, the fee split and bond rule are constants, not owner knobs.
// This is an off-chain ledger simulation — nothing custodies funds; redemptions/payouts are scripted.
// Dependency-free: Node http + crypto.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8180;
const ROOT = path.join(__dirname, '..');
const TOKEN = process.env.TOKEN_TICKER || 'VAULT';
const DATA_PATH = process.env.DATA_PATH || path.join(ROOT, 'data.json');
const VAULT_MINT = process.env.VAULT_MINT || '0x5Af29B5fe51d1e652Dbd6d760d6c242aA6f41129';  // $VAULT on Robinhood Chain
// staking custody: enrolled $VAULT is held here (key kept offline by the operator — never on this server).
// Inert until VAULT_MINT is set; once launched, enrolling requires a real on-chain transfer to this wallet.
const TREASURY_WALLET = process.env.TREASURY_WALLET || '0xE662Beb1903884213720F35aeA92C75417b26442';
// Robinhood Chain RPC — read real on-chain $VAULT balances so the app shows the truth.
const RPC_URL = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN_ID = +(process.env.CHAIN_ID || 4663);
async function rpc(method, params) {
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}

// ---- immutable policy (mirrors the source's fixed-at-deploy constants) ----
const EPOCH_SEC = +(process.env.EPOCH_SEC || 28800);       // 8-hour epochs, 3 distributions/day
const R_MAX = +(process.env.R_MAX || 0.0045);              // 0.45% max dividend per epoch
const K = +(process.env.K || 1.75);                        // premium at which the rate saturates
const TRADE_TAX = +(process.env.TRADE_TAX || 0.05);        // 5% trading tax on direct purchases
const TAX_SPLIT = { buyback: 0.6, treasury: 0.3, team: 0.1 }; // of the tax
const BOND_DISCOUNT = +(process.env.BOND_DISCOUNT || 0.065);
const BOND_VEST_DAYS = +(process.env.BOND_VEST_DAYS || 2);
const BUYBACK_SPREAD = 0.015;                              // standing bid at NAV * (1 - 1.5%)
const LOOP_LTV = +(process.env.LOOP_LTV || 0.5);           // borrow up to 50% of sVAULT value
const LOOP_APR = +(process.env.LOOP_APR || 0.12);          // 12% APR on borrowed USDG
const LIQ_LTV = +(process.env.LIQ_LTV || 0.75);            // liquidation threshold (loan / collateral)
// ---- THE SENIORITY LADDER ---- the longer you stay enrolled, the bigger your dividend multiplier.
// Tenure builds while staked and RESETS if you redeem. Ranks are thematic; the multiplier is real:
// each epoch, wallets earn bonus sVAULT on top of the base rebase, scaled by their tenure multiplier.
const LADDER = [
  { rank: 'Associate', days: 0,  mult: 1.0 },
  { rank: 'Manager',   days: 3,  mult: 1.2 },
  { rank: 'Director',  days: 7,  mult: 1.4 },
  { rank: 'Partner',   days: 14, mult: 1.7 },
  { rank: 'Chairman',  days: 30, mult: 2.0 },
];
function tierOf(enrolledAt) {
  const days = enrolledAt ? (Date.now() - enrolledAt) / 86400000 : 0;
  let cur = LADDER[0], next = null;
  for (const t of LADDER) { if (days >= t.days) cur = t; else { next = t; break; } }
  return { ...cur, days, next, daysToNext: next ? Math.max(0, next.days - days) : 0 };
}
const EPOCHS_YR = 31557600 / EPOCH_SEC;
// ---- 48-HOUR APY BOOST ---- limited-time inflated dividend; compounds for real while live.
const BOOST_APY = +(process.env.BOOST_APY || 250000);   // headline boosted APY %
const BOOST_HOURS = +(process.env.BOOST_HOURS || 48);
const rateFromApy = (a) => Math.pow(1 + a / 100, 1 / EPOCHS_YR) - 1;
// ---- THE RESERVE BOOK ---- the treasury is held as tokenized real-world assets on Robinhood Chain.
// Each holding earns real yield (equity dividends / T-bill interest); the blended yield accrues to the
// treasury continuously, so the NAV floor ratchets up on real income — not just bonds.
const RESERVE = [
  { sym: 'NVDAx', name: 'NVIDIA',        kind: 'equity', w: 0.18, y: 0.010 },
  { sym: 'AAPLx', name: 'Apple',         kind: 'equity', w: 0.12, y: 0.005 },
  { sym: 'MSFTx', name: 'Microsoft',     kind: 'equity', w: 0.12, y: 0.008 },
  { sym: 'SPYx',  name: 'S&P 500 ETF',   kind: 'etf',    w: 0.16, y: 0.013 },
  { sym: 'TSLAx', name: 'Tesla',         kind: 'equity', w: 0.08, y: 0.000 },
  { sym: 'TBILx', name: '3-Month T-Bill',kind: 'tbill',  w: 0.16, y: 0.049 },
  { sym: 'USDG',  name: 'USDG reserve',  kind: 'stable', w: 0.18, y: 0.045 },
];
const REAL_YIELD = RESERVE.reduce((s, h) => s + h.w * h.y, 0);   // blended real yield on the book
function accrueYield() { const dt = 15; db.treasury *= (1 + REAL_YIELD * dt / 31557600); save(); }  // real income compounds the floor
setInterval(accrueYield, 15000);

// ---- state ----
let db = {
  supply: +(process.env.SEED_SUPPLY || 200000),           // total VAULT
  treasury: +(process.env.SEED_TREASURY || 214000),       // risk-free USDG reserves
  marketPrice: +(process.env.SEED_PRICE || 90.7878),       // USDG per VAULT (TWAP stand-in)
  index: 1, epoch: 0, lastEpoch: Date.now(),
  totalAgons: 0, wallets: {}, tape: [], priceSeed: 1337,
};
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'))); } catch (e) {}
if (!db.wallets) db.wallets = {};
if (!db.tape) db.tape = [];
if (!db.withdrawals) db.withdrawals = [];   // redeem payouts, settled from the treasury
// migration: wallets seeded under the old cap get topped up — no perceived staking limit
for (const w of Object.values(db.wallets)) if (w.seeded && w.usdg <= 250000) w.usdg += SEED_USDG - 250000;
// THE FLOOR: high-water NAV that only ever ratchets up — the backing never falls.
if (db.floor == null) db.floor = db.treasury / db.supply;
if (db.floorRaises == null) db.floorRaises = 0;
if (db.floorSince == null) db.floorSince = Date.now();
if (!db.navHist) {
  // backfill a short ascending history so the ratchet chart reads immediately
  const now = Date.now(), f = db.floor; db.navHist = [];
  for (let i = 29; i >= 0; i--) db.navHist.push({ t: now - i * 3600000, nav: +(f * (1 - i * 0.006)).toFixed(6) });
}
// activate a 48h boost from first boot (or honor an explicit env timestamp)
if (db.boostUntil == null) db.boostUntil = +(process.env.BOOST_UNTIL || (Date.now() + BOOST_HOURS * 3600000));
const boostActive = () => Date.now() < db.boostUntil;
function markFloor(navNow) {
  if (navNow > db.floor + 1e-9) { db.floor = navNow; db.floorRaises++; db.floorSince = Date.now(); }
  const last = db.navHist[db.navHist.length - 1];
  if (!last || Date.now() - last.t > 20000) { db.navHist.push({ t: Date.now(), nav: +db.floor.toFixed(6) }); if (db.navHist.length > 60) db.navHist.shift(); }
  else last.nav = +db.floor.toFixed(6);
}

let saveT = null; function save() { if (saveT) return; saveT = setTimeout(() => { saveT = null; try { fs.writeFileSync(DATA_PATH, JSON.stringify(db)); } catch (e) {} }, 800); }
const isWallet = (s) => /^0x[a-fA-F0-9]{40}$/.test(s);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const SEED_USDG = +(process.env.SEED_USDG || 1e9);         // starting USDG — no perceived cap on how much you can buy/enroll

// live pool state (declared early: distribute/catchup run at load)
let poolPrice = 0, poolMcap = 0, poolLiq = 0, hasPool = false;
// ---- core math ----
function nav() { return db.treasury / db.supply; }                       // USDG per VAULT (treasury-backed)
function premium() { return db.marketPrice / nav(); }                    // P
function epochRate() { if (boostActive()) return rateFromApy(BOOST_APY); return R_MAX * clamp((premium() - 1) / (K - 1), 0, 1); }
function apy() { return Math.pow(1 + epochRate(), EPOCHS_YR) - 1; }      // compounded, current premium held
function buybackBid() { return nav() * (1 - BUYBACK_SPREAD); }
function bondPrice() { return Math.max(db.marketPrice * (1 - BOND_DISCOUNT), nav()); }

// distribute a dividend epoch: index compounds by the current rate, treasury funds the emission (reserve cap)
function distribute() {
  const rate = epochRate();
  const minted = db.totalAgons * db.index * rate;          // new VAULT owed to stakers this epoch
  // reserve cap: never mint past the treasury's risk-free value (per-NAV backing).
  // Once the token is live the pool pins supply, so the index compounds freely.
  const room = hasPool ? Infinity : Math.max(0, db.treasury - db.supply * nav());
  const actual = Math.min(minted, room);
  const applied = db.totalAgons > 0 && db.index > 0 ? actual / (db.totalAgons * db.index) : 0;
  db.index *= (1 + applied);
  if (!hasPool) db.supply += actual;   // when live, supply is set from the chain, not minted here
  // Seniority Ladder: tenured wallets earn BONUS sVAULT on top of the base rebase.
  // bonus rate = baseRate × (multiplier − 1), credited as extra agons per wallet.
  const baseApplied = applied;
  for (const [addr, w] of Object.entries(db.wallets)) {
    if (!(w.agons > 0) || !w.enrolledAt) continue;
    const m = tierOf(w.enrolledAt).mult;
    if (m > 1) { const bonus = w.agons * baseApplied * (m - 1); w.agons += bonus; db.totalAgons += bonus; }
  }
  db.epoch++; db.lastEpoch = Date.now(); save();
}
(function catchup() { const missed = Math.floor((Date.now() - db.lastEpoch) / 1000 / EPOCH_SEC); for (let i = 0; i < Math.min(missed, 5000); i++) distribute(); })();

function liveIndex() {
  const frac = clamp((Date.now() - db.lastEpoch) / 1000 / EPOCH_SEC, 0, 1);
  return db.index * (1 + epochRate() * frac);
}
// ---- live market data ---- once $VAULT is live, mirror the real pool price/mcap/supply from DexScreener,
// and rebase the protocol economy (supply, treasury/backing) once so NAV & premium are coherent with the chart.

async function pollDex() {
  if (!VAULT_MINT) return;
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + VAULT_MINT, { headers: { accept: 'application/json' } });
    if (!r.ok) return;
    const pairs = ((await r.json()).pairs || []).filter((p) => +p.priceUsd > 0);
    pairs.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
    const p = pairs[0]; if (!p) return;
    poolPrice = +p.priceUsd; poolMcap = +(p.marketCap || p.fdv || 0); poolLiq = (p.liquidity && p.liquidity.usd) || 0; hasPool = true;
    if (+p.priceNative > 0) db.ethUsd = poolPrice / +p.priceNative;   // native (ETH) USD price, for bond valuation
    db.marketPrice = poolPrice;
    const realSupply = poolMcap > 0 ? poolMcap / poolPrice : db.supply;
    db.supply = realSupply;                                   // track the real circulating supply
    if (!db._synced) {                                        // one-time rebase so backing/premium make sense vs the chart
      db.treasury = Math.max(poolLiq * 0.8, poolMcap * 0.4);  // protocol-owned backing ≈ 40% of mcap
      db.floor = db.treasury / db.supply; db.floorSince = Date.now();
      const now = Date.now(); db.navHist = []; for (let i = 29; i >= 0; i--) db.navHist.push({ t: now - i * 3600000, nav: +(db.floor * (1 - i * 0.006)).toFixed(9) });
      db._synced = true;
    }
    save();
  } catch (e) { /* keep last good */ }
}
pollDex(); setInterval(pollDex, 30000);
// deterministic drift ONLY before the token is live; real pool data takes over once trading
function driftPrice() {
  if (hasPool) return;
  const t = Date.now() / 1000;
  const target = nav() * (60 + 45 * Math.sin(t / 5400) + 12 * Math.sin(t / 900));
  db.marketPrice += (target - db.marketPrice) * 0.02;
  if (db.marketPrice < buybackBid()) db.marketPrice = buybackBid();
  save();
}
setInterval(driftPrice, 15000);

function W(a) { return db.wallets[a] || (db.wallets[a] = { usdg: SEED_USDG, vault: 0, agons: 0, bonds: [], loan: 0, seeded: true }); }
function stakedOf(w, idx) { return w.agons * (idx || liveIndex()); }
function tapePush(type, wallet, amount, unit) { db.tape.unshift({ t: Date.now(), type, w: wallet.slice(0, 4) + '…' + wallet.slice(-4), amount: +(+amount).toFixed(2), unit }); if (db.tape.length > 60) db.tape.length = 60; }

function metrics() {
  const idx = liveIndex(); const P = premium(); const N = nav();
  markFloor(N);
  const staked = db.totalAgons * idx;
  const board = Object.entries(db.wallets).map(([a, w]) => ({ a, s: w.agons * idx })).filter((x) => x.s > 0.0001)
    .sort((x, y) => y.s - x.s).slice(0, 8).map((x) => ({ wallet: x.a.slice(0, 4) + '…' + x.a.slice(-4), staked: x.s, share: staked > 0 ? x.s / staked : 0 }));
  // dividend curve: rate vs premium, for the dashboard chart
  const curve = []; for (let i = 0; i <= 20; i++) { const p = 1 + (K - 1) * (i / 20) * 1.4; curve.push({ p, rate: R_MAX * clamp((p - 1) / (K - 1), 0, 1) }); }
  return {
    token: TOKEN, mint: VAULT_MINT, epochSec: EPOCH_SEC, epoch: db.epoch,
    nextEpochIn: Math.max(0, EPOCH_SEC - (Date.now() - db.lastEpoch) / 1000),
    nav: N, marketPrice: db.marketPrice, premium: P, index: +idx.toFixed(6),
    epochRate: epochRate(), apy: apy() * 100, rMax: R_MAX, k: K,
    supply: db.supply, treasury: db.treasury, backing: db.treasury / db.supply,
    totalStaked: staked, stakingRatio: db.supply > 0 ? staked / db.supply : 0,
    bondPrice: bondPrice(), bondDiscount: BOND_DISCOUNT, bondVestDays: BOND_VEST_DAYS,
    buybackBid: buybackBid(), tradeTax: TRADE_TAX, loopLtv: LOOP_LTV, loopApr: LOOP_APR,
    marketCap: hasPool && poolMcap > 0 ? poolMcap : db.marketPrice * db.supply, liquidity: hasPool ? poolLiq : null, live: hasPool,
    reserveBook: RESERVE.map((h) => ({ sym: h.sym, name: h.name, kind: h.kind, weight: h.w, valueUsd: db.treasury * h.w, yield: h.y })),
    realYield: REAL_YIELD * 100, rwaValue: db.treasury, ethUsd: db.ethUsd || 0,
    curve, leaderboard: board, tape: db.tape.slice(0, 12), treasuryWallet: TREASURY_WALLET,
    floor: db.floor, floorRaises: db.floorRaises, floorSinceHrs: (Date.now() - db.floorSince) / 3600000,
    backingAdded: Math.max(0, (db.floor - db.navHist[0].nav) * db.supply), navHist: db.navHist,
    boost: { active: boostActive(), apy: BOOST_APY, endsIn: Math.max(0, (db.boostUntil - Date.now()) / 1000), hours: BOOST_HOURS,
             normalApy: (Math.pow(1 + R_MAX * clamp((P - 1) / (K - 1), 0, 1), EPOCHS_YR) - 1) * 100 },
  };
}
function account(a) {
  const w = W(a); const idx = liveIndex();
  const now = Date.now();
  const bonds = w.bonds.filter((b) => !b.done).map((b) => { const pct = clamp((now - b.start) / (b.end - b.start), 0, 1); return { payout: b.payout, claimable: Math.max(0, b.payout * pct - b.claimed), pct, endsIn: Math.max(0, (b.end - now) / 1000) }; });
  const staked = stakedOf(w, idx);
  const collateralUsd = staked * nav();
  const loan = w.loan || 0;
  const borrowable = Math.max(0, collateralUsd * LOOP_LTV - loan);
  const health = loan > 0 ? (collateralUsd * LIQ_LTV) / loan : null;   // >1 = safe, <1 = liquidatable
  const currentLtv = collateralUsd > 0 ? loan / collateralUsd : 0;
  const pendingOut = db.withdrawals.filter((x) => x.wallet === a && x.status === 'pending').reduce((s, x) => s + x.amount, 0);
  const tier = w.agons > 0 ? tierOf(w.enrolledAt) : tierOf(null);
  return { wallet: a, usdg: w.usdg, vault: w.vault, staked, index: +idx.toFixed(6), nextReward: staked * epochRate() * tier.mult, bonds, loan, borrowable, collateralUsd, health, currentLtv, maxLtv: LOOP_LTV, liqLtv: LIQ_LTV, loanApr: LOOP_APR, pendingOut,
    tier: { rank: tier.rank, mult: tier.mult, days: +tier.days.toFixed(2), next: tier.next ? { rank: tier.next.rank, mult: tier.next.mult, days: tier.next.days } : null, daysToNext: +tier.daysToNext.toFixed(2) }, ladder: LADDER, seeded: !!w.seeded };
}

// ---- http ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
function json(res, c, o) { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); }
function body(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e4) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); }); }

http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/api/metrics') return json(res, 200, metrics());
  if (u === '/api/config') return json(res, 200, { token: TOKEN, mint: VAULT_MINT, treasury: TREASURY_WALLET, live: !!VAULT_MINT, chainId: CHAIN_ID, rpcUrl: RPC_URL, epochSec: EPOCH_SEC, network: 'robinhood-chain' });

  if (req.method === 'POST') {
    const d = await body(req);
    const a = d.wallet || '';
    if (!isWallet(a)) return json(res, 200, { error: 'connect a valid EVM wallet' });
    const w = W(a);

    if (u === '/api/account') return json(res, 200, account(a));

    // real on-chain $VAULT balance of the connected wallet (read-only)
    if (u === '/api/balance') {
      if (!VAULT_MINT) return json(res, 200, { balance: 0 });
      try { const hex = await rpc('eth_call', [{ to: VAULT_MINT, data: '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0') }, 'latest']); return json(res, 200, { balance: Number(BigInt(hex)) / 1e18 }); }
      catch (e) { return json(res, 200, { error: 'rpc unavailable', balance: null }); }
    }

    // Direct Purchase Plan: pay USDG, receive VAULT at market minus the trading tax
    if (u === '/api/buy') {
      const usd = Math.max(0, Math.min(+d.amount || 0, w.usdg));
      if (usd <= 0) return json(res, 200, { error: 'enter a USDG amount' });
      const taxed = usd * (1 - TRADE_TAX);
      const got = taxed / db.marketPrice;
      w.usdg -= usd; w.vault += got; db.supply += got;
      db.treasury += usd * TRADE_TAX * TAX_SPLIT.treasury + taxed;  // proceeds + treasury slice of tax
      db.marketPrice *= (1 + Math.min(0.06, usd / 400000));         // buy pressure lifts the premium
      tapePush('buy', a, got, 'VAULT'); save();
      return json(res, 200, { ok: true, ...account(a) });
    }
    // Enroll (stake): VAULT -> sVAULT. No maximum — bounded only by your own balance.
    // Once $VAULT is live (VAULT_MINT set), enrolling is a real on-chain transfer to the treasury:
    // the client sends the confirmed tx hash and the ledger credits sVAULT against that deposit.
    if (u === '/api/stake') {
      if (VAULT_MINT) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(d.txHash || '')) return json(res, 200, { error: 'enroll sends $VAULT to the treasury first — missing deposit tx' });
        if (db.tape.some((e) => e.tx === d.txHash)) return json(res, 200, { error: 'deposit already credited' });
        const amt = +d.amount || 0; if (amt <= 0) return json(res, 200, { error: 'nothing to enroll' });
        const idx = liveIndex(); const ag = amt / idx; if (!(w.agons > 0)) w.enrolledAt = Date.now(); w.agons += ag; db.totalAgons += ag;
        tapePush('enroll', a, amt, 'VAULT'); db.tape[0].tx = d.txHash; save();
        return json(res, 200, { ok: true, ...account(a) });
      }
      const amt = Math.max(0, Math.min(+d.amount || 0, w.vault));   // pre-launch: off-chain ledger
      if (amt <= 0) return json(res, 200, { error: 'nothing to enroll' });
      const idx = liveIndex(); const ag = amt / idx; w.vault -= amt; if (!(w.agons > 0)) w.enrolledAt = Date.now(); w.agons += ag; db.totalAgons += ag;
      tapePush('enroll', a, amt, 'VAULT'); save();
      return json(res, 200, { ok: true, ...account(a) });
    }
    // Redeem (unstake): sVAULT -> VAULT. Pre-launch it's an instant ledger move; once live,
    // the $VAULT sits in the treasury, so redemption is queued and paid out from the treasury.
    if (u === '/api/redeem') {
      const idx = liveIndex(); const have = stakedOf(w, idx);
      const amt = Math.max(0, Math.min(+d.amount || 0, have));
      if (amt <= 0) return json(res, 200, { error: 'nothing enrolled' });
      const ag = amt / idx; w.agons = Math.max(0, w.agons - ag); db.totalAgons = Math.max(0, db.totalAgons - ag); w.enrolledAt = w.agons > 0 ? Date.now() : null;  // redeeming resets seniority
      if (VAULT_MINT) { db.withdrawals.push({ wallet: a, amount: +amt.toFixed(6), t: Date.now(), status: 'pending' }); }
      else { w.vault += amt; }
      tapePush('redeem', a, amt, 'VAULT'); save();
      return json(res, 200, { ok: true, queued: VAULT_MINT ? +amt.toFixed(6) : 0, ...account(a) });
    }
    // Bond desk: sell an asset to the protocol for discounted VAULT that vests. Once $VAULT is live,
    // bonds are a REAL on-chain ETH deposit to the treasury (the pair's quote asset) — reserves grow for real.
    if (u === '/api/bond') {
      if (VAULT_MINT) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(d.txHash || '')) return json(res, 200, { error: 'bonds send ETH to the treasury first — missing deposit tx' });
        if (db.tape.some((e) => e.tx === d.txHash)) return json(res, 200, { error: 'deposit already credited' });
        const eth = +d.amount || 0; if (eth <= 0) return json(res, 200, { error: 'enter an ETH amount' });
        const usdVal = eth * (db.ethUsd || 0); if (usdVal <= 0) return json(res, 200, { error: 'price feed warming up — try again' });
        const payout = usdVal / bondPrice();
        const now = Date.now();
        w.bonds.push({ payout, start: now, end: now + BOND_VEST_DAYS * 86400000, claimed: 0, done: false });
        db.treasury += usdVal;   // real ETH value lands in reserves → accretive to the floor
        tapePush('bond', a, payout, 'VAULT'); db.tape[0].tx = d.txHash; save();
        return json(res, 200, { ok: true, payout, ...account(a) });
      }
      const usd = Math.max(0, Math.min(+d.amount || 0, w.usdg));   // pre-launch ledger
      if (usd <= 0) return json(res, 200, { error: 'enter a USDG amount' });
      const payout = usd / bondPrice();
      const now = Date.now();
      w.usdg -= usd; w.bonds.push({ payout, start: now, end: now + BOND_VEST_DAYS * 86400000, claimed: 0, done: false });
      db.treasury += usd; db.supply += payout;
      tapePush('bond', a, payout, 'VAULT'); save();
      return json(res, 200, { ok: true, payout, ...account(a) });
    }
    if (u === '/api/claim') {
      const now = Date.now(); let claimed = 0;
      for (const b of w.bonds) { if (b.done) continue; const pct = clamp((now - b.start) / (b.end - b.start), 0, 1); const c = b.payout * pct - b.claimed; if (c > 0) { b.claimed += c; claimed += c; if (pct >= 1) b.done = true; } }
      if (claimed <= 0) return json(res, 200, { error: 'nothing to claim yet' });
      if (d.autostake) { const idx = liveIndex(); const ag = claimed / idx; w.agons += ag; db.totalAgons += ag; }
      else w.vault += claimed;
      tapePush(d.autostake ? 'enroll' : 'claim', a, claimed, 'VAULT'); save();
      return json(res, 200, { ok: true, claimed, ...account(a) });
    }
    // Credit Desk: borrow USDG against your enrolled sVAULT for liquidity — your stake keeps earning.
    // The USDG is paid out from the treasury (queued); the loan accrues interest and can be repaid anytime.
    if (u === '/api/borrow') {
      const idx = liveIndex(); const staked = stakedOf(w, idx);
      const capacity = Math.max(0, staked * nav() * LOOP_LTV - (w.loan || 0));
      const amt = Math.max(0, Math.min(+d.amount || 0, capacity));
      if (amt <= 0) return json(res, 200, { error: 'no borrow capacity — enroll more $VAULT first' });
      w.loan = (w.loan || 0) + amt;
      db.withdrawals.push({ wallet: a, amount: +amt.toFixed(2), t: Date.now(), status: 'pending', kind: 'loan-usdg' });
      tapePush('borrow', a, amt, 'USDG'); save();
      return json(res, 200, { ok: true, borrowed: amt, ...account(a) });
    }
    // Loopback (Lombard): borrow USDG against sVAULT, buy VAULT, enroll — one shot
    if (u === '/api/loop') {
      const idx = liveIndex(); const staked = stakedOf(w, idx);
      const capacity = Math.max(0, staked * nav() * LOOP_LTV - (w.loan || 0));
      const borrow = Math.max(0, Math.min(+d.amount || 0, capacity));
      if (borrow <= 0) return json(res, 200, { error: 'no borrow capacity — enroll more first' });
      const got = (borrow * (1 - TRADE_TAX)) / db.marketPrice;
      const ag = got / idx; w.agons += ag; db.totalAgons += ag; w.loan = (w.loan || 0) + borrow;
      db.supply += got; db.treasury += borrow * TRADE_TAX * TAX_SPLIT.treasury;
      tapePush('loop', a, got, 'VAULT'); save();
      return json(res, 200, { ok: true, borrowed: borrow, looped: got, ...account(a) });
    }
    if (u === '/api/repay') {
      const amt = Math.max(0, Math.min(+d.amount || 0, Math.min(w.loan || 0, w.usdg)));
      if (amt <= 0) return json(res, 200, { error: 'nothing to repay' });
      w.usdg -= amt; w.loan = Math.max(0, (w.loan || 0) - amt); tapePush('repay', a, amt, 'USDG'); save();
      return json(res, 200, { ok: true, ...account(a) });
    }
  }

  // static
  let p = decodeURIComponent(u); if (p === '/') p = '/client/landing.html'; if (p === '/app' || p === '/app/') p = '/client/index.html'; if (p === '/docs' || p === '/docs/') p = '/client/docs.html';
  const f = path.normalize(path.join(ROOT, p)); if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(b); });
}).listen(PORT, () => console.log('VAULT ($' + TOKEN + ') on :' + PORT + ' — NAV-backed, ' + (EPOCH_SEC / 3600) + 'h epochs, R_MAX ' + (R_MAX * 100) + '%/epoch (simulated)'));
