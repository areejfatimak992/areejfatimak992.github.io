/*!
 * Portfolio analytics dashboard.
 * Reads the local event store written by assets/analytics.js and renders it as
 * KPIs, charts and an exportable report. No network calls, no dependencies.
 */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var PAGE_SIZE = 25;

  var SECTION_LABELS = {
    hero: 'Hero', about: 'About', skills: 'Skills',
    work: 'Work', experience: 'Experience', contact: 'Contact'
  };

  var EVENT_LABELS = {
    cv_download: 'CV download',
    contact_email: 'Email click',
    contact_whatsapp: 'WhatsApp click',
    contact_phone: 'Phone click',
    copy_contact: 'Copied contact detail',
    project_open: 'Opened live project',
    repo_open: 'Opened repository',
    outbound_click: 'Outbound link',
    nav_click: 'Navigation click',
    theme_toggle: 'Theme switch',
    project_filter: 'Filtered projects',
    dashboard_open: 'Opened dashboard'
  };

  /* Events that describe browsing rather than an intentional interaction. */
  var PASSIVE = ['page_view', 'session_start', 'section_view', 'scroll_depth', 'page_time'];
  var CONTACT_EVENTS = ['contact_email', 'contact_whatsapp', 'contact_phone', 'copy_contact'];

  /* ===================== small helpers ===================================== */

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); };

  function el(name, attrs, text) {
    var n = document.createElement(name);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }

  function svg(name, attrs) {
    var n = document.createElementNS(NS, name);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  function token(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }

  function num(n) { return (n || 0).toLocaleString('en-US'); }

  function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }

  function duration(sec) {
    if (!sec) return '0s';
    if (sec < 60) return Math.round(sec) + 's';
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return m + 'm ' + (s < 10 ? '0' : '') + s + 's';
  }

  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function dayLabel(key) {
    var p = key.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function startOfDay(d) { var n = new Date(d); n.setHours(0, 0, 0, 0); return n; }
  function endOfDay(d) { var n = new Date(d); n.setHours(23, 59, 59, 999); return n; }

  function truncate(s, max) {
    s = String(s == null ? '' : s);
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function eventLabel(name) {
    return EVENT_LABELS[name] || name.replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); });
  }

  function sectionLabel(id) { return SECTION_LABELS[id] || id; }

  function countBy(list, keyFn) {
    var map = Object.create(null);
    list.forEach(function (item) {
      var k = keyFn(item);
      if (k == null || k === '') return;
      map[k] = (map[k] || 0) + 1;
    });
    return map;
  }

  /* Distinct sessions per key — "how many people", not "how many times". */
  function sessionsBy(list, keyFn) {
    var map = Object.create(null);
    list.forEach(function (item) {
      var k = keyFn(item);
      if (k == null || k === '') return;
      (map[k] || (map[k] = Object.create(null)))[item.s || '?'] = 1;
    });
    var out = Object.create(null);
    Object.keys(map).forEach(function (k) { out[k] = Object.keys(map[k]).length; });
    return out;
  }

  function toRows(map, labelFn) {
    return Object.keys(map)
      .map(function (k) { return { key: k, label: labelFn ? labelFn(k) : k, value: map[k] }; })
      .sort(function (a, b) { return b.value - a.value; });
  }

  /* Keep the chart readable: top N, everything else folded into "Other". */
  function capRows(rows, max) {
    if (rows.length <= max) return rows;
    var head = rows.slice(0, max - 1);
    var rest = rows.slice(max - 1).reduce(function (sum, r) { return sum + r.value; }, 0);
    head.push({ key: '__other', label: 'Other (' + (rows.length - max + 1) + ')', value: rest });
    return head;
  }

  /* Axis labels must be whole numbers: pick a step that divides the range evenly. */
  function niceScale(dataMax) {
    if (!(dataMax > 0)) return { max: 1, step: 1, ticks: 1 };
    var unit = [1, 2, 5];
    for (var p = 0; p < 9; p++) {
      for (var u = 0; u < unit.length; u++) {
        var step = unit[u] * Math.pow(10, p);
        var ticks = Math.ceil(dataMax / step);
        if (ticks <= 5) return { max: step * ticks, step: step, ticks: ticks };
      }
    }
    return { max: dataMax, step: dataMax / 5, ticks: 5 };
  }

  /* ===================== state ============================================= */

  var state = {
    all: [],
    slice: [],
    prevSlice: [],
    range: '30',
    from: null,
    to: null,
    tableMode: Object.create(null),
    log: { search: '', type: '', sort: 't', dir: -1, page: 0, rows: [] },
    agg: null
  };

  function loadEvents() {
    var api = window.AF_ANALYTICS;
    state.all = (api ? api.all() : []).filter(function (e) {
      return e && typeof e.t === 'number' && e.e;
    }).sort(function (a, b) { return a.t - b.t; });
  }

  function computeWindow() {
    var now = new Date();
    if (state.range === 'custom' && state.from && state.to) {
      return { start: startOfDay(state.from).getTime(), end: endOfDay(state.to).getTime() };
    }
    if (state.range === 'all') {
      var first = state.all.length ? state.all[0].t : now.getTime();
      return { start: startOfDay(new Date(first)).getTime(), end: endOfDay(now).getTime() };
    }
    var days = parseInt(state.range, 10) || 30;
    var start = startOfDay(new Date(now.getTime() - (days - 1) * 86400000));
    return { start: start.getTime(), end: endOfDay(now).getTime() };
  }

  function computeSlice() {
    var w = computeWindow();
    var span = w.end - w.start;
    state.window = w;
    state.slice = state.all.filter(function (e) { return e.t >= w.start && e.t <= w.end; });
    state.prevSlice = state.all.filter(function (e) { return e.t >= w.start - span && e.t < w.start; });
    state.agg = aggregate(state.slice, w);
  }

  function aggregate(events, w) {
    var views = events.filter(function (e) { return e.e === 'page_view'; });
    var sessions = Object.keys(countBy(events, function (e) { return e.s; }));
    var visitors = Object.keys(countBy(events, function (e) { return e.v; }));

    /* Daily series — every day in the window, including the zeros. */
    var perDay = countBy(views, function (e) { return dayKey(e.t); });
    var sessionsPerDay = sessionsBy(events, function (e) { return dayKey(e.t); });
    var cvPerDay = countBy(events.filter(function (e) { return e.e === 'cv_download'; }), function (e) { return dayKey(e.t); });
    var contactPerDay = countBy(events.filter(function (e) { return CONTACT_EVENTS.indexOf(e.e) > -1; }), function (e) { return dayKey(e.t); });

    var series = [];
    var cursor = startOfDay(new Date(w.start));
    var last = startOfDay(new Date(w.end));
    var guard = 0;
    while (cursor <= last && guard++ < 800) {
      var k = dayKey(cursor.getTime());
      series.push({
        key: k,
        label: dayLabel(k),
        value: perDay[k] || 0,
        sessions: sessionsPerDay[k] || 0,
        cv: cvPerDay[k] || 0,
        contact: contactPerDay[k] || 0
      });
      cursor = new Date(cursor.getTime() + 86400000);
    }

    var times = events.filter(function (e) { return e.e === 'page_time' && e.p && e.p.seconds; })
      .map(function (e) { return e.p.seconds; });
    var avgTime = times.length ? times.reduce(function (a, b) { return a + b; }, 0) / times.length : 0;

    var depthRows = [25, 50, 75, 100].map(function (d) {
      var n = Object.keys(countBy(events.filter(function (e) {
        return e.e === 'scroll_depth' && e.p && e.p.depth === d;
      }), function (e) { return e.s; })).length;
      return { key: String(d), label: d + '%', value: n };
    });

    var reached = Object.keys(countBy(events.filter(function (e) {
      return (e.e === 'section_view' && e.p && e.p.section === 'contact') ||
             (e.e === 'scroll_depth' && e.p && e.p.depth === 100);
    }), function (e) { return e.s; })).length;

    var interactions = events.filter(function (e) { return PASSIVE.indexOf(e.e) === -1; });

    return {
      views: views.length,
      sessions: sessions.length,
      visitors: visitors.length,
      cv: events.filter(function (e) { return e.e === 'cv_download'; }).length,
      contact: events.filter(function (e) { return CONTACT_EVENTS.indexOf(e.e) > -1; }).length,
      avgTime: avgTime,
      timeSamples: times.length,
      reached: reached,
      series: series,
      devices: toRows(countBy(views, function (e) { return e.p && e.p.device; })),
      sections: toRows(sessionsBy(events.filter(function (e) { return e.e === 'section_view'; }),
        function (e) { return e.p && e.p.section; }), sectionLabel),
      depth: depthRows,
      events: capRows(toRows(countBy(interactions, function (e) { return e.e; }), eventLabel), 8),
      sources: capRows(toRows(sessionsBy(events.filter(function (e) { return e.e === 'session_start' || e.e === 'page_view'; }),
        function (e) { return e.p && e.p.ref; })), 8)
    };
  }

  /* ===================== KPI tiles ========================================= */

  function deltaNode(now, before) {
    if (!before) return null;
    var change = Math.round(((now - before) / before) * 100);
    var cls = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
    var arrow = change > 0 ? 'M12 5v14M5 12l7-7 7 7' : change < 0 ? 'M12 19V5M5 12l7 7 7-7' : 'M5 12h14';
    var wrap = el('span', { class: 'delta ' + cls });
    var ic = svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.5' });
    ic.appendChild(svg('path', { d: arrow }));
    wrap.appendChild(ic);
    wrap.appendChild(document.createTextNode(Math.abs(change) + '% vs previous period'));
    return wrap;
  }

  function renderKpis() {
    var a = state.agg;
    $('#kpiViews').textContent = num(a.views);
    $('#kpiSessions').textContent = num(a.sessions);
    $('#kpiVisitors').textContent = num(a.visitors) + (a.visitors === 1 ? ' browser profile' : ' browser profiles');
    $('#kpiCv').textContent = num(a.cv);
    $('#kpiCvRate').textContent = a.sessions ? pct(a.cv, a.sessions) + '% of sessions' : 'no sessions yet';
    $('#kpiContact').textContent = num(a.contact);
    $('#kpiTime').textContent = duration(a.avgTime);
    $('#kpiTimeN').textContent = a.timeSamples ? 'from ' + num(a.timeSamples) + ' measured visits' : 'not measured yet';
    $('#kpiReach').textContent = a.sessions ? pct(a.reached, a.sessions) + '%' : '—';

    var host = $('#kpiViewsDelta');
    host.innerHTML = '';
    var prevViews = state.prevSlice.filter(function (e) { return e.e === 'page_view'; }).length;
    var d = deltaNode(a.views, prevViews);
    if (d) host.appendChild(d);
    else host.appendChild(el('div', { class: 'sub' }, 'no earlier period to compare'));
  }

  /* ===================== chart primitives ================================== */

  function plotWidth(host) {
    var w = host.clientWidth;
    return w > 40 ? w : 560;
  }

  function emptyState(host, message) {
    host.appendChild(el('div', { class: 'empty' }, message));
  }

  function makeTip(host) {
    var tip = el('div', { class: 'tip', role: 'status' });
    host.appendChild(tip);
    return {
      show: function (x, y, html) {
        tip.innerHTML = html;
        tip.style.left = x + 'px';
        tip.style.top = y + 'px';
        tip.classList.add('on');
      },
      hide: function () { tip.classList.remove('on'); }
    };
  }

  /* A bar whose far end is rounded and whose baseline end stays square. */
  function barPath(x, y, w, h, r) {
    r = Math.min(r, w, h / 2);
    if (w <= 0) return 'M' + x + ',' + y + 'h0';
    return 'M' + x + ',' + y +
      'h' + (w - r) +
      'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r +
      'v' + (h - 2 * r) +
      'a' + r + ',' + r + ' 0 0 1 ' + (-r) + ',' + r +
      'h' + (-(w - r)) + 'z';
  }

  function axisText(x, y, str, opts) {
    var t = svg('text', {
      x: x, y: y,
      fill: (opts && opts.fill) || token('--viz-muted'),
      'font-size': (opts && opts.size) || 11,
      'font-weight': (opts && opts.weight) || 500,
      'text-anchor': (opts && opts.anchor) || 'start',
      'dominant-baseline': (opts && opts.baseline) || 'middle'
    });
    if (opts && opts.tabular) t.setAttribute('style', 'font-variant-numeric:tabular-nums');
    t.textContent = str;
    return t;
  }

  /* ---------- line / area over time ---------------------------------------- */

  function lineChart(host, rows, opts) {
    if (!rows.length) return emptyState(host, opts.empty);

    var W = plotWidth(host), H = 250;
    var padL = 42, padR = 18, padT = 14, padB = 30;
    var iw = W - padL - padR, ih = H - padT - padB;
    var scale = niceScale(Math.max.apply(null, rows.map(function (r) { return r.value; })));
    var max = scale.max;
    var n = rows.length;

    var x = function (i) { return n === 1 ? padL + iw / 2 : padL + (i * iw) / (n - 1); };
    var y = function (v) { return padT + ih - (v / max) * ih; };

    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', tabindex: '0' });
    s.setAttribute('aria-label', opts.aria);

    /* gridlines + y ticks */
    for (var g = 0; g <= scale.ticks; g++) {
      var v = scale.step * g, gy = y(v);
      s.appendChild(svg('line', {
        x1: padL, x2: W - padR, y1: gy, y2: gy,
        stroke: g === 0 ? token('--axis') : token('--grid'), 'stroke-width': 1
      }));
      s.appendChild(axisText(padL - 9, gy, num(v), { anchor: 'end', tabular: true }));
    }

    /* x ticks — at most 6, never overlapping */
    var every = Math.max(1, Math.ceil(n / 6));
    rows.forEach(function (r, i) {
      if (i % every !== 0 && i !== n - 1) return;
      s.appendChild(axisText(x(i), H - padB + 15, r.label, { anchor: 'middle' }));
    });

    var c1 = token('--series-1');

    /* area */
    var area = 'M' + x(0) + ',' + y(rows[0].value);
    rows.forEach(function (r, i) { if (i) area += 'L' + x(i) + ',' + y(r.value); });
    area += 'L' + x(n - 1) + ',' + y(0) + 'L' + x(0) + ',' + y(0) + 'Z';
    s.appendChild(svg('path', { d: area, fill: c1, 'fill-opacity': '0.12' }));

    /* line */
    var line = 'M' + x(0) + ',' + y(rows[0].value);
    rows.forEach(function (r, i) { if (i) line += 'L' + x(i) + ',' + y(r.value); });
    s.appendChild(svg('path', {
      d: line, fill: 'none', stroke: c1, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round'
    }));

    /* direct label on the last point only */
    var lastRow = rows[n - 1];
    s.appendChild(svg('circle', {
      cx: x(n - 1), cy: y(lastRow.value), r: 4, fill: c1,
      stroke: token('--surface-1'), 'stroke-width': 2
    }));
    if (n > 1) {
      s.appendChild(axisText(x(n - 1) - 8, y(lastRow.value) - 14, num(lastRow.value), {
        anchor: 'end', fill: token('--text-primary'), size: 12, weight: 700, tabular: true
      }));
    }

    host.appendChild(s);
    var tip = makeTip(host);

    /* crosshair — mouse and keyboard reach the same values */
    var cross = svg('line', { y1: padT, y2: padT + ih, stroke: token('--axis'), 'stroke-width': 1, opacity: '0' });
    var dot = svg('circle', { r: 5, fill: c1, stroke: token('--surface-1'), 'stroke-width': 2, opacity: '0' });
    s.appendChild(cross); s.appendChild(dot);

    var active = -1;
    function focusIndex(i) {
      if (i < 0 || i >= n) return;
      active = i;
      var r = rows[i], px = x(i), py = y(r.value);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('opacity', '1');
      dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('opacity', '1');
      tip.show(px, py, '<b>' + num(r.value) + ' page view' + (r.value === 1 ? '' : 's') + '</b>' +
        '<em>' + r.label + ' · ' + num(r.sessions) + ' session' + (r.sessions === 1 ? '' : 's') + '</em>');
    }
    function blur() { active = -1; cross.setAttribute('opacity', '0'); dot.setAttribute('opacity', '0'); tip.hide(); }

    var hit = svg('rect', { x: padL, y: padT, width: Math.max(iw, 1), height: ih, fill: 'transparent' });
    s.appendChild(hit);
    hit.addEventListener('mousemove', function (ev) {
      var rect = s.getBoundingClientRect();
      var rel = ((ev.clientX - rect.left) / rect.width) * W;
      var i = n === 1 ? 0 : Math.round(((rel - padL) / iw) * (n - 1));
      focusIndex(Math.max(0, Math.min(n - 1, i)));
    });
    hit.addEventListener('mouseleave', blur);
    s.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowRight') { focusIndex(active < 0 ? 0 : active + 1); ev.preventDefault(); }
      else if (ev.key === 'ArrowLeft') { focusIndex(active < 0 ? n - 1 : active - 1); ev.preventDefault(); }
      else if (ev.key === 'Escape') blur();
    });
    s.addEventListener('blur', blur);
  }

  /* ---------- horizontal bars ---------------------------------------------- */

  function barChart(host, rows, opts) {
    if (!rows.length || !rows.some(function (r) { return r.value > 0; })) return emptyState(host, opts.empty);

    var W = plotWidth(host);
    var rowH = 32, barH = 15, padT = 6, padB = 6;
    var labelW = Math.min(150, Math.max(78, Math.round(W * 0.3)));
    var valueW = 52;
    var trackX = labelW + 12;
    var trackW = Math.max(30, W - trackX - valueW);
    var H = padT + padB + rows.length * rowH;
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; })) || 1;

    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img' });
    s.setAttribute('aria-label', opts.aria);
    host.appendChild(s);
    var tip = makeTip(host);

    rows.forEach(function (r, i) {
      var cy = padT + i * rowH + rowH / 2;
      var w = Math.max(r.value > 0 ? 3 : 0, (r.value / max) * trackW);
      var fill = opts.colors ? opts.colors[Math.min(i, opts.colors.length - 1)] : token('--series-1');

      s.appendChild(axisText(labelW, cy, truncate(r.label, 22), {
        anchor: 'end', fill: token('--text-secondary'), size: 12, weight: 600
      }));

      /* recessive track so short bars still read as a proportion */
      s.appendChild(svg('rect', {
        x: trackX, y: cy - barH / 2, width: trackW, height: barH,
        rx: 4, fill: token('--grid'), 'fill-opacity': '0.55'
      }));

      s.appendChild(svg('path', { d: barPath(trackX, cy - barH / 2, w, barH, 4), fill: fill }));

      s.appendChild(axisText(W - 4, cy, num(r.value), {
        anchor: 'end', fill: token('--text-primary'), size: 12, weight: 700, tabular: true
      }));

      /* hit area is the whole row, so the target never shrinks with the bar */
      var hit = svg('rect', { x: 0, y: padT + i * rowH, width: W, height: rowH, fill: 'transparent' });
      s.appendChild(hit);
      hit.addEventListener('mouseenter', function () {
        tip.show(trackX + w, cy - 4, '<b>' + r.label + '</b><em>' + num(r.value) + ' ' + opts.unit +
          ' · ' + pct(r.value, opts.total || max) + '%</em>');
      });
      hit.addEventListener('mouseleave', tip.hide);
    });
  }

  /* ---------- donut --------------------------------------------------------- */

  function donutChart(host, rows, opts) {
    var total = rows.reduce(function (s, r) { return s + r.value; }, 0);
    if (!total) return emptyState(host, opts.empty);

    var W = plotWidth(host), H = 210;
    var cx = W / 2, cy = H / 2, R = 78, r = 50;
    var colors = [token('--series-1'), token('--series-2'), token('--series-3')];
    var gapDeg = 2;

    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img' });
    s.setAttribute('aria-label', opts.aria);
    host.appendChild(s);
    var tip = makeTip(host);

    function arc(a0, a1) {
      var rad = function (d) { return ((d - 90) * Math.PI) / 180; };
      var large = (a1 - a0) > 180 ? 1 : 0;
      var x0 = cx + R * Math.cos(rad(a0)), y0 = cy + R * Math.sin(rad(a0));
      var x1 = cx + R * Math.cos(rad(a1)), y1 = cy + R * Math.sin(rad(a1));
      var x2 = cx + r * Math.cos(rad(a1)), y2 = cy + r * Math.sin(rad(a1));
      var x3 = cx + r * Math.cos(rad(a0)), y3 = cy + r * Math.sin(rad(a0));
      return 'M' + x0 + ',' + y0 + 'A' + R + ',' + R + ' 0 ' + large + ' 1 ' + x1 + ',' + y1 +
             'L' + x2 + ',' + y2 + 'A' + r + ',' + r + ' 0 ' + large + ' 0 ' + x3 + ',' + y3 + 'Z';
    }

    var angle = 0;
    var single = rows.length === 1;
    rows.slice(0, 3).forEach(function (row, i) {
      var sweep = (row.value / total) * 360;
      var a0 = angle + (single ? 0 : gapDeg / 2);
      var a1 = angle + sweep - (single ? 0 : gapDeg / 2);
      angle += sweep;
      if (a1 <= a0) return;
      var path = svg('path', { d: arc(a0, a1), fill: colors[i] });
      s.appendChild(path);
      path.addEventListener('mouseenter', function () {
        var mid = ((a0 + a1) / 2 - 90) * Math.PI / 180;
        tip.show(cx + (R - 14) * Math.cos(mid), cy + (R - 14) * Math.sin(mid),
          '<b>' + row.label + '</b><em>' + num(row.value) + ' ' + opts.unit + ' · ' + pct(row.value, total) + '%</em>');
      });
      path.addEventListener('mouseleave', tip.hide);
    });

    var mid = svg('text', {
      x: cx, y: cy - 6, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
      fill: token('--text-primary'), 'font-size': 26, 'font-weight': 800
    });
    mid.textContent = num(total);
    s.appendChild(mid);
    s.appendChild(axisText(cx, cy + 18, opts.unit, { anchor: 'middle', size: 12 }));

    /* legend carries the value too, so identity is never colour-alone */
    var legend = el('div', { class: 'legend' });
    rows.slice(0, 3).forEach(function (row, i) {
      var item = el('span');
      item.appendChild(el('i', { style: 'background:' + colors[i] }));
      item.appendChild(document.createTextNode(row.label + ' · ' + num(row.value) + ' (' + pct(row.value, total) + '%)'));
      legend.appendChild(item);
    });
    host.appendChild(legend);
  }

  /* ===================== table twins ======================================= */

  function tableTwin(host, cols, rows) {
    var wrap = el('div', { class: 'tbl-wrap' });
    var table = el('table');
    var thead = el('thead'), tr = el('tr');
    cols.forEach(function (c) {
      var th = el('th', { scope: 'col', class: c.num ? 'num' : '' }, c.label);
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    table.appendChild(thead);

    var tbody = el('tbody');
    if (!rows.length) {
      var empty = el('tr');
      empty.appendChild(el('td', { colspan: String(cols.length) }, 'No data in this range.'));
      tbody.appendChild(empty);
    }
    rows.forEach(function (r) {
      var row = el('tr');
      cols.forEach(function (c) {
        row.appendChild(el('td', { class: c.num ? 'num' : '' }, c.get(r)));
      });
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    host.appendChild(wrap);
  }

  /* ===================== chart registry ==================================== */

  var CHARTS = {
    trend: {
      chart: function (host) {
        lineChart(host, state.agg.series, {
          aria: 'Page views per day', empty: 'No visits recorded in this range yet.'
        });
      },
      table: function (host) {
        tableTwin(host, [
          { label: 'Date', get: function (r) { return r.label; } },
          { label: 'Page views', num: true, get: function (r) { return num(r.value); } },
          { label: 'Sessions', num: true, get: function (r) { return num(r.sessions); } },
          { label: 'CV', num: true, get: function (r) { return num(r.cv); } },
          { label: 'Contact', num: true, get: function (r) { return num(r.contact); } }
        ], state.agg.series);
      }
    },
    devices: {
      chart: function (host) {
        donutChart(host, state.agg.devices, {
          aria: 'Visits by device class', unit: 'views', empty: 'No device data yet.'
        });
      },
      table: function (host) {
        var total = state.agg.devices.reduce(function (s, r) { return s + r.value; }, 0);
        tableTwin(host, [
          { label: 'Device', get: function (r) { return r.label; } },
          { label: 'Views', num: true, get: function (r) { return num(r.value); } },
          { label: 'Share', num: true, get: function (r) { return pct(r.value, total) + '%'; } }
        ], state.agg.devices);
      }
    },
    sections: {
      chart: function (host) {
        barChart(host, state.agg.sections, {
          aria: 'Sessions that viewed each section', unit: 'sessions',
          total: state.agg.sessions, empty: 'No section views recorded yet.'
        });
      },
      table: function (host) {
        tableTwin(host, [
          { label: 'Section', get: function (r) { return r.label; } },
          { label: 'Sessions', num: true, get: function (r) { return num(r.value); } },
          { label: 'Reach', num: true, get: function (r) { return pct(r.value, state.agg.sessions) + '%'; } }
        ], state.agg.sections);
      }
    },
    depth: {
      chart: function (host) {
        barChart(host, state.agg.depth, {
          aria: 'Sessions reaching each scroll depth', unit: 'sessions',
          total: state.agg.sessions, empty: 'No scroll data recorded yet.',
          colors: [token('--ord-1'), token('--ord-2'), token('--ord-3'), token('--ord-4')]
        });
      },
      table: function (host) {
        tableTwin(host, [
          { label: 'Depth reached', get: function (r) { return r.label; } },
          { label: 'Sessions', num: true, get: function (r) { return num(r.value); } },
          { label: 'Of all sessions', num: true, get: function (r) { return pct(r.value, state.agg.sessions) + '%'; } }
        ], state.agg.depth);
      }
    },
    events: {
      chart: function (host) {
        barChart(host, state.agg.events, {
          aria: 'Interaction events by count', unit: 'events', empty: 'No interactions recorded yet.'
        });
      },
      table: function (host) {
        tableTwin(host, [
          { label: 'Interaction', get: function (r) { return r.label; } },
          { label: 'Count', num: true, get: function (r) { return num(r.value); } }
        ], state.agg.events);
      }
    },
    sources: {
      chart: function (host) {
        barChart(host, state.agg.sources, {
          aria: 'Sessions by traffic source', unit: 'sessions',
          total: state.agg.sessions, empty: 'No referrer data yet.'
        });
      },
      table: function (host) {
        tableTwin(host, [
          { label: 'Source', get: function (r) { return r.label; } },
          { label: 'Sessions', num: true, get: function (r) { return num(r.value); } }
        ], state.agg.sources);
      }
    }
  };

  function renderChart(id) {
    var host = document.getElementById(id);
    if (!host) return;
    host.innerHTML = '';
    (state.tableMode[id] ? CHARTS[id].table : CHARTS[id].chart)(host);
  }

  function renderCharts() { Object.keys(CHARTS).forEach(renderChart); }

  /* ===================== event log ========================================= */

  function detailsOf(e) {
    if (!e.p) return '';
    var p = e.p;
    if (p.section) return sectionLabel(p.section);
    if (p.depth != null) return p.depth + '% of the page';
    if (p.seconds != null) return duration(p.seconds) + ' on ' + (p.path || 'page');
    if (p.host) return p.host;
    if (p.label) return p.label;
    if (p.to) return '→ ' + p.to;
    if (p.ref) return 'from ' + p.ref + (p.device ? ' · ' + p.device : '');
    if (p.device) return p.device + (p.viewport ? ' · ' + p.viewport : '');
    return Object.keys(p).map(function (k) { return k + ': ' + p[k]; }).join(', ');
  }

  function logRows() {
    var q = state.log.search.toLowerCase();
    var rows = state.slice.filter(function (e) {
      if (state.log.type && e.e !== state.log.type) return false;
      if (!q) return true;
      return (e.e + ' ' + eventLabel(e.e) + ' ' + detailsOf(e)).toLowerCase().indexOf(q) > -1;
    });
    var key = state.log.sort, dir = state.log.dir;
    rows.sort(function (a, b) {
      var av = key === 't' ? a.t : String(a[key] || '');
      var bv = key === 't' ? b.t : String(b[key] || '');
      return av < bv ? -dir : av > bv ? dir : 0;
    });
    return rows;
  }

  function renderLog() {
    var rows = logRows();
    state.log.rows = rows;
    var pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (state.log.page >= pages) state.log.page = pages - 1;
    var page = rows.slice(state.log.page * PAGE_SIZE, (state.log.page + 1) * PAGE_SIZE);

    var tbody = $('#logTable tbody');
    tbody.innerHTML = '';
    if (!page.length) {
      var tr = el('tr');
      tr.appendChild(el('td', { colspan: '4' }, 'No events match this filter.'));
      tbody.appendChild(tr);
    }
    page.forEach(function (e) {
      var tr = el('tr');
      tr.appendChild(el('td', { class: 'mono' }, new Date(e.t).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
      })));
      var td = el('td');
      td.appendChild(el('span', { class: 'pill' }, eventLabel(e.e)));
      tr.appendChild(td);
      tr.appendChild(el('td', {}, detailsOf(e)));
      tr.appendChild(el('td', { class: 'mono' }, truncate(e.s || '—', 12)));
      tbody.appendChild(tr);
    });

    $('#pageInfo').textContent = rows.length
      ? 'Page ' + (state.log.page + 1) + ' of ' + pages + ' · ' + num(rows.length) + ' events'
      : 'No events';
    $('#prevPage').disabled = state.log.page === 0;
    $('#nextPage').disabled = state.log.page >= pages - 1;

    /* keep the type filter in sync with what is actually in range */
    var select = $('#logType');
    var current = select.value;
    var types = Object.keys(countBy(state.slice, function (e) { return e.e; })).sort();
    select.innerHTML = '';
    select.appendChild(el('option', { value: '' }, 'All event types'));
    types.forEach(function (t) { select.appendChild(el('option', { value: t }, eventLabel(t))); });
    select.value = types.indexOf(current) > -1 ? current : '';
    state.log.type = select.value;
  }

  /* ===================== CSV / JSON ======================================== */

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function csvRows(rows) {
    return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
  }

  function download(name, text, mime) {
    var blob = new Blob(['﻿' + text], { type: (mime || 'text/csv') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  function rangeLabel() {
    var w = state.window;
    return dayKey(w.start) + ' to ' + dayKey(w.end);
  }

  function buildReport() {
    var a = state.agg;
    var out = [];
    out.push([['Portfolio analytics report'], ['Site', 'areejfatimak992.github.io'],
      ['Generated', new Date().toISOString()], ['Range', rangeLabel()]]);

    out.push([[''], ['Summary'], ['Metric', 'Value'],
      ['Page views', a.views],
      ['Sessions', a.sessions],
      ['Browser profiles', a.visitors],
      ['CV downloads', a.cv],
      ['Contact clicks', a.contact],
      ['Average time on page (seconds)', Math.round(a.avgTime)],
      ['Sessions reaching contact (%)', pct(a.reached, a.sessions)]]);

    out.push([[''], ['Daily'], ['Date', 'Page views', 'Sessions', 'CV downloads', 'Contact clicks']]
      .concat(a.series.map(function (r) { return [r.key, r.value, r.sessions, r.cv, r.contact]; })));

    out.push([[''], ['Section engagement'], ['Section', 'Sessions', 'Reach %']]
      .concat(a.sections.map(function (r) { return [r.label, r.value, pct(r.value, a.sessions)]; })));

    out.push([[''], ['Scroll depth'], ['Depth', 'Sessions', 'Of all sessions %']]
      .concat(a.depth.map(function (r) { return [r.label, r.value, pct(r.value, a.sessions)]; })));

    out.push([[''], ['Interactions'], ['Event', 'Count']]
      .concat(a.events.map(function (r) { return [r.label, r.value]; })));

    out.push([[''], ['Traffic sources'], ['Source', 'Sessions']]
      .concat(a.sources.map(function (r) { return [r.label, r.value]; })));

    out.push([[''], ['Devices'], ['Device', 'Views']]
      .concat(a.devices.map(function (r) { return [r.label, r.value]; })));

    return out.map(csvRows).join('\r\n');
  }

  /* ===================== demo data ========================================= */

  function seedDemo() {
    var events = [];
    var sources = ['Direct', 'linkedin.com', 'github.com', 'google.com', 'Direct', 'Direct', 'wa.me'];
    var devices = ['Desktop', 'Desktop', 'Mobile', 'Mobile', 'Mobile', 'Tablet'];
    var sections = ['hero', 'about', 'skills', 'work', 'experience', 'contact'];
    var now = Date.now();

    function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

    for (var d = 44; d >= 0; d--) {
      var date = new Date(now - d * 86400000);
      var weekend = date.getDay() === 0 || date.getDay() === 6;
      var sessions = Math.max(1, Math.round((weekend ? 3 : 7) + (Math.random() * 6 - 2)));

      for (var k = 0; k < sessions; k++) {
        var sid = 's-demo-' + d + '-' + k;
        var vid = 'v-demo-' + Math.floor(Math.random() * 90);
        var device = pick(devices);
        var ref = pick(sources);
        var base = new Date(date);
        base.setHours(8 + Math.floor(Math.random() * 13), Math.floor(Math.random() * 60), 0, 0);
        var t = base.getTime();

        function add(name, props, offset) {
          events.push({ t: t + (offset || 0), e: name, s: sid, v: vid, p: props });
        }

        add('session_start', { ref: ref, device: device, lang: 'en-GB' }, 0);
        add('page_view', { path: 'index.html', ref: ref, device: device, theme: Math.random() < 0.35 ? 'dark' : 'light' }, 60);

        /* engagement decays the further down the page the visitor goes */
        var reach = Math.random();
        var depthCount = reach > 0.82 ? 4 : reach > 0.58 ? 3 : reach > 0.3 ? 2 : 1;
        for (var si = 0; si < Math.min(sections.length, depthCount + 2); si++) {
          add('section_view', { section: sections[si] }, 3000 + si * 9000);
        }
        [25, 50, 75, 100].slice(0, depthCount).forEach(function (dep, di) {
          add('scroll_depth', { depth: dep }, 5000 + di * 11000);
        });

        if (Math.random() < 0.3) add('nav_click', { to: pick(sections) }, 12000);
        if (Math.random() < 0.22) add('project_open', {}, 30000);
        if (Math.random() < 0.1) add('repo_open', {}, 34000);
        if (Math.random() < 0.15) add('project_filter', { label: pick(['erp', 'telecom', 'reporting']) }, 26000);
        if (Math.random() < 0.12) add('theme_toggle', { to: 'dark' }, 9000);

        if (depthCount >= 3 && Math.random() < 0.3) add('cv_download', {}, 48000);
        if (depthCount === 4 && Math.random() < 0.26) {
          add(pick(['contact_email', 'contact_whatsapp', 'copy_contact']), { label: 'email address' }, 56000);
        }

        add('page_time', { seconds: Math.round(35 + depthCount * 42 + Math.random() * 60), path: 'index.html' }, 70000);
      }
    }

    events.sort(function (a, b) { return a.t - b.t; });
    window.AF_ANALYTICS.replace(events);
  }

  /* ===================== wiring ============================================ */

  function setScopeNote() {
    var note = $('#scopeNote');
    var labels = { '7': 'the last 7 days', '30': 'the last 30 days', '90': 'the last 90 days', all: 'all recorded time' };
    var scope = state.range === 'custom' ? rangeLabel() : labels[state.range];
    note.textContent = 'Showing ' + scope + ' · ' + num(state.slice.length) + ' events · ' +
      num(state.all.length) + ' stored in total.';
  }

  function refresh() {
    computeSlice();
    renderKpis();
    renderCharts();
    renderLog();
    setScopeNote();
    /* An empty store means a first-time visitor, not a broken page — say so. */
    $('#emptyBanner').hidden = state.all.length > 0;
  }

  function reload() { loadEvents(); refresh(); }

  function wire() {
    /* date range */
    $$('.rangeset button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.range = b.getAttribute('data-range');
        $$('.rangeset button').forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); });
        $('#from').value = ''; $('#to').value = '';
        state.log.page = 0;
        refresh();
      });
    });

    function customChanged() {
      var f = $('#from').value, t = $('#to').value;
      if (!f || !t) return;
      state.from = new Date(f + 'T00:00:00');
      state.to = new Date(t + 'T00:00:00');
      if (state.from > state.to) { var tmp = state.from; state.from = state.to; state.to = tmp; }
      state.range = 'custom';
      $$('.rangeset button').forEach(function (o) { o.setAttribute('aria-pressed', 'false'); });
      state.log.page = 0;
      refresh();
    }
    $('#from').addEventListener('change', customChanged);
    $('#to').addEventListener('change', customChanged);

    /* chart ↔ table twins */
    $$('.toggle[data-table]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-table');
        state.tableMode[id] = !state.tableMode[id];
        b.setAttribute('aria-pressed', String(!!state.tableMode[id]));
        b.textContent = state.tableMode[id] ? 'Chart' : 'Table';
        renderChart(id);
      });
    });

    /* event log */
    var searchTimer = null;
    $('#logSearch').addEventListener('input', function (e) {
      clearTimeout(searchTimer);
      var v = e.target.value;
      searchTimer = setTimeout(function () { state.log.search = v; state.log.page = 0; renderLog(); }, 180);
    });
    $('#logType').addEventListener('change', function (e) {
      state.log.type = e.target.value; state.log.page = 0; renderLog();
    });
    $$('#logTable th.sortable').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort');
        if (state.log.sort === key) state.log.dir *= -1;
        else { state.log.sort = key; state.log.dir = key === 't' ? -1 : 1; }
        renderLog();
      });
    });
    $('#prevPage').addEventListener('click', function () { state.log.page--; renderLog(); });
    $('#nextPage').addEventListener('click', function () { state.log.page++; renderLog(); });

    /* exports */
    $('#exportCsv').addEventListener('click', function () {
      download('portfolio-report-' + dayKey(Date.now()) + '.csv', buildReport());
    });
    $('#exportLog').addEventListener('click', function () {
      var rows = [['Timestamp', 'Date', 'Event', 'Event name', 'Details', 'Session', 'Visitor']];
      state.log.rows.forEach(function (e) {
        rows.push([e.t, new Date(e.t).toISOString(), e.e, eventLabel(e.e), detailsOf(e), e.s || '', e.v || '']);
      });
      download('portfolio-events-' + dayKey(Date.now()) + '.csv', csvRows(rows));
    });
    $('#exportJson').addEventListener('click', function () {
      download('portfolio-analytics-backup-' + dayKey(Date.now()) + '.json',
        window.AF_ANALYTICS.exportJSON(), 'application/json');
    });

    /* import */
    $('#importBtn').addEventListener('click', function () { $('#importFile').click(); });
    $('#importFile').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var n = window.AF_ANALYTICS.importJSON(String(reader.result));
          reload();
          alert('Imported ' + n + ' events. Duplicates were skipped.');
        } catch (err) {
          alert('Could not read that file: ' + err.message);
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    /* demo data + clear */
    $('#demoBtn').addEventListener('click', function () {
      /* Only warn when there is something to lose. */
      if (state.all.length && !confirm('Replace the stored events with 45 days of realistic demo data?\n\nYour current events will be lost — export a backup first if you need them.')) return;
      seedDemo();
      reload();
    });
    $('#starterBtn').addEventListener('click', function () {
      seedDemo();
      reload();
    });
    $('#clearBtn').addEventListener('click', function () {
      if (!confirm('Delete every stored analytics event on this device?\n\nThis cannot be undone.')) return;
      window.AF_ANALYTICS.clear();
      reload();
    });

    /* theme */
    $('#theme').addEventListener('click', function () {
      var root = document.documentElement;
      var cur = root.getAttribute('data-theme') ||
        (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      var next = cur === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch (e) { /* private mode */ }
      renderCharts(); // chart colours are read from CSS tokens, so re-read them
    });

    /* charts are measured in pixels, so they need a re-render on resize */
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(renderCharts, 160);
    });

    /* another tab wrote an event — pick it up */
    window.addEventListener('storage', function (e) {
      if (e.key === window.AF_ANALYTICS.key) reload();
    });
  }

  function init() {
    if (!window.AF_ANALYTICS) {
      $('#scopeNote').textContent = 'assets/analytics.js did not load, so there is nothing to report on.';
      return;
    }
    wire();
    reload();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
