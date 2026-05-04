(function cards() {
  function setupCv(cv) {
    const dpr = window.devicePixelRatio || 1;
    const r   = cv.getBoundingClientRect();
    cv.width  = r.width  * dpr;
    cv.height = r.height * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx, w: r.width, h: r.height };
  }

  /* 01 — Accuracy residual plot */
  (function () {
    const cv = document.getElementById('vizAccuracy');
    const { ctx, w, h } = setupCv(cv);
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(120,160,210,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(28, h - 22); ctx.lineTo(w - 12, h - 22);
    ctx.moveTo(28, 14);     ctx.lineTo(28, h - 22);
    ctx.stroke();

    ctx.strokeStyle = '#5ab7ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(28, h / 2); ctx.lineTo(w - 12, h / 2);
    ctx.stroke();

    ctx.strokeStyle = '#ff8c5a';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let x = 28; x <= w - 12; x++) {
      const t = (x - 28) / (w - 40);
      const y = h / 2 + (Math.sin(t * 8 + 1.3) * 1.5 + Math.sin(t * 21) * 0.8) * (0.3 + t * 2);
      if (x === 28) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = '#4f5a6e';
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.fillText('Δr (AU)', 4, 18);
    ctx.fillText('t (yr)', w - 36, h - 6);
    ctx.fillStyle = '#5ab7ff'; ctx.fillText('JPL',  w - 62, h / 2 - 6);
    ctx.fillStyle = '#ff8c5a'; ctx.fillText('OURS', w - 38, h / 2 + 18);
  })();

  /* 02 — Uncertainty cone */
  (function () {
    const cv = document.getElementById('vizCone');
    const { ctx, w, h } = setupCv(cv);
    ctx.clearRect(0, 0, w, h);

    const cy = h / 2;
    ctx.fillStyle = 'rgba(255,140,90,0.18)';
    ctx.beginPath();
    for (let x = 0; x <= w; x++) {
      const t = x / w;
      const y = cy + Math.sin(t * Math.PI * 1.6) * 18;
      ctx.lineTo(x, y - t * t * 30);
    }
    for (let x = w; x >= 0; x--) {
      const t = x / w;
      const y = cy + Math.sin(t * Math.PI * 1.6) * 18;
      ctx.lineTo(x, y + t * t * 30);
    }
    ctx.closePath(); ctx.fill();

    ctx.strokeStyle = '#5ab7ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x <= w; x++) {
      const t = x / w;
      const y = cy + Math.sin(t * Math.PI * 1.6) * 18;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,140,90,0.85)';
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.fillText('↑ Jupiter flyby', w - 90, 16);
    ctx.fillStyle = '#7a8699';
    ctx.fillText('3σ cone', 8, h - 10);
  })();

  /* 03 — Jupiter perturbation vectors (animated) */
  (function () {
    const cv = document.getElementById('vizJupiter');
    const { ctx, w, h } = setupCv(cv);
    let phase = 0;

    function draw() {
      ctx.clearRect(0, 0, w, h);
      phase += 0.012;

      const cy = h / 2;
      const sunX = 30, jupX = w - 34;

      ctx.fillStyle = '#ffd27a';
      ctx.beginPath(); ctx.arc(sunX, cy, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#c49a63';
      ctx.beginPath(); ctx.arc(jupX, cy, 6, 0, Math.PI * 2); ctx.fill();

      ctx.strokeStyle = 'rgba(90,183,255,0.6)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let x = 30; x <= w - 30; x++) {
        const y = cy + Math.sin(x * 0.03 + phase) * 14;
        if (x === 30) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      const aX  = 60 + (Math.sin(phase) * 0.5 + 0.5) * (w - 90);
      const aY  = cy + Math.sin(aX * 0.03 + phase) * 14;
      ctx.fillStyle = '#5ab7ff';
      ctx.beginPath(); ctx.arc(aX, aY, 3, 0, Math.PI * 2); ctx.fill();

      const dx   = jupX - aX, dy = cy - aY, d = Math.hypot(dx, dy);
      const vLen = Math.min(28, 350 / d);
      const vx   = (dx / d) * vLen, vy = (dy / d) * vLen;
      ctx.strokeStyle = '#ff8c5a';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(aX, aY); ctx.lineTo(aX + vx, aY + vy); ctx.stroke();

      const ang = Math.atan2(vy, vx);
      ctx.fillStyle = '#ff8c5a';
      ctx.beginPath();
      ctx.moveTo(aX + vx, aY + vy);
      ctx.lineTo(aX + vx - 5 * Math.cos(ang - 0.4), aY + vy - 5 * Math.sin(ang - 0.4));
      ctx.lineTo(aX + vx - 5 * Math.cos(ang + 0.4), aY + vy - 5 * Math.sin(ang + 0.4));
      ctx.closePath(); ctx.fill();

      ctx.fillStyle = '#7a8699';
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.fillText('☉', sunX - 3, cy + 18);
      ctx.fillText('♃', jupX - 4, cy + 22);
      ctx.fillStyle = '#ff8c5a';
      ctx.fillText('a_pert', aX + vx + 4, aY + vy + 3);

      requestAnimationFrame(draw);
    }
    draw();
  })();

  /* 04 — State vector flow diagram (animated) */
  (function () {
    const cv = document.getElementById('vizFlow');
    const { ctx, w, h } = setupCv(cv);

    const nodes = [
      { x: 0.5, y: 0.1,  label: 'JPL Horizons',  tag: 'DATA' },
      { x: 0.5, y: 0.3,  label: 'Initial state',  tag: 'r, v, Σ' },
      { x: 0.2, y: 0.55, label: 'Kepler solve',   tag: 'FAST' },
      { x: 0.8, y: 0.55, label: 'RK4 N-body',     tag: 'SLOW' },
      { x: 0.5, y: 0.82, label: 'Propagated',     tag: 'r(t), σ(t)' },
    ];
    const edges = [[0, 1], [1, 2], [1, 3], [2, 4], [3, 4]];
    let phase = 0;

    function rr(x, y, w2, h2, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w2, y,      x + w2, y + h2, r);
      ctx.arcTo(x + w2, y + h2, x,      y + h2, r);
      ctx.arcTo(x,      y + h2, x,      y,      r);
      ctx.arcTo(x,      y,      x + w2, y,      r);
      ctx.closePath();
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      phase += 0.014;

      edges.forEach(([a, b], i) => {
        const n1 = nodes[a], n2 = nodes[b];
        const x1 = n1.x * w, y1 = n1.y * h;
        const x2 = n2.x * w, y2 = n2.y * h;

        ctx.strokeStyle = 'rgba(120,160,210,0.14)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

        const t  = (phase + i * 0.3) % 1;
        const px = x1 + (x2 - x1) * t;
        const py = y1 + (y2 - y1) * t;
        ctx.fillStyle = '#5ab7ff';
        ctx.beginPath(); ctx.arc(px, py, 1.8, 0, Math.PI * 2); ctx.fill();
      });

      nodes.forEach((n, i) => {
        const x     = n.x * w, y = n.y * h;
        const color = i === 2 ? '#5ab7ff' : (i === 3 ? '#ff8c5a' : 'rgba(120,160,210,0.3)');

        ctx.fillStyle   = 'rgba(8,18,32,0.9)';
        ctx.strokeStyle = color;
        ctx.lineWidth   = 1.2;
        rr(x - 54, y - 15, 108, 30, 3);
        ctx.fill(); ctx.stroke();

        ctx.fillStyle  = '#ffffff';
        ctx.font       = '500 11px Archivo, sans-serif';
        ctx.textAlign  = 'center';
        ctx.fillText(n.label, x, y - 1);

        ctx.fillStyle = i === 2 ? '#5ab7ff' : (i === 3 ? '#ff8c5a' : '#4f5a6e');
        ctx.font      = '8px JetBrains Mono, monospace';
        ctx.fillText(n.tag, x, y + 10);
      });

      requestAnimationFrame(draw);
    }
    draw();
  })();
})();
