// VAULT app — NAV dashboard, purchase, dividend enrollment, bonds, loopback simulator.
// All state is the off-chain ledger in server/index.js. Nothing here custodies funds.
(function () {
  const $ = (id) => document.getElementById(id);
  let M = null, A = null, wallet = localStorage.getItem('vault_w') || '';
  let anchor = null, stakeMode = 'enroll', boostEndAt = 0, CFG = null, chainBal = null;

  const isW = (s) => /^0x[a-fA-F0-9]{40}$/.test(s);
  const n0 = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const n2 = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usd = (n) => '$' + (Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2));
  // price-aware formatter: keeps precision for sub-dollar tokens ($0.00003105) and abbreviates big numbers
  const px = (n) => { if (n == null || !isFinite(n)) return '—'; const a = Math.abs(n); if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K'; if (a >= 1) return '$' + n.toFixed(2); if (a === 0) return '$0'; return '$' + Number(n.toPrecision(4)).toString(); };
  const pxN = (n) => (Math.abs(n) >= 1 ? Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(Number(n.toPrecision(4))));
  const tok = (n) => Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? n0(n) : n2(n);
  const pctf = (n) => (n * 100).toLocaleString('en-US', { maximumFractionDigits: n < 0.01 ? 3 : 2 }) + '%';
  const apyf = (n) => n0(n) + '%';
  function toast(t) { const e = $('toast'); e.textContent = t; e.style.display = 'block'; clearTimeout(e._t); e._t = setTimeout(() => e.style.display = 'none', 2600); }

  // views
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    if (!t.dataset.view) return;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
    ['dash', 'buy', 'enroll', 'bond', 'credit', 'loop'].forEach((v) => $(v).classList.toggle('hide', v !== t.dataset.view));
  }));

  // wallet
  const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
  function renderWallet() { const b = $('connectBtn'); if (wallet) { b.textContent = short(wallet); b.classList.add('connected'); } else { b.textContent = 'Connect account'; b.classList.remove('connected'); } }
  function setWallet(a) { if (a && isW(a)) { wallet = a; localStorage.setItem('vault_w', a); renderWallet(); loadAccount(); loadChainBalance(); } else { wallet = ''; A = null; chainBal = null; localStorage.removeItem('vault_w'); renderWallet(); renderAccount(); } }
  $('connectBtn').onclick = async () => {
    if (wallet) { setWallet(''); toast('Account disconnected'); return; }
    const eth = window.ethereum; if (!eth) return toast('No EVM wallet found — install MetaMask or Rabby');
    try { const acc = await eth.request({ method: 'eth_requestAccounts' }); if (acc && acc[0]) { setWallet(acc[0]); toast('Welcome to Shareholder Services'); } } catch (e) { toast('Connection declined'); }
  };
  if (window.ethereum && window.ethereum.on) window.ethereum.on('accountsChanged', (acc) => setWallet(acc && acc[0]));
  renderWallet();

  // fetch
  async function loadMetrics() { try { M = await (await fetch('/api/metrics')).json(); reanchor(); renderMetrics(); } catch (e) {} }
  async function loadAccount() { if (!isW(wallet)) return; try { A = await (await fetch('/api/account', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet }) })).json(); reanchor(); renderAccount(); } catch (e) {} }
  async function loadConfig() { try { CFG = await (await fetch('/api/config')).json(); if (CFG && CFG.live) { if ($('buyBtn')) $('buyBtn').textContent = 'Buy on DEX ↗'; const bp = document.querySelector('#buy .psub'); if (bp) bp.textContent = 'Once live, $VAULT trades on the open market. Buy on the DEX, then enroll it here to earn the dividend.'; } } catch (e) {} }
  // real on-chain $VAULT balance, read server-side from the Robinhood Chain RPC
  async function loadChainBalance() {
    if (!isW(wallet)) { chainBal = null; return; }
    try { const r = await (await fetch('/api/balance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet }) })).json(); chainBal = (r && r.error) ? null : r.balance; }
    catch (e) { chainBal = null; }
    renderAccount();
  }
  // make sure the wallet is on Robinhood Chain before an on-chain transfer
  async function ensureChain() {
    if (!CFG || !CFG.chainId) return; const idHex = '0x' + (+CFG.chainId).toString(16);
    const cur = await window.ethereum.request({ method: 'eth_chainId' }); if (cur === idHex) return;
    try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: idHex }] }); }
    catch (e) {
      if (e && (e.code === 4902 || String(e.message).toLowerCase().includes('unrecognized') || String(e.message).includes('4902')))
        await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId: idHex, chainName: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [CFG.rpcUrl], blockExplorerUrls: ['https://robinhoodchain.blockscout.com'] }] });
      else throw new Error('switch your wallet to Robinhood Chain to enroll');
    }
  }
  // ERC-20 transfer of $VAULT to the treasury; resolves with the confirmed tx hash
  async function depositVault(amount) {
    await ensureChain();
    const wei = BigInt(Math.floor(amount * 1e6)) * (10n ** 12n);   // 18-decimal, avoid float overflow
    const data = '0xa9059cbb' + CFG.treasury.slice(2).toLowerCase().padStart(64, '0') + wei.toString(16).padStart(64, '0');
    const txHash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: wallet, to: CFG.mint, data }] });
    // wait for the receipt (up to ~60s)
    for (let i = 0; i < 40; i++) { try { const rc = await window.ethereum.request({ method: 'eth_getTransactionReceipt', params: [txHash] }); if (rc && rc.blockNumber) { if (rc.status && rc.status !== '0x1') throw new Error('transfer failed'); return txHash; } } catch (e) { if (String(e.message).includes('failed')) throw e; } await new Promise((r) => setTimeout(r, 1500)); }
    return txHash;   // submitted; credit optimistically
  }
  function reanchor() { if (!M) return; anchor = { index: M.index, nextIn: M.nextEpochIn, rate: M.epochRate, epochSec: M.epochSec, t: Date.now(), agons: A && A.staked ? A.staked / A.index : 0, totalStaked: M.totalStaked }; }
  function liveIndex() { if (!anchor) return { index: 1, nextIn: 0 }; let idx = anchor.index; let nextIn = anchor.nextIn - (Date.now() - anchor.t) / 1000; let g = 0; while (nextIn < 0 && g++ < 50) { idx *= (1 + anchor.rate); nextIn += anchor.epochSec; } const frac = 1 - nextIn / anchor.epochSec; return { index: idx * (1 + anchor.rate * frac), nextIn }; }

  async function post(url, b) { try { return await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json(); } catch (e) { return { error: 'request failed' }; } }

  // render metrics + dashboard
  function renderMetrics() {
    if (!M) return;
    $('mApy').textContent = apyf(M.apy);
    // 48h APY boost
    if (M.boost && M.boost.active) {
      $('boostBanner').style.display = 'flex';
      $('boostApy').textContent = apyf(M.boost.apy);
      $('mApy').innerHTML = apyf(M.apy) + ' <span style="font-size:15px;color:var(--accent)">⚡</span>';
      $('mApy').nextElementSibling.textContent = 'BOOSTED · ends soon · compounds every 8h';
      boostEndAt = Date.now() + M.boost.endsIn * 1000;
    } else if ($('boostBanner')) { $('boostBanner').style.display = 'none'; boostEndAt = 0; }
    $('mNav').textContent = px(M.nav);
    $('mPrice').textContent = px(M.marketPrice);
    $('mPremium').textContent = M.premium.toFixed(2) + '×';
    $('mTreasury').textContent = usd(M.treasury);
    $('mSupply').textContent = tok(M.supply);
    $('mMcap').textContent = usd(M.marketCap);
    $('mBacking').textContent = px(M.backing) + ' / VAULT';
    $('mRatio').textContent = pctf(M.stakingRatio) + ' enrolled';
    $('mEpochRate').textContent = pctf(M.epochRate) + ' / epoch';
    $('mBuyback').textContent = px(M.buybackBid);
    drawCurve();
    // THE FLOOR panel
    $('fFloor').textContent = px(M.floor);
    $('fRaises').textContent = n0(M.floorRaises);
    $('fAdded').textContent = usd(M.backingAdded);
    $('fSince').textContent = M.floorSinceHrs < 1 ? Math.round(M.floorSinceHrs * 60) + 'm' : M.floorSinceHrs < 48 ? M.floorSinceHrs.toFixed(1) + 'h' : Math.round(M.floorSinceHrs / 24) + 'd';
    drawFloor();
    // THE RESERVE BOOK — tokenized RWA treasury
    if (M.reserveBook) {
      $('rReal').textContent = M.realYield.toFixed(2) + '%';
      $('rVal').textContent = usd(M.rwaValue);
      const shades = { equity: 'var(--accent)', etf: 'var(--accent2)', tbill: 'var(--deep)', stable: 'var(--mut)' };
      $('rBar').innerHTML = M.reserveBook.map((h) => `<div title="${h.sym} ${(h.weight * 100).toFixed(0)}%" style="width:${(h.weight * 100).toFixed(2)}%;background:${shades[h.kind] || 'var(--accent)'};border-right:1px solid var(--bg)"></div>`).join('');
      const kindLabel = { equity: 'tokenized equity', etf: 'tokenized ETF', tbill: 'T-Bill', stable: 'stable' };
      $('rRows').innerHTML = M.reserveBook.map((h) => `<div class="row"><span><b class="cd">${h.sym}</b> ${h.name} <span class="mut">· ${kindLabel[h.kind]}</span></span><span><b>${(h.weight * 100).toFixed(0)}%</b> · ${usd(h.valueUsd)} · <span style="color:var(--accent)">${(h.yield * 100).toFixed(1)}% yld</span></span></div>`).join('');
    }
    // leaderboard
    if (M.leaderboard && M.leaderboard.length) { $('lbBox').style.display = 'block'; $('lbRows').innerHTML = M.leaderboard.map((b, i) => `<div class="row"><span>${i + 1}. <b class="cd">${b.wallet}</b></span><span><b class="gold">${tok(b.staked)} sVAULT</b> · ${pctf(b.share)}</span></div>`).join(''); }
    // tape
    if (M.tape && M.tape.length) { const ago = (t) => { const s = Math.max(1, (Date.now() - t) / 1000); return s < 60 ? Math.floor(s) + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h'; }; const ic = { buy: '↑', enroll: '◆', redeem: '↓', bond: '❖', claim: '✓', loop: '∞', repay: '−' }; const vb = { buy: 'purchased', enroll: 'enrolled', redeem: 'redeemed', bond: 'bonded', claim: 'claimed', loop: 'looped', repay: 'repaid' }; $('tapeRows').innerHTML = M.tape.map((e) => `<div class="row"><span><b class="gold">${ic[e.type] || '·'}</b> <b class="cd">${e.w}</b> ${vb[e.type] || e.type} <b>${tok(e.amount)} ${e.unit}</b></span><span class="mut">${ago(e.t)} ago</span></div>`).join(''); }
    if (M.mint) { const bar = $('caBar'); if (bar) { bar.style.display = 'flex'; $('caText').textContent = M.mint.slice(0, 10) + '…' + M.mint.slice(-6); bar.href = 'https://robinhoodchain.blockscout.com/token/' + M.mint; bar.target = '_blank'; bar.title = 'Copy CA'; bar.onclick = (e) => { e.preventDefault(); navigator.clipboard && navigator.clipboard.writeText(M.mint); toast('CA copied'); }; } }
    if (M.treasuryWallet) { const tl = $('treasuryLink'); if (tl) { tl.textContent = M.treasuryWallet.slice(0, 8) + '…' + M.treasuryWallet.slice(-6); tl.href = 'https://robinhoodchain.blockscout.com/address/' + M.treasuryWallet; } }
    calcBuy(); calcBond(); calcLoop();
  }

  // dividend curve (rate vs premium) — the enhancement centerpiece
  function drawCurve() {
    const c = $('curve'); if (!c || !M) return; const ctx = c.getContext('2d');
    const w = c.width = c.clientWidth * 2, h = c.height = c.clientHeight * 2; ctx.clearRect(0, 0, w, h);
    const pad = 30 * 2; const maxP = M.curve[M.curve.length - 1].p, maxR = M.rMax;
    const X = (p) => pad + (p - 1) / (maxP - 1) * (w - pad * 1.4);
    const Y = (r) => h - pad - r / maxR * (h - pad * 1.8);
    // grid
    ctx.strokeStyle = 'rgba(20,37,28,.10)'; ctx.lineWidth = 2;
    for (let i = 0; i <= 4; i++) { const yy = pad * 0.6 + i / 4 * (h - pad * 1.8); ctx.beginPath(); ctx.moveTo(pad, yy); ctx.lineTo(w - pad * 0.4, yy); ctx.stroke(); }
    // area + line
    ctx.beginPath(); ctx.moveTo(X(1), Y(0));
    M.curve.forEach((pt) => ctx.lineTo(X(pt.p), Y(pt.rate)));
    ctx.lineTo(X(maxP), Y(0)); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(15,107,79,.20)'); g.addColorStop(1, 'rgba(15,107,79,0)'); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); M.curve.forEach((pt, i) => { const x = X(pt.p), y = Y(pt.rate); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.strokeStyle = '#0f6b4f'; ctx.lineWidth = 3; ctx.stroke();
    // K marker
    ctx.strokeStyle = 'rgba(20,37,28,.28)'; ctx.setLineDash([5, 6]); ctx.beginPath(); ctx.moveTo(X(M.k), pad * 0.6); ctx.lineTo(X(M.k), h - pad); ctx.stroke(); ctx.setLineDash([]);
    // live premium dot
    const p = Math.min(M.premium, maxP); const dotX = X(p), dotY = Y(M.epochRate);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#0f6b4f'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(dotX, dotY, 9, 0, 7); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#0f6b4f'; ctx.beginPath(); ctx.arc(dotX, dotY, 4, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(20,37,28,.5)'; ctx.font = '600 20px "JetBrains Mono", monospace'; ctx.textAlign = 'center';
    ctx.fillText('NAV (1×)', X(1), h - pad + 34); ctx.fillText('K = ' + M.k + '×', X(M.k), h - pad + 34);
  }

  // rising-floor step chart — monotonic, only-up
  function drawFloor() {
    const c = $('floorC'); if (!c || !M || !M.navHist || !M.navHist.length) return; const ctx = c.getContext('2d');
    const w = c.width = c.clientWidth * 2, h = c.height = c.clientHeight * 2; ctx.clearRect(0, 0, w, h);
    const pad = 20 * 2; const hist = M.navHist; const navs = hist.map((p) => p.nav);
    const lo = Math.min(...navs) * 0.999, hi = Math.max(M.floor, ...navs) * 1.001;
    const X = (i) => pad + i / (hist.length - 1) * (w - pad * 1.6);
    const Y = (v) => h - pad - (v - lo) / (hi - lo || 1) * (h - pad * 2);
    ctx.strokeStyle = 'rgba(20,37,28,.09)'; ctx.lineWidth = 2;
    for (let i = 0; i <= 3; i++) { const yy = pad + i / 3 * (h - pad * 2); ctx.beginPath(); ctx.moveTo(pad, yy); ctx.lineTo(w - pad * 0.6, yy); ctx.stroke(); }
    // area under step
    ctx.beginPath(); ctx.moveTo(X(0), Y(navs[0]));
    for (let i = 1; i < hist.length; i++) { ctx.lineTo(X(i), Y(navs[i - 1])); ctx.lineTo(X(i), Y(navs[i])); }
    ctx.lineTo(X(hist.length - 1), h - pad); ctx.lineTo(X(0), h - pad); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(15,107,79,.22)'); g.addColorStop(1, 'rgba(15,107,79,0)'); ctx.fillStyle = g; ctx.fill();
    // step line
    ctx.beginPath(); ctx.moveTo(X(0), Y(navs[0]));
    for (let i = 1; i < hist.length; i++) { ctx.lineTo(X(i), Y(navs[i - 1])); ctx.lineTo(X(i), Y(navs[i])); }
    ctx.strokeStyle = '#0f6b4f'; ctx.lineWidth = 3.5; ctx.lineJoin = 'round'; ctx.stroke();
    // head dot
    const lx = X(hist.length - 1), ly = Y(navs[navs.length - 1]);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#0f6b4f'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(lx, ly, 8, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#0f6b4f'; ctx.beginPath(); ctx.arc(lx, ly, 4, 0, 7); ctx.fill();
  }
  function renderAccount() {
    if (!A || !isW(wallet)) { ['aUsdg', 'aVault', 'aStaked', 'aNext', 'aLoan'].forEach((id) => { const e = $(id); if (e) e.textContent = '—'; }); renderBonds(); return; }
    const live = CFG && CFG.live;
    // when the token is live, show the real on-chain wallet balance; otherwise the ledger balance
    $('aVault').textContent = live ? (chainBal == null ? '…' : tok(chainBal) + ' VAULT') : tok(A.vault) + ' VAULT';
    if ($('aUsdg')) { const lbl = $('aUsdg').previousElementSibling; if (live) { $('aUsdg').textContent = A.pendingOut > 0 ? tok(A.pendingOut) + ' VAULT' : '—'; if (lbl) lbl.textContent = 'Pending payout'; } else { $('aUsdg').textContent = tok(A.usdg) + ' USDG'; if (lbl) lbl.textContent = 'USDG balance'; } }
    $('aStaked').textContent = tok(A.staked) + ' sVAULT';
    $('aNext').textContent = '+' + (A.staked * (M ? M.epochRate : 0)).toFixed(3) + ' VAULT';
    if ($('aLoan')) $('aLoan').textContent = tok(A.loan) + ' USDG';
    renderBonds(); calcLoop(); renderCredit();
  }
  function renderBonds() {
    const box = $('yourBonds'); if (!box) return;
    if (!A || !A.bonds || !A.bonds.length) { box.innerHTML = '<div class="psub">No vesting notes.</div>'; return; }
    box.innerHTML = A.bonds.map((b) => `<div class="yb"><span>${tok(b.payout)} VAULT note</span><div class="prog"><i style="width:${(b.pct * 100).toFixed(0)}%"></i></div><span class="gold">${tok(b.claimable)} claimable</span></div>`).join('') + `<div style="display:flex;gap:8px;margin-top:12px"><button class="btn ghost" id="claimBtn">Claim</button><button class="btn gold" id="claimStakeBtn">Claim &amp; Enroll</button></div>`;
    if ($('claimBtn')) $('claimBtn').onclick = () => doClaim(false);
    if ($('claimStakeBtn')) $('claimStakeBtn').onclick = () => doClaim(true);
  }

  // actions
  $('buyBtn').onclick = async () => {
    // once live, VAULT is bought on the DEX — send users to the real market
    if (CFG && CFG.live && CFG.mint) { window.open('https://dexscreener.com/robinhood/' + CFG.mint, '_blank'); return; }
    if (!isW(wallet)) return toast('connect first'); const amt = parseFloat($('buyAmt').value); if (!(amt > 0)) return toast('enter USDG');
    const r = await post('/api/buy', { wallet, amount: amt }); if (r.error) return toast(r.error); A = r; reanchor(); renderAccount(); $('buyAmt').value = ''; toast('Purchased ' + tok(amt / M.marketPrice) + ' VAULT'); loadMetrics();
  };
  $('buyAmt').addEventListener('input', calcBuy);
  function calcBuy() { if (!M) return; const amt = parseFloat($('buyAmt').value) || 0; $('buyRate').textContent = '1 VAULT = ' + pxN(M.marketPrice) + ' USDG'; $('buyOut').textContent = tok(amt * (1 - M.tradeTax) / M.marketPrice) + ' VAULT'; $('buyTax').textContent = usd(amt * M.tradeTax) + ' tax (' + pctf(M.tradeTax) + ')'; }

  $('segEnroll').onclick = () => { stakeMode = 'enroll'; $('segEnroll').classList.add('on'); $('segRedeem').classList.remove('on'); $('stakeBtn').textContent = 'Enroll'; };
  $('segRedeem').onclick = () => { stakeMode = 'redeem'; $('segRedeem').classList.add('on'); $('segEnroll').classList.remove('on'); $('stakeBtn').textContent = 'Redeem'; };
  $('stakeMax').onclick = () => { if (!A) return; const live = CFG && CFG.live; const max = stakeMode === 'enroll' ? (live ? (chainBal || 0) : A.vault) : A.staked; $('stakeAmt').value = max > 0 ? (Math.floor(max * 100) / 100).toString() : '0'; };
  $('stakeBtn').onclick = async () => {
    if (!isW(wallet)) return toast('connect first');
    const amt = parseFloat($('stakeAmt').value); if (!(amt > 0)) return toast('enter an amount');
    const live = CFG && CFG.live;
    if (stakeMode === 'enroll') {
      if (live) {
        if (chainBal != null && amt > chainBal + 1e-9) return toast('amount exceeds your $VAULT balance');
        if (!window.ethereum) return toast('no EVM wallet found');
        const btn = $('stakeBtn'); const old = btn.textContent; btn.textContent = 'Confirm in wallet…'; btn.disabled = true;
        try {
          const txHash = await depositVault(amt);
          toast('Deposit sent — crediting sVAULT…');
          const r = await post('/api/stake', { wallet, amount: amt, txHash });
          if (r.error) { btn.textContent = old; btn.disabled = false; return toast(r.error); }
          A = r; reanchor(); renderAccount(); $('stakeAmt').value = ''; toast('Enrolled ' + tok(amt) + ' VAULT (3,3)'); loadMetrics(); loadChainBalance();
        } catch (e) { toast(e && e.code === 4001 ? 'transaction rejected' : (e.message || 'enroll failed')); }
        btn.textContent = old; btn.disabled = false; return;
      }
      const r = await post('/api/stake', { wallet, amount: amt });   // pre-launch ledger
      if (r.error) return toast(r.error); A = r; reanchor(); renderAccount(); $('stakeAmt').value = ''; toast('Enrolled ' + tok(amt) + ' VAULT'); loadMetrics(); return;
    }
    // redeem
    const r = await post('/api/redeem', { wallet, amount: amt });
    if (r.error) return toast(r.error); A = r; reanchor(); renderAccount(); $('stakeAmt').value = '';
    toast(r.queued ? 'Redemption queued — ' + tok(r.queued) + ' VAULT paid from treasury' : 'Redeemed ' + tok(amt) + ' VAULT'); loadMetrics();
  };

  $('bondBtn').onclick = async () => { if (!isW(wallet)) return toast('connect first'); const amt = parseFloat($('bondAmt').value); if (!(amt > 0)) return toast('enter USDG'); const r = await post('/api/bond', { wallet, amount: amt }); if (r.error) return toast(r.error); A = r; renderAccount(); $('bondAmt').value = ''; toast('Bonded — ' + tok(r.payout) + ' VAULT vesting'); loadMetrics(); };
  $('bondAmt').addEventListener('input', calcBond);
  function calcBond() { if (!M) return; const amt = parseFloat($('bondAmt').value) || 0; $('bondPrice').textContent = pxN(M.bondPrice) + ' USDG'; $('bondOut').textContent = tok(amt / M.bondPrice) + ' VAULT'; $('bondDisc').textContent = pctf(M.bondDiscount) + ' discount · ' + M.bondVestDays + '-day vest'; }
  async function doClaim(autostake) { const r = await post('/api/claim', { wallet, autostake }); if (r.error) return toast(r.error); A = r; reanchor(); renderAccount(); toast(autostake ? 'Claimed & enrolled ' + tok(r.claimed) : 'Claimed ' + tok(r.claimed) + ' VAULT'); }

  // Credit Desk — borrow against sVAULT
  $('borrowBtn').onclick = async () => { if (!isW(wallet)) return toast('connect first'); const amt = parseFloat($('borrowAmt').value); if (!(amt > 0)) return toast('enter a USDG amount'); const r = await post('/api/borrow', { wallet, amount: amt }); if (r.error) return toast(r.error); A = r; reanchor(); renderAccount(); $('borrowAmt').value = ''; toast('Borrowed ' + tok(r.borrowed) + ' USDG — paid from treasury'); loadMetrics(); };
  $('crRepayBtn').onclick = async () => { if (!isW(wallet)) return toast('connect first'); if (!A || !(A.loan > 0)) return toast('no loan outstanding'); const r = await post('/api/repay', { wallet, amount: A.loan }); if (r.error) return toast(r.error); A = r; renderAccount(); toast('Loan repaid'); loadMetrics(); };
  function renderCredit() {
    if (!A) { ['crColl', 'crAvail', 'crLoan', 'crLtv'].forEach((id) => { if ($(id)) $(id).textContent = '—'; }); return; }
    if ($('crColl')) $('crColl').textContent = usd(A.collateralUsd || 0);
    if ($('crAvail')) $('crAvail').textContent = usd(A.borrowable || 0);
    if ($('crLoan')) $('crLoan').textContent = usd(A.loan || 0);
    if ($('crLtv')) $('crLtv').textContent = pctf(A.currentLtv || 0) + ' / ' + pctf(A.liqLtv || 0.75) + ' liq';
    if ($('borrowCap')) $('borrowCap').textContent = usd(A.borrowable || 0) + ' available';
    if ($('borrowApr')) $('borrowApr').textContent = pctf(A.loanApr || 0.12) + ' APR';
    // health bar: 1 - ltv/liqLtv
    const hv = A.loan > 0 ? clamp(1 - (A.currentLtv / (A.liqLtv || 0.75)), 0, 1) : 1;
    const bar = $('crHealth'); if (bar) { bar.style.width = (hv * 100).toFixed(0) + '%'; bar.style.background = hv > 0.5 ? 'linear-gradient(90deg,#3fae86,#0f6b4f)' : hv > 0.2 ? '#d99a2b' : '#c0492f'; }
    if ($('crHealthL')) $('crHealthL').textContent = A.loan > 0 ? (hv * 100).toFixed(0) + '% headroom · ' + usd(A.loan) + ' borrowed' : 'no loan — full headroom';
  }
  // Loopback simulator + execution
  $('loopAmt').addEventListener('input', calcLoop);
  $('loopBtn').onclick = async () => { if (!isW(wallet)) return toast('connect first'); const amt = parseFloat($('loopAmt').value); if (!(amt > 0)) return toast('enter a borrow amount'); const r = await post('/api/loop', { wallet, amount: amt }); if (r.error) return toast(r.error); A = r; reanchor(); renderAccount(); $('loopAmt').value = ''; toast('Looped — borrowed ' + tok(r.borrowed) + ' USDG → ' + tok(r.looped) + ' VAULT enrolled'); loadMetrics(); };
  $('repayBtn').onclick = async () => { if (!isW(wallet)) return toast('connect first'); if (!A || !(A.loan > 0)) return toast('no loan outstanding'); const r = await post('/api/repay', { wallet, amount: A.loan }); if (r.error) return toast(r.error); A = r; renderAccount(); toast('Repaid loan'); loadMetrics(); };
  function calcLoop() {
    if (!M) return;
    const staked = A ? A.staked : 0, loan = A ? A.loan : 0;
    const collateralUsd = staked * M.nav;
    const maxBorrow = Math.max(0, collateralUsd * M.loopLtv - loan);
    $('loopCap').textContent = usd(maxBorrow) + ' available';
    // simulate compounding loops of the base position at LTV — "effective APY" headline
    let equity = 1, exposure = 1, ltv = M.loopLtv; for (let i = 0; i < 5; i++) exposure += Math.pow(ltv, i + 1);
    const lev = exposure; // total exposure per unit equity
    const baseApy = M.apy / 100; const borrowCost = (lev - 1) * M.loopApr;
    const effApy = (baseApy * lev - borrowCost) * 100;
    $('loopLev').textContent = lev.toFixed(2) + '×';
    $('loopEff').textContent = apyf(Math.max(0, effApy));
    $('loopApr').textContent = pctf(M.loopApr) + ' APR';
    // health: loan vs max
    const health = collateralUsd > 0 ? clamp(1 - loan / (collateralUsd * M.loopLtv), 0, 1) : 1;
    const bar = $('loopHealth'); if (bar) { bar.style.width = (health * 100).toFixed(0) + '%'; bar.style.background = health > 0.5 ? 'linear-gradient(90deg,#3fae86,#c9a86a)' : health > 0.2 ? '#e0b23a' : '#d4544e'; }
    $('loopHealthL').textContent = loan > 0 ? (health * 100).toFixed(0) + '% headroom · ' + usd(loan) + ' borrowed' : 'no loan — full headroom';
  }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

  // live tick
  function tick() {
    if (!anchor || !M) return; const li = liveIndex();
    const cd = Math.max(0, li.nextIn); const hh = Math.floor(cd / 3600), mm = Math.floor(cd % 3600 / 60), ss = Math.floor(cd % 60);
    const s = (hh > 0 ? String(hh).padStart(2, '0') + ':' : '') + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
    $('mEpoch').textContent = s; $('mIndex').textContent = li.index.toFixed(6);
    if (boostEndAt) { const b = Math.max(0, (boostEndAt - Date.now()) / 1000); const bh = Math.floor(b / 3600), bm = Math.floor(b % 3600 / 60), bs = Math.floor(b % 60); if ($('boostCd')) $('boostCd').textContent = String(bh).padStart(2, '0') + ':' + String(bm).padStart(2, '0') + ':' + String(bs).padStart(2, '0'); }
    if (A && anchor.agons) $('aStaked').textContent = tok(anchor.agons * li.index) + ' sVAULT';
  }

  loadConfig().then(() => { loadMetrics(); if (wallet) { loadAccount(); loadChainBalance(); } });
  setInterval(loadMetrics, 6000); setInterval(() => { if (wallet) { loadAccount(); loadChainBalance(); } }, 12000);
  setInterval(tick, 100); tick();
  window.addEventListener('resize', () => { drawCurve(); drawFloor(); });
})();
