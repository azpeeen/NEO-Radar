(function () {
  'use strict';

  // ---------- Threat strip ----------

  const fmtDate = (d) => {
    return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }).toUpperCase();
  };

  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  const fmtKm = (km) => {
    if (km >= 1e6) return (km / 1e6).toFixed(2) + 'M';
    return km.toLocaleString('en-US');
  };

  function buildCard(neo) {
    const now = new Date();
    const approachDate = new Date(neo.nextApproach);
    const daysUntil = Math.round((approachDate - now) / (1000 * 60 * 60 * 24));
    const desig = neo.designation !== neo.name
      ? `${neo.designation} · ${neo.group}`
      : `NEA · ${neo.group}`;

    return `
      <article class="threat-card">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom: 14px;">
          <span class="risk ${neo.riskLevel}">${capitalize(neo.riskLevel)}</span>
          <span class="date">${fmtDate(approachDate)}</span>
        </div>
        <div class="name">${neo.name}</div>
        <div class="desig">${desig}</div>
        <div class="grid">
          <div>
            <div class="k">Miss Distance</div>
            <div class="v">${neo.missDist_ld}<small>LD</small></div>
          </div>
          <div>
            <div class="k">Velocity</div>
            <div class="v">${neo.velocity_kms}<small>km/s</small></div>
          </div>
        </div>
        <div class="footer-row">
          <span class="date">${daysUntil > 0 ? 'T − ' + daysUntil + ' d' : 'T + ' + Math.abs(daysUntil) + ' d'}</span>
          <span style="font-family: var(--font-mono); font-size: 10.5px; color: var(--ink-4);">${fmtKm(neo.missDist_km)} km</span>
        </div>
      </article>
    `;
  }

  function initThreatStrip() {
    const strip = document.getElementById('threat-scroll');
    if (!strip) return;
    const neos = window.NEO_DATA || [];
    strip.innerHTML = neos.map(buildCard).join('');
  }

  // ---------- Seamless looping hero video (cross-fade between two <video>s) ----------

  function initVideoLoop() {
    const A = document.getElementById('bg-a');
    const B = document.getElementById('bg-b');
    if (!A || !B) return;

    const CROSSFADE_LEAD = 0.5;
    const FADE_MS = 600;
    let active = A;
    let buffer = B;
    let swapping = false;

    function setFront(v, isFront) {
      v.classList.toggle('front', isFront);
      v.classList.toggle('back', !isFront);
    }

    function onTimeUpdate(e) {
      const v = e.target;
      if (v !== active || swapping) return;
      if (!v.duration || !isFinite(v.duration)) return;
      if (v.duration - v.currentTime <= CROSSFADE_LEAD) {
        swapping = true;
        buffer.currentTime = 0;
        const playP = buffer.play();
        if (playP && playP.catch) playP.catch(() => {});
        setFront(buffer, true);
        setFront(active, false);
        setTimeout(() => {
          try { active.pause(); active.currentTime = 0; } catch (_) {}
          const prev = active;
          active = buffer;
          buffer = prev;
          swapping = false;
        }, FADE_MS + 50);
      }
    }

    A.addEventListener('timeupdate', onTimeUpdate);
    B.addEventListener('timeupdate', onTimeUpdate);

    const tryPlay = () => {
      const p = A.play();
      if (p && p.catch) p.catch(() => {});
    };
    if (A.readyState >= 2) tryPlay();
    else A.addEventListener('canplay', tryPlay, { once: true });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initThreatStrip();
    initVideoLoop();
  });
})();
