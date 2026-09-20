# Areej Fatima — Portfolio

Personal portfolio for **Areej Fatima**, Senior Frontend Developer and Team Lead at Averlabz, Lahore.
Static site, no build step, no dependencies — plain HTML, CSS and vanilla JavaScript, deployed on GitHub Pages.

**Live site:** https://areejfatimak992.github.io/

---

## What's in here

| Path | What it is |
|---|---|
| `index.html` | The portfolio itself — hero, about, skills, work, experience, contact |
| `dashboard.html` | Private engagement dashboard and reporting (not indexed, not linked from the nav) |
| `assets/analytics.js` | The tracker: records visits and interactions into the visitor's own browser |
| `assets/dashboard.js` | Dashboard logic — aggregation, charts, CSV/JSON reporting |
| `assets/dashboard.css` | Dashboard styling and the chart colour tokens |
| `assets/cv-data.js` | The CV as base64, so the download button works even offline |
| `cv.pdf` | The CV |
| `404.html` | Branded not-found page for GitHub Pages |
| `robots.txt`, `sitemap.xml` | Search-engine directives (`dashboard.html` is disallowed) |
| `.nojekyll` | Tells GitHub Pages to serve the files as-is |

---

## The analytics dashboard

Open `dashboard.html` (or the **Site analytics** link in the footer) to see how visitors use the site.

**What it measures**

- Page views, sessions and time on page
- CV downloads and contact clicks (email, WhatsApp, copy-to-clipboard)
- Section engagement — which sections visitors actually read
- Scroll depth — 25 / 50 / 75 / 100%
- Traffic sources and device class
- Project card interactions: filters, live-system opens, repository opens

**Reporting**

- Date range: 7 / 30 / 90 days, all time, or a custom from–to
- Every chart has a **Table** toggle with the same numbers
- **CSV report** — a full multi-section report for the selected range
- **Export this table (CSV)** — the filtered event log
- **Backup JSON** / **Import** — move data between devices and merge it
- **Load demo data** — 45 days of realistic sample data, useful for showing the dashboard off

### How the data works — read this

There is **no backend**. `assets/analytics.js` writes events to `localStorage` on the visitor's own
device, and the dashboard reads that same store. The practical consequences:

- The dashboard shows **only the visits made in the browser you open it in**. It is not a
  site-wide counter — a visitor's events stay on their machine and never reach you.
- Data survives reloads but is lost if the browser's site data is cleared.
- Visitors with **Do Not Track** enabled are never recorded. `AF_ANALYTICS.optOut()` opts a
  browser out permanently.
- Nothing is sent to any server, and there is no third-party tracker.

To make it site-wide later, set `window.AF_ANALYTICS_ENDPOINT = 'https://your-api/collect'`
before `analytics.js` loads. Every event is then also POSTed there via `navigator.sendBeacon`,
while the local copy keeps working unchanged.

### Tracking something new

Add `data-track` to any element:

```html
<a href="..." data-track="newsletter_click" data-track-label="footer">Subscribe</a>
```

Or call it directly:

```js
afTrack('demo_requested', { project: 'Chips Distribution' });
```

---

## Running it locally

No build, no install. Any static server works:

```bash
python -m http.server 5173
```

Then open http://localhost:5173. Opening `index.html` straight from the filesystem also works —
the CV download falls back to the embedded copy — but `localStorage` can be restricted on
`file://`, so use a server when testing the dashboard.

---

## Deployment

GitHub Pages serves the repository root on every push to `main`. `.nojekyll` keeps Pages from
running Jekyll over the files.

---

## Accessibility and performance notes

- Skip-to-content link, visible focus rings, `aria-pressed` on every toggle
- Charts are keyboard-navigable (arrow keys move the crosshair) and each one has a table twin
- Chart colours are validated for colour-vision deficiency in both light and dark themes
- Respects `prefers-reduced-motion` and `prefers-color-scheme`
- The CV base64 lives in its own deferred file, so `index.html` stays around 47 KB
