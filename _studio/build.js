'use strict';
// Vault Capital brand-kit generator. Self-contained HTML per asset -> headless Chrome (ABSOLUTE file:// URL) -> Desktop PNG.
// Palette: ivory paper + emerald, Space Grotesk + JetBrains Mono. "Classified dossier" motif.
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700;800&display=swap" rel="stylesheet">`;

const BASE = `
:root{--bg:#f3f0e7;--ink:#14251c;--sub:rgba(20,37,28,.6);--mut:rgba(20,37,28,.36);--line:rgba(20,37,28,.15);--line2:rgba(20,37,28,.3);--accent:#0f6b4f;--deep:#0c5a41;--cream:#f3f0e7;--creamsub:rgba(243,240,231,.7);--disp:'Space Grotesk',sans-serif;--mono:'JetBrains Mono',monospace}
*{margin:0;padding:0;box-sizing:border-box}
html,body{font-family:var(--mono);color:var(--ink);background:var(--bg)}
.stage{position:relative;overflow:hidden;background:var(--bg)}
.grid{position:absolute;inset:0;background:linear-gradient(90deg,rgba(20,37,28,.04) 1px,transparent 1px),linear-gradient(0deg,rgba(20,37,28,.04) 1px,transparent 1px);background-size:60px 60px;-webkit-mask:radial-gradient(130% 90% at 50% 0%,#000,transparent 82%)}
.disp{font-family:var(--disp);text-transform:uppercase;letter-spacing:-.03em}
.mono{font-family:var(--mono)}
.crest{border:2px solid var(--deep);background:var(--deep);color:var(--cream);display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-weight:800}
.o{color:var(--bg);-webkit-text-stroke-color:var(--deep)}
`;

const page = (w, h, css, body) => `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${BASE}
.stage{width:${w}px;height:${h}px}${css}</style></head><body><div class="stage"><div class="grid"></div>${body}</div></body></html>`;

const stamp = (t) => `<span style="display:inline-flex;align-items:center;gap:10px;border:1px solid var(--line2);padding:10px 18px;font-size:15px;letter-spacing:.24em;text-transform:uppercase;color:var(--ink)"><span style="width:8px;height:8px;background:var(--accent)"></span>${t}</span>`;

const assets = {};

// 1) PFP 800x800 — crest + wordmark stack
assets['vault-pfp'] = page(800, 800, `
  .wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:34px}
  .crest{width:230px;height:230px;font-size:130px;border-width:4px}
  .wm{font-size:60px;font-weight:700;color:var(--deep)}`,
  `<div class="wrap"><div class="crest">V</div><div class="wm disp">Vault<span style="color:var(--sub);font-size:26px;display:block;text-align:center;letter-spacing:.3em;margin-top:8px">CAPITAL</span></div></div>`);

// 2) BANNER 1500x500
assets['vault-banner'] = page(1500, 500, `
  .wrap{position:absolute;inset:0;display:flex;align-items:center;gap:48px;padding:0 70px}
  .crest{width:150px;height:150px;font-size:88px;border-width:3px;flex:none}
  .h{font-size:78px;font-weight:700;color:var(--deep);line-height:.9}
  .s{font-size:22px;color:var(--sub);margin-top:16px;letter-spacing:.02em}
  .rt{position:absolute;right:70px;top:44px;font-size:14px;letter-spacing:.24em;color:var(--mut);text-transform:uppercase}
  .rb{position:absolute;right:70px;bottom:44px;font-size:20px;font-weight:700;color:var(--accent)}`,
  `<div class="rt mono">NAV-BACKED RESERVE // ROBINHOOD CHAIN</div>
   <div class="wrap"><div class="crest">V</div><div><div class="h disp">Vault Cap<span class="o" style="-webkit-text-stroke:1.4px var(--deep)">ital</span></div><div class="s">A floor beneath you. A press above. · $VAULT</div></div></div>
   <div class="rb mono">vaultcapitalrh.xyz</div>`);

// 3) KEY ART 2400x1350 — hero dossier
assets['vault-keyart'] = page(2400, 1350, `
  .wrap{position:absolute;inset:0;padding:130px 140px;display:flex;flex-direction:column;justify-content:center}
  .h{font-size:190px;font-weight:700;color:var(--deep);line-height:.86;margin:34px 0 40px}
  .s{font-size:40px;color:var(--sub);line-height:1.5;max-width:1500px}
  .row{display:flex;gap:20px;margin-top:70px;flex-wrap:wrap}
  .chip{border:1px solid var(--line2);padding:18px 30px;font-size:30px;font-weight:700;color:var(--ink)}
  .chip b{color:var(--accent)}
  .rt{position:absolute;right:140px;top:110px;font-size:22px;letter-spacing:.24em;color:var(--mut);text-transform:uppercase}
  .rb{position:absolute;right:140px;bottom:110px;font-size:30px;font-weight:700;color:var(--accent)}`,
  `<div class="rt mono">DOC · VLT-01 · CLASSIFIED</div>
   <div class="wrap">${stamp('Reserve Protocol · Immutable Policy')}
     <div class="h disp">Vault Cap<span class="o" style="-webkit-text-stroke:2.4px var(--deep)">ital</span></div>
     <div class="s">A reserve currency in the shape of a capital-management fund. Every VAULT is backed by at least 1 USDG of risk-free value — a hard floor you redeem against, 1:1. Above it, the press runs, scaled to the premium the market will pay.</div>
     <div class="row"><div class="chip">◆ NAV <b>floor</b></div><div class="chip">◆ Premium-driven <b>dividend</b></div><div class="chip">◆ Bond · <b>Loopback</b></div></div>
   </div>
   <div class="rb mono">vaultcapitalrh.xyz</div>`);

// 4) MECHANISM 2400x1350 — the four instruments as manifest rows
const mrow = (n, t, d) => `<div style="display:grid;grid-template-columns:200px 1fr 1.7fr;gap:28px;align-items:baseline;padding:38px 0;border-top:1px solid var(--line)">
  <div class="mono" style="font-size:26px;letter-spacing:.1em;color:var(--accent)">${n}</div>
  <div class="disp" style="font-size:46px;font-weight:600">${t}</div>
  <div style="font-size:28px;color:var(--sub);line-height:1.45">${d}</div></div>`;
assets['vault-mechanism'] = page(2400, 1350, `
  .wrap{position:absolute;inset:0;padding:100px 140px;display:flex;flex-direction:column}
  .ey{font-size:26px;letter-spacing:.3em;color:var(--mut);text-transform:uppercase}
  .h{font-size:96px;font-weight:700;color:var(--deep);margin:14px 0 34px}
  .foot{margin-top:auto;display:flex;justify-content:space-between;font-size:28px;color:var(--sub)}`,
  `<div class="wrap">
     <div class="ey mono">// Instruments</div>
     <div class="h disp">One engine. Four holds.</div>
     ${mrow('01 · ENROLL', 'Dividend Program', 'Enroll VAULT, receive sVAULT, compound every epoch. Redemption 1:1, immediate.')}
     ${mrow('02 · BOND', 'Equity Bond Desk', 'Subscribe USDG for discounted VAULT notes, floored at NAV. Every sale grows backing.')}
     ${mrow('03 · LOOP', 'Loopback Credit', 'Borrow USDG against sVAULT, buy & enroll in one tx. Leverage the dividend.')}
     <div class="foot mono"><span>◆ NAV-backed · Robinhood Chain</span><span style="color:var(--accent)">vaultcapitalrh.xyz</span></div>
   </div>`);

// 5) THE CURVE 2400x1350 — dividend policy formula + curve
assets['vault-policy'] = page(2400, 1350, `
  .wrap{position:absolute;inset:0;padding:110px 140px;display:flex;gap:90px;align-items:center}
  .h{font-size:104px;font-weight:700;color:var(--deep);line-height:1.02;margin-bottom:34px}
  .s{font-size:34px;color:var(--sub);line-height:1.55}
  .form{margin-top:44px;background:var(--deep);color:var(--cream);border-left:5px solid var(--accent);padding:28px 32px;font-size:30px;font-family:var(--mono)}
  .panel{flex:1;border:1px solid var(--line2);background:#faf8f1;padding:44px}
  .pl{font-size:22px;letter-spacing:.2em;color:var(--mut);text-transform:uppercase}`,
  `<div class="wrap">
     <div style="flex:1.05">
       <div class="mono" style="font-size:26px;letter-spacing:.3em;color:var(--mut);text-transform:uppercase">// Emissions Policy</div>
       <div class="h disp">You earn only<br>what's earned.</div>
       <div class="s">Dividends scale with the premium the market pays over NAV. Zero at the floor, full at a 1.75× premium. Immutable at deployment — no admin, ever.</div>
       <div class="form">rate = R_MAX × clamp((P−1)/(K−1), 0, 1)</div>
     </div>
     <div class="panel">
       <div class="pl mono">The Curve</div>
       <svg width="720" height="520" viewBox="0 0 720 520" style="margin-top:24px">
         <line x1="60" y1="60" x2="60" y2="440" stroke="rgba(20,37,28,.2)" stroke-width="2"/>
         <line x1="60" y1="440" x2="700" y2="440" stroke="rgba(20,37,28,.2)" stroke-width="2"/>
         <path d="M60 440 L360 150 L700 150" fill="none" stroke="#0f6b4f" stroke-width="6"/>
         <path d="M60 440 L360 150 L700 150 L700 440 Z" fill="rgba(15,107,79,.14)"/>
         <line x1="360" y1="60" x2="360" y2="440" stroke="rgba(20,37,28,.28)" stroke-width="2" stroke-dasharray="6 7"/>
         <circle cx="700" cy="150" r="11" fill="#fff" stroke="#0f6b4f" stroke-width="4"/>
         <text x="60" y="478" font-family="JetBrains Mono" font-size="22" fill="rgba(20,37,28,.5)">NAV 1×</text>
         <text x="330" y="478" font-family="JetBrains Mono" font-size="22" fill="rgba(20,37,28,.5)">K 1.75×</text>
       </svg>
     </div>
   </div>`);

// 6) VS NETNET / LINEAGE 2400x1350 — comparison
const vrow = (name, tick, note, us) => `<div style="display:flex;align-items:center;gap:40px;padding:36px 44px;border:1px solid ${us ? 'var(--deep)' : 'var(--line2)'};background:${us ? 'var(--deep)' : '#faf8f1'};color:${us ? 'var(--cream)' : 'var(--ink)'};margin-top:22px">
  <div style="flex:1"><div class="disp" style="font-size:48px;font-weight:600">${name}</div><div class="mono" style="font-size:24px;color:${us ? 'var(--creamsub)' : 'var(--mut)'};margin-top:6px">${tick}</div></div>
  <div style="flex:1.4;font-size:28px;line-height:1.4;color:${us ? 'var(--cream)' : 'var(--sub)'}">${note}</div></div>`;
assets['vault-lineage'] = page(2400, 1350, `
  .wrap{position:absolute;inset:0;padding:104px 150px;display:flex;flex-direction:column}
  .ey{font-size:26px;letter-spacing:.3em;color:var(--mut);text-transform:uppercase}
  .h{font-size:96px;font-weight:700;color:var(--deep);margin:12px 0 20px}
  .foot{margin-top:auto;display:flex;justify-content:space-between;font-size:28px;color:var(--sub)}`,
  `<div class="wrap">
     <div class="ey mono">// The Lineage</div>
     <div class="h disp">Backed. Then better.</div>
     ${vrow('NetNet Capital', '$NET · the reference', 'Proved the model — NAV floor, premium dividends, a fund you can redeem against.', false)}
     ${vrow('Vault Capital', '$VAULT · the build', 'Same immutable engine + a live NAV / premium / curve dashboard and a one-click Loopback leverage simulator.', true)}
     <div class="foot mono"><span>◆ Not affiliated with NetNet Capital</span><span style="color:var(--accent)">vaultcapitalrh.xyz</span></div>
   </div>`);

// 7) VS NETNET 2400x1350 — feature comparison, Vault superior
const crow = (label, net, vlt) => `<div style="display:grid;grid-template-columns:1.5fr 1fr 1fr;align-items:center;border-top:1px solid var(--line)">
  <div style="font-size:28px;color:var(--ink);padding:26px 30px">${label}</div>
  <div style="font-size:26px;color:var(--sub);padding:26px 30px;text-align:center;border-left:1px solid var(--line)">${net}</div>
  <div style="font-size:26px;color:var(--cream);font-weight:700;padding:26px 30px;text-align:center;background:var(--deep)">${vlt}</div></div>`;
assets['vault-vs-netnet'] = page(2400, 1350, `
  .wrap{position:absolute;inset:0;padding:80px 130px;display:flex;flex-direction:column}
  .ey{font-size:24px;letter-spacing:.3em;color:var(--mut);text-transform:uppercase}
  .h{font-size:82px;font-weight:700;color:var(--deep);margin:10px 0 26px}
  .tbl{border:1px solid var(--line2)}
  .hd{display:grid;grid-template-columns:1.5fr 1fr 1fr;align-items:stretch}
  .hd .c{padding:26px 30px;font-family:var(--disp);font-weight:600;font-size:34px;text-transform:uppercase}
  .hd .net{text-align:center;color:var(--sub);border-left:1px solid var(--line);font-size:28px}
  .hd .vlt{text-align:center;background:var(--deep);color:var(--cream)}
  .foot{margin-top:auto;display:flex;justify-content:space-between;font-size:26px;color:var(--sub)}`,
  `<div class="wrap">
     <div class="ey mono">// Head to head</div>
     <div class="h disp">Same model. Sharper build.</div>
     <div class="tbl">
       <div class="hd"><div class="c">&nbsp;</div><div class="c net">NetNet</div><div class="c vlt">Vault Capital</div></div>
       ${crow('NAV floor · redeem 1:1', '✓', '✓')}
       ${crow('Premium-driven dividend', '✓', '✓')}
       ${crow('Live NAV / premium / curve dashboard', '—', '✓ built-in')}
       ${crow('One-click Loopback simulator', 'manual', '✓ + health meter')}
       ${crow('All-time high', '$5M', 'unwritten')}
     </div>
     <div class="foot mono"><span>◆ Not affiliated with NetNet Capital</span><span style="color:var(--accent)">$VAULT · vaultcapitalrh.xyz</span></div>
   </div>`);

for (const [name, html] of Object.entries(assets)) { fs.writeFileSync(path.join(OUT, name + '.html'), html); console.log('wrote', name); }
console.log('done:', Object.keys(assets).length);
