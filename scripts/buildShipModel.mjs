// Rebuilds public/assets/models/ship_shuttle.glb, the pilot-mode ship.
//
// Not part of the app: run it by hand only if the model needs regenerating.
//   1. Get NASA's "Space Shuttle (D)" files (5 .glb) from
//      https://github.com/nasa/NASA-3D-Resources → 3D Models/Space Shuttle (D)
//      and save them in one folder with spaces and brackets replaced by "_":
//        Space_Shuttle__D_.glb            Space_Shuttle__D__eng.glb
//        Space_Shuttle__D__door-prt.glb   Space_Shuttle__D__rcs.glb
//        Space_Shuttle__D__door-stb.glb
//   2. In a scratch folder:
//        npm i @gltf-transform/core@4 @gltf-transform/extensions@4 @gltf-transform/functions@4 draco3dgltf
//        node buildShipModel.mjs <folder with the 5 files> ship_shuttle.glb
//
// Assembles the pilot-mode ship from NASA's "Space Shuttle (D)" model set
// (github.com/nasa/NASA-3D-Resources, 3D Models/Space Shuttle (D)):
//   orbiter body + payload bay doors (posed open) + 3 SSME bells + 2 OMS bells
// and rewrites it for the app's glTF loader (three r128, no Draco decoder):
// geometry uncompressed + quantized, WebP textures only, one buffer.
//
// Model frame (inches): +X nose, +Y port, +Z up. Output frame: −Z nose,
// +Y up, +X starboard (what the renderer's ship root expects).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression, KHRMaterialsSpecular } from '@gltf-transform/extensions';
import { prune, dedup, quantize, mergeDocuments, transformMesh, unpartition } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import fs from 'fs';

const [,, srcDir, dst] = process.argv;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
const D2R = Math.PI / 180;

const doc = await io.read(`${srcDir}/Space_Shuttle__D_.glb`);
const root = doc.getRoot();
for (const ext of root.listExtensionsUsed()) {
  if (ext instanceof KHRDracoMeshCompression || ext instanceof KHRMaterialsSpecular) ext.dispose();
}
for (const a of root.listAnimations()) a.dispose();   // only key the whole object's transform
const scene = root.listScenes()[0];

// A part file → its mesh, merged into `doc` and expressed in the body's frame.
// The parts reference two door textures that NASA's folder does not ship
// (external .JPG URIs): strip the references, the doors keep their flat colour.
async function part(file) {
  // Split the GLB by hand: NodeIO refuses a .glb whose images are external
  const glb = fs.readFileSync(`${srcDir}/${file}`);
  const jl = glb.readUInt32LE(12);
  const j = JSON.parse(glb.slice(20, 20 + jl).toString('utf8'));
  const bl = glb.readUInt32LE(20 + jl);
  const jd = { json: j, resources: { '@glb.bin': new Uint8Array(glb.slice(28 + jl, 28 + jl + bl)) } };
  delete j.images; delete j.textures; delete j.samplers; delete j.extensionsUsed; delete j.extensionsRequired;
  for (const m of j.materials || []) {
    delete m.extensions;
    if (m.pbrMetallicRoughness) delete m.pbrMetallicRoughness.baseColorTexture;
  }
  const pd = await io.readJSON(jd);
  const pr = pd.getRoot();
  const node = pr.listNodes().find(n => n.getMesh());
  transformMesh(node.getMesh(), node.getWorldMatrix());   // bake the 3DS Z-up root matrix
  const srcMesh = node.getMesh();
  const map = mergeDocuments(doc, pd);
  const mesh = map.get(srcMesh);
  for (const s of pr.listScenes()) map.get(s).dispose();
  for (const n of pr.listNodes()) map.get(n).dispose();
  return mesh;
}
function quatAxis(ax, ay, az, angle) {
  const s = Math.sin(angle / 2);
  return [ax * s, ay * s, az * s, Math.cos(angle / 2)];
}
function quatMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

// Everything hangs off one node that turns the model frame into the ship frame
const frame = doc.createNode('shuttle')
  .setMatrix([0, 0, -1, 0,  -1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 0, 1]);
for (const n of scene.listChildren()) { scene.removeChild(n); frame.addChild(n); }
scene.addChild(frame);

// ── Payload bay doors, open as on orbit ──
// The part files hold each door closed, in the body frame: hinge along X at
// the sill (y = ±105.5, z = 18.5), free edge at the top centreline. The real
// doors open 175.5°; 165° is used here so the free edge clearly clears the wing.
const DOOR_OPEN = 165 * D2R;
for (const [file, side] of [['Space_Shuttle__D__door-prt.glb', 1], ['Space_Shuttle__D__door-stb.glb', -1]]) {
  const mesh = await part(file);
  const hinge = doc.createNode(side > 0 ? 'door_port_hinge' : 'door_stbd_hinge')
    .setTranslation([0, side * 105.5, 18.5])
    .setRotation(quatAxis(1, 0, 0, -side * DOOR_OPEN));
  hinge.addChild(doc.createNode(side > 0 ? 'door_port' : 'door_stbd')
    .setTranslation([0, -side * 105.5, -18.5]).setMesh(mesh));
  frame.addChild(hinge);
}

// ── Engines ──
// Positions from the orbiter structural coordinates (inches): SSME gimbals at
// Yo 0 / ±53, Zo 443 / 342.64; OMS engines at Xo 1518, Yo ±88, Zo 492. Model
// x = 1002 − Xo (the OMS pod's aft face sits at x = −516 in the mesh, which
// fixes the offset) and z = Zo − 405. The SSME part is only the nozzle bell,
// so it is placed by its exit plane: level with the body flap's trailing edge.
// Null cant angles: centre SSME pitched 16° up, the lower pair 10° up and 3.5°
// outboard; OMS 15.8° up and 6.5° outboard.
const eng = await part('Space_Shuttle__D__eng.glb');
const oms = await part('Space_Shuttle__D__rcs.glb');   // NASA's "rcs" part is the OMS-sized bell
function engine(name, mesh, pos, pitchUp, yawOut, side) {
  const q = quatMul(quatAxis(0, 0, 1, -side * yawOut * D2R), quatAxis(0, 1, 0, pitchUp * D2R));
  const n = doc.createNode(name).setTranslation(pos).setRotation(q).setMesh(mesh);
  frame.addChild(n);
  return n;
}
engine('ssme_1', eng, [-513, 0, 38], 16, 0, 0);
engine('ssme_2', eng, [-513, 53, -62.4], 10, 3.5, 1);
engine('ssme_3', eng, [-513, -53, -62.4], 10, 3.5, -1);
for (const side of [1, -1]) {
  const n = engine(side > 0 ? 'oms_port' : 'oms_stbd', oms, [-517, side * 88, 87], 15.8, 6.5, side);
  // Exit-plane marker: the renderer hangs the exhaust glow on these
  n.addChild(doc.createNode(side > 0 ? 'oms_exit_port' : 'oms_exit_stbd').setTranslation([-46, 0, 0]));
}

await doc.transform(dedup(), prune({ keepLeaves: true }), unpartition(),
  quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }));

let tris = 0;
for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
  tris += (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3;
}
root.getAsset().copyright = 'Model: NASA 3D Resources, Space Shuttle (D). Assembled for NEO Radar.';
await io.write(dst, doc);
console.log('unique triangles', tris, '| materials', root.listMaterials().length, '| textures', root.listTextures().length,
  '| nodes', root.listNodes().map(n => n.getName()).join(','), '| ext', root.listExtensionsUsed().map(e => e.extensionName).join(','));
console.log('wrote', dst, (fs.statSync(dst).size / 1024).toFixed(0), 'KB');
