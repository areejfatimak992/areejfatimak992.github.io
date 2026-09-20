/*!
 * af-analytics — privacy-first, dependency-free analytics for this portfolio.
 *
 * Everything is stored in the visitor's own browser (localStorage). Nothing is
 * sent anywhere unless `window.AF_ANALYTICS_ENDPOINT` is set before this script
 * runs, and even then the local copy stays the source of truth for dashboard.html.
 *
 * Public API
 *   afTrack(name, props)            record a custom event
 *   AF_ANALYTICS.all()              every stored event
 *   AF_ANALYTICS.clear()            wipe stored events
 *   AF_ANALYTICS.exportJSON()       JSON string of the store
 *   AF_ANALYTICS.importJSON(text)   merge events from a JSON export
 *   AF_ANALYTICS.optOut() / optIn() / isOptedOut()
 */
(function (win, doc) {
  'use strict';

  var KEY = 'af_analytics_v1';
  var OPTOUT_KEY = 'af_analytics_optout';
  var VISITOR_KEY = 'af_visitor_id';
  var SESSION_KEY = 'af_session_id';
  var MAX_EVENTS = 3000;
  var FLUSH_MS = 600;

  var respectDNT = win.AF_ANALYTICS_RESPECT_DNT !== false;
  var endpoint = win.AF_ANALYTICS_ENDPOINT || null;

  /* ---------- storage helpers (every access guarded: private mode throws) ---- */

  function ls(fn, fallback) {
    try { return fn(win.localStorage); } catch (e) { return fallback; }
  }
  function ss(fn, fallback) {
    try { return fn(win.sessionStorage); } catch (e) { return fallback; }
  }

  function dntOn() {
    if (!respectDNT) return false;
    var d = win.doNotTrack || (win.navigator && (navigator.doNotTrack || navigator.msDoNotTrack));
    return d === '1' || d === 'yes';
  }

  function optedOut() {
    return ls(function (s) { return s.getItem(OPTOUT_KEY) === '1'; }, false);
  }

  var disabled = dntOn() || optedOut();

  function uid(prefix) {
    return prefix + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function visitorId() {
    return ls(function (s) {
      var v = s.getItem(VISITOR_KEY);
      if (!v) { v = uid('v'); s.setItem(VISITOR_KEY, v); }
      return v;
    }, 'v-anon');
  }

  function sessionId() {
    return ss(function (s) {
      var v = s.getItem(SESSION_KEY);
      if (!v) { v = uid('s'); s.setItem(SESSION_KEY, v); }
      return v;
    }, 's-anon');
  }

  var isNewSession = ss(function (s) { return !s.getItem(SESSION_KEY); }, true);
  var VID = visitorId();
  var SID = sessionId();

  /* ---------- the event buffer ---------------------------------------------- */

  var buffer = ls(function (s) {
    var raw = s.getItem(KEY);
    var parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  }, []);

  var flushTimer = null;

  function flush() {
    flushTimer = null;
    if (buffer.length > MAX_EVENTS) buffer = buffer.slice(buffer.length - MAX_EVENTS);
    ls(function (s) { s.setItem(KEY, JSON.stringify(buffer)); });
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = win.setTimeout(flush, FLUSH_MS);
  }

  function forward(evt) {
    if (!endpoint) return;
    try {
      var body = JSON.stringify(evt);
      if (navigator.sendBeacon) navigator.sendBeacon(endpoint, body);
      else fetch(endpoint, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'application/json' } });
    } catch (e) { /* forwarding is best-effort; the local store still has it */ }
  }

  function track(name, props) {
    if (disabled || !name) return;
    var evt = { t: Date.now(), e: String(name), s: SID, v: VID };
    if (props && typeof props === 'object') evt.p = props;
    buffer.push(evt);
    scheduleFlush();
    forward(evt);
  }

  /* ---------- environment facts --------------------------------------------- */

  function deviceClass() {
    var w = win.innerWidth || 1024;
    if (w < 768) return 'Mobile';
    if (w < 1100) return 'Tablet';
    return 'Desktop';
  }

  function referrer() {
    var r = doc.referrer;
    if (!r) return 'Direct';
    try {
      var h = new URL(r).hostname.replace(/^www\./, '');
      if (h === location.hostname) return 'Internal';
      return h;
    } catch (e) { return 'Unknown'; }
  }

  function currentTheme() {
    var t = doc.documentElement.getAttribute('data-theme');
    if (t) return t;
    return win.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function pagePath() {
    var p = location.pathname.split('/').pop();
    return p || 'index.html';
  }

  /* ---------- automatic events ---------------------------------------------- */

  function start() {
    if (disabled) return;

    if (isNewSession) {
      track('session_start', { ref: referrer(), device: deviceClass(), lang: (navigator.language || 'n/a') });
    }

    track('page_view', {
      path: pagePath(),
      ref: referrer(),
      device: deviceClass(),
      viewport: (win.innerWidth || 0) + 'x' + (win.innerHeight || 0),
      theme: currentTheme()
    });

    trackSections();
    trackScrollDepth();
    trackClicks();
    trackTimeOnPage();
  }

  /* Section views — fires once per session per section, at 45% visibility. */
  function trackSections() {
    if (!('IntersectionObserver' in win)) return;
    var targets = doc.querySelectorAll('[data-section], main section[id], header[id]');
    if (!targets.length) return;
    var seenKey = 'af_sections_' + SID;
    var seen = ss(function (s) { return JSON.parse(s.getItem(seenKey) || '[]'); }, []);

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var id = en.target.getAttribute('data-section') || en.target.id;
        if (!id || seen.indexOf(id) > -1) return;
        seen.push(id);
        ss(function (s) { s.setItem(seenKey, JSON.stringify(seen)); });
        track('section_view', { section: id });
        io.unobserve(en.target);
      });
    }, { threshold: 0.45 });

    [].forEach.call(targets, function (el) { io.observe(el); });
  }

  /* Scroll depth — 25 / 50 / 75 / 100, once each per session. */
  function trackScrollDepth() {
    var marks = [25, 50, 75, 100];
    var hitKey = 'af_depth_' + SID;
    var hit = ss(function (s) { return JSON.parse(s.getItem(hitKey) || '[]'); }, []);
    var ticking = false;

    function measure() {
      ticking = false;
      var docEl = doc.documentElement;
      var scrollable = docEl.scrollHeight - win.innerHeight;
      if (scrollable <= 0) return;
      var pct = Math.min(100, Math.round((win.scrollY / scrollable) * 100));
      marks.forEach(function (m) {
        if (pct >= m && hit.indexOf(m) === -1) {
          hit.push(m);
          ss(function (s) { s.setItem(hitKey, JSON.stringify(hit)); });
          track('scroll_depth', { depth: m });
        }
      });
      if (hit.length === marks.length) win.removeEventListener('scroll', onScroll);
    }

    function onScroll() {
      if (ticking) return;
      ticking = true;
      (win.requestAnimationFrame || win.setTimeout)(measure);
    }

    win.addEventListener('scroll', onScroll, { passive: true });
    measure();
  }

  /* Clicks — explicit data-track wins, otherwise the link type is inferred. */
  function trackClicks() {
    doc.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-track],a[href],button[data-track]') : null;
      if (!el) return;

      var explicit = el.getAttribute('data-track');
      if (explicit) {
        var props = {};
        var label = el.getAttribute('data-track-label');
        if (label) props.label = label;
        track(explicit, props);
        return;
      }

      var href = el.getAttribute('href') || '';
      if (/^mailto:/i.test(href)) return track('contact_email');
      if (/wa\.me|whatsapp/i.test(href)) return track('contact_whatsapp');
      if (/^tel:/i.test(href)) return track('contact_phone');
      if (/^#/.test(href)) return track('nav_click', { to: href.slice(1) });

      if (/^https?:/i.test(href)) {
        try {
          var host = new URL(href, location.href).hostname.replace(/^www\./, '');
          if (host === location.hostname) return;
          track('outbound_click', { host: host });
        } catch (err) { /* malformed href — nothing useful to record */ }
      }
    }, true);
  }

  /* Time on page — reported once, when the page is hidden or unloaded. */
  function trackTimeOnPage() {
    var started = Date.now();
    var reported = false;

    function report() {
      if (reported) return;
      reported = true;
      var sec = Math.round((Date.now() - started) / 1000);
      if (sec < 1 || sec > 3600) { flush(); return; }
      track('page_time', { seconds: sec, path: pagePath() });
      flush();
    }

    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState === 'hidden') report();
    });
    win.addEventListener('pagehide', report);
  }

  /* ---------- public surface ------------------------------------------------ */

  win.afTrack = track;

  win.AF_ANALYTICS = {
    key: KEY,
    all: function () {
      return ls(function (s) {
        var raw = s.getItem(KEY);
        var parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      }, []).concat([]);
    },
    flush: flush,
    clear: function () {
      buffer = [];
      ls(function (s) { s.removeItem(KEY); });
    },
    replace: function (events) {
      buffer = Array.isArray(events) ? events.slice(0) : [];
      flush();
    },
    exportJSON: function () {
      return JSON.stringify({ exported: new Date().toISOString(), version: 1, events: this.all() }, null, 2);
    },
    importJSON: function (text) {
      var parsed = JSON.parse(text);
      var incoming = Array.isArray(parsed) ? parsed : parsed.events;
      if (!Array.isArray(incoming)) throw new Error('No events array found in that file.');
      var seen = {};
      var merged = buffer.concat(incoming).filter(function (ev) {
        if (!ev || typeof ev.t !== 'number' || !ev.e) return false;
        var k = ev.t + '|' + ev.e + '|' + (ev.s || '');
        if (seen[k]) return false;
        seen[k] = 1;
        return true;
      });
      merged.sort(function (a, b) { return a.t - b.t; });
      buffer = merged;
      flush();
      return incoming.length;
    },
    isOptedOut: function () { return optedOut(); },
    optOut: function () {
      ls(function (s) { s.setItem(OPTOUT_KEY, '1'); });
      disabled = true;
    },
    optIn: function () {
      ls(function (s) { s.removeItem(OPTOUT_KEY); });
      disabled = dntOn();
    },
    dntActive: dntOn
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})(window, document);
