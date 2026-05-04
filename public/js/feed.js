(async function () {
  const grid = document.getElementById("feedGrid");
  const note = document.getElementById("feedNote");
  const fallback = [
    { name: "2024 ON",   date: "2026-05-12", dist_au: 0.0234, v_kms: 14.2,  haz: false, diam: 42   },
    { name: "2019 OD",   date: "2026-05-28", dist_au: 0.0091, v_kms: 22.7,  haz: true,  diam: 88   },
    { name: "2023 DW",   date: "2026-06-04", dist_au: 0.0453, v_kms: 9.8,   haz: false, diam: 51   },
    { name: "1994 PC1",  date: "2026-07-18", dist_au: 0.0128, v_kms: 19.3,  haz: true,  diam: 1050 },
  ];

  function render(items, src) {
    grid.innerHTML = "";
    items.forEach((it) => {
      const el = document.createElement("div");
      el.className = "feed-card";
      el.innerHTML = `
        <div class="feed-date">${it.date}</div>
        <div class="feed-name">${it.name}</div>
        <div class="feed-stats">
          <div class="feed-stat"><span class="feed-stat-label">Distance</span><span class="feed-stat-val">${it.dist_au.toFixed(4)} AU</span></div>
          <div class="feed-stat"><span class="feed-stat-label">Velocity</span><span class="feed-stat-val">${it.v_kms.toFixed(2)} km/s</span></div>
          <div class="feed-stat"><span class="feed-stat-label">Est. diameter</span><span class="feed-stat-val">${it.diam} m</span></div>
          <div class="feed-stat"><span class="feed-stat-label">Hazardous</span><span class="feed-stat-val ${it.haz ? "hazard" : ""}">${it.haz ? "YES" : "no"}</span></div>
        </div>
      `;
      grid.appendChild(el);
    });
    note.textContent = src;
  }

  try {
    const today = new Date();
    const in7   = new Date(today.getTime() + 7 * 864e5);
    const fmt   = (d) => d.toISOString().slice(0, 10);
    const url   = `https://api.nasa.gov/neo/rest/v1/feed?start_date=${fmt(today)}&end_date=${fmt(in7)}&api_key=DEMO_KEY`;
    const ctrl  = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const res  = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("http " + res.status);
    const data = await res.json();
    const flat = [];
    Object.keys(data.near_earth_objects).sort().forEach((d) => {
      data.near_earth_objects[d].forEach((neo) => {
        const ca = neo.close_approach_data[0];
        if (!ca) return;
        flat.push({
          name:    neo.name.replace(/[()]/g, ""),
          date:    ca.close_approach_date,
          dist_au: parseFloat(ca.miss_distance.astronomical),
          v_kms:   parseFloat(ca.relative_velocity.kilometers_per_second),
          haz:     neo.is_potentially_hazardous_asteroid,
          diam:    Math.round(neo.estimated_diameter.meters.estimated_diameter_max),
        });
      });
    });
    if (!flat.length) throw new Error("empty");
    flat.sort((a, b) => a.dist_au - b.dist_au);
    render(flat.slice(0, 4), "● Live · NASA NeoWs · DEMO_KEY · próximos 7 dias, 4 mais próximos");
  } catch (err) {
    render(fallback, "○ Exemplos validados · NeoWs indisponível (" + (err.message || "erro") + ")");
  }
})();
