/* ESEP: тема сайта и кабинета — auto | light | dark. Подключать в <head> до стилей страницы. */
(function () {
  var KEY = 'esep-theme', root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  function get() { try { return localStorage.getItem(KEY) || 'auto'; } catch (e) { return 'auto'; } }
  function eff(t) { return t === 'auto' ? (mq && mq.matches ? 'light' : 'dark') : t; }
  function paint() {
    var t = get(), e = eff(t);
    if (t === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', e === 'light' ? '#f6f3fb' : '#271d3b');
    var imgs = document.querySelectorAll('img[data-logo]');
    for (var i = 0; i < imgs.length; i++) imgs[i].src = e === 'light' ? '/img/esep-logo-dark.png' : '/img/esep-logo.png';
    var ICO = { auto: '🌓', light: '☀️', dark: '🌙' }, TXT = { auto: 'Тема: как в системе (нажмите, чтобы сменить)', light: 'Тема: светлая', dark: 'Тема: тёмная' };
    var bs = document.querySelectorAll('[data-theme-toggle]');
    for (var j = 0; j < bs.length; j++) { bs[j].textContent = ICO[t]; bs[j].title = TXT[t]; bs[j].setAttribute('aria-label', TXT[t]); }
  }
  function next() { var o = ['auto', 'light', 'dark'], t = o[(o.indexOf(get()) + 1) % 3]; try { localStorage.setItem(KEY, t); } catch (e) {} paint(); }
  paint();
  document.addEventListener('DOMContentLoaded', function () {
    paint();
    document.addEventListener('click', function (ev) { var b = ev.target.closest && ev.target.closest('[data-theme-toggle]'); if (b) { ev.preventDefault(); next(); } });
  });
  if (mq && mq.addEventListener) mq.addEventListener('change', paint);
  window.esepTheme = { paint: paint, next: next };
})();
