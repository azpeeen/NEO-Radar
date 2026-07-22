const fs = require('fs');
const path = require('path');

const NEO3D = 'C:/Users/jaque/Downloads/neo3d';
const MODELS = 'public/assets/models';
const TEXTURES = 'public/assets/textures';

function slugify(name) {
  return name.toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_\-]/g, '');
}

const manifest = {
  generated: new Date().toISOString(),
  asteroids: [],
  moons: [],
  dwarf_planets: [],
  comets: [],
};

const CATEGORY_MAP = {
  'asteroids':     'asteroids',
  'moons':         'moons',
  'dwarf planets': 'dwarf_planets',
  'comets':        'comets',
};

for (const [folder, category] of Object.entries(CATEGORY_MAP)) {
  const dir = path.join(NEO3D, folder);
  if (!fs.existsSync(dir)) continue;

  const files = fs.readdirSync(dir);
  const objs = files.filter(f => /\.(obj|glb|ply)$/i.test(f));
  const imgs = files.filter(f => /\.(jpg|jpeg|png)$/i.test(f));

  for (const obj of objs) {
    const ext = path.extname(obj).toLowerCase();
    const baseName = path.basename(obj, ext);
    const slug = slugify(baseName);
    const glbFile = slug + '.glb';
    const glbPath = path.join(MODELS, glbFile);

    // Verificar se GLB foi gerado
    if (!fs.existsSync(glbPath)) {
      console.log(`  ✗ GLB não encontrado: ${glbFile}`);
      continue;
    }

    // Casar textura pelo "corpo" (primeira palavra do nome original),
    // dentro da mesma pasta, preferindo variante colorida
    const body = slugify(baseName.split(/\s+/)[0]);
    const cands = imgs.filter(img => {
      const texBase = slugify(path.basename(img, path.extname(img)));
      return texBase.startsWith(body + '_') || texBase === body;
    });
    // preferir cor > enh.color > grayscale > primeira
    const pick = cands.find(c => /color/i.test(c) && !/enh/i.test(c))
              || cands.find(c => /color/i.test(c))
              || cands.find(c => /grayscale/i.test(c))
              || cands[0];

    let texture = null;
    if (pick) {
      texture = slugify(path.basename(pick, path.extname(pick))) +
                path.extname(pick).toLowerCase().replace('jpeg', 'jpg');
    }

    // Verificar se textura existe em public/assets/textures/
    const texExists = texture && fs.existsSync(path.join(TEXTURES, texture));

    manifest[category].push({
      slug,
      originalName: baseName,
      model: glbFile,
      modelPath: `/assets/models/${glbFile}`,
      texture: texExists ? texture : null,
      texturePath: texExists ? `/assets/textures/${texture}` : null,
    });
  }

  console.log(`[${category}] ${manifest[category].length} entradas`);
}

fs.writeFileSync(
  'public/assets/models/manifest.json',
  JSON.stringify(manifest, null, 2)
);

// Resumo
console.log('\n=== MANIFESTO GERADO ===');
console.log(`Asteroides:     ${manifest.asteroids.length}`);
console.log(`Luas:           ${manifest.moons.length}`);
console.log(`Planetas anões: ${manifest.dwarf_planets.length}`);
console.log(`Cometas:        ${manifest.comets.length}`);

console.log('\nLuas (modelo + textura):');
manifest.moons.forEach(m =>
  console.log(`  ${m.slug.padEnd(30)} modelo:✓  textura:${m.texture ? '✓ '+m.texture : '✗'}`)
);

console.log('\nPlanetas anões:');
manifest.dwarf_planets.forEach(m =>
  console.log(`  ${m.slug.padEnd(30)} modelo:✓  textura:${m.texture ? '✓ '+m.texture : '✗'}`)
);

console.log('\nCometas:');
manifest.comets.forEach(m =>
  console.log(`  ${m.slug.padEnd(30)} modelo:✓  textura:${m.texture ? '✓ '+m.texture : '✗'}`)
);
