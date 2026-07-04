/**
 * CharacterModels — procedural low-poly humanoid rigs for the roster (visual overhaul Task 1).
 *
 * THE NO-PILLS RULE: every figure is a limbed humanoid — head on a neck, distinct torso,
 * pelvis, two pivoted arms, two pivoted legs — never a single capsule. Proportions are
 * deliberately chunky (heads ~1.4× realistic, thick limbs) so silhouettes read from the
 * gameplay camera at ~25 m.
 *
 * Per-character look table (hand-tuned, stats-informed):
 * | id     | silhouette                                    | distinguishing look                          |
 * |--------|-----------------------------------------------|----------------------------------------------|
 * | carl   | tall, confident opener (1.88 m)               | captain's GOLD ARMBAND on the right arm      |
 * | kian   | wiry, narrow-shouldered (1.74 m)              | tweed FLAT CAP with a forward brim           |
 * | laurie | tall with visibly TOO-LONG ARMS (×1.40)       | blond quiff; hands hang near the knees       |
 * | josh   | lean sprinter (1.78 m)                        | oversized cream KEEPER'S GLOVES              |
 * | joel   | BARREL CHEST, wide shoulders, bald (1.76 m)   | ROLLED SLEEVES — bare arms with a cuff roll  |
 * | darcy  | perfectly symmetric average build (1.75 m)    | TWO trim-coloured WRISTBANDS; hair bun       |
 * | jonty  | SQUAT and WIDE (1.55 m, widest shoulders/H)   | white HEADBAND under a mop of curls          |
 * | robbie | heavy-set (1.72 m)                            | HUGE FOREARMS (×1.8) and BIG BOOTS (×1.6)    |
 * | joe    | short and SCRAWNY (1.30 m), twig limbs        | OVERSIZED baggy shirt hanging past the hips  |
 * | ricy   | tidy athletic all-rounder (1.80 m)            | neat kit: collar + trim WAISTBAND, no props  |
 * | whale  | rounded GIANT (3.10 m, ~2.5× bulk)            | blue-grey skin, comically SMALL ARMS (×0.45) |
 *
 * Facing convention: the figure faces +z (boot toes, cap brim and eyes all point +z);
 * callers rotate `group` to aim it. All dimensions are metres at field scale.
 *
 * Pure construction only — no per-frame logic (animation is wired in Task 3).
 */
import * as THREE from 'three';
import type { Character } from '@carlquest/shared';

export type KitId = 'A' | 'B' | 'neutral';

/**
 * Kit shirt palettes (unslop pass): deep navy vs maroon with shared cream trim — a
 * deliberate club-cricket pairing that sits with the parchment/gold UI identity rather
 * than a saturated red-vs-blue arcade default. Neutral (pre-draft) is a warm kit-grey.
 */
export const KIT_COLOURS: Record<KitId, { shirt: number; trim: number }> = {
  A: { shirt: 0x22345e, trim: 0xf1e6cc },
  B: { shirt: 0x7a2231, trim: 0xf1e6cc },
  neutral: { shirt: 0x9a958a, trim: 0xdcd6c8 },
};

export interface CharacterModel {
  group: THREE.Group; // position/rotate THIS; internal parts are relative
  pose: {
    leftArm: THREE.Group; // shoulder pivots — rotate about x to swing
    rightArm: THREE.Group;
    leftLeg: THREE.Group; // hip pivots
    rightLeg: THREE.Group;
    torso: THREE.Group; // lean/bob pivot at the hips (carries head + arms)
  };
  /** Feet ring for status cues; hidden by default. Set .visible and .material colour. */
  ring: THREE.Mesh;
  /** In-hand ball prop (parented to the right hand); hidden unless the character holds the ball. */
  ball: THREE.Mesh;
  /** Approximate standing height in metres (whale ≈ 3.1, joe ≈ 1.3) — for camera/tests. */
  height: number;
  /** Emissive traverse tint (out = red); null restores originals. */
  setTint(colour: number | null): void;
  dispose(): void;
}

type HairStyle = 'crop' | 'quiff' | 'bun' | 'bald' | 'curls';
type Accessory =
  | 'armband'
  | 'flat-cap'
  | 'gloves'
  | 'rolled-sleeves'
  | 'wristbands'
  | 'headband'
  | 'none';

interface Visual {
  heightM: number;
  /** Full shoulder width (m) — sets torso top radius and arm pivot spread. */
  shoulderW: number;
  /** Torso bottom (belly) radius (m) — girth. */
  bellyR: number;
  /** Base limb radius (m). */
  limbR: number;
  skin: number;
  hair: number;
  hairStyle: HairStyle;
  accessory: Accessory;
  /** Arm LENGTH multiplier (laurie 1.4 long; whale 0.45 tiny flipper-ish arms). */
  armScale?: number;
  /** Forearm RADIUS multiplier (robbie's heavy forearms). */
  forearmScale?: number;
  /** Boot size multiplier (robbie's big boots). */
  bootScale?: number;
  /** Torso radius multiplier for a baggy shirt hanging over a small frame (joe). */
  shirtOversize?: number;
  /** Whale: rounded sphere torso instead of the tapered cylinder. */
  rounded?: boolean;
  /** Ricy: tidy-kit trim waistband. */
  waistband?: boolean;
}

// Skin/hair palette (varied across the roster; the whale is a whale — blue-grey).
const SKIN_LIGHT = 0xf1c9a5;
const SKIN_TAN = 0xe0ac7e;
const SKIN_MEDIUM = 0xc68642;
const SKIN_BROWN = 0x8d5524;
const SKIN_WHALE = 0x7d93a8;
const HAIR_DARK_BROWN = 0x3b2b1b;
const HAIR_BLACK = 0x1c1a17;
const HAIR_BLOND = 0xcfa64e;
const HAIR_GINGER = 0xa14e2a;
const HAIR_MOUSY = 0x7a6a4f;

// Fixed prop colours.
const SHORTS_COLOUR = 0x2e2e38; // shared dark PE-shorts slate for both kits
const BOOT_COLOUR = 0x2a2119;
const GLOVE_COLOUR = 0xf2ead8;
const CAP_COLOUR = 0x6b5a3e; // kian's tweed
const ARMBAND_COLOUR = 0xd9a441; // captain's gold, matching the UI gold identity
const HEADBAND_COLOUR = 0xf5f2e8;
const BALL_COLOUR = 0xe8483f; // matches the scene ball
const RING_COLOUR = 0xd9a441; // default; Task 3 recolours per status
const EYE_COLOUR = 0x14110d;

const DEFAULT_VISUAL: Visual = {
  heightM: 1.7,
  shoulderW: 0.55,
  bellyR: 0.22,
  limbR: 0.075,
  skin: SKIN_LIGHT,
  hair: HAIR_DARK_BROWN,
  hairStyle: 'crop',
  accessory: 'none',
};

/** One entry per roster character (design spec §1); unknown ids fall back to DEFAULT_VISUAL. */
const VISUALS: Record<string, Visual> = {
  carl: {
    heightM: 1.88,
    shoulderW: 0.62,
    bellyR: 0.26,
    limbR: 0.085,
    skin: SKIN_LIGHT,
    hair: HAIR_DARK_BROWN,
    hairStyle: 'crop',
    accessory: 'armband',
  },
  kian: {
    heightM: 1.74,
    shoulderW: 0.52,
    bellyR: 0.2,
    limbR: 0.065,
    skin: SKIN_LIGHT,
    hair: HAIR_DARK_BROWN,
    hairStyle: 'crop',
    accessory: 'flat-cap',
  },
  laurie: {
    heightM: 1.86,
    shoulderW: 0.56,
    bellyR: 0.22,
    limbR: 0.075,
    skin: SKIN_TAN,
    hair: HAIR_BLOND,
    hairStyle: 'quiff',
    accessory: 'none',
    armScale: 1.4,
  },
  josh: {
    heightM: 1.78,
    shoulderW: 0.54,
    bellyR: 0.19,
    limbR: 0.07,
    skin: SKIN_MEDIUM,
    hair: HAIR_BLACK,
    hairStyle: 'crop',
    accessory: 'gloves',
  },
  joel: {
    heightM: 1.76,
    shoulderW: 0.7,
    bellyR: 0.34,
    limbR: 0.09,
    skin: SKIN_LIGHT,
    hair: HAIR_DARK_BROWN,
    hairStyle: 'bald',
    accessory: 'rolled-sleeves',
  },
  darcy: {
    heightM: 1.75,
    shoulderW: 0.56,
    bellyR: 0.23,
    limbR: 0.075,
    skin: SKIN_TAN,
    hair: HAIR_DARK_BROWN,
    hairStyle: 'bun',
    accessory: 'wristbands',
  },
  jonty: {
    heightM: 1.55,
    shoulderW: 0.72,
    bellyR: 0.32,
    limbR: 0.095,
    skin: SKIN_BROWN,
    hair: HAIR_BLACK,
    hairStyle: 'curls',
    accessory: 'headband',
  },
  robbie: {
    heightM: 1.72,
    shoulderW: 0.6,
    bellyR: 0.28,
    limbR: 0.08,
    skin: SKIN_LIGHT,
    hair: HAIR_GINGER,
    hairStyle: 'crop',
    accessory: 'none',
    forearmScale: 1.8,
    bootScale: 1.6,
  },
  joe: {
    heightM: 1.3,
    shoulderW: 0.4,
    bellyR: 0.15,
    limbR: 0.05,
    skin: SKIN_LIGHT,
    hair: HAIR_MOUSY,
    hairStyle: 'curls',
    accessory: 'none',
    shirtOversize: 1.55,
  },
  ricy: {
    heightM: 1.8,
    shoulderW: 0.58,
    bellyR: 0.21,
    limbR: 0.075,
    skin: SKIN_MEDIUM,
    hair: HAIR_BLACK,
    hairStyle: 'crop',
    accessory: 'none',
    waistband: true,
  },
  whale: {
    heightM: 3.1,
    shoulderW: 1.6,
    bellyR: 0.8,
    limbR: 0.15,
    skin: SKIN_WHALE,
    hair: HAIR_BLACK,
    hairStyle: 'bald',
    accessory: 'none',
    armScale: 0.45,
    rounded: true,
  },
};

export function buildCharacterModel(character: Character, kit: KitId): CharacterModel {
  const v = VISUALS[character.id] ?? DEFAULT_VISUAL;
  const kitColours = KIT_COLOURS[kit];

  // Per-model resource registers so dispose() can release everything this build created.
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  // Per-model material cache keyed by colour — per-MODEL instances are required so that
  // setTint on one figure never bleeds emissive onto another figure's shared material.
  const matCache = new Map<number, THREE.MeshLambertMaterial>();
  const mat = (colour: number): THREE.MeshLambertMaterial => {
    let m = matCache.get(colour);
    if (m === undefined) {
      m = new THREE.MeshLambertMaterial({ color: colour });
      matCache.set(colour, m);
      materials.push(m);
    }
    return m;
  };
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

  // ---- Derived skeleton dimensions (all fractions of total height H, ground = y 0) ----
  // Vertical budget: boots+legs to the hip 0.42H, torso 0.33H, neck 0.02H, head 2×headR
  // (headR ≈ 0.115H, ~1.4× realistic for low-poly chunk) → 0.42+0.33+0.02+0.23 ≈ 1.00H.
  const H = v.heightM;
  const hipY = 0.42 * H; // hip pivot height — legs hang exactly hipY down to the ground
  const torsoH = 0.33 * H;
  const neckH = 0.02 * H;
  const headR = H * (v.rounded ? 0.095 : 0.115); // the whale's head is relatively small
  const bootH = 0.05 * H;
  const armScale = v.armScale ?? 1;
  const forearmScale = v.forearmScale ?? 1;
  const bootScale = v.bootScale ?? 1;
  const oversize = v.shirtOversize ?? 1;
  const armLen = 0.4 * H * armScale; // shoulder→wrist; 1.4× puts laurie's hands near his knees
  const upperArmLen = armLen * 0.55;
  const lowerArmLen = armLen * 0.45;
  const handR = v.limbR * (v.accessory === 'gloves' ? 2.1 : 1.25); // gloves = oversized mitts

  const group = new THREE.Group();

  // ---- Torso group: the lean/bob pivot sits AT THE HIPS (y = hipY), so rotating it
  // about x leans the upper body forward while the legs stay planted. Head and arms
  // are children of this group so a lean carries them naturally. ----
  const torso = new THREE.Group();
  torso.position.y = hipY;
  group.add(torso);

  const skinMat = mat(v.skin);
  const shirtMat = mat(kitColours.shirt);
  const trimMat = mat(kitColours.trim);

  if (v.rounded === true) {
    // The whale: a big rounded belly — a scaled SPHERE torso (still a torso on legs with
    // arms and a head, emphatically not a full-figure pill).
    const belly = part(new THREE.SphereGeometry(1, 14, 12), shirtMat);
    belly.scale.set(v.shoulderW * 0.5, torsoH * 0.62, v.shoulderW * 0.4);
    belly.position.y = torsoH * 0.5;
    torso.add(belly);
  } else {
    // Tapered low-poly cylinder: shoulders (top radius) vs belly (bottom radius), squashed
    // in z (×0.72) so the chest reads flat-fronted rather than tubular.
    const topR = v.shoulderW * 0.42 * oversize;
    const botR = Math.max(v.bellyR, topR * 0.75) * oversize;
    const shirtH = torsoH * (oversize > 1 ? 1.15 : 1); // baggy shirt hangs past the hips
    const chest = part(new THREE.CylinderGeometry(topR, botR, shirtH, 10), shirtMat);
    chest.scale.z = 0.72;
    // Centre the shirt so its TOP stays at the shoulder line (y = torsoH); any extra
    // oversize length hangs downward over the pelvis.
    chest.position.y = torsoH - shirtH / 2;
    torso.add(chest);

    // Collar (trim) at the neck base.
    const collar = part(new THREE.CylinderGeometry(headR * 0.62, headR * 0.62, 0.03 * H, 10), trimMat);
    collar.position.y = torsoH;
    torso.add(collar);

    if (v.waistband === true) {
      // Ricy's tidy kit: a crisp trim waistband at the shirt hem.
      const band = part(new THREE.CylinderGeometry(botR * 1.02, botR * 1.02, 0.035 * H, 10), trimMat);
      band.scale.z = 0.72;
      band.position.y = torsoH - shirtH + 0.02 * H;
      torso.add(band);
    }
  }

  // Pelvis block (shorts colour) — bridges torso and legs; child of the ROOT so it stays
  // with the planted legs when the torso leans.
  const pelvis = part(
    new THREE.BoxGeometry(v.shoulderW * 0.5, 0.1 * H, v.shoulderW * 0.34),
    mat(SHORTS_COLOUR),
  );
  pelvis.position.y = hipY - 0.02 * H;
  group.add(pelvis);

  // ---- Head (child of torso; local y measured from the hip pivot) ----
  const headCentreY = torsoH + neckH + headR;
  const neck = part(new THREE.CylinderGeometry(headR * 0.35, headR * 0.4, neckH * 2.5, 8), skinMat);
  neck.position.y = torsoH + neckH;
  torso.add(neck);
  const head = part(new THREE.SphereGeometry(headR, 14, 12), skinMat);
  head.position.y = headCentreY;
  torso.add(head);
  // Eyes — two dots on the +z face so the figure's facing reads at a glance.
  for (const side of [-1, 1]) {
    const eye = part(new THREE.SphereGeometry(headR * 0.09, 6, 6), mat(EYE_COLOUR));
    eye.position.set(side * headR * 0.33, headCentreY + headR * 0.15, headR * 0.85);
    torso.add(eye);
  }

  // Hair (simple cap geometry variants).
  const hairMat = mat(v.hair);
  if (v.hairStyle === 'crop' || v.hairStyle === 'quiff' || v.hairStyle === 'bun') {
    const cap = part(new THREE.SphereGeometry(headR * 1.05, 12, 8), hairMat);
    cap.scale.y = 0.55;
    cap.position.y = headCentreY + headR * 0.35;
    torso.add(cap);
  }
  if (v.hairStyle === 'quiff') {
    const quiff = part(new THREE.BoxGeometry(headR * 0.8, headR * 0.4, headR * 0.6), hairMat);
    quiff.position.set(0, headCentreY + headR * 0.85, headR * 0.45);
    quiff.rotation.x = -0.35; // tipped up at the front
    torso.add(quiff);
  }
  if (v.hairStyle === 'bun') {
    const bun = part(new THREE.SphereGeometry(headR * 0.38, 8, 8), hairMat);
    bun.position.set(0, headCentreY + headR * 0.5, -headR * 0.9);
    torso.add(bun);
  }
  if (v.hairStyle === 'curls') {
    const curlOffsets: ReadonlyArray<readonly [number, number]> = [
      [-0.5, 0.15],
      [0, -0.2],
      [0.5, 0.15],
    ];
    for (const [cx, cz] of curlOffsets) {
      const curl = part(new THREE.SphereGeometry(headR * 0.5, 8, 8), hairMat);
      curl.position.set(cx * headR, headCentreY + headR * 0.6, cz * headR);
      torso.add(curl);
    }
  }
  if (v.accessory === 'flat-cap') {
    // Kian: flattened tweed disc with a short forward brim.
    const capMat = mat(CAP_COLOUR);
    const crown = part(new THREE.CylinderGeometry(headR * 1.18, headR * 1.18, headR * 0.3, 12), capMat);
    crown.position.y = headCentreY + headR * 0.75;
    torso.add(crown);
    const brim = part(new THREE.BoxGeometry(headR * 1.4, headR * 0.12, headR * 0.9), capMat);
    brim.position.set(0, headCentreY + headR * 0.62, headR * 0.75);
    torso.add(brim);
  }
  if (v.accessory === 'headband') {
    // Jonty: band around the forehead, below the curls.
    const band = part(
      new THREE.CylinderGeometry(headR * 1.02, headR * 1.02, headR * 0.25, 12),
      mat(HEADBAND_COLOUR),
    );
    band.position.y = headCentreY + headR * 0.25;
    torso.add(band);
  }

  // ---- Arms: pivot groups AT the shoulders (children of torso; local y just below the
  // shoulder line, x at the torso edge) so rotation.x swings the whole arm naturally.
  // Limb meshes hang DOWNWARD from the pivot (negative local y). ----
  const buildArm = (side: -1 | 1): THREE.Group => {
    const arm = new THREE.Group();
    arm.position.set(side * (v.shoulderW / 2 + v.limbR * 0.2), torsoH - v.limbR * 0.6, 0);
    torso.add(arm);

    // Deltoid cap in shirt colour rounds the shoulder joint.
    const shoulder = part(new THREE.SphereGeometry(v.limbR * 1.5, 8, 8), shirtMat);
    arm.add(shoulder);

    const rolled = v.accessory === 'rolled-sleeves';
    const sleeveLen = upperArmLen * (rolled ? 0.4 : 1);
    const sleeve = part(new THREE.CylinderGeometry(v.limbR * 1.15, v.limbR * 1.15, sleeveLen, 8), shirtMat);
    sleeve.position.y = -sleeveLen / 2;
    arm.add(sleeve);
    if (rolled) {
      // Joel: a chunky cuff roll at the sleeve end, bare (skin) upper arm below it.
      const cuff = part(new THREE.CylinderGeometry(v.limbR * 1.4, v.limbR * 1.4, 0.04 * H, 8), shirtMat);
      cuff.position.y = -sleeveLen;
      arm.add(cuff);
      const bareLen = upperArmLen - sleeveLen;
      const bare = part(new THREE.CylinderGeometry(v.limbR, v.limbR, bareLen, 8), skinMat);
      bare.position.y = -(sleeveLen + bareLen / 2);
      arm.add(bare);
    }

    const forearmR = v.limbR * 0.9 * forearmScale;
    const forearm = part(new THREE.CylinderGeometry(forearmR, forearmR * 0.85, lowerArmLen, 8), skinMat);
    forearm.position.y = -(upperArmLen + lowerArmLen / 2);
    arm.add(forearm);

    if (v.accessory === 'wristbands') {
      // Darcy: matching trim bands on BOTH wrists (the SWITCH tell — perfectly symmetric).
      const band = part(new THREE.CylinderGeometry(forearmR * 1.35, forearmR * 1.35, 0.03 * H, 8), trimMat);
      band.position.y = -(upperArmLen + lowerArmLen * 0.82);
      arm.add(band);
    }
    if (v.accessory === 'armband' && side === 1) {
      // Carl: captain's gold armband on the RIGHT upper arm only.
      const band = part(new THREE.CylinderGeometry(v.limbR * 1.35, v.limbR * 1.35, 0.03 * H, 8), mat(ARMBAND_COLOUR));
      band.position.y = -upperArmLen * 0.45;
      arm.add(band);
    }

    const hand = part(
      new THREE.SphereGeometry(handR, 8, 8),
      v.accessory === 'gloves' ? mat(GLOVE_COLOUR) : skinMat,
    );
    hand.position.y = -(upperArmLen + lowerArmLen + handR * 0.5);
    arm.add(hand);
    return arm;
  };
  const rightArm = buildArm(1);
  const leftArm = buildArm(-1);

  // In-hand ball prop — parented to the RIGHT arm just in front of the hand, so a cocked
  // throwing-arm pose (Task 3) carries the ball with it. Hidden unless held.
  const ball = part(new THREE.SphereGeometry(0.14, 10, 8), mat(BALL_COLOUR), true);
  ball.position.set(0, -(upperArmLen + lowerArmLen + handR * 0.5), handR * 1.3);
  ball.visible = false;
  rightArm.add(ball);

  // ---- Legs: pivot groups AT the hips (children of the ROOT group at y = hipY) so a
  // torso lean does not move the legs. Total leg drop = hipY exactly, so boot soles land
  // on y = 0: upper + lower cover (hipY − bootH) and the boot box fills the last bootH. ----
  const hipX = v.shoulderW * 0.23;
  const upperLegLen = (hipY - bootH) * 0.52;
  const lowerLegLen = (hipY - bootH) * 0.48;
  const buildLeg = (side: -1 | 1): THREE.Group => {
    const leg = new THREE.Group();
    leg.position.set(side * hipX, hipY, 0);
    group.add(leg);

    const thigh = part(
      new THREE.CylinderGeometry(v.limbR * 1.25, v.limbR * 1.1, upperLegLen, 8),
      mat(SHORTS_COLOUR),
    );
    thigh.position.y = -upperLegLen / 2;
    leg.add(thigh);

    const shin = part(new THREE.CylinderGeometry(v.limbR * 0.85, v.limbR * 0.75, lowerLegLen, 8), skinMat);
    shin.position.y = -(upperLegLen + lowerLegLen / 2);
    leg.add(shin);

    const boot = part(
      new THREE.BoxGeometry(v.limbR * 2.8 * bootScale, bootH, v.limbR * 4.4 * bootScale),
      mat(BOOT_COLOUR),
    );
    // Boot centre sits bootH/2 above the ground; toes poke forward (+z).
    boot.position.set(0, -(hipY - bootH / 2), v.limbR * 0.9);
    leg.add(boot);
    return leg;
  };
  const rightLeg = buildLeg(1);
  const leftLeg = buildLeg(-1);

  // ---- Ground furniture: blob shadow + status ring (both tint-excluded) ----
  const shadowR = Math.max(v.shoulderW * 0.75, v.bellyR * 1.6, 0.35);
  const shadowMat = new THREE.MeshLambertMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  });
  materials.push(shadowMat);
  const shadow = part(new THREE.CircleGeometry(shadowR, 20), shadowMat, true);
  shadow.rotation.x = -Math.PI / 2; // face up
  shadow.position.y = 0.01;
  group.add(shadow);

  const ringMat = new THREE.MeshLambertMaterial({ color: RING_COLOUR, side: THREE.DoubleSide });
  materials.push(ringMat);
  const ring = part(new THREE.RingGeometry(shadowR * 1.08, shadowR * 1.08 + 0.14, 24), ringMat, true);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02; // just above the shadow to avoid z-fighting
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
  };

  return {
    group,
    pose: { leftArm, rightArm, leftLeg, rightLeg, torso },
    ring,
    ball,
    height: v.heightM,
    setTint,
    dispose,
  };
}
