'use strict';

require('dotenv').config();

const express = require('express');
const path    = require('path');
const helmet  = require('helmet');
const compression = require('compression');

const app = express();

app.use(compression());

if (!process.env.KO_FI_TOKEN) {
  console.warn('[Ko-fi] KO_FI_TOKEN not set — webhook will reject all requests');
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      mediaSrc:   ["'self'"],
      // blob: — three.js GLTFLoader unpacks GLB-embedded textures into blob
      // URLs and reads them via fetch/createImageBitmap; without it every
      // NASA shape model silently falls back to the procedural mesh.
      connectSrc: ["'self'", "blob:"],
      imgSrc:     ["'self'", "data:", "blob:"],
    }
  }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// SEO routes — registered before express.static so they take priority over
// the (stale) public/robots.txt and public/sitemap.xml files.
app.get('/sitemap.xml', (req, res) => {
  const pages = [
    { url: '/',              changefreq: 'weekly',  priority: '1.0' },
    { url: '/radar',         changefreq: 'daily',   priority: '0.9' },
    { url: '/asteroid/99942', changefreq: 'weekly',  priority: '0.8' },
    { url: '/methodology',   changefreq: 'monthly', priority: '0.7' },
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(p => `  <url>
    <loc>https://neoradar.space${p.url}</loc>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

  res.header('Content-Type', 'application/xml');
  res.send(xml);
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(
`User-agent: *
Allow: /

Sitemap: https://neoradar.space/sitemap.xml`
  );
});

app.get('/llms.txt', (req, res) => {
  res.type('text/plain');
  res.send(
`# NEO Radar

> Real orbital mechanics engine for Near-Earth Objects.
> Built by Davi Martins, 17, from Barueri, Brazil.

## What is NEO Radar

NEO Radar is a browser-based orbital mechanics engine that
tracks 41,812 real near-Earth asteroids from the Minor
Planet Center catalog. It uses the same mathematical basis
employed by NASA to calculate orbital trajectories and
close approaches.

## Key facts

- 41,812 asteroids from the MPC catalog
- 47 high-fidelity objects with full RK4 N-body dynamics
- 20 moons, 2 dwarf planets, 5 comets
- 1,585 3D shape models
- Newton-Raphson solver for Kepler's equation (ε < 1e-12)
- Adaptive RK4 N-body integration
- Monte Carlo uncertainty propagation
- 412 km RMS validation against JPL Horizons over 50 years
- Free and open source (MIT License)

## URLs

- Live site: https://neoradar.space
- Radar: https://neoradar.space/radar
- Catalog: https://neoradar.space/asteroid/99942
- Methodology: https://neoradar.space/methodology
- GitHub: https://github.com/azpeeen/NEO-Radar

## Author

Davi Martins — full-stack developer, co-founder of Inova,
olympiad medalist (6 medals including international).
Contact: davimartins.2611@gmail.com`
  );
});

// 30-day immutable cache for static assets that never change without a new
// deploy (GLB/JPG/PNG/MP4/WOFF2) — safe for a CDN in front of this origin.
// /api/* responses never pass through here since no static file matches
// those routes, so they stay uncached by construction.
const CACHEABLE_EXT = new Set(['.glb', '.jpg', '.jpeg', '.png', '.mp4', '.woff2']);

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (CACHEABLE_EXT.has(path.extname(filePath).toLowerCase())) {
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    }
  },
}));

// The Three.js renderer lives in src/renderer/ (architecture rule: renderer
// code stays in the renderer layer) but is served as a classic script here.
app.get('/js/renderer3d.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'renderer', 'threejs.js'));
});

app.use('/',            require('./routes/index'));
app.use('/radar',       require('./routes/radar'));
app.use('/asteroid',    require('./routes/asteroid'));
app.use('/methodology', require('./routes/methodology'));
app.use('/about',       require('./routes/about'));
app.use('/api',         require('./routes/api'));

app.use((req, res) => {
  res.status(404).send('404 — page not found');
});

app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(500).send(`500 — ${err.message}`);
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`NEO Radar → http://localhost:${PORT}`);
});
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n✗ Port ${PORT} already in use. Kill the existing process first:\n  npx kill-port ${PORT}\n`);
    process.exit(1);
  } else {
    throw err;
  }
});

// Non-blocking MPC asteroid seed (runs after server is ready)
require('./src/data/seedMPC')().catch(e => console.warn('[MPC] Seed error:', e.message));