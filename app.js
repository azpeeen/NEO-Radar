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
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      mediaSrc:   ["'self'"],                   
      imgSrc:     ["'self'", "data:"],
    }
  }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));

app.use('/',            require('./routes/index'));
app.use('/radar',       require('./routes/radar'));
app.use('/asteroid',    require('./routes/asteroid'));
app.use('/methodology', require('./routes/methodology'));

app.use((req, res) => {
  res.status(404).send('404 — page not found');
});

app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(500).send(`500 — ${err.message}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NEO Radar → http://localhost:${PORT}`);
});