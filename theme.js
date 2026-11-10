/* ESEP: оформление сайта и кабинета — как на устройстве | светлая | тёмная (меню как у Google). Подключать в <head>. */
(function () {
  var KEY = 'esep-theme', root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  var ICON = {
    auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>'
  };
  var NAME = { auto: 'Как на устройстве', light: 'Светлая', dark: 'Тёмная' };
  function get() { try { var t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : 'auto'; } catch (e) { return 'auto'; } }
  function eff(t) { return t === 'auto' ? (mq && mq.matches ? 'light' : 'dark') : t; }
  function paint() {
    var t = get(), e = eff(t);
    if (t === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', e === 'light' ? '#ffffff' : '#271d3b');
    var imgs = document.querySelectorAll('img[data-logo]');
    for (var i = 0; i < imgs.length; i++) imgs[i].src = e === 'light' ? '/img/esep-logo-ring-dark.png' : '/img/esep-logo-ring.png';
    var bs = document.querySelectorAll('[data-theme-toggle]');
    for (var j = 0; j < bs.length; j++) { bs[j].innerHTML = ICON[e === 'light' ? 'light' : 'dark']; bs[j].title = 'Оформление: ' + NAME[t].toLowerCase(); bs[j].setAttribute('aria-label', 'Оформление: ' + NAME[t].toLowerCase()); }
    var items = document.querySelectorAll('.theme-menu [data-t]');
    for (var k = 0; k < items.length; k++) items[k].setAttribute('aria-checked', String(items[k].getAttribute('data-t') === t));
  }
  function set(t) { try { if (t === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch (e) {} paint(); }
  var menu = null, owner = null;
  function close() { if (menu) { menu.remove(); menu = null; if (owner) owner.setAttribute('aria-expanded', 'false'); owner = null; } }
  function open(btn) {
    close(); owner = btn; btn.setAttribute('aria-expanded', 'true');
    menu = document.createElement('div'); menu.className = 'theme-menu'; menu.setAttribute('role', 'menu');
    var h = '<div class="tm-title">Оформление</div>';
    ['auto', 'light', 'dark'].forEach(function (t) { h += '<button type="button" role="menuitemradio" data-t="' + t + '"><span class="tm-ic">' + ICON[t] + '</span><span>' + NAME[t] + '</span><span class="tm-ok" aria-hidden="true">✓</span></button>'; });
    menu.innerHTML = h; document.body.appendChild(menu);
    var r = btn.getBoundingClientRect(), w = menu.offsetWidth;
    menu.style.top = (r.bottom + 8) + 'px';
    menu.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
    paint();
    var first = menu.querySelector('[aria-checked="true"]') || menu.querySelector('button'); if (first) first.focus();
  }
  paint();
  document.addEventListener('DOMContentLoaded', paint);
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-theme-toggle]');
    if (b) { ev.preventDefault(); if (menu && owner === b) close(); else open(b); return; }
    var it = ev.target.closest && ev.target.closest('.theme-menu [data-t]');
    if (it) { set(it.getAttribute('data-t')); close(); return; }
    if (menu && !(ev.target.closest && ev.target.closest('.theme-menu'))) close();
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') close(); });
  window.addEventListener('resize', close); window.addEventListener('scroll', close, { passive: true });
  if (mq && mq.addEventListener) mq.addEventListener('change', paint);
  window.esepTheme = { paint: paint, set: set };
})();
