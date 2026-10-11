/**
 * pages.mjs: the fake web pages Claude "browses" in the demo harness.
 *
 * The real Apaki browser pane lays a native WebView2 over the pane's body;
 * the harness lays an iframe there instead (browser-shell.mjs) and fills it
 * with one of these pages. They belong to a fictional shop, "Acme Store", on
 * a fictional localhost dev server. Light and dark variants follow the theme
 * the window tells its pages about.
 *
 * pageFor(url, { dark }) -> { title, html }
 * shotSvg(url, { dark, confirmed }) -> an SVG string standing in for a screenshot Claude took
 */

const PALETTE = {
  light: { bg: '#f6f5f2', card: '#ffffff', ink: '#1c1b19', soft: '#6b6860', line: '#e3e0d9', accent: '#2d5be3', accentInk: '#ffffff', field: '#fbfaf8', ok: '#14764a', okBg: '#e5f4ec', bar: '#ffffff' },
  dark: { bg: '#121316', card: '#1b1d22', ink: '#ecebe7', soft: '#9a978f', line: '#2b2e35', accent: '#6f8cff', accentInk: '#0d1020', field: '#15171b', ok: '#5fd39a', okBg: '#16291f', bar: '#17191d' },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function shell(title, body, { dark, script = '' }) {
  const c = dark ? PALETTE.dark : PALETTE.light;
  return `<!doctype html><html class="${dark ? 'dark' : ''}"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:${c.bg};color:${c.ink};font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
html.dark body{background:${PALETTE.dark.bg};color:${PALETTE.dark.ink}}
header.top{display:flex;align-items:center;gap:18px;height:56px;padding:0 28px;background:${c.bar};border-bottom:1px solid ${c.line}}
html.dark header.top{background:${PALETTE.dark.bar};border-color:${PALETTE.dark.line}}
.logo{font-weight:760;letter-spacing:-.02em;font-size:19px}
.logo i{display:inline-block;width:14px;height:14px;border-radius:4px;background:${c.accent};margin-right:8px;vertical-align:-1px}
header.top nav{display:flex;gap:18px;color:${c.soft};font-size:14px}
header.top .cart{margin-left:auto;color:${c.soft};font-size:14px}
main{max-width:980px;margin:0 auto;padding:30px 28px 40px;display:grid;grid-template-columns:1.25fr 1fr;gap:26px}
h1{font-size:24px;letter-spacing:-.02em;margin:0 0 18px}
.card{background:${c.card};border:1px solid ${c.line};border-radius:14px;padding:22px}
html.dark .card{background:${PALETTE.dark.card};border-color:${PALETTE.dark.line}}
.card h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${c.soft};margin:0 0 12px;font-weight:650}
label{display:block;font-size:13px;color:${c.soft};margin:0 0 5px}
input{width:100%;height:42px;padding:0 13px;border-radius:9px;border:1px solid ${c.line};background:${c.field};color:${c.ink};font:inherit;outline:0;transition:box-shadow .15s,border-color .15s}
html.dark input{background:${PALETTE.dark.field};color:${PALETTE.dark.ink};border-color:${PALETTE.dark.line}}
input.focus{border-color:${c.accent};box-shadow:0 0 0 3px ${dark ? 'rgba(111,140,255,.25)' : 'rgba(45,91,227,.18)'}}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
.stack>*+*{margin-top:12px}
button.pay{margin-top:18px;width:100%;height:46px;border:0;border-radius:10px;background:${c.accent};color:${c.accentInk};font:inherit;font-weight:650;cursor:pointer;transition:transform .12s,opacity .2s}
button.pay.busy{opacity:.7}
.line{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid ${c.line};font-size:14px}
html.dark .line{border-color:${PALETTE.dark.line}}
.line.total{border:0;font-weight:700;font-size:16px;padding-top:14px}
.line span:last-child{font-variant-numeric:tabular-nums}
.banner{display:none;margin:0 0 18px;padding:14px 16px;border-radius:12px;background:${c.okBg};color:${c.ok};font-weight:600}
.banner.on{display:block}
.banner small{display:block;font-weight:500;margin-top:3px;opacity:.9}
.ring{position:fixed;z-index:9;pointer-events:none;border:2px solid ${c.accent};border-radius:10px;box-shadow:0 0 0 4px ${dark ? 'rgba(111,140,255,.22)' : 'rgba(45,91,227,.18)'};animation:ring 1.1s ease-out forwards}
@keyframes ring{0%{opacity:0;transform:scale(1.08)}18%{opacity:1;transform:scale(1)}80%{opacity:1}100%{opacity:0}}
.item{display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid ${c.line}}
.item .thumb{width:46px;height:46px;border-radius:10px;background:linear-gradient(135deg,${c.accent},${dark ? '#a98bff' : '#8fb2ff'});opacity:.85}
.item .t{flex:1}.item .t small{display:block;color:${c.soft}}
</style></head><body>${body}<script>${script}</script></body></html>`;
}

const header = (cartLabel) => `<header class="top"><div class="logo"><i></i>Acme Store</div><nav><span>Men</span><span>Women</span><span>Outdoor</span><span>Sale</span></nav><div class="cart">${esc(cartLabel)}</div></header>`;

const CHECKOUT_SCRIPT = `
const pay = document.getElementById('pay');
const banner = document.getElementById('banner');
const oid = document.getElementById('order-id');
pay.addEventListener('click', () => {
  pay.textContent = 'Processing...'; pay.classList.add('busy');
  setTimeout(() => { banner.classList.add('on'); pay.textContent = 'Paid'; }, 650);
  setTimeout(() => { oid.textContent = '#10428'; }, 4800);
});
`;

function checkout(dark) {
  const body = `${header('Cart (2)')}<main>
  <section>
    <h1>Checkout</h1>
    <div id="banner" class="banner" data-testid="confirmation">Thanks, your order is confirmed<small>Order <span id="order-id" data-testid="order-id">#</span></small></div>
    <div class="card stack"><h2>Contact</h2>
      <div><label for="email">Email</label><input id="email" autocomplete="off" placeholder="you@example.com"></div>
      <h2 style="margin-top:20px">Payment</h2>
      <div><label for="card">Card number</label><input id="card" value="4242 4242 4242 4242" autocomplete="off"></div>
      <div class="row" style="margin-top:12px"><div><label for="exp">Expiry</label><input id="exp" value="04 / 29" autocomplete="off"></div><div><label for="cvc">CVC</label><input id="cvc" value="123" autocomplete="off"></div></div>
      <button id="pay" class="pay">Pay now</button>
    </div>
  </section>
  <aside class="card"><h2>Order summary</h2>
    <div class="item"><div class="thumb"></div><div class="t">Trail jacket<small>Slate, size M</small></div><span>$64.00</span></div>
    <div class="item"><div class="thumb"></div><div class="t">Wool socks, 2 pairs<small>Moss</small></div><span>$20.00</span></div>
    <div class="line"><span>Shipping</span><span>Free</span></div>
    <div class="line total"><span>Total</span><span>$84.00</span></div>
  </aside></main>`;
  return { title: 'Checkout · Acme Store', html: shell('Checkout · Acme Store', body, { dark, script: CHECKOUT_SCRIPT }) };
}

function cart(dark) {
  const body = `${header('Cart (2)')}<main style="grid-template-columns:1fr">
  <section><h1>Your cart</h1><div class="card">
    <div class="item"><div class="thumb"></div><div class="t">Trail jacket<small>Slate, size M</small></div><span>$64.00</span></div>
    <div class="item"><div class="thumb"></div><div class="t">Wool socks, 2 pairs<small>Moss</small></div><span>$20.00</span></div>
    <div class="line total"><span>Subtotal</span><span>$84.00</span></div>
    <button class="pay" style="margin-top:8px">Go to checkout</button></div></section></main>`;
  return { title: 'Your cart · Acme Store', html: shell('Your cart · Acme Store', body, { dark }) };
}

function notFound(url, dark) {
  let host = url;
  try { host = new URL(url).host; } catch { /* keep the text */ }
  const body = `${header('Cart (2)')}<main style="grid-template-columns:1fr"><section><h1>Nothing here</h1><div class="card"><p style="margin:0">${esc(host)} has no page at that address in this demo.</p></div></section></main>`;
  return { title: 'Not found · Acme Store', html: shell('Not found · Acme Store', body, { dark }) };
}

/** The page for an address, in the window's theme. */
export function pageFor(url, { dark = false } = {}) {
  let path = '';
  try { path = new URL(url).pathname; } catch { path = ''; }
  if (/^\/checkout/.test(path)) return checkout(dark);
  if (/^\/cart/.test(path)) return cart(dark);
  return notFound(url, dark);
}

/**
 * A stand-in screenshot for browser_screenshot: the checkout page after Pay
 * now, drawn as shapes in an SVG (an image Claude "saw"). ASCII only, so it
 * can be base64 encoded with btoa.
 */
export function shotSvg({ dark = false } = {}) {
  const c = dark ? PALETTE.dark : PALETTE.light;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
<rect width="640" height="400" fill="${c.bg}"/>
<rect width="640" height="36" fill="${c.bar}"/><rect x="0" y="35" width="640" height="1" fill="${c.line}"/>
<rect x="18" y="12" width="9" height="9" rx="3" fill="${c.accent}"/><rect x="33" y="12" width="64" height="10" rx="3" fill="${c.ink}" opacity=".8"/>
<rect x="22" y="56" width="120" height="14" rx="4" fill="${c.ink}" opacity=".85"/>
<rect x="22" y="82" width="360" height="40" rx="9" fill="${c.okBg}"/><rect x="36" y="92" width="170" height="9" rx="3" fill="${c.ok}"/><rect x="36" y="106" width="64" height="8" rx="3" fill="${c.ok}" opacity=".7"/>
<rect x="22" y="134" width="360" height="236" rx="12" fill="${c.card}" stroke="${c.line}"/>
<rect x="38" y="152" width="80" height="8" rx="3" fill="${c.soft}" opacity=".6"/><rect x="38" y="168" width="328" height="30" rx="7" fill="${c.field}" stroke="${c.line}"/>
<rect x="38" y="214" width="80" height="8" rx="3" fill="${c.soft}" opacity=".6"/><rect x="38" y="230" width="328" height="30" rx="7" fill="${c.field}" stroke="${c.line}"/>
<rect x="38" y="276" width="156" height="30" rx="7" fill="${c.field}" stroke="${c.line}"/><rect x="210" y="276" width="156" height="30" rx="7" fill="${c.field}" stroke="${c.line}"/>
<rect x="38" y="322" width="328" height="34" rx="8" fill="${c.accent}" opacity=".7"/>
<rect x="404" y="56" width="214" height="200" rx="12" fill="${c.card}" stroke="${c.line}"/>
<rect x="420" y="74" width="90" height="8" rx="3" fill="${c.soft}" opacity=".6"/>
<rect x="420" y="96" width="30" height="30" rx="7" fill="${c.accent}" opacity=".7"/><rect x="460" y="102" width="90" height="8" rx="3" fill="${c.ink}" opacity=".7"/>
<rect x="420" y="140" width="30" height="30" rx="7" fill="${c.accent}" opacity=".7"/><rect x="460" y="146" width="110" height="8" rx="3" fill="${c.ink}" opacity=".7"/>
<rect x="420" y="214" width="60" height="9" rx="3" fill="${c.ink}" opacity=".85"/><rect x="560" y="214" width="42" height="9" rx="3" fill="${c.ink}" opacity=".85"/>
</svg>`;
}
