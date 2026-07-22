const obj2gltf = require('obj2gltf');
const fs = require('fs');
const path = require('path');

const NEO3D = 'C:/Users/jaque/Downloads/neo3d';
const MODELS_OUT = 'public/assets/models';
const TEX_OUT = 'public/assets/textures';

fs.mkdirSync(MODELS_OUT, { recursive: true });
fs.mkdirSync(TEX_OUT, { recursive: true });

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_\-]/g, '');
}

async function processDir(dir, category) {
  const files = fs.readdirSync(dir);
  const results = { models: [], textures: [], failed: [] };

  // Separar OBJs e imagens
  const objs = files.filter(f => f.toLowerCase().endsWith('.obj'));
  const imgs = files.filter(f => /\.(jpg|jpeg|png)$/i.test(f));
  const glbs = files.filter(f => f.toLowerCase().endsWith('.glb'));
  const plys = files.filter(f => f.toLowerCase().endsWith('.ply'));

  // Copiar GLBs direto
  for (const f of glbs) {
    const slug = slugify(path.basename(f, '.glb'));
    const dest = path.join(MODELS_OUT, slug + '.glb');
    fs.copyFileSync(path.join(dir, f), dest);
    results.models.push(slug + '.glb');
    console.log(`  ✓ GLB: ${slug}.glb`);
  }

  // Converter OBJs → GLB
  for (const f of objs) {
    const slug = slugify(path.basename(f, '.obj'));
    const dest = path.join(MODELS_OUT, slug + '.glb');

    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
      results.models.push(slug + '.glb (skip)');
      continue;
    }

    try {
      const glb = await obj2gltf(path.join(dir, f), { binary: true });
      fs.writeFileSync(dest, glb);
      results.models.push(slug + '.glb');
    } catch (e) {
      results.failed.push(f + ': ' + e.message);
    }
  }

  // Copiar texturas — substituir existentes
  for (const f of imgs) {
    const slug = slugify(path.basename(f, path.extname(f)));
    const ext = path.extname(f).toLowerCase().replace('jpeg', 'jpg');
    const dest = path.join(TEX_OUT, slug + ext);
    fs.copyFileSync(path.join(dir, f), dest);
    results.textures.push(slug + ext);
  }

  console.log(`\n[${category}]`);
  console.log(`  modelos: ${results.models.length}`);
  console.log(`  texturas: ${results.textures.length}`);
  if (results.failed.length) {
    console.log(`  falhas: ${results.failed.length}`);
    results.failed.forEach(e => console.log(`    ✗ ${e}`));
  }

  return results;
}

async function main() {
  const categories = [
    { dir: 'asteroids',     label: 'Asteroides'     },
    { dir: 'comets',        label: 'Cometas'        },
    { dir: 'dwarf planets', label: 'Planetas Anões' },
    { dir: 'moons',         label: 'Luas'           },
  ];

  const allModels = [];

  for (const cat of categories) {
    const fullDir = path.join(NEO3D, cat.dir);
    if (!fs.existsSync(fullDir)) {
      console.log(`\n[${cat.label}] pasta não encontrada, pulando`);
      continue;
    }
    const r = await processDir(fullDir, cat.label);
    allModels.push(...r.models);
  }

  // Listar todos os GLBs gerados
  console.log('\n=== GLBs em public/assets/models/ ===');
  const glbs = fs.readdirSync(MODELS_OUT)
    .filter(f => f.endsWith('.glb'))
    .sort();
  console.log(`Total: ${glbs.length}`);
  glbs.forEach(f => console.log(' ', f));

  console.log('\n=== Texturas em public/assets/textures/ ===');
  const texs = fs.readdirSync(TEX_OUT)
    .filter(f => /\.(jpg|png)$/.test(f))
    .sort();
  console.log(`Total: ${texs.length}`);
}

main().catch(console.error);
