import * as THREE from 'three';
import { CONST } from '@carlquest/shared';

/**
 * Small-stadium world (visual overhaul). Everything procedural: canvas textures
 * only, no asset files, no shadow maps (software-rasteriser friendly).
 *
 * Triangle budget, measured (Task-2 review numbers, renderer.info):
 *   ground plane                        2
 *   sky dome (16×12 sphere)           352
 *   terraced stands (instanced)     2 112  (176 boxes × 12)
 *   crowd (instanced cones)        45 000  (3 000 × 15)
 *   hoardings (merged quads)           88
 *   posts                             128
 *   flags                               8
 *   floodlight masts                   96
 *   lamp heads                          8
 *   ------------------------------------------
 *   total                          47 794  — leaves headroom for the character
 *   models added by RenderModule (whole scene target ≤ ~75k with ~11 figures).
 */

/** Deterministic local LCG — client visuals only (do NOT import the server rng). */
function createLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function make2dContext(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  return ctx;
}

/** Shortest angular distance between two angles (radians). */
function angDist(a: number, b: number): number {
  const d = Math.abs(((a - b + Math.PI) % (2 * Math.PI)) - Math.PI);
  return d;
}

/** Builds the static match scene: stadium bowl, pitch, posts, lights, camera. */
export function createScene(canvas: HTMLCanvasElement) {
  const scene = new THREE.Scene();

  const { FIELD } = CONST;
  const zone = FIELD.LEGAL_ZONE;
  const halfW = (zone.maxX - zone.minX) / 2;
  const halfD = (zone.maxZ - zone.minZ) / 2;
  const CX = (zone.minX + zone.maxX) / 2;
  const CZ = (zone.minZ + zone.maxZ) / 2;
  const rand = createLcg(0xca71);

  // Warm late-afternoon atmosphere: gradient sky dome + gentle haze.
  scene.background = new THREE.Color(0xe9cba4);
  scene.fog = new THREE.Fog(0xe9cba4, 50, 150);

  // ---------------------------------------------------------------- sky dome
  // Procedural equirectangular sky (one canvas, mapped onto a large inverted
  // sphere) so it reads correctly from every orbit angle within the camera's
  // polar clamp (10°-80° elevation): graded horizon, a sun disc + glow low
  // in the +z direction (matching the DirectionalLight below), and a field
  // of soft scattered clouds banding the upper sky. u wraps azimuth (0..2π),
  // v runs zenith(0)->horizon(~0.72)->nadir(1), so there is no seam at the
  // vertical poles (top/bottom are flat colour fills, never visited within
  // the polar clamp) and the horizontal wrap tiles seamlessly (drawn with
  // wrapped x sampling, see the cloud loop below).
  {
    const W = 1024;
    const H = 512;
    const ctx = make2dContext(W, H);
    const skyRand = createLcg(0x50cb);

    // Vertical gradient: zenith blue -> warm band -> horizon gold -> ground haze.
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0.0, '#5f86b8'); // zenith — fading blue
    grad.addColorStop(0.42, '#9db2c4');
    grad.addColorStop(0.58, '#c9b18f');
    grad.addColorStop(0.68, '#f0c98c'); // warm band above the horizon
    grad.addColorStop(0.74, '#f6dcae'); // horizon gold
    grad.addColorStop(0.82, '#e9cba4'); // below-horizon haze (matches fog colour)
    grad.addColorStop(1.0, '#dcb98f');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Sun disc + glow. The DirectionalLight below sits at (25,30,-18), i.e.
    // towards +x/-z; the sphere's default UV mapping puts +x at u≈0 (and
    // u≈1, the seam), -z at u≈0.75, so u≈0.85 (between them, biased towards
    // -z) places the painted sun roughly under the actual light direction
    // without needing to rotate the mesh afterwards.
    const sunU = 0.85;
    const sunV = 0.66;
    const sunX = sunU * W;
    const sunY = sunV * H;
    {
      const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 170);
      glow.addColorStop(0.0, 'rgba(255,244,214,0.95)');
      glow.addColorStop(0.15, 'rgba(255,230,180,0.55)');
      glow.addColorStop(0.5, 'rgba(255,214,150,0.18)');
      glow.addColorStop(1.0, 'rgba(255,214,150,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(sunX - 170, sunY - 170, 340, 340);
      ctx.beginPath();
      ctx.fillStyle = '#fff8e6';
      ctx.arc(sunX, sunY, 34, 0, Math.PI * 2);
      ctx.fill();
    }

    // Scattered soft clouds: elongated radial-gradient blobs, wrapped across
    // the u seam (drawn up to three times, offset by ±W) so panning all the
    // way round shows no discontinuity.
    const cloudBands = [
      { vMin: 0.08, vMax: 0.22, n: 10, r: 70 },
      { vMin: 0.24, vMax: 0.4, n: 14, r: 55 },
      { vMin: 0.42, vMax: 0.56, n: 10, r: 40 },
    ];
    for (const band of cloudBands) {
      for (let i = 0; i < band.n; i++) {
        const u = skyRand();
        const v = band.vMin + skyRand() * (band.vMax - band.vMin);
        const cx = u * W;
        const cy = v * H;
        const rx = band.r * (0.6 + skyRand() * 0.8);
        const ry = rx * (0.32 + skyRand() * 0.18);
        const alpha = 0.16 + skyRand() * 0.22;
        for (const dx of [-W, 0, W]) {
          const g = ctx.createRadialGradient(cx + dx, cy, 0, cx + dx, cy, rx);
          g.addColorStop(0.0, `rgba(255,250,240,${alpha})`);
          g.addColorStop(0.7, `rgba(255,250,240,${alpha * 0.4})`);
          g.addColorStop(1.0, 'rgba(255,250,240,0)');
          ctx.save();
          ctx.translate(cx + dx, cy);
          ctx.scale(1, ry / rx);
          ctx.translate(-(cx + dx), -cy);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(cx + dx, cy, rx, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    }

    const skyTex = new THREE.CanvasTexture(ctx.canvas);
    skyTex.colorSpace = THREE.SRGBColorSpace;
    skyTex.wrapS = THREE.RepeatWrapping;
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(300, 48, 32),
      new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false }),
    );
    sky.position.set(CX, 0, CZ);
    scene.add(sky);
  }

  // -------------------------------------------------- grass + chalk markings
  // One canvas maps the whole 80×80 m ground; mow stripes run along the
  // bowling direction (+z) and every chalk marking is drawn from CONST.FIELD.
  {
    const S = 2048;
    const G = FIELD.GROUND_HALF_EXTENT; // 40
    const px = (x: number): number => ((x + G) / (2 * G)) * S;
    const pz = (z: number): number => ((z + G) / (2 * G)) * S;
    const m = S / (2 * G); // canvas px per metre

    const ctx = make2dContext(S, S);

    // Two-tone mow stripes, ~2 m wide, aligned with batting→bowling (+z).
    const stripeW = 2 * m;
    for (let i = 0; i * stripeW < S; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#4e8340' : '#447437';
      ctx.fillRect(i * stripeW, 0, stripeW + 1, S);
    }
    // Subtle grass noise speckle.
    for (let i = 0; i < 14000; i++) {
      const shade = rand();
      ctx.fillStyle = shade < 0.5 ? 'rgba(30,60,25,0.10)' : 'rgba(190,215,150,0.08)';
      ctx.fillRect(rand() * S, rand() * S, 1 + rand() * 3, 1 + rand() * 3);
    }

    // Chalk style.
    ctx.strokeStyle = 'rgba(246,242,230,0.92)';
    ctx.lineWidth = 0.14 * m;
    ctx.lineCap = 'round';

    // Batting and bowling squares.
    for (const { pos, size } of [
      { pos: FIELD.BATTING_SQUARE, size: FIELD.BATTING_SQUARE_SIZE },
      { pos: FIELD.BOWLING_SQUARE, size: FIELD.BOWLING_SQUARE_SIZE },
    ]) {
      const half = size / 2;
      ctx.strokeRect(px(pos.x - half), pz(pos.z - half), size * m, size * m);
    }

    // Running arcs: batting square → post 1 → 2 → 3 → 4, each a quarter-ish
    // arc bowed outward from the ring centroid.
    const chain = [FIELD.BATTING_SQUARE, ...FIELD.POSTS];
    const cenX = chain.reduce((a, p) => a + p.x, 0) / chain.length;
    const cenZ = chain.reduce((a, p) => a + p.z, 0) / chain.length;
    ctx.setLineDash([0.5 * m, 0.4 * m]);
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      if (a === undefined || b === undefined) continue;
      const midX = (a.x + b.x) / 2;
      const midZ = (a.z + b.z) / 2;
      const bow = 0.28;
      const cx = midX + (midX - cenX) * bow;
      const cz = midZ + (midZ - cenZ) * bow;
      ctx.beginPath();
      ctx.moveTo(px(a.x), pz(a.z));
      ctx.quadraticCurveTo(px(cx), pz(cz), px(b.x), pz(b.z));
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Boundary ring at the LEGAL_ZONE edge (rounded rectangle).
    {
      const r = 3 * m;
      const x0 = px(zone.minX);
      const x1 = px(zone.maxX);
      const y0 = pz(zone.minZ);
      const y1 = pz(zone.maxZ);
      ctx.beginPath();
      ctx.moveTo(x0 + r, y0);
      ctx.arcTo(x1, y0, x1, y1, r);
      ctx.arcTo(x1, y1, x0, y1, r);
      ctx.arcTo(x0, y1, x0, y0, r);
      ctx.arcTo(x0, y0, x1, y0, r);
      ctx.closePath();
      ctx.stroke();
    }

    const grassTex = new THREE.CanvasTexture(ctx.canvas);
    grassTex.colorSpace = THREE.SRGBColorSpace;
    grassTex.anisotropy = 4;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(G * 2, G * 2),
      new THREE.MeshLambertMaterial({ map: grassTex }),
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
  }

  // ------------------------------------------------------------------ posts
  // Exact CONST positions; slightly thicker pole + a two-tri pennant flag.
  {
    const postGeo = new THREE.CylinderGeometry(0.06, 0.09, FIELD.POST_HEIGHT, 8);
    const postMat = new THREE.MeshLambertMaterial({ color: 0xece5d6 });
    const flagMat = new THREE.MeshBasicMaterial({ color: 0xd8a531, side: THREE.DoubleSide });
    const h = FIELD.POST_HEIGHT;
    const flagGeo = new THREE.BufferGeometry();
    // Tapered pennant: two triangles off the pole top.
    flagGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [0, h, 0, 0.55, h - 0.04, 0, 0.55, h - 0.18, 0, 0, h, 0, 0.55, h - 0.18, 0, 0, h - 0.22, 0],
        3,
      ),
    );
    flagGeo.computeVertexNormals();
    for (const post of FIELD.POSTS) {
      const pole = new THREE.Mesh(postGeo, postMat);
      pole.position.set(post.x, h / 2, post.z);
      scene.add(pole);
      const flag = new THREE.Mesh(flagGeo, flagMat);
      flag.position.set(post.x, 0, post.z);
      flag.rotation.y = rand() * Math.PI * 2;
      scene.add(flag);
    }
  }

  // ----------------------------------------------------- stadium bowl layout
  // Oval ring outside LEGAL_ZONE with a gap behind the batting end (z < 0).
  const gapCentre = -Math.PI / 2; // batting end direction from field centre
  const gapHalf = 0.62;
  const SEGS = 56;
  const STEPS = 4;
  const stepDepth = 1.4;
  const stepRise = 0.8;
  const standRx0 = halfW + 11; // 31 — clears the zone corners on the oval
  const standRz0 = halfD + 10; // 29
  const keptSegs: number[] = [];
  for (let i = 0; i < SEGS; i++) {
    const th = (i + 0.5) * ((2 * Math.PI) / SEGS) - Math.PI;
    if (angDist(th, gapCentre) > gapHalf) keptSegs.push(i);
  }
  const segAngle = (i: number): number => (i + 0.5) * ((2 * Math.PI) / SEGS) - Math.PI;
  const oval = (rx: number, rz: number, th: number): { x: number; z: number } => ({
    x: CX + rx * Math.cos(th),
    z: CZ + rz * Math.sin(th),
  });

  // ------------------------------------------------------- terraced stands
  {
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const standMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const stands = new THREE.InstancedMesh(boxGeo, standMat, keptSegs.length * STEPS);
    const dummy = new THREE.Object3D();
    const concrete = [0x9d968b, 0x948d82, 0xa39c90, 0x8b857b];
    const tone = new THREE.Color();
    let idx = 0;
    for (const i of keptSegs) {
      const th = segAngle(i);
      const dth = (2 * Math.PI) / SEGS;
      for (let k = 0; k < STEPS; k++) {
        const rx = standRx0 + k * stepDepth;
        const rz = standRz0 + k * stepDepth;
        const p = oval(rx, rz, th);
        const width =
          dth * Math.hypot(rx * Math.sin(th), rz * Math.cos(th)) * 1.08;
        const hk = stepRise * (k + 1);
        dummy.position.set(p.x, hk / 2, p.z);
        dummy.lookAt(CX, hk / 2, CZ);
        dummy.scale.set(width, hk, stepDepth);
        dummy.updateMatrix();
        stands.setMatrixAt(idx, dummy.matrix);
        tone.setHex(concrete[k % concrete.length] ?? 0x9d968b);
        stands.setColorAt(idx, tone);
        idx++;
      }
    }
    scene.add(stands);
  }

  // ------------------------------------------------------------------ crowd
  // ONE InstancedMesh of low-poly cones (10 tris each), 3 000 instances,
  // deterministic seeded placement, per-instance colour speckle.
  {
    const CROWD = 3000;
    const blobGeo = new THREE.ConeGeometry(0.3, 0.8, 5);
    const blobMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const crowd = new THREE.InstancedMesh(blobGeo, blobMat, CROWD);
    const palette = [
      0xc94f4f, 0xe0b84f, 0x4f6fc9, 0x4fa06a, 0xe8e0d0, 0x8a5fc9, 0xd97f3f, 0x3f3f46, 0xc9c2b4,
      0x6fb9c9, 0xb85f7f, 0x746a5c,
    ];
    const dummy = new THREE.Object3D();
    const tint = new THREE.Color();
    let placed = 0;
    while (placed < CROWD) {
      const th = rand() * Math.PI * 2 - Math.PI;
      if (angDist(th, gapCentre) <= gapHalf + 0.05) continue;
      const k = Math.floor(rand() * STEPS);
      const rx = standRx0 + k * stepDepth + (rand() - 0.5) * 0.7;
      const rz = standRz0 + k * stepDepth + (rand() - 0.5) * 0.7;
      const p = oval(rx, rz, th);
      const s = 0.8 + rand() * 0.5;
      dummy.position.set(p.x, stepRise * (k + 1) + 0.28 * s, p.z);
      dummy.scale.set(s, s, s);
      dummy.rotation.y = rand() * Math.PI * 2;
      dummy.updateMatrix();
      crowd.setMatrixAt(placed, dummy.matrix);
      tint.setHex(palette[Math.floor(rand() * palette.length)] ?? 0xc9c2b4);
      crowd.setColorAt(placed, tint);
      placed++;
    }
    scene.add(crowd);
  }

  // ------------------------------------------------------------- hoardings
  // One merged geometry of quads on an oval between the boundary and the
  // stands, textured from a single in-fiction signage atlas canvas.
  {
    const SLOTS = 8;
    const signs = [
      'CARL QUEST SPORTS',
      'THE WHALE STANDS FIRM',
      "RICY'S ALL-ROUNDER ACADEMY",
      "JOEL'S CANNON ARM GYMNASIUM",
      'FRESH HALF-ROUNDERS DAILY',
      "DARCY'S AMBIDEXTROUS OUTFITTERS",
      'PROPER ROUNDERS SINCE TEATIME',
      'MIND THE BACKSTOP',
    ];
    const styles: readonly { bg: string; fg: string }[] = [
      { bg: '#1e2a4a', fg: '#f0e3c0' },
      { bg: '#5a1f24', fg: '#f0e3c0' },
      { bg: '#efe6cf', fg: '#22304f' },
      { bg: '#2c4a33', fg: '#efe6cf' },
    ];
    const slotW = 256;
    const slotH = 128;
    const ctx = make2dContext(slotW * SLOTS, slotH);
    for (let i = 0; i < SLOTS; i++) {
      const st = styles[i % styles.length] ?? { bg: '#1e2a4a', fg: '#f0e3c0' };
      ctx.fillStyle = st.bg;
      ctx.fillRect(i * slotW, 0, slotW, slotH);
      ctx.strokeStyle = st.fg;
      ctx.lineWidth = 3;
      ctx.strokeRect(i * slotW + 5, 5, slotW - 10, slotH - 10);
      ctx.fillStyle = st.fg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const text = signs[i] ?? 'CARL QUEST SPORTS';
      let size = 30;
      ctx.font = `bold ${size}px Georgia, serif`;
      while (ctx.measureText(text).width > slotW - 26 && size > 10) {
        size -= 1;
        ctx.font = `bold ${size}px Georgia, serif`;
      }
      ctx.fillText(text, i * slotW + slotW / 2, slotH / 2 + 2);
    }
    const atlas = new THREE.CanvasTexture(ctx.canvas);
    atlas.colorSpace = THREE.SRGBColorSpace;
    atlas.anisotropy = 4;

    const boardRx = halfW + 9; // 29 — oval still contains the zone corners
    const boardRz = halfD + 8; // 27
    const boardH = 0.9;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    let v = 0;
    for (const i of keptSegs) {
      const dth = (2 * Math.PI) / SEGS;
      const th0 = segAngle(i) - dth / 2;
      const th1 = segAngle(i) + dth / 2;
      const a = oval(boardRx, boardRz, th0);
      const b = oval(boardRx, boardRz, th1);
      const slot = i % SLOTS;
      const u0 = slot / SLOTS;
      const u1 = (slot + 1) / SLOTS;
      positions.push(a.x, 0, a.z, b.x, 0, b.z, b.x, boardH, b.z, a.x, boardH, a.z);
      uvs.push(u0, 0, u1, 0, u1, 1, u0, 1);
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
      v += 4;
    }
    const boardGeo = new THREE.BufferGeometry();
    boardGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    boardGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    boardGeo.setIndex(indices);
    boardGeo.computeVertexNormals();
    const boards = new THREE.Mesh(
      boardGeo,
      new THREE.MeshLambertMaterial({ map: atlas, side: THREE.DoubleSide }),
    );
    scene.add(boards);
  }

  // ---------------------------------------------------- floodlight pylons
  // Four corner masts with emissive-look lamp panels (textures, no lights).
  {
    // Mast height chosen so the lamp heads sit INSIDE the fixed camera's
    // frustum (~13 m visible at the far pylons) — taller masts render headless.
    const mastGeo = new THREE.CylinderGeometry(0.35, 0.5, 12, 6);
    const mastMat = new THREE.MeshLambertMaterial({ color: 0x707880 });
    const lampCtx = make2dContext(128, 96);
    lampCtx.fillStyle = '#2a2e33';
    lampCtx.fillRect(0, 0, 128, 96);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        lampCtx.fillStyle = '#fff3cf';
        lampCtx.fillRect(8 + c * 30, 8 + r * 30, 22, 22);
      }
    }
    const lampTex = new THREE.CanvasTexture(lampCtx.canvas);
    lampTex.colorSpace = THREE.SRGBColorSpace;
    const headMat = new THREE.MeshBasicMaterial({ map: lampTex });
    const headGeo = new THREE.PlaneGeometry(2.8, 2.0);
    for (const th of [Math.PI / 4, (3 * Math.PI) / 4, (-3 * Math.PI) / 4, -Math.PI / 4]) {
      const p = oval(standRx0 + 4.5, standRz0 + 4.5, th);
      const pylon = new THREE.Group();
      pylon.position.set(p.x, 0, p.z);
      pylon.lookAt(CX, 0, CZ);
      const mast = new THREE.Mesh(mastGeo, mastMat);
      mast.position.y = 6;
      pylon.add(mast);
      const head = new THREE.Mesh(headGeo, headMat);
      head.position.set(0, 12.4, 0.5);
      head.rotation.x = -0.35; // tilt down towards the field
      pylon.add(head);
      scene.add(pylon);
    }
  }

  // ----------------------------------------------------------------- lights
  scene.add(new THREE.HemisphereLight(0xffe3b8, 0x4a6b3a, 0.9));
  const sun = new THREE.DirectionalLight(0xffd9a8, 1.15);
  sun.position.set(25, 30, -18);
  scene.add(sun);

  // Camera: behind the batter, looking across the field
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 500);
  camera.position.set(0, 12, -14);
  camera.lookAt(new THREE.Vector3(2, 0, 10));

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });

  function resize(): void {
    const { clientWidth, clientHeight } = canvas;
    renderer.setSize(clientWidth, clientHeight, false);
    renderer.setPixelRatio(window.devicePixelRatio);
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
  }

  function start(): void {
    resize();
    window.addEventListener('resize', resize);
    renderer.setAnimationLoop(() => renderer.render(scene, camera));
  }

  return { scene, camera, renderer, start };
}
