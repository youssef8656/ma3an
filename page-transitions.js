/**
 * MA3AN Camp Teams — shared page-transition animation.
 *
 * Include this on every page with:
 *   <script src="page-transitions.js"></script>
 *
 * What it does:
 * - Fades/slides the page in on load.
 * - Intercepts clicks on internal links (href ending in .html, same tab,
 *   no modifier keys), plays a quick fade/slide-out, then navigates.
 * - Leaves external links, mailto:, tel:, "#" anchors, downloads, and
 *   ctrl/cmd/shift-clicks completely alone (normal browser behavior).
 *
 * No dependencies, no build step — just a plain <script> include.
 */
(function () {
  var ENTER_MS = 320;
  var EXIT_MS = 220;

  var style = document.createElement('style');
  style.textContent =
    'body.pt-enter{opacity:0;transform:translateY(12px);}' +
    'body.pt-enter-active{opacity:1;transform:translateY(0);' +
      'transition:opacity ' + ENTER_MS + 'ms ease, transform ' + ENTER_MS + 'ms ease;}' +
    'body.pt-exit{opacity:0!important;transform:translateY(-12px)!important;' +
      'transition:opacity ' + EXIT_MS + 'ms ease, transform ' + EXIT_MS + 'ms ease;}';
  document.head.appendChild(style);

  /**
   * Lightweight "who's using the site" pass-through, since there's no
   * real login system yet. Reads ?email= / ?name= off the CURRENT page's
   * URL and (unless overridden) carries them onto any internal link you
   * build or navigate to, so a camper's identity survives clicking
   * between pages without needing localStorage/sessionStorage.
   *
   * Usage from any page's own <script>:
   *   window.MA3AN_getIdentity()               -> { email, name }
   *   window.MA3AN_buildUrl('x.html')          -> carries current email/name forward
   *   window.MA3AN_buildUrl('x.html', {email, name}) -> use these instead/in addition
   */
  window.MA3AN_getIdentity = function () {
    var params = new URLSearchParams(window.location.search);
    return { email: params.get('email') || '', name: params.get('name') || '' };
  };

  window.MA3AN_buildUrl = function (href, overrides) {
    overrides = overrides || {};
    var current = window.MA3AN_getIdentity();
    var email = overrides.email !== undefined ? overrides.email : current.email;
    var name = overrides.name !== undefined ? overrides.name : current.name;

    var hashSplit = href.split('#');
    var pathAndQuery = hashSplit[0];
    var hash = hashSplit.length > 1 ? hashSplit.slice(1).join('#') : '';
    var qSplit = pathAndQuery.split('?');
    var base = qSplit[0];
    var query = qSplit.length > 1 ? qSplit.slice(1).join('?') : '';

    var sp = new URLSearchParams(query);
    if (email) sp.set('email', email);
    if (name) sp.set('name', name);
    var qs = sp.toString();

    return base + (qs ? '?' + qs : '') + (hash ? '#' + hash : '');
  };

  function playEnter() {
    document.body.classList.add('pt-enter');
    // Two rAFs so the browser registers the starting state before transitioning.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        document.body.classList.remove('pt-enter');
        document.body.classList.add('pt-enter-active');
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', playEnter);
  } else {
    playEnter();
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    var link = e.target.closest('a');
    if (!link) return;

    var href = link.getAttribute('href');
    if (!href) return;
    if (href.charAt(0) === '#') return;
    if (/^(https?:|mailto:|tel:)/i.test(href)) return;
    if (link.target === '_blank' || link.hasAttribute('download')) return;
    if (!/\.html($|[?#])/i.test(href)) return;

    e.preventDefault();
    var target = window.MA3AN_buildUrl(href);
    document.body.classList.remove('pt-enter-active');
    document.body.classList.add('pt-exit');
    setTimeout(function () {
      window.location.href = target;
    }, EXIT_MS);
  });
})();
