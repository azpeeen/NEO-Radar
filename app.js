'use strict';

require('dotenv').config();

const express = require('express');
const path    = require('path');
const helmet  = require('helmet');

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      mediaSrc:   ["'self'"],                   
      imgSrc:     ["'self'", "data:"],
    }
  }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));

// The Three.js renderer lives in src/renderer/ (architecture rule: renderer
// code stays in the renderer layer) but is served as a classic script here.
app.get('/js/renderer3d.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'renderer', 'threejs.js'));
});

app.use('/',            require('./routes/index'));
app.use('/radar',       require('./routes/radar'));
app.use('/asteroid',    require('./routes/asteroid'));
app.use('/methodology', require('./routes/methodology'));
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