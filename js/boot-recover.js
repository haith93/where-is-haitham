/*
 * Recovers from a half-updated install, once, by itself.
 *
 * WHY THIS FILE IS NOT A MODULE
 * -----------------------------
 * It exists to survive the failure of the modules. A classic script
 * runs even when every `type="module"` on the page has failed to load
 * or parse, which is exactly the situation it has to notice.
 *
 * WHAT GOES WRONG
 * ---------------
 * A deploy replaces every file at once, but a browser does not. An
 * older service worker can still be in charge of the tab, serving a
 * cached copy of one script beside a freshly fetched copy of another.
 * The two then disagree:
 *
 *   "The requested module './requests.js' does not provide an export
 *    named 'markReady'"
 *
 * and the page is dead. Haitham knows to unregister the worker and
 * hard reload. A teacher holding a phone in a corridor does not, and
 * for them the app is simply broken until somebody tells them.
 *
 * Current workers call skipWaiting and clients.claim, so they replace
 * themselves immediately and this cannot happen twice. But the worker
 * already installed on somebody's phone is whatever shipped last, and
 * there is no reaching it except by surviving it once.
 *
 * ONCE, AND ONLY ONCE
 * -------------------
 * The attempt is recorded in sessionStorage before the reload. A
 * genuinely broken deploy therefore shows its error rather than
 * reloading for ever, which is the failure mode that actually matters:
 * a boot loop hides the real fault and burns a phone's battery doing
 * it.
 */
(function () {
  'use strict';

  var KEY = 'wih.recovered';
  var busy = false;

  // A module that failed to load, parse or link. The wording differs
  // across browsers, so match on all of them rather than one.
  function isModuleMismatch(message) {
    return /does not provide an export named/i.test(message)
        || /Importing a module script failed/i.test(message)
        || /Failed to fetch dynamically imported module/i.test(message)
        || /error loading dynamically imported module/i.test(message);
  }

  function alreadyTried() {
    try { return sessionStorage.getItem(KEY) === '1'; }
    catch (err) { return true; }   // no storage: do not risk a loop
  }

  function remember() {
    try { sessionStorage.setItem(KEY, '1'); } catch (err) { /* ignore */ }
  }

  async function recover() {
    busy = true;
    remember();
    try {
      if ('serviceWorker' in navigator) {
        var regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(function (r) { return r.unregister(); }));
      }
      if (window.caches) {
        var keys = await caches.keys();
        await Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }
    } catch (err) {
      // Nothing useful to do; reload anyway. A plain reload against no
      // worker is still likely to fix it.
    }
    // replace(), not reload(): the broken page should not sit in the
    // back history waiting to be returned to.
    location.replace(location.href);
  }

  window.addEventListener('error', function (event) {
    if (busy || alreadyTried()) return;
    if (!isModuleMismatch(String((event && event.message) || ''))) return;
    recover();
  }, true);

  // A dynamic import that rejects never reaches the error event.
  window.addEventListener('unhandledrejection', function (event) {
    if (busy || alreadyTried()) return;
    var reason = event && event.reason;
    var message = (reason && reason.message) ? reason.message : String(reason || '');
    if (!isModuleMismatch(message)) return;
    recover();
  });

  // A clean load clears the flag, so the next genuine mismatch - months
  // from now, after some future deploy - is allowed its one attempt.
  window.addEventListener('load', function () {
    setTimeout(function () {
      if (!busy) { try { sessionStorage.removeItem(KEY); } catch (err) { /* ignore */ } }
    }, 4000);
  });
})();
