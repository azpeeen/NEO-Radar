(function heroScene() {
  const { solveKepler, keplerXY } = window.Physics;

  const canvas = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x00050d, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x00050d, 0.010);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
  camera.position.set(0, 18, 36);
  camera.lookAt(0, 0, 0);

  /* STARFIELD */
  function buildStars(count, radius) {
    const geom = new THREE.BufferGeometry();
    const pos  = new Float32Array(count * 3);
    const col  = new Float32Array(count * 3);
    const size = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const u = Math.random(), v = Math.random();
      const theta = 2 * Math.PI * u;
      const phi   = Math.acos(2 * v - 1);
      const r     = radius * (0.85 + Math.random() * 0.3);
      pos[i*3]   = r * Math.sin(phi) * Math.cos(theta);
      pos[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i*3+2] = r * Math.cos(phi);

      const variant = Math.random();
      if (variant < 0.7) {
        col[i*3]   = 0.95 + Math.random()*0.05;
        col[i*3+1] = 0.95 + Math.random()*0.05;
        col[i*3+2] = 1.0;
      } else if (variant < 0.88) {
        col[i*3]   = 0.6  + Math.random()*0.2;
        col[i*3+1] = 0.75 + Math.random()*0.15;
        col[i*3+2] = 1.0;
      } else {
        col[i*3]   = 1.0;
        col[i*3+1] = 0.85 + Math.random()*0.1;
        col[i*3+2] = 0.7  + Math.random()*0.15;
      }
      size[i] = Math.random() < 0.03 ? 2.5 + Math.random()*1.5 : 0.8 + Math.random()*1.2;
    }
    geom.setAttribute('position', new THREE.BufferAttribute(pos,  3));
    geom.setAttribute('color',    new THREE.BufferAttribute(col,  3));
    geom.setAttribute('size',     new THREE.BufferAttribute(size, 1));

    const mat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float size;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (300.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          vec2 c = gl_PointCoord - vec2(0.5);
          float d = length(c);
          float a = smoothstep(0.5, 0.1, d);
          gl_FragColor = vec4(vColor, a);
        }
      `,
      transparent: true,
      vertexColors: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    return new THREE.Points(geom, mat);
  }
  scene.add(buildStars(3800, 600));

  /* SUN */
  const sunGroup = new THREE.Group();
  scene.add(sunGroup);
  sunGroup.add(new THREE.Mesh(
    new THREE.SphereGeometry(0.8, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xfff4d6 })
  ));

  function makeGlowTex() {
    const s = 256;
    const c = document.createElement('canvas');
    c.width = s; c.height = s;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
    grad.addColorStop(0,    'rgba(255,220,150,1)');
    grad.addColorStop(0.15, 'rgba(255,180,90,0.8)');
    grad.addColorStop(0.4,  'rgba(255,140,60,0.25)');
    grad.addColorStop(1,    'rgba(255,120,40,0)');
    g.fillStyle = grad; g.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(c);
  }
  const glowTex = makeGlowTex();
  const glow1 = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false
  }));
  glow1.scale.set(7, 7, 1);
  sunGroup.add(glow1);

  const glow2 = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.5
  }));
  glow2.scale.set(14, 14, 1);
  sunGroup.add(glow2);

  sunGroup.add(new THREE.PointLight(0xfff0cc, 2.4, 300));
  scene.add(new THREE.AmbientLight(0x334466, 0.3));

  /* ORBITS */
  const SCALE = 6; // 1 AU = 6 units

  function orbitLine(a, e = 0, color = 0x5ab7ff, opacity = 0.25, segments = 256) {
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      const r = a * (1 - e*e) / (1 + e * Math.cos(t));
      pts.push(new THREE.Vector3(r * Math.cos(t), 0, r * Math.sin(t)));
    }
    return new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity })
    );
  }

  scene.add(orbitLine(1.0  * SCALE, 0.017, 0x5ab7ff, 0.35));
  scene.add(orbitLine(1.52 * SCALE, 0.093, 0x7aa8cc, 0.22));
  scene.add(orbitLine(5.2  * SCALE, 0.048, 0xc49a63, 0.18));

  /* PLANETS */
  function planet(color, size, a, e, omega0, speed) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(size, 20, 20),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.15, roughness: 0.8 })
    );
    scene.add(mesh);
    return { mesh, a: a * SCALE, e, omega: omega0, n: speed, M0: Math.random() * Math.PI * 2 };
  }
  const earth   = planet(0x6abaff, 0.26, 1.0,  0.017, 0,   2 * Math.PI / 1.0);
  const mars    = planet(0xd37a4b, 0.18, 1.52, 0.093, 0.8, 2 * Math.PI / 1.88);
  const jupiter = planet(0xc49a63, 0.7,  5.2,  0.048, 1.9, 2 * Math.PI / 11.86);
  const planets = [earth, mars, jupiter];

  /* ASTEROIDS */
  const N = 42;
  const asteroids = [];
  for (let i = 0; i < N; i++) {
    const a     = 1.0 + Math.random() * 2.0;
    const e     = 0.1 + Math.random() * 0.5;
    const omega = Math.random() * Math.PI * 2;
    const incl  = (Math.random() - 0.5) * 0.3;
    const T     = Math.pow(a, 1.5);
    asteroids.push({ a: a * SCALE, e, omega, incl, n: 2 * Math.PI / T, M0: Math.random() * Math.PI * 2, aAU: a });
  }

  const astGeom = new THREE.BufferGeometry();
  const astPos  = new Float32Array(N * 3);
  const astCol  = new Float32Array(N * 3);
  const astSize = new Float32Array(N);
  astGeom.setAttribute('position', new THREE.BufferAttribute(astPos,  3));
  astGeom.setAttribute('color',    new THREE.BufferAttribute(astCol,  3));
  astGeom.setAttribute('size',     new THREE.BufferAttribute(astSize, 1));

  const astMat = new THREE.ShaderMaterial({
    vertexShader: `
      attribute float size;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (250.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        float d = length(c);
        if (d > 0.5) discard;
        float g = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor, g);
      }
    `,
    transparent: true,
    vertexColors: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  scene.add(new THREE.Points(astGeom, astMat));

  /* Ghost trails */
  asteroids.forEach((ast, i) => {
    if (i % 6 !== 0) return;
    const segments = 96;
    const pts = [];
    for (let s = 0; s <= segments; s++) {
      const t       = (s / segments) * Math.PI * 2;
      const { E }   = solveKepler(t, ast.e, 1e-8, 15);
      const xy      = keplerXY(ast.aAU * SCALE, ast.e, ast.omega, E);
      const y       = Math.sin(t) * ast.incl * 2;
      pts.push(new THREE.Vector3(xy.x, y, xy.y));
    }
    scene.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xff8c5a, transparent: true, opacity: 0.08 })
    ));
  });

  /* Resize */
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  /* Animate */
  let t = 0;
  let last = performance.now();
  let frames = 0, lastFpsSample = last, frameMs = 0;

  function animate() {
    const now  = performance.now();
    const dt   = Math.min(0.05, (now - last) / 1000);
    last = now;
    frames++;
    const sinceSample = now - lastFpsSample;
    if (sinceSample > 500) {
      frameMs = sinceSample / frames;
      frames = 0; lastFpsSample = now;
    }

    t += dt * 0.15;

    planets.forEach(p => {
      const { E } = solveKepler(p.M0 + p.n * t, p.e);
      const xy    = keplerXY(p.a, p.e, p.omega, E);
      p.mesh.position.set(xy.x, 0, xy.y);
    });

    let iterSum = 0;
    let closestDist = 999;
    for (let i = 0; i < N; i++) {
      const ast       = asteroids[i];
      const M         = ast.M0 + ast.n * t;
      const { E, iter } = solveKepler(M, ast.e);
      iterSum += iter;
      const xy        = keplerXY(ast.a, ast.e, ast.omega, E);
      const y         = Math.sin(M) * ast.incl * 2;
      astPos[i*3]     = xy.x;
      astPos[i*3+1]   = y;
      astPos[i*3+2]   = xy.y;

      const distToEarth = Math.hypot(
        xy.x - earth.mesh.position.x,
        y    - earth.mesh.position.y,
        xy.y - earth.mesh.position.z
      ) / SCALE;
      if (distToEarth < closestDist) closestDist = distToEarth;

      const hazard    = distToEarth < 0.2 ? 1 : distToEarth < 0.5 ? 0.6 : 0;
      astCol[i*3]     = 1.0;
      astCol[i*3+1]   = 0.65 - hazard * 0.3;
      astCol[i*3+2]   = 0.35 + (1 - hazard) * 0.2;
      astSize[i]      = 1.6 + hazard * 2.5;
    }
    astGeom.attributes.position.needsUpdate = true;
    astGeom.attributes.color.needsUpdate    = true;
    astGeom.attributes.size.needsUpdate     = true;

    if (sinceSample > 500) {
      document.getElementById('hudObjs').textContent  = String(N);
      document.getElementById('hudIter').textContent  = (iterSum / N).toFixed(2);
      document.getElementById('hudClose').textContent = closestDist.toFixed(4) + ' AU';
      document.getElementById('hudFrame').textContent = frameMs.toFixed(1) + ' ms';
    }

    const camAng = t * 0.08;
    camera.position.x = Math.sin(camAng) * 36;
    camera.position.z = Math.cos(camAng) * 36;
    camera.position.y = 14 + Math.sin(t * 0.2) * 2;
    camera.lookAt(0, 0, 0);

    glow1.scale.setScalar(7 + Math.sin(t * 4) * 0.2);

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  requestAnimationFrame(() => {
    resize();
    animate();
    setTimeout(() => document.getElementById('loader').classList.add('hidden'), 400);
  });

  /* Nav scroll state */
  const nav = document.getElementById('nav');
  window.addEventListener('scroll', () => {
    if (window.scrollY > 40) nav.classList.add('scrolled');
    else nav.classList.remove('scrolled');
  });
})();
