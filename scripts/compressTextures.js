const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const TARGET_DIRS = [
  path.join(__dirname, '..', 'public', 'assets', 'textures'),
  path.join(__dirname, '..', 'public', 'assets', 'textures', 'rock'),
];

const KEEP_PNG = new Set(['saturn_ring.png', 'pix-qr.png']);

function formatMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

async function collectFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .map((f) => path.join(dir, f));
}

async function compressFile(filePath) {
  const name = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const sizeBefore = fs.statSync(filePath).size;

  const input = fs.readFileSync(filePath);
  const sharpOpts = { limitInputPixels: false };

  if (ext === '.png' && !KEEP_PNG.has(name)) {
    const buffer = await sharp(input, sharpOpts).jpeg({ quality: 75, progressive: true }).toBuffer();
    const newPath = filePath.replace(/\.png$/i, '.jpg');
    fs.writeFileSync(newPath, buffer);
    fs.unlinkSync(filePath);
    const sizeAfter = buffer.length;
    return { name, newName: path.basename(newPath), sizeBefore, sizeAfter };
  }

  if (ext === '.png') {
    const buffer = await sharp(input, sharpOpts).png({ compressionLevel: 9 }).toBuffer();
    fs.writeFileSync(filePath, buffer);
    const sizeAfter = buffer.length;
    return { name, newName: name, sizeBefore, sizeAfter };
  }

  const buffer = await sharp(input, sharpOpts).jpeg({ quality: 75, progressive: true }).toBuffer();
  fs.writeFileSync(filePath, buffer);
  const sizeAfter = buffer.length;
  return { name, newName: name, sizeBefore, sizeAfter };
}

async function main() {
  let files = [];
  for (const dir of TARGET_DIRS) {
    files = files.concat(await collectFiles(dir));
  }

  let totalBefore = 0;
  let totalAfter = 0;

  for (const filePath of files) {
    try {
      const result = await compressFile(filePath);
      totalBefore += result.sizeBefore;
      totalAfter += result.sizeAfter;
      const label = result.newName !== result.name ? `${result.name} -> ${result.newName}` : result.name;
      console.log(
        `${label}: ${formatMB(result.sizeBefore)} MB -> ${formatMB(result.sizeAfter)} MB`
      );
    } catch (err) {
      console.error(`Erro ao processar ${filePath}: ${err.message}`);
    }
  }

  console.log('---');
  console.log(`Total antes: ${formatMB(totalBefore)} MB`);
  console.log(`Total depois: ${formatMB(totalAfter)} MB`);
  console.log(`Economizado: ${formatMB(totalBefore - totalAfter)} MB`);
}

main();
