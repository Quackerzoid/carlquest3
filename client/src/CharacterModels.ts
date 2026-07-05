/**
 * CharacterModels — minimal-mascot rigs for the roster (readable-game overhaul, Task 3).
 *
 * GROUND-UP REWORK (replaces the limbed low-poly humanoid rigs): every figure is now ONE
 * rounded body-head blob mesh (a lathe-revolved bean/egg profile — a single geometry, not a
 * head+neck+torso+pelvis assembly) plus two FLOATING SPHERE HANDS beside it (no arms — a
 * deliberate simplification the user asked for by name). There are NO LEGS: the mascot bobs
 * and waddles to move (that motion is wired in Task 4; this file only builds the pose surface
 * animation needs). Every character is skinned by a SELF-PAINTED canvas texture (deterministic
 * HTML canvas drawing, no image assets, no rng) carrying the face, the kit colour + trim + a
 * big painted squad number, and most personality "tells" — only ≤2 extra small meshes per
 * character are used where paint genuinely can't sell a tell (a brim disc, a headband torus).
 *
 * Per-character look table (hand-tuned, stats/ability-informed):
 * | # | id     | blob shape                          | painted face personality      | tell (painted unless noted)          |
 * |---|--------|--------------------------------------|--------------------------------|---------------------------------------|
 * | 1 | carl   | tall, upright egg, broad shoulders   | confident half-smile, level brows | gold captain's armband stripe painted around the blob |
 * | 2 | kian   | narrow, slightly forward-leaning egg | sly narrow-eyed smirk          | tweed flat-cap brim (EXTRA mesh disc) |
 * | 3 | laurie | tall, slim, elongated bean           | wide alert eyes, keen grin      | blond quiff painted as a hairline flick + tuft (EXTRA small mesh) |
 * | 4 | josh   | lean, athletic bean                 | sharp focused eyes, tight grin | cream keeper's gloves — HAND spheres painted/coloured, not the blob |
 * | 5 | joel   | barrel-round, wide egg              | broad steady grin, thick brows | rolled-sleeve cuff rings painted at the hand cuffs |
 * | 6 | darcy  | perfectly symmetric round egg       | calm even gaze, neutral mouth  | two trim wristband stripes painted around each hand |
 * | 7 | jonty  | squat, very wide egg (flattened)    | stoic flat mouth, unmoving brows | white headband torus (EXTRA mesh) over painted curls |
 * | 8 | robbie | heavy-set, thick egg                | firm set jaw, small determined eyes | oversized painted hand spheres (scaled up, not extra geometry) |
 * | 9 | joe    | tiny, narrow bean                   | worried wide eyes, wobbly frown | oversized painted shirt collar/hem band near the top of the blob |
 * | 10| ricy   | tidy, medium athletic egg            | easy relaxed grin, soft brows  | trim waistband stripe painted low on the blob |
 * | 11| whale  | huge, near-spherical blob            | gentle half-closed eyes, soft smile | blue-grey skin tone (no extra geometry — paint + scale sell "gentle giant") |
 *
 * Facing convention: the painted face sits on the +z hemisphere of the blob (eyes/brows/mouth
 * all point +z); callers rotate `group` to aim it, matching the old rig's convention exactly.
 * All dimensions are metres at field scale.
 *
 * Pure construction only — no per-frame logic (animation is wired in Task 4). `pose` is
 * deliberately reduced to `{ body, leftHand, rightHand }` — Task 4 rebuilds RenderModule's
 * consumer of the old `{leftArm,rightArm,leftLeg,rightLeg,torso}` surface against this.
 */
import * as THREE from 'three';
import type { Character } from '@carlquest/shared';

export type KitId = 'A' | 'B' | 'neutral';

/**
 * Kit body palettes for the incoming BOLD ARCADE-POP UI: brighter, more saturated navy and
 * maroon than the retired parchment-era pairing, still readably "team navy vs team maroon"
 * against light arcade backgrounds. Shared bright cream trim. Neutral (pre-draft) is a
 * warm mid-grey kit. Exported names/keys stable for Task 4 + the UI restyle.
 */
export const KIT_COLOURS: Record<KitId, { shirt: number; trim: number }> = {
  A: { shirt: 0x1e4fd8, trim: 0xfff4d6 },
  B: { shirt: 0xd83a3a, trim: 0xfff4d6 },
  neutral: { shirt: 0x8a8f9a, trim: 0xe8e4d8 },
};

export interface CharacterModel {
  group: THREE.Group; // position/rotate THIS; internal parts are relative
  pose: {
    /** The whole blob — bob (position.y) and lean/waddle (rotation) pivot here. */
    body: THREE.Group;
    /** Floating hand spheres either side of the body — orbit/bob them for wind-up/carry. */
    leftHand: THREE.Group;
    rightHand: THREE.Group;
  };
  /** Feet ring for status cues; hidden by default. Set .visible and .material colour. */
  ring: THREE.Mesh;
  /** In-hand ball prop (parented to the right hand); hidden unless the character holds the ball. */
  ball: THREE.Mesh;
  /**
   * Rounders bat prop (parented to the right hand, alongside `ball`); hidden by default —
   * fielders never show it. The batter view (RenderModule Task 4) reveals it for whoever
   * is currently batting.
   */
  bat: THREE.Mesh;
  /** Approximate standing height in metres (whale ≈ 3.1, joe ≈ 1.1) — for camera/tests. */
  height: number;
  /** Emissive traverse tint (out = red); null restores originals. */
  setTint(colour: number | null): void;
  dispose(): void;
}

type FaceMood = 'confident' | 'sly' | 'keen' | 'focused' | 'steady' | 'calm' | 'stoic' | 'firm' | 'worried' | 'easy' | 'gentle';

interface Visual {
  heightM: number;
  /** Blob half-width at its widest (m) — the lathe profile's max radius. */
  widthR: number;
  /** Blob depth scale relative to width (1 = round; <1 flattens front-to-back). */
  depthScale: number;
  /** Where along the height (0=bottom,1=top) the blob is widest — egg vs bean vs squat. */
  bulgeAt: number;
  /** Skin/base tone used for hands and any bare-paint patches. */
  skin: number;
  /** Face paint mood. */
  mood: FaceMood;
  /** Squad number, painted large on the blob's kit panel (stable, roster order 1–11). */
  number: number;
  /** Hand sphere radius as a fraction of widthR (robbie's big mitts, joe's tiny hands). */
  handScale: number;
  /** Hand colour override (josh's cream gloves); defaults to skin. */
  handColour?: number;
  /** Painted hair colour + simple style flag for the canvas painter. */
  hairColour?: number;
  hairStyle?: 'flick' | 'curls' | 'none';
  /** Extra small meshes (kept to ≤2 per character): flat-cap brim, headband torus. */
  extra?: 'cap-brim' | 'headband' | 'quiff-tuft';
}

// ---- Palette --------------------------------------------------------------------------
const SKIN_LIGHT = 0xf1c9a5;
const SKIN_TAN = 0xe0ac7e;
const SKIN_MEDIUM = 0xc68642;
const SKIN_BROWN = 0x8d5524;
const SKIN_WHALE = 0x8fa6ba; // friendly blue-grey
const HAIR_DARK_BROWN = 0x3b2b1b;
const HAIR_BLACK = 0x1c1a17;
const HAIR_BLOND = 0xe0c15a;
const HAIR_GINGER = 0xc0602f;

const BALL_COLOUR = 0xe8483f;
const RING_COLOUR = 0xd9a441; // default; RenderModule recolours per status
const CAP_COLOUR = 0x6b5a3e;
const HEADBAND_COLOUR = 0xf5f2e8;
const BAT_BARREL_COLOUR = 0xd7b26a;
const BAT_HANDLE_COLOUR = 0x5a4326;

const DEFAULT_VISUAL: Visual = {
  heightM: 1.6,
  widthR: 0.42,
  depthScale: 0.85,
  bulgeAt: 0.35,
  skin: SKIN_LIGHT,
  mood: 'easy',
  number: 0,
  handScale: 0.32,
  hairStyle: 'none',
};

/** One entry per roster character (design spec §1), roster order fixes the painted number. */
const VISUALS: Record<string, Visual> = {
  carl: {
    heightM: 1.7,
    widthR: 0.46,
    depthScale: 0.9,
    bulgeAt: 0.32,
    skin: SKIN_LIGHT,
    mood: 'confident',
    number: 1,
    handScale: 0.3,
    hairColour: HAIR_DARK_BROWN,
    hairStyle: 'flick',
  },
  kian: {
    heightM: 1.55,
    widthR: 0.36,
    depthScale: 0.82,
    bulgeAt: 0.4,
    skin: SKIN_LIGHT,
    mood: 'sly',
    number: 2,
    handScale: 0.27,
    hairColour: HAIR_DARK_BROWN,
    hairStyle: 'none',
    extra: 'cap-brim',
  },
  laurie: {
    heightM: 1.85,
    widthR: 0.34,
    depthScale: 0.8,
    bulgeAt: 0.3,
    skin: SKIN_TAN,
    mood: 'keen',
    number: 3,
    handScale: 0.28,
    hairColour: HAIR_BLOND,
    hairStyle: 'flick',
    extra: 'quiff-tuft',
  },
  josh: {
    heightM: 1.65,
    widthR: 0.38,
    depthScale: 0.85,
    bulgeAt: 0.34,
    skin: SKIN_MEDIUM,
    mood: 'focused',
    number: 4,
    handScale: 0.34,
    handColour: 0xf2ead8,
    hairColour: HAIR_BLACK,
    hairStyle: 'flick',
  },
  joel: {
    heightM: 1.6,
    widthR: 0.52,
    depthScale: 0.95,
    bulgeAt: 0.34,
    skin: SKIN_LIGHT,
    mood: 'steady',
    number: 5,
    handScale: 0.31,
    hairStyle: 'none',
  },
  darcy: {
    heightM: 1.62,
    widthR: 0.42,
    depthScale: 0.88,
    bulgeAt: 0.36,
    skin: SKIN_TAN,
    mood: 'calm',
    number: 6,
    handScale: 0.29,
    hairColour: HAIR_DARK_BROWN,
    hairStyle: 'curls',
  },
  jonty: {
    heightM: 1.3,
    widthR: 0.56,
    depthScale: 1.0,
    bulgeAt: 0.42,
    skin: SKIN_BROWN,
    mood: 'stoic',
    number: 7,
    handScale: 0.33,
    hairColour: HAIR_BLACK,
    hairStyle: 'curls',
    extra: 'headband',
  },
  robbie: {
    heightM: 1.58,
    widthR: 0.48,
    depthScale: 0.92,
    bulgeAt: 0.35,
    skin: SKIN_LIGHT,
    mood: 'firm',
    number: 8,
    handScale: 0.42,
    hairColour: HAIR_GINGER,
    hairStyle: 'flick',
  },
  joe: {
    heightM: 1.1,
    widthR: 0.26,
    depthScale: 0.78,
    bulgeAt: 0.3,
    skin: SKIN_LIGHT,
    mood: 'worried',
    number: 9,
    handScale: 0.24,
    hairColour: 0x7a6a4f,
    hairStyle: 'curls',
  },
  ricy: {
    heightM: 1.68,
    widthR: 0.4,
    depthScale: 0.86,
    bulgeAt: 0.33,
    skin: SKIN_MEDIUM,
    mood: 'easy',
    number: 10,
    handScale: 0.3,
    hairColour: HAIR_BLACK,
    hairStyle: 'flick',
  },
  whale: {
    heightM: 3.0,
    widthR: 1.15,
    depthScale: 1.0,
    bulgeAt: 0.4,
    skin: SKIN_WHALE,
    mood: 'gentle',
    number: 11,
    handScale: 0.24,
    hairStyle: 'none',
  },
};

// ---- Blob silhouette --------------------------------------------------------------------
// The body-head is a single lathe profile revolved about y. Its silhouette is a friendly
// ROUNDED blob (a weeble/egg), NOT a spinning-top: a firmly-seated rounded base, a broad body
// bulge at `bulgeAt`, and a rounded head DOME that ends in a soft crown cap (no pinched spike).
// The old profile tapered both ends to a point (sin below the bulge, cos above) which rendered
// as an ugly diamond/kite balancing on its tip — this is the readable-overhaul fix.
//
// `blobRadiusFraction(t, bulgeAt)` returns the profile radius as a fraction of `widthR` in
// [BLOB_CROWN_FRACTION, 1] for t (0 = ground, 1 = crown). It is the SINGLE source of the
// silhouette: the lathe profile is built from it AND hand/face placement query it, so the hands
// can never embed and the face never floats off the body regardless of future retuning.
const BLOB_BASE_FRACTION = 0.5; // seated base = 50% of max width — a rounded, planted bottom
const BLOB_CROWN_FRACTION = 0.12; // crown cap = 12% of max width — a rounded top, never a point
const BLOB_STEPS = 24; // lathe profile samples (was 16 — more samples smooth the dome)

function blobRadiusFraction(t: number, bulgeAt: number): number {
  const b = bulgeAt;
  if (t <= b) {
    // Base → bulge: a quarter-circle swell off a seated base floor (rounded bottom).
    const u = b > 0 ? t / b : 1;
    const round = Math.sqrt(Math.max(0, 1 - (1 - u) * (1 - u)));
    return BLOB_BASE_FRACTION + (1 - BLOB_BASE_FRACTION) * round;
  }
  // Bulge → crown: a semicircle shoulder (rounded DOME) tapering to a small crown cap, so the
  // very top is a gentle rounded cap rather than a pinched spike.
  const u = (t - b) / (1 - b);
  const dome = Math.sqrt(Math.max(0, 1 - u * u));
  return BLOB_CROWN_FRACTION + (1 - BLOB_CROWN_FRACTION) * dome;
}

/** The blob's x-axis half-width (metres) at height fraction t. depthScale only squashes z, so
 * x half-width is the unscaled profile radius — this is what hand placement must clear. */
function blobRadiusAt(v: Visual, t: number): number {
  return v.widthR * blobRadiusFraction(t, v.bulgeAt);
}

// ---- Canvas face/kit painter -----------------------------------------------------------
// One 512×512 canvas per character, wrapped around the lathe blob (u = around, v = up).
// Layout (deterministic, no rng): a kit-colour band with a trim collar near the top, a big
// painted number roundel on the chest-front, and the face (eyes/brows/mouth) painted higher
// on the front band so it sits on the blob's upper "head" curvature.
const TEX_SIZE = 512;

function paintCharacterTexture(v: Visual, kit: { shirt: number; trim: number }): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('CharacterModels: 2D canvas context unavailable');

  const shirtCss = `#${kit.shirt.toString(16).padStart(6, '0')}`;
  const trimCss = `#${kit.trim.toString(16).padStart(6, '0')}`;
  const skinCss = `#${v.skin.toString(16).padStart(6, '0')}`;

  // Base kit fill (the whole wrap is "shirt" colour by default; the face patch overpaints
  // its own skin-coloured region on the front band).
  ctx.fillStyle = shirtCss;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  // Trim collar band near the top of the profile (v is inverted in canvas y: v=1 top → y=0).
  const collarY = TEX_SIZE * 0.06;
  ctx.fillStyle = trimCss;
  ctx.fillRect(0, collarY, TEX_SIZE, TEX_SIZE * 0.05);

  // Waistband tell (ricy): a trim stripe low on the body.
  if (v.number === 10) {
    ctx.fillStyle = trimCss;
    ctx.fillRect(0, TEX_SIZE * 0.78, TEX_SIZE, TEX_SIZE * 0.045);
  }
  // Captain's armband tell (carl): a gold stripe wrapping the lower band, clear of the
  // number roundel painted later (roundel spans ≈0.47–0.69 normalised — the stripe sits
  // below it so the two tells stay visually distinct rather than merging).
  if (v.number === 1) {
    ctx.fillStyle = '#d9a441';
    ctx.fillRect(0, TEX_SIZE * 0.72, TEX_SIZE, TEX_SIZE * 0.05);
  }
  // Wristband tells (darcy): two narrow trim stripes lower down, also clear of the roundel
  // (read as painted "hand" bands since darcy's hand spheres share this same body texture
  // via a simplified UV, painted here as extra low stripes for a consistent silhouette).
  if (v.number === 6) {
    ctx.fillStyle = trimCss;
    ctx.fillRect(0, TEX_SIZE * 0.72, TEX_SIZE, TEX_SIZE * 0.03);
    ctx.fillRect(0, TEX_SIZE * 0.79, TEX_SIZE, TEX_SIZE * 0.03);
  }
  // Rolled-sleeve cuff tell (joel): two shirt-toned ring bands near the shoulders.
  if (v.number === 5) {
    ctx.fillStyle = trimCss;
    ctx.fillRect(0, TEX_SIZE * 0.16, TEX_SIZE, TEX_SIZE * 0.03);
  }
  // Oversized shirt collar/hem tell (joe): a wide trim hem low on the tiny frame.
  if (v.number === 9) {
    ctx.fillStyle = trimCss;
    ctx.fillRect(0, TEX_SIZE * 0.82, TEX_SIZE, TEX_SIZE * 0.08);
  }

  // ---- Face patch: a skin-coloured rounded panel on the front band (centred u, upper v) ----
  // The face is painted in UV space, but the same UV rectangle covers a very different PHYSICAL
  // area on a narrow character (kian, joe) vs a wide one (jonty, whale) — the lathe wraps the u
  // axis around the whole circumference, so a constant faceW fraction stretches the face wide on
  // wide bodies and tall on narrow ones (measured 0.76..2.4 aspect across the roster — visibly
  // squashed). Fix: hold faceH constant and DERIVE faceW per character so the face renders at a
  // consistent ~1:1 physical aspect (roughly circular eyes, undistorted mouth) on everyone.
  //   physical aspect = (faceWfrac · circumference) / (faceHfrac · height); solve for aspect≈1.
  // circumference is taken at the face's own height using the shared blob profile (+ depthScale
  // for the oval cross-section), so this tracks any future silhouette retune automatically.
  const faceCx = TEX_SIZE * 0.5;
  const faceCyFrac = 0.28;
  const faceCy = TEX_SIZE * faceCyFrac;
  const FACE_H_BASE = 0.24;
  // Face height as a fraction of the model height maps (flipY) to v = 1 − faceCyFrac.
  const faceHeightT = 1 - faceCyFrac;
  const faceRx = blobRadiusAt(v, faceHeightT);
  const faceRAvg = (faceRx + faceRx * v.depthScale) / 2; // oval cross-section average radius
  const faceCirc = 2 * Math.PI * Math.max(faceRAvg, 0.001);
  // aspect 1: faceWfrac = faceHFrac · H / circ. Clamp faceW so a very wide body still gets a
  // readable (not sliver) face and a very narrow one doesn't wrap the patch around the sides.
  const faceWIdeal = (FACE_H_BASE * v.heightM) / faceCirc;
  const faceWFrac = Math.min(0.5, Math.max(0.135, faceWIdeal));
  // When faceW is FLOOR-clamped (the widest bodies: jonty, whale — their ideal width would be a
  // sliver), grow faceH by the SAME factor faceW was inflated so the ~1:1 aspect is restored
  // instead of leaving the face squashed-wide. Unclamped characters keep FACE_H_BASE (ratio 1).
  const faceHFrac = FACE_H_BASE * (faceWFrac / faceWIdeal);
  const faceW = TEX_SIZE * faceWFrac;
  const faceH = TEX_SIZE * faceHFrac;
  ctx.fillStyle = skinCss;
  ctx.beginPath();
  ctx.ellipse(faceCx, faceCy, faceW / 2, faceH / 2, 0, 0, Math.PI * 2);
  ctx.fill();

  // Painted hairline (flick/curls) sitting just above the face patch.
  if (v.hairStyle === 'flick' && v.hairColour !== undefined) {
    ctx.fillStyle = `#${v.hairColour.toString(16).padStart(6, '0')}`;
    ctx.beginPath();
    ctx.ellipse(faceCx, faceCy - faceH * 0.42, faceW * 0.56, faceH * 0.32, 0, Math.PI, 0);
    ctx.fill();
  }
  if (v.hairStyle === 'curls' && v.hairColour !== undefined) {
    ctx.fillStyle = `#${v.hairColour.toString(16).padStart(6, '0')}`;
    for (const dx of [-0.32, 0, 0.32]) {
      ctx.beginPath();
      ctx.arc(faceCx + dx * faceW, faceCy - faceH * 0.4, faceW * 0.16, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- Eyes/brows/mouth painted per mood ----
  // Eye spacing scales with faceW; eye SIZE is floored in absolute pixels so the narrowest
  // faces (whale/jonty, faceW≈69px) keep crisp readable eyes rather than pin-pricks.
  const eyeY = faceCy - faceH * 0.03;
  const eyeDx = faceW * 0.2;
  const eyeR = Math.max(faceW * 0.055, 5);
  ctx.fillStyle = '#14110d';

  const drawEyes = (openness: number, browAngle: number): void => {
    for (const side of [-1, 1]) {
      const ex = faceCx + side * eyeDx;
      ctx.beginPath();
      ctx.ellipse(ex, eyeY, eyeR, eyeR * openness, 0, 0, Math.PI * 2);
      ctx.fill();
      // Brow: a short angled stroke above each eye.
      ctx.save();
      ctx.strokeStyle = '#14110d';
      ctx.lineWidth = faceW * 0.02;
      ctx.beginPath();
      ctx.translate(ex, eyeY - eyeR * 3);
      ctx.rotate(side * browAngle);
      ctx.moveTo(-faceW * 0.08, 0);
      ctx.lineTo(faceW * 0.08, 0);
      ctx.stroke();
      ctx.restore();
    }
  };

  const drawMouth = (kind: 'smile' | 'smirk' | 'flat' | 'frown' | 'grin'): void => {
    const my = faceCy + faceH * 0.28;
    ctx.strokeStyle = '#14110d';
    ctx.lineWidth = faceW * 0.025;
    ctx.beginPath();
    if (kind === 'smile' || kind === 'grin') {
      ctx.arc(faceCx, my - faceH * 0.05, faceW * 0.16, 0.15 * Math.PI, 0.85 * Math.PI);
    } else if (kind === 'smirk') {
      ctx.moveTo(faceCx - faceW * 0.14, my);
      ctx.quadraticCurveTo(faceCx + faceW * 0.02, my + faceH * 0.03, faceCx + faceW * 0.16, my - faceH * 0.06);
    } else if (kind === 'flat') {
      ctx.moveTo(faceCx - faceW * 0.15, my);
      ctx.lineTo(faceCx + faceW * 0.15, my);
    } else {
      ctx.arc(faceCx, my + faceH * 0.14, faceW * 0.15, 1.15 * Math.PI, 1.85 * Math.PI);
    }
    ctx.stroke();
  };

  switch (v.mood) {
    case 'confident':
      drawEyes(1, 0.05);
      drawMouth('smile');
      break;
    case 'sly':
      drawEyes(0.55, 0.18);
      drawMouth('smirk');
      break;
    case 'keen':
      drawEyes(1.25, -0.05);
      drawMouth('grin');
      break;
    case 'focused':
      drawEyes(0.75, 0.0);
      drawMouth('flat');
      break;
    case 'steady':
      drawEyes(1, 0.02);
      drawMouth('smile');
      break;
    case 'calm':
      drawEyes(0.85, 0);
      drawMouth('flat');
      break;
    case 'stoic':
      drawEyes(0.9, 0);
      drawMouth('flat');
      break;
    case 'firm':
      drawEyes(0.7, 0.12);
      drawMouth('flat');
      break;
    case 'worried':
      drawEyes(1.35, -0.22);
      drawMouth('frown');
      break;
    case 'easy':
      drawEyes(1, -0.03);
      drawMouth('smile');
      break;
    case 'gentle':
      drawEyes(0.5, -0.08);
      drawMouth('smile');
      break;
  }

  // ---- Big painted squad number roundel, lower on the chest-front ----
  const numCx = TEX_SIZE * 0.5;
  const numCy = TEX_SIZE * 0.58;
  const numR = TEX_SIZE * 0.11;
  ctx.fillStyle = trimCss;
  ctx.beginPath();
  ctx.arc(numCx, numCy, numR, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = shirtCss;
  const numText = String(v.number);
  // Double-digit numbers (10, 11) need a smaller point size to stay inside the roundel —
  // a single fixed size overflows for two characters at the one-digit fit.
  const fontScale = numText.length > 1 ? 1.05 : 1.5;
  ctx.font = `700 ${Math.round(numR * fontScale)}px "Arial Black", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(numText, numCx, numCy + numR * 0.06);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Paints a small square texture for a hand sphere: mostly the skin/glove colour with a
 * subtle wristband stripe for darcy and robbie's oversize mitts read via handScale alone
 * (no extra geometry needed — a plain flat-coloured material suffices there), so this
 * painter is reserved for the one tell that genuinely needs a stripe on the hand itself.
 */
function paintHandTexture(colour: number, stripeColour: number | null): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('CharacterModels: 2D canvas context unavailable');
  ctx.fillStyle = `#${colour.toString(16).padStart(6, '0')}`;
  ctx.fillRect(0, 0, size, size);
  if (stripeColour !== null) {
    ctx.fillStyle = `#${stripeColour.toString(16).padStart(6, '0')}`;
    ctx.fillRect(0, size * 0.4, size, size * 0.2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export function buildCharacterModel(character: Character, kit: KitId): CharacterModel {
  const v = VISUALS[character.id] ?? DEFAULT_VISUAL;
  const kitColours = KIT_COLOURS[kit];

  // Per-model resource registers so dispose() can release everything this build created.
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];

  /** Registers the geometry and builds a mesh; noTint parts are skipped by setTint. */
  const part = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    noTint = false,
  ): THREE.Mesh => {
    geometries.push(geometry);
    const m = new THREE.Mesh(geometry, material);
    if (noTint) m.userData.noTint = true;
    return m;
  };

  const group = new THREE.Group();

  // ---- The blob: a single LatheGeometry profile revolved 360° — a friendly ROUNDED egg/
  // weeble silhouette (seated base, body bulge at `bulgeAt`, rounded head dome). This is the
  // ONE main body-head mesh (no separate head/neck/torso/pelvis) per the user's minimal-mascot
  // requirement. The radius at each height comes from `blobRadiusFraction` (shared with hand/
  // face placement) so the shape, the hand clearance and the face patch can never drift apart. ----
  const H = v.heightM;
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= BLOB_STEPS; i++) {
    const t = i / BLOB_STEPS; // 0 (ground) .. 1 (crown)
    const radius = v.widthR * blobRadiusFraction(t, v.bulgeAt);
    profile.push(new THREE.Vector2(Math.max(radius, 0.001), t * H));
  }
  // phiStart = π puts the UV seam (u=0/u=1) at phi=π i.e. (x=0, z=-widthR) — the BACK of
  // the model — so u=0.5 (phi=0: x=0, z=+widthR) lands on the FRONT, exactly where the
  // texture painter centres the face and number. Without this offset the seam (not the
  // front) would sit at u=0.5 and the face would paint onto the model's back.
  const blobGeometry = new THREE.LatheGeometry(profile, 20, Math.PI);
  // LatheGeometry revolves the profile about y into a circular cross-section; scaling only
  // z squashes that circle into an oval (front-to-back), giving a rounder face-on silhouette
  // while `v.widthR` (the profile's own radius, unscaled) stays the true x-axis half-width
  // used below for hand placement and the shadow/ring sizing.
  blobGeometry.scale(1, 1, v.depthScale);
  const texture = paintCharacterTexture(v, kitColours);
  textures.push(texture);
  const bodyMat = new THREE.MeshLambertMaterial({ map: texture });
  materials.push(bodyMat);
  const blob = part(blobGeometry, bodyMat);

  const body = new THREE.Group();
  body.add(blob);
  group.add(body);

  // ---- Extra tell meshes (kept to ≤2 per character; most tells are painted above). Heights
  // are height FRACTIONS on the new rounded dome, and radii are sized from the ACTUAL head
  // width there (blobRadiusAt) so a cap/band hugs the dome instead of floating over a spike. ----
  if (v.extra === 'cap-brim') {
    // Kian: a flattened tweed cap capping the head dome, with a short forward brim.
    const capMat = new THREE.MeshLambertMaterial({ color: CAP_COLOUR });
    materials.push(capMat);
    const capT = 0.9; // sit high on the dome
    const headR = blobRadiusAt(v, capT);
    const crownY = capT * H;
    // A shallow spherical cap over the crown reads as a cloth cap far better than a flat disc.
    const crown = part(
      new THREE.SphereGeometry(headR * 1.08, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
      capMat,
    );
    crown.position.y = crownY;
    crown.scale.y = 0.55; // flatten into a cap
    body.add(crown);
    const brim = part(new THREE.BoxGeometry(headR * 1.7, H * 0.015, headR * 1.2), capMat);
    brim.position.set(0, crownY, headR * 0.95);
    body.add(brim);
  }
  if (v.extra === 'headband') {
    // Jonty: a slim white headband torus around the forehead, above the brows. Sits high on the
    // dome (t≈0.87) with a thin tube so it reads as a sweatband, not a bowl. The torus radius
    // matches the head width there so it hugs rather than floats.
    const bandMat = new THREE.MeshLambertMaterial({ color: HEADBAND_COLOUR });
    materials.push(bandMat);
    const bandT = 0.87;
    const headR = blobRadiusAt(v, bandT);
    const band = part(new THREE.TorusGeometry(headR * 1.02, headR * 0.1, 8, 28), bandMat);
    band.rotation.x = Math.PI / 2;
    band.scale.z = v.depthScale; // match the oval cross-section so it hugs the head
    band.position.y = bandT * H;
    body.add(band);
  }
  if (v.extra === 'quiff-tuft') {
    // Laurie: a single small tuft flicking up-and-forward from the blond hairline on the dome.
    const tuftMat = new THREE.MeshLambertMaterial({ color: v.hairColour ?? HAIR_BLOND });
    materials.push(tuftMat);
    const tuftT = 0.9;
    const tuft = part(new THREE.ConeGeometry(H * 0.045, H * 0.11, 8), tuftMat);
    tuft.position.set(0, tuftT * H, blobRadiusAt(v, tuftT) * 0.6);
    tuft.rotation.x = -0.6;
    body.add(tuft);
  }

  // ---- Floating sphere hands: two spheres beside the body, NOT connected by arms. They
  // are children of `body` (not `group`) so the body's bob/lean pivot carries them along
  // naturally — a bobbing body with hands that stay statically in world space would read
  // as broken, not "floating". They sit a little below the widest point, offset outward in x
  // and slightly forward in z so they read in front of the silhouette from the +z camera.
  // Their OWN local position/rotation is still free for animation (wind-up orbit / carry). ----
  const handR = Math.max(v.widthR * v.handScale, 0.05);
  // Hands hover just below the bulge (looks like arms hanging by the sides), as a height
  // FRACTION so it tracks the new profile: bulge is at v.bulgeAt, hands at 0.92× that.
  const handT = v.bulgeAt * 0.92;
  const handY = handT * H;
  // Clear the body: the inner edge of the hand sphere must sit a positive DAYLIGHT gap outside
  // the blob's actual x half-width at hand height (blobRadiusAt) — the old formula used the
  // DEPTH half-width and subtracted nothing for the sphere radius, so every hand embedded
  // −0.02..−0.08 m into the silhouette. Daylight scales gently with size (whale gets more).
  const handDaylight = Math.max(0.07, v.widthR * 0.16);
  const handOffsetX = blobRadiusAt(v, handT) + handR + handDaylight;
  const handBaseColour = v.handColour ?? v.skin;
  const handStripeColour = v.number === 6 ? kitColours.trim : null; // darcy's wristband tell
  const handTexture = paintHandTexture(handBaseColour, handStripeColour);
  textures.push(handTexture);
  const handMat = new THREE.MeshLambertMaterial({ map: handTexture });
  materials.push(handMat);

  const makeHand = (side: -1 | 1): THREE.Group => {
    const hand = new THREE.Group();
    hand.position.set(side * handOffsetX, handY, v.widthR * 0.15);
    body.add(hand);
    const sphere = part(new THREE.SphereGeometry(handR, 12, 10), handMat);
    hand.add(sphere);
    return hand;
  };
  const rightHand = makeHand(1);
  const leftHand = makeHand(-1);

  // In-hand ball prop — parented to the RIGHT hand sphere, hidden unless held.
  const ballMat = new THREE.MeshLambertMaterial({ color: BALL_COLOUR });
  materials.push(ballMat);
  const ball = part(new THREE.SphereGeometry(handR * 0.55, 10, 8), ballMat, true);
  ball.position.set(0, 0, handR * 1.1);
  ball.visible = false;
  rightHand.add(ball);

  // In-hand rounders bat — a tapered cylinder barrel with a slim handle child, hanging
  // from the right hand pointing down at rest. Hidden by default; only the batter view
  // reveals it (Task 4).
  const batHandleLen = handR * 2.2;
  const batBarrelLen = handR * 3.4;
  const batMat = new THREE.MeshLambertMaterial({ color: BAT_BARREL_COLOUR });
  materials.push(batMat);
  const bat = part(new THREE.CylinderGeometry(handR * 0.4, handR * 0.18, batBarrelLen, 10), batMat, true);
  bat.position.y = -(handR + batHandleLen + batBarrelLen / 2);
  bat.visible = false;
  const handleMat = new THREE.MeshLambertMaterial({ color: BAT_HANDLE_COLOUR });
  materials.push(handleMat);
  const batHandle = part(new THREE.CylinderGeometry(handR * 0.15, handR * 0.18, batHandleLen, 8), handleMat, true);
  batHandle.position.y = batBarrelLen / 2 + batHandleLen / 2;
  bat.add(batHandle);
  rightHand.add(bat);

  // ---- Ground furniture: blob shadow + status ring (both tint-excluded) ----
  const shadowR = Math.max(v.widthR * 1.1, 0.3);
  const shadowMat = new THREE.MeshLambertMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  });
  materials.push(shadowMat);
  const shadow = part(new THREE.CircleGeometry(shadowR, 20), shadowMat, true);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.01;
  group.add(shadow);

  const ringMat = new THREE.MeshLambertMaterial({ color: RING_COLOUR, side: THREE.DoubleSide });
  materials.push(ringMat);
  const ring = part(new THREE.RingGeometry(shadowR * 1.08, shadowR * 1.08 + 0.14, 24), ringMat, true);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  ring.visible = false;
  group.add(ring);

  // ---- Tint: traverse flipping emissive on every Lambert part except noTint furniture;
  // originals are captured lazily so restore is exact even if defaults ever change. ----
  const originalEmissives = new Map<THREE.MeshLambertMaterial, number>();
  const setTint = (colour: number | null): void => {
    group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) || obj.userData.noTint === true) return;
      const material = obj.material;
      if (!(material instanceof THREE.MeshLambertMaterial)) return;
      if (colour === null) {
        const original = originalEmissives.get(material);
        if (original !== undefined) material.emissive.setHex(original);
      } else {
        if (!originalEmissives.has(material)) originalEmissives.set(material, material.emissive.getHex());
        material.emissive.setHex(colour);
      }
    });
  };

  const dispose = (): void => {
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    for (const t of textures) t.dispose();
  };

  return {
    group,
    pose: { body, leftHand, rightHand },
    ring,
    ball,
    bat,
    height: v.heightM,
    setTint,
    dispose,
  };
}
