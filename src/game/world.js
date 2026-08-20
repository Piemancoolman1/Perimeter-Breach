import * as THREE from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";

export const ARENA_BOUND = 38;

const textureLoader = new THREE.TextureLoader();

// Every obstacle — wall, rock, building, or car — gets one invisible box mesh matching its
// exact collision footprint (hx, hz, top), which is what hitscan/line-of-sight raycasts test
// against instead of each obstacle's own *visual* mesh. This is the "one system" for
// obstacle collision: the same {x, z, hx, hz, top} numbers already drive player-movement
// collision (resolveCollisions/getGroundHeight) AND now drive exactly what a bullet can hit,
// so the two can never disagree. It's also what actually fixes bullets passing through
// buildings/cars — their *visual* meshes are THREE.Group instances (multiple child meshes,
// no geometry of their own), and the raycast call used `recursive: false`, so it silently
// never hit them at all; a plain invisible Mesh always has direct geometry to test against.
// Wireframe (not fully invisible) so the same mesh can double as the "show collision boxes"
// dev-tool overlay in main.js — normally hidden (`visible = false`, the renderer skips it
// entirely regardless of the material), toggled visible on demand. depthTest: false so the
// wireframe still reads clearly even when it's inside/behind a rock or building's solid
// visual mesh, which is the whole point of a collision-box debug view.
const HITBOX_MAT = new THREE.MeshBasicMaterial({
  color: 0x39ff6a,
  wireframe: true,
  transparent: true,
  opacity: 0.9,
  depthTest: false,
});
// Shared unit cylinder (radius 1, height 1), scaled per-instance to (hx, top, hz) — the
// "ellipse" shape's visual/debug representation, used for anything whose real footprint is
// rounded rather than rectangular (rocks, trees) so the F4 overlay reads as a curved shape
// instead of a box even though the underlying collision math (below) is the one actually
// doing the rounding.
const ELLIPSE_HITBOX_GEO = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true);
// "roofPrism" builds a true triangular-prism hitbox (base at wallTop spanning ±hz, peak at
// `top`, extruded the full ridge length hx*2) instead of a flat-topped box — see the
// buildBuildingMesh roof-collision comment below for why a flat top isn't good enough here.
// The cross-section triangle is identical in shape to the gable end-cap triangle
// buildBuildingMesh already builds (base ±hz at y=wallTop, apex at y=top) — same technique,
// just extruded the long way (the full ridge) instead of as a thin end cap.
function buildHitbox(x, z, hx, hz, top, rotY = 0, shape = "box", wallTop) {
  if (shape === "roofPrism") {
    const roofShape = new THREE.Shape();
    roofShape.moveTo(-hz, wallTop);
    roofShape.lineTo(hz, wallTop);
    roofShape.lineTo(0, top);
    roofShape.closePath();
    const geo = new THREE.ExtrudeGeometry(roofShape, { depth: hx * 2, bevelEnabled: false });
    geo.translate(0, 0, -hx); // center the extrusion (it's built from local z=0 to z=hx*2)
    const hitbox = new THREE.Mesh(geo, HITBOX_MAT);
    hitbox.position.set(x, 0, z); // shape's own y-coordinates already encode absolute world height
    // Extrusion runs along local Z by default; rotating 90° about Y maps that to the ridge's
    // own X axis. Both this fixed orientation fix and the building's own placement rotation
    // are rotations about the same (Y) axis, so they simply add.
    hitbox.rotation.y = Math.PI / 2 + rotY;
    hitbox.visible = false;
    hitbox.renderOrder = 999;
    return hitbox;
  }
  if (shape === "ramp") {
    // A one-directional staircase ramp — low at local z=-hz (height wallTop), high at local
    // z=+hz (height top) — a right triangle, unlike roofPrism's isosceles ridge shape (which
    // peaks at the *center* and slopes down both ways, correct for a gable roof but wrong for
    // a staircase that only ever climbs in one direction).
    const rampShape = new THREE.Shape();
    rampShape.moveTo(-hz, wallTop);
    rampShape.lineTo(hz, top);
    rampShape.lineTo(hz, wallTop);
    rampShape.closePath();
    const geo = new THREE.ExtrudeGeometry(rampShape, { depth: hx * 2, bevelEnabled: false });
    geo.translate(0, 0, -hx);
    const hitbox = new THREE.Mesh(geo, HITBOX_MAT);
    hitbox.position.set(x, 0, z);
    hitbox.rotation.y = Math.PI / 2 + rotY;
    hitbox.visible = false;
    hitbox.renderOrder = 999;
    return hitbox;
  }
  const geo = shape === "ellipse" ? ELLIPSE_HITBOX_GEO : new THREE.BoxGeometry(hx * 2, top, hz * 2);
  const hitbox = new THREE.Mesh(geo, HITBOX_MAT);
  if (shape === "ellipse") hitbox.scale.set(hx, top, hz);
  hitbox.position.set(x, top / 2, z);
  hitbox.rotation.y = rotY;
  hitbox.visible = false;
  hitbox.renderOrder = 999; // draw on top, after depthTest:false already lets it show through
  return hitbox;
}

// Dev tool: toggles every obstacle's collision-box wireframe on/off at once — see main.js's
// F4 handler. Called again after every loadMap() so switching maps doesn't silently reset a
// currently-active overlay back off (a fresh buildWorld() call makes new hitboxes, which
// default to hidden same as always).
export function setHitboxesVisible(obstacles, visible) {
  for (const o of obstacles) {
    if (o.hitboxMesh) o.hitboxMesh.visible = visible;
  }
}

// Most maps share the default arena footprint and the same collision/spawn math; a map can
// opt into a larger one via `arenaBound` (see buildWorld) — either way, randomSpawnPoint()
// (entities.js) and the collision helpers below take the effective bound as a parameter
// rather than assuming the fixed export, so picking a map never needs to touch them.

// Places a small group of obstacles as a single named "cluster" — buildings/cars oriented
// relative to EACH OTHER (a settlement facing a shared clearing, a ruin with a car blocking
// its alley) rather than scattered independently with arbitrary absolute coordinates. `items`
// are authored in the cluster's own local space (local +Z is the cluster's "forward"); this
// rotates and offsets each item by the cluster's placement (originX, originZ, rotY) and
// returns plain obstacleLayout entries, so a cluster is authored once and dropped into a map
// at a single anchor point/rotation like a stamp.
function cluster(originX, originZ, rotY, items) {
  const cosR = Math.cos(rotY);
  const sinR = Math.sin(rotY);
  return items.map(({ x, z, rotY: localRotY, ...rest }) => ({
    ...rest,
    x: originX + x * cosR - z * sinR,
    z: originZ + x * sinR + z * cosR,
    rotY: (localRotY || 0) + rotY,
  }));
}

// Own small local constants rather than reusing buildMultiStoryBuilding's WALL_HALF_THICKNESS/
// DOOR_GAP_HALF_WIDTH (same values, deliberately duplicated) — those are declared much later in
// this file, and `room()` gets called from inside a map's `obstacleLayout` array literal, which
// (like `cluster()` calls already do) executes immediately as part of evaluating the top-level
// `MAPS` object — a `const` declared later in the file wouldn't exist yet at that point (a real
// temporal-dead-zone hazard, unlike a `function` declaration, which is fully hoisted regardless
// of where it's written).
const ROOM_WALL_HALF_THICKNESS = 0.12;
const ROOM_DOOR_GAP_HALF_WIDTH = 0.85; // total 1.7 units — comfortably more than 2x the player's 0.9 diameter

// Authors one rectangular room's four walls as plain `{type:"wall"}` obstacleLayout entries —
// a pure data generator, same spirit as `cluster()` above, not a mesh builder. `doorSides` is a
// subset of ["north","south","east","west"] (local axes, before rotY); each listed side gets a
// real door-width gap (split into two wall segments), everything else is one solid piece. A
// room never builds a "corridor" of its own — the corridor is just the open floor space a row
// of rooms' doorways face onto, exactly like the Urban map's streets are just open ground
// between building blocks.
function room(x, z, hx, hz, rotY, doorSides = []) {
  const has = (side) => doorSides.includes(side);
  const segs = [];
  const addWall = (localX, localZ, wHx, wHz) => {
    const off = localOffsetToWorld(localX, localZ, rotY);
    segs.push({ x: x + off.x, z: z + off.z, hx: wHx, hz: wHz, rotY, type: "wall" });
  };
  // `axisIsX`: true for north/south (the wall runs along local X, so a door gap splits it along
  // X); false for east/west (runs along local Z, split along Z).
  const addSide = (side, wallLocalPos, span, axisIsX) => {
    if (has(side)) {
      const half = (span - ROOM_DOOR_GAP_HALF_WIDTH) / 2;
      if (half > 0.1) {
        if (axisIsX) {
          addWall(-(ROOM_DOOR_GAP_HALF_WIDTH + half), wallLocalPos, half, ROOM_WALL_HALF_THICKNESS);
          addWall(ROOM_DOOR_GAP_HALF_WIDTH + half, wallLocalPos, half, ROOM_WALL_HALF_THICKNESS);
        } else {
          addWall(wallLocalPos, -(ROOM_DOOR_GAP_HALF_WIDTH + half), ROOM_WALL_HALF_THICKNESS, half);
          addWall(wallLocalPos, ROOM_DOOR_GAP_HALF_WIDTH + half, ROOM_WALL_HALF_THICKNESS, half);
        }
      }
    } else if (axisIsX) {
      addWall(0, wallLocalPos, span, ROOM_WALL_HALF_THICKNESS);
    } else {
      addWall(wallLocalPos, 0, ROOM_WALL_HALF_THICKNESS, span);
    }
  };
  addSide("north", hz - ROOM_WALL_HALF_THICKNESS, hx, true);
  addSide("south", -(hz - ROOM_WALL_HALF_THICKNESS), hx, true);
  addSide("east", hx - ROOM_WALL_HALF_THICKNESS, hz, false);
  addSide("west", -(hx - ROOM_WALL_HALF_THICKNESS), hz, false);
  return segs;
}

export const MAPS = {
  grassland: {
    id: "grassland",
    name: "Grassland Perimeter",
    description: "The original arena — open fields, moderate cover, a balanced all-rounder.",
    groundColor: 0xffffff,
    groundTextured: true,
    sky: { top: 0x4a90d6, bottom: 0xe8f3ff, body: "sun", cloudColor: 0xffffff, cloudCount: 12 },
    fog: { color: 0xcfe4f2, density: 0.0065 },
    hemi: { sky: 0xbfddf5, ground: 0x4a5a34, intensity: 1.1 },
    sun: { color: 0xfff3d8, intensity: 2.1 },
    wallColor: 0x8a8878,
    rockTint: 0xa89a86,
    rockEmissive: 0x1c1712,
    treeTrunkColor: 0x5b3d24,
    treeFoliageColor: 0x2f6b34,
    obstacleLayout: [
      { x: 10, z: 6, hx: 1.5, hz: 1.5, h: 1.6 },
      { x: -12, z: 9, hx: 1.5, hz: 1.5, h: 1.6 },
      { x: 6, z: -14, hx: 2, hz: 2, h: 1.8 },
      { x: -8, z: -16, hx: 1.5, hz: 1.5, h: 1.6 },
      { x: 20, z: -6, hx: 1.8, hz: 1.8, h: 1.8 },
      { x: -22, z: -4, hx: 1.8, hz: 1.8, h: 1.8 },
      { x: 16, z: 20, hx: 2, hz: 2, h: 1.8 },
      { x: -18, z: 18, hx: 1.5, hz: 1.5, h: 1.6 },
      { x: 0, z: 26, hx: 3, hz: 1.2, h: 1.4 },
      { x: 2, z: -28, hx: 3, hz: 1.2, h: 1.4 },
      { x: -28, z: 2, hx: 1.2, hz: 3, h: 1.4 },
      { x: 28, z: -18, hx: 1.2, hz: 3, h: 1.4 },
      // A couple of abandoned cars parked in the open field, for close-range cover variety.
      { x: -4, z: -2, type: "car", rotY: 0.3 },
      { x: 9, z: -3, type: "car", rotY: -1.2 },
    ],
    treeLayout: [
      { x: 15, z: 14, s: 1.1 }, { x: -20, z: 22, s: 0.9 }, { x: 24, z: 2, s: 1.2 },
      { x: -6, z: -8, s: 0.85 }, { x: -30, z: -14, s: 1.05 }, { x: 8, z: -22, s: 1.0 },
      { x: -14, z: -26, s: 0.95 }, { x: 30, z: 20, s: 1.15 }, { x: -4, z: 32, s: 1.0 },
      { x: 18, z: -30, s: 0.9 }, { x: -32, z: 8, s: 1.1 }, { x: 4, z: 18, s: 0.95 },
      { x: -22, z: -22, s: 1.05 }, { x: 33, z: -6, s: 0.9 }, { x: -10, z: 5, s: 0.85 },
      { x: 12, z: 32, s: 1.0 }, { x: -34, z: -30, s: 1.1 }, { x: 26, z: -20, s: 0.95 },
      { x: -18, z: 34, s: 0.9 }, { x: 34, z: 32, s: 1.05 },
    ],
  },

  frostbite: {
    id: "frostbite",
    name: "Frostbite Hollow",
    description: "A snowbound, wide-open expanse — sparse cover rewards long sightlines.",
    groundColor: 0xe4eef2,
    groundTextured: false,
    sky: { top: 0x8fb8d9, bottom: 0xf3f8fb, body: "sun", cloudColor: 0xeaf2f7, cloudCount: 18 }, // heavier overcast cloud cover to match the hazy winter light
    fog: { color: 0xdce8ef, density: 0.004 }, // thinner than grassland — long sniper sightlines
    hemi: { sky: 0xcfe6f2, ground: 0x9fb0b8, intensity: 1.2 },
    sun: { color: 0xdcefff, intensity: 1.7 }, // hazy overcast winter light
    wallColor: 0xaeb8bd,
    rockTint: 0xc7d3d8,
    rockEmissive: 0x141a1e,
    treeTrunkColor: 0x4a3f38,
    treeFoliageColor: 0xdbe6ec, // snow-dusted pine
    buildingWallColor: 0xcbd6da,
    buildingRoofColor: 0x8a949a,
    buildingTrimColor: 0x2a2420,
    // Few, large, widely-spaced formations — open lanes between them for sniper/AK duels.
    obstacleLayout: [
      { x: 18, z: 16, hx: 2.2, hz: 2.2, h: 2.0 },
      { x: -20, z: -14, hx: 2.2, hz: 2.2, h: 2.0 },
      { x: -16, z: 22, hx: 1.8, hz: 1.8, h: 1.7 },
      { x: 20, z: -20, hx: 1.8, hz: 1.8, h: 1.7 },
      { x: 0, z: 0, hx: 1.4, hz: 1.4, h: 1.5 },
      { x: -30, z: 6, hx: 1.5, hz: 3, h: 1.6 },
      { x: 30, z: -6, hx: 1.5, hz: 3, h: 1.6 },
      // A single isolated cabin — a bit of shelter/flavor without diluting the open layout.
      { x: -10, z: -4, type: "building", hx: 2, hz: 1.8, h: 2.6 },
    ],
    treeLayout: [
      { x: 26, z: 30, s: 1.1 }, { x: -28, z: -30, s: 1.0 }, { x: -32, z: 24, s: 0.9 },
      { x: 32, z: -26, s: 1.05 }, { x: 6, z: -32, s: 0.95 }, { x: -6, z: 32, s: 1.0 },
      { x: -34, z: -4, s: 0.9 }, { x: 34, z: 4, s: 1.1 },
    ],
  },

  dunes: {
    id: "dunes",
    name: "Sundrift Dunes",
    description: "Sun-scorched sandstone clusters and abandoned outposts sprawl across open desert.",
    arenaBound: 96,
    groundColor: 0xd9b877,
    groundTextured: false,
    sky: { top: 0xf2a65a, bottom: 0xffe3b0, body: "sun", cloudColor: 0xffdca8, cloudCount: 5 }, // clear desert sky — a few sparse, warm-tinted wisps
    fog: { color: 0xe8c48a, density: 0.008 }, // dusty heat haze
    hemi: { sky: 0xffdca0, ground: 0xb08850, intensity: 1.15 },
    sun: { color: 0xffe6b3, intensity: 2.3 }, // harsh, bright desert sun
    wallColor: 0xc9a876,
    rockTint: 0xcaa06a,
    rockEmissive: 0x241a0e,
    treeTrunkColor: 0x5b3d24,
    treeFoliageColor: 0x2f6b34, // unused — no trees on this map
    buildingWallColor: 0xdcc290,
    buildingRoofColor: 0x8a6a45,
    buildingTrimColor: 0x3a2a1a,
    // A handful of larger clustered rock formations forming pinch-point corridors, plus one
    // abandoned settlement — three buildings facing a shared courtyard with a car parked
    // between them, authored as a single cluster() stamp rather than scattered independently.
    obstacleLayout: [
      { x: 8, z: 8, hx: 2, hz: 2, h: 2.0 },
      { x: 12, z: 3, hx: 1.6, hz: 1.6, h: 1.8 },
      { x: -10, z: -8, hx: 2, hz: 2, h: 2.0 },
      { x: -14, z: -3, hx: 1.6, hz: 1.6, h: 1.8 },
      { x: -8, z: 14, hx: 1.8, hz: 1.8, h: 1.9 },
      { x: 10, z: -16, hx: 1.8, hz: 1.8, h: 1.9 },
      { x: 22, z: -10, hx: 2.2, hz: 2.2, h: 2.1 },
      { x: -22, z: 12, hx: 2.2, hz: 2.2, h: 2.1 },
      { x: 0, z: -26, hx: 2.5, hz: 1.3, h: 1.6 },
      { x: 0, z: 26, hx: 2.5, hz: 1.3, h: 1.6 },
      { x: -38, z: -2, hx: 2, hz: 2, h: 2.0 },
      { x: 38, z: 6, hx: 2, hz: 2, h: 2.0 },
      { x: 6, z: -40, hx: 2.2, hz: 1.4, h: 1.7 },
      { x: -6, z: 40, hx: 2.2, hz: 1.4, h: 1.7 },
      // The doubled arena needs a whole further-out ring of formations, not just a couple —
      // otherwise the middle 90 units are developed and the outer half is bare sand.
      { x: 62, z: 28, hx: 2.2, hz: 2.2, h: 2.1 },
      { x: -62, z: -28, hx: 2.2, hz: 2.2, h: 2.1 },
      { x: 28, z: 66, hx: 2, hz: 2, h: 2.0 },
      { x: -28, z: -66, hx: 2, hz: 2, h: 2.0 },
      { x: 74, z: -10, hx: 2.3, hz: 1.5, h: 1.9 },
      { x: -74, z: 10, hx: 2.3, hz: 1.5, h: 1.9 },
      { x: 10, z: -74, hx: 1.6, hz: 2.4, h: 1.9 },
      { x: -10, z: 74, hx: 1.6, hz: 2.4, h: 1.9 },
      ...cluster(14, 14, 0.5, [
        { x: 0, z: -6, type: "building", hx: 2.5, hz: 2, h: 3.2 },
        { x: -6.5, z: 3, type: "building", hx: 2, hz: 2.2, h: 2.8, rotY: -2.2 },
        { x: 6.5, z: 4, type: "building", hx: 2, hz: 2.2, h: 2.8, rotY: 2.2 },
        { x: 0.5, z: -1, type: "car", rotY: 0.2 },
      ]),
      // A second, smaller settlement out in the new far ring — two buildings and a car.
      ...cluster(55, -50, -0.8, [
        { x: 0, z: -5, type: "building", hx: 2.2, hz: 2, h: 2.9 },
        { x: 6, z: 3, type: "building", hx: 1.8, hz: 2, h: 2.6, rotY: -2.0 },
        { x: 1, z: -1, type: "car", rotY: 0.3 },
      ]),
      // A single isolated outpost building further still.
      ...cluster(-58, 55, 0.4, [{ x: 0, z: 0, type: "building", hx: 2, hz: 2, h: 2.6 }]),
    ],
    treeLayout: [],
  },

  nightfall: {
    id: "nightfall",
    name: "Nightfall Thicket",
    description: "A sprawling, moonlit forest maze with ruined outposts — short sightlines, close-quarters combat.",
    arenaBound: 96,
    groundColor: 0x2a3038,
    groundTextured: false,
    sky: { top: 0x0d1220, bottom: 0x2a3a55, body: "moon", cloudColor: 0x2c3958, cloudCount: 8 }, // dim, dark-tinted night clouds — moonlit, not moonlit-white
    fog: { color: 0x1c2436, density: 0.012 }, // thicker fog — deliberately short visibility
    hemi: { sky: 0x3a4a6a, ground: 0x20242c, intensity: 0.95 },
    sun: { color: 0x9fb8ff, intensity: 1.6 }, // brighter moonlight — dim/cool, but enough to actually see by
    wallColor: 0x3a3f48,
    rockTint: 0x4a4f58,
    rockEmissive: 0x0a0c10,
    treeTrunkColor: 0x1c1712,
    treeFoliageColor: 0x1f3a24,
    buildingWallColor: 0x3a3f48,
    buildingRoofColor: 0x24282e,
    buildingTrimColor: 0x0a0c10,
    // More obstacles and trees than any other map, packed closer together — a tight maze.
    // A couple of dark, ruined structures are worked into the maze for close-range ambushes.
    obstacleLayout: [
      { x: 8, z: 6, hx: 1.3, hz: 1.3, h: 1.6 },
      { x: -9, z: 7, hx: 1.3, hz: 1.3, h: 1.6 },
      { x: 6, z: -8, hx: 1.3, hz: 1.3, h: 1.6 },
      { x: -7, z: -9, hx: 1.3, hz: 1.3, h: 1.6 },
      { x: 16, z: 2, hx: 1.4, hz: 1.4, h: 1.7 },
      { x: -16, z: -2, hx: 1.4, hz: 1.4, h: 1.7 },
      { x: 2, z: 16, hx: 1.4, hz: 1.4, h: 1.7 },
      { x: -2, z: -16, hx: 1.4, hz: 1.4, h: 1.7 },
      { x: 18, z: 18, hx: 1.6, hz: 1.6, h: 1.8 },
      { x: -18, z: -18, hx: 1.6, hz: 1.6, h: 1.8 },
      { x: 18, z: -18, hx: 1.6, hz: 1.6, h: 1.8 },
      { x: -18, z: 18, hx: 1.6, hz: 1.6, h: 1.8 },
      { x: 26, z: 0, hx: 1.3, hz: 1.3, h: 1.6 },
      { x: -26, z: 0, hx: 1.3, hz: 1.3, h: 1.6 },
      { x: 0, z: 26, hx: 1.3, hz: 1.3, h: 1.6 },
      { x: 0, z: -26, hx: 1.3, hz: 1.3, h: 1.6 },
      { x: -40, z: 6, hx: 1.5, hz: 1.5, h: 1.7 },
      { x: 40, z: -6, hx: 1.5, hz: 1.5, h: 1.7 },
      // The doubled arena needs the maze density to keep going, not just a couple of extra
      // rocks — a further-out ring continuing the same grid pattern, well clear of the
      // existing tree ring (which tops out around radius ~33).
      { x: 55, z: 0, hx: 1.5, hz: 1.5, h: 1.7 },
      { x: -55, z: 0, hx: 1.5, hz: 1.5, h: 1.7 },
      { x: 0, z: 55, hx: 1.5, hz: 1.5, h: 1.7 },
      { x: 0, z: -55, hx: 1.5, hz: 1.5, h: 1.7 },
      { x: 40, z: 40, hx: 1.4, hz: 1.4, h: 1.7 },
      { x: -40, z: -40, hx: 1.4, hz: 1.4, h: 1.7 },
      { x: 40, z: -40, hx: 1.4, hz: 1.4, h: 1.7 },
      { x: -40, z: 40, hx: 1.4, hz: 1.4, h: 1.7 },
      { x: 80, z: 12, hx: 1.5, hz: 1.5, h: 1.7 },
      { x: -80, z: -12, hx: 1.5, hz: 1.5, h: 1.7 },
      // A larger ruined-outpost cluster (two buildings facing a narrow alley, with a wrecked
      // car turned sideways blocking it) plus two smaller single-building ruins elsewhere in
      // the maze, all authored as cluster() stamps instead of independently-placed props.
      ...cluster(-14, 34, 0.5, [
        { x: -3.5, z: 0, type: "building", hx: 1.8, hz: 1.8, h: 2.4 },
        { x: 3.5, z: 1, type: "building", hx: 1.6, hz: 2, h: 2.2, rotY: -0.4 },
        { x: 0, z: -3, type: "car", rotY: 1.5 },
      ]),
      ...cluster(30, -14, -0.3, [{ x: 0, z: 0, type: "building", hx: 1.8, hz: 1.8, h: 2.4 }]),
      ...cluster(62, 60, 1.2, [
        { x: -3.5, z: 0, type: "building", hx: 1.7, hz: 1.8, h: 2.3 },
        { x: 3.5, z: 1, type: "building", hx: 1.6, hz: 1.8, h: 2.2, rotY: -0.4 },
        { x: 0, z: -3, type: "car", rotY: 1.1 },
      ]),
      ...cluster(-65, -58, -0.6, [{ x: 0, z: 0, type: "building", hx: 1.8, hz: 1.8, h: 2.4 }]),
    ],
    treeLayout: [
      { x: 12, z: -4, s: 0.9 }, { x: -12, z: 4, s: 0.9 }, { x: 4, z: 12, s: 0.85 },
      { x: -4, z: -12, s: 0.85 }, { x: 22, z: 10, s: 1.0 }, { x: -22, z: -10, s: 1.0 },
      { x: 10, z: -22, s: 0.95 }, { x: -10, z: 22, s: 0.95 }, { x: 30, z: -12, s: 1.05 },
      { x: -30, z: 12, s: 1.05 }, { x: 12, z: 30, s: 0.9 }, { x: -12, z: -30, s: 0.9 },
      { x: 28, z: 24, s: 1.0 }, { x: -28, z: -24, s: 1.0 }, { x: 24, z: -28, s: 0.95 },
      { x: -24, z: 28, s: 0.95 }, { x: 32, z: 4, s: 0.85 }, { x: -32, z: -4, s: 0.85 },
      { x: 4, z: 32, s: 0.85 }, { x: -4, z: -32, s: 0.85 },
      { x: 6, z: -42, s: 1.0 }, { x: -6, z: 42, s: 1.0 }, { x: 42, z: 16, s: 0.9 }, { x: -42, z: -16, s: 0.9 },
      // Further-out grove continuing the density into the new outer half of the arena.
      { x: 50, z: -22, s: 1.0 }, { x: -50, z: 22, s: 1.0 }, { x: 22, z: -50, s: 0.95 }, { x: -22, z: 50, s: 0.95 },
      { x: 65, z: 8, s: 0.9 }, { x: -65, z: -8, s: 0.9 }, { x: 8, z: 65, s: 0.85 }, { x: -8, z: -65, s: 0.85 },
      { x: 70, z: -35, s: 1.0 }, { x: -70, z: 35, s: 1.0 }, { x: 35, z: 70, s: 0.95 }, { x: -35, z: -70, s: 0.95 },
      { x: 85, z: 5, s: 0.9 }, { x: -85, z: -5, s: 0.9 }, { x: 5, z: 85, s: 0.85 }, { x: -5, z: -85, s: 0.85 },
    ],
  },

  urban: {
    id: "urban",
    name: "Perimeter Heights",
    description: "A small city block — paved streets, parked cars, and buildings you can actually walk (and climb) into.",
    // No arenaBound override — same small footprint as Grassland/Frostbite, not the bigger
    // Dunes/Nightfall arenas.
    groundColor: 0x6b6a5c,
    groundTextured: false,
    sky: { top: 0x5a9bd6, bottom: 0xe6f0f7, body: "sun", cloudColor: 0xffffff, cloudCount: 10 },
    fog: { color: 0xd8e2ea, density: 0.006 },
    hemi: { sky: 0xb8d4e8, ground: 0x4a4a42, intensity: 1.15 },
    sun: { color: 0xfff0d8, intensity: 2.0 },
    wallColor: 0x8a8478,
    rockTint: 0x8a8478,
    rockEmissive: 0x1a1814,
    treeTrunkColor: 0x4a3524,
    treeFoliageColor: 0x3a6b3a,
    buildingWallColor: 0xc9beac,
    buildingRoofColor: 0x7a4a3a,
    buildingTrimColor: 0x2a2620,
    streetColor: 0x3a3a3e,
    sidewalkColor: 0x9a9690,
    // A "+" crossing through the map center dividing it into 4 city blocks.
    streetLayout: [
      { x: 0, z: 0, width: 9, length: 72, rotY: 0 },
      { x: 0, z: 0, width: 9, length: 72, rotY: Math.PI / 2 },
    ],
    obstacleLayout: [
      // NE block — a 2-story building + parked car.
      ...cluster(16, 16, 0, [
        { x: 0, z: 0, type: "building", hx: 3.4, hz: 3.2, stories: 2 },
        { x: 5.8, z: -1, type: "car", rotY: 0.2 },
      ]),
      // NW block — a small 1-story shop + car (still the existing single-story path — no
      // `stories` field, byte-identical to how every other map's buildings already work).
      ...cluster(-16, 16, 1.6, [
        { x: 0, z: 0, type: "building", hx: 2.4, hz: 2.2, h: 2.6 },
        { x: 4.6, z: 1.6, type: "car", rotY: -0.3 },
      ]),
      // SE block — the 3-story landmark.
      ...cluster(16, -16, -1.0, [
        { x: 0, z: 0, type: "building", hx: 3.6, hz: 3.4, stories: 3 },
        { x: -5.8, z: 1, type: "car", rotY: 1.4 },
      ]),
      // SW block — a 2-story building + two cars.
      ...cluster(-16, -16, 2.4, [
        { x: 0, z: 0, type: "building", hx: 3.2, hz: 3, stories: 2 },
        { x: 5.2, z: 3.2, type: "car", rotY: 0.5 },
        { x: 5.2, z: -3.2, type: "car", rotY: -0.5 },
      ]),
      // A couple of standalone shops out toward the corners, and a few roadside cars not tied
      // to any block, for a less uniform street-level feel.
      { x: 28, z: 4, type: "building", hx: 2, hz: 1.8, h: 2.6, rotY: 0.4 },
      { x: -6, z: 29, type: "building", hx: 2, hz: 2, h: 2.6, rotY: -0.6 },
      { x: 4.8, z: 26, type: "car", rotY: 0 },
      { x: -4.8, z: -27, type: "car", rotY: Math.PI },
    ],
    // Sparse street trees — a city block, not Grassland's forest.
    treeLayout: [
      { x: 30, z: -20, s: 1.0 }, { x: -30, z: 22, s: 0.95 }, { x: 24, z: 30, s: 1.05 },
      { x: -28, z: -30, s: 1.0 }, { x: 2, z: -33, s: 0.9 }, { x: -2, z: 33, s: 0.9 },
    ],
  },

  hospital: {
    id: "hospital",
    name: "St. Perimeter Medical",
    description: "A fully indoor hospital floor — corridors, patient rooms, and an OR. No outdoor space at all.",
    // No arenaBound override — same small footprint as Grassland/Frostbite/Urban.
    ceiling: true, // caps the whole arena at wall height — see buildWorld's ceiling block
    groundColor: 0xd8dcd6,
    groundTextured: false,
    // Sky/fog/hemi/sun still need real values (every map config expects them, and the outer
    // walls + ceiling are what actually keep them from ever being seen) — kept dim/cool since
    // the ceiling blocks the sun entirely; the interior lights below carry the actual lighting.
    sky: { top: 0x9fb0b8, bottom: 0xc8d2d4, body: "sun", cloudColor: 0xffffff, cloudCount: 4 },
    fog: { color: 0xc8d2d4, density: 0.01 },
    hemi: { sky: 0x8fa0a8, ground: 0x707868, intensity: 0.55 },
    sun: { color: 0xdce8ec, intensity: 0.4 },
    wallColor: 0xe8ece6, // pale sterile wall/ceiling tone
    rockTint: 0xe8ece6,
    rockEmissive: 0x1a1c18,
    treeTrunkColor: 0x4a3524,
    treeFoliageColor: 0x3a6b3a, // unused — no trees indoors
    // A main corridor along X (z in [-3,3]) crosses a corridor along Z (x in [-3,3]); every
    // room's doorway opens directly onto whichever corridor arm it lines, so the corridors
    // themselves need no walls of their own (see room()'s comment). East/west-wing rooms are
    // kept to |z|<=9 and north/south-wing rooms to |x|<=9, each starting no closer than |x| or
    // |z|=9.5 respectively — verified by hand as non-overlapping bounding boxes (an earlier
    // draft placed a north-wing room and an east-wing room close enough to the intersection
    // that their footprints actually overlapped, so one room's solid wall silently cut through
    // the other's interior — see this round's memory entry for how that was caught).
    obstacleLayout: [
      // East wing (main corridor, +X)
      ...room(13, 6, 3.5, 3, 0, ["south"]), // Reception / waiting area
      ...room(13, -6, 3, 3, 0, ["north"]), // Patient Room B
      ...room(23, 6, 3, 3, 0, ["south"]), // Nurses' Station
      ...room(23, -6, 3, 3, 0, ["north"]), // Patient Room A
      // West wing (main corridor, -X)
      ...room(-13, 6, 3, 3, 0, ["south"]), // Patient Room C
      ...room(-13, -6, 3, 3, 0, ["north"]), // Break Room
      // North wing (cross corridor, +Z)
      ...room(6, 13, 3, 3.5, 0, ["west"]), // Operating Room
      ...room(-6, 13, 2.2, 2.2, 0, ["east"]), // Supply Closet
      // South wing (cross corridor, -Z)
      ...room(6, -13, 3, 3, 0, ["west"]), // Patient Room D
      ...room(-6, -13, 2.5, 2.5, 0, ["east"]), // Morgue / storage
    ],
    treeLayout: [],
    // A row of fixtures down each corridor arm plus one inside every room — cool white-blue
    // "fluorescent" tone, no shadows (cheap, matches this project's other small point lights —
    // muzzle flash, mine, rocket glow).
    interiorLights: [
      { x: 0, z: 0 }, { x: 7, z: 0 }, { x: 13, z: 0 }, { x: 18, z: 0 }, { x: 23, z: 0 },
      { x: -7, z: 0 }, { x: -13, z: 0 }, { x: -18, z: 0 },
      { x: 0, z: 7 }, { x: 0, z: 13 }, { x: 0, z: -7 }, { x: 0, z: -13 },
      { x: 13, z: 6 }, { x: 13, z: -6 }, { x: 23, z: 6 }, { x: 23, z: -6 },
      { x: -13, z: 6 }, { x: -13, z: -6 },
      { x: 6, z: 13 }, { x: -6, z: 13 }, { x: 6, z: -13 }, { x: -6, z: -13 },
    ].map((l) => ({ ...l, color: 0xdceeff, intensity: 1.9, distance: 13 })),
  },
};

export const DEFAULT_MAP_ID = "grassland";
export function getMapDef(mapId) {
  return MAPS[mapId] || MAPS[DEFAULT_MAP_ID];
}

function buildBoxMesh(hx, hz, h, color) {
  const geo = new THREE.BoxGeometry(hx * 2, h, hz * 2);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = h / 2;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Two sculpted rock models (public/models/Rock 1.obj, Rock 2.obj) replace the procedural
// boulder below once loaded — each file's vertex data is already recentered on its own bounding
// box and scaled to a [-1,1] unit cube (done once, offline), so it's a drop-in swap for the
// same mesh.scale.set(hx, h/2, hz) math the procedural rock already used. Loaded once at app
// startup (see preloadRockModels, called fire-and-forget from main.js — same pattern as
// preloadCharacterModel in humanoidParts.js) rather than per-rock, since buildWorld/buildRockMesh
// run synchronously and OBJLoader is inherently async. Falls back to the procedural boulder
// below if the preload hasn't finished (or failed) by the time a rock is actually built.
const ROCK_MODEL_FILES = ["/models/Rock 1.obj", "/models/Rock 2.obj"];
let rockModelGeometries = null;

export async function preloadRockModels() {
  try {
    const loader = new OBJLoader();
    const groups = await Promise.all(ROCK_MODEL_FILES.map((url) => loader.loadAsync(url)));
    const geometries = groups.map((group) => {
      let geo = null;
      group.traverse((child) => {
        if (child.isMesh && !geo) geo = child.geometry;
      });
      return geo;
    });
    if (geometries.every(Boolean)) rockModelGeometries = geometries;
    else console.warn("Rock model preload missing mesh geometry, falling back to procedural rocks.");
  } catch (err) {
    console.warn("Rock model preload failed, falling back to procedural rocks.", err);
  }
}

// Low-poly boulder: an icosahedron with per-vertex radial jitter (breaks the symmetric-ball
// look) and per-face flat-color shading (cheap blotchy stone texture, no texture map).
// The collision footprint stays the plain hx/hz/h box in the obstacles list — only the visual
// is rock-shaped, so resolveCollisions/getGroundHeight don't need to know about the geometry.
//
// IcosahedronGeometry builds a NON-INDEXED buffer: corners shared by adjacent faces are stored
// as separate, duplicate position entries. Jittering each buffer entry independently (the old
// approach) moved each face's copy of a shared corner by a different random amount, so faces
// that used to meet exactly pulled apart into visible cracks. To keep the boulder watertight,
// every duplicate of the same original corner must be displaced by the *same* jittered position,
// so we weld them by a rounded-coordinate key before jittering, then write the shared result
// back to every buffer slot that had that key.
function buildRockMesh(hx, hz, h, tint, emissive, variantIndex = 0) {
  if (rockModelGeometries && rockModelGeometries.length) {
    const geo = rockModelGeometries[variantIndex % rockModelGeometries.length].clone();
    const mat = new THREE.MeshStandardMaterial({
      color: tint,
      roughness: 0.88,
      metalness: 0.02,
      flatShading: true,
      emissive,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.set(hx, h / 2, hz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.rockKind = "model";
    return mesh;
  }
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  const jitterByKey = new Map();
  const keyOf = (x, y, z) => `${x.toFixed(4)}|${y.toFixed(4)}|${z.toFixed(4)}`;

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key = keyOf(v.x, v.y, v.z);
    let jittered = jitterByKey.get(key);
    if (!jittered) {
      const bump = 1 + (Math.random() - 0.5) * 0.3;
      jittered = v.clone().multiplyScalar(bump);
      jitterByKey.set(key, jittered);
    }
    pos.setXYZ(i, jittered.x, jittered.y, jittered.z);
  }

  // Flat per-face color (all 3 vertices of a triangle share one shade) so each facet reads as
  // a single solid plate rather than a gradient smeared across it.
  const colors = [];
  for (let i = 0; i < pos.count; i += 3) {
    const shade = 0.85 + Math.random() * 0.4;
    const r = tint.r * shade, g = tint.g * shade, b = tint.b * shade;
    colors.push(r, g, b, r, g, b, r, g, b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.88,
    metalness: 0.02,
    flatShading: true,
    emissive,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(hx, h / 2, hz);
  mesh.position.y = h / 2;
  // Rotation is applied by the caller (buildWorld's obstacle loop), not chosen here — it
  // needs to match whatever rotation the collision hitbox ends up using, and buildRockMesh
  // has no way to communicate a self-chosen value back out.
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.rockKind = "procedural";
  return mesh;
}

// A simple gabled structure: a box body with a pitched two-slope roof, a door, and a row of
// windows on each long face — built from two long half-arena footprint conventions: hx is the
// half-width along the ridge (the building's "length"), hz is the half-depth (front-to-back).
// The roof is two flat slabs meeting at a ridge line rather than a single prism, since that
// keeps the geometry to plain, independently-verifiable box placements (position/rotation
// derived directly from the pitch angle, no compound-rotation reasoning needed) rather than
// fighting a single rotated prism's cross-section into the right orientation.
const ROOF_PITCH = 0.56; // ~32 degrees
const ROOF_OVERHANG_DEPTH = 0.3;
const ROOF_OVERHANG_RIDGE = 0.25;
const ROOF_THICKNESS = 0.12;
const GABLE_THICKNESS = 0.1;

// Returns { group, roofPeakHeight } — roofPeakHeight is exposed so the caller (buildWorld's
// pushRoofPrism) can build a matching triangular-prism collision piece for the sloped roof.
function buildBuildingMesh(hx, hz, h, wallColor, roofColor, trimColor) {
  const group = new THREE.Group();
  const wallMat = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.88, metalness: 0.04 });
  const roofMat = new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.75, metalness: 0.05 });
  const trimMat = new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.6, metalness: 0.1 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, h, hz * 2), wallMat);
  body.position.y = h / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Roof: two slabs, each spanning half the depth (plus eave overhang) and the full ridge
  // length (plus gable overhang), tilted by ROOF_PITCH around the ridge (X) axis. Position and
  // slab length are solved directly from the pitch angle so the two slabs' top edges meet
  // exactly along the ridge line (z=0) and their bottom edges land exactly on the wall-top
  // eave line (y=h, z=±(hz+overhang)) — verified algebraically, not eyeballed.
  const halfDepthWithOverhang = hz + ROOF_OVERHANG_DEPTH;
  const slopeLen = halfDepthWithOverhang / Math.cos(ROOF_PITCH);
  const totalRise = halfDepthWithOverhang * Math.tan(ROOF_PITCH);
  const ridgeLen = hx * 2 + ROOF_OVERHANG_RIDGE * 2;
  const roofSlopeGeo = new THREE.BoxGeometry(ridgeLen, ROOF_THICKNESS, slopeLen);

  const roofFront = new THREE.Mesh(roofSlopeGeo, roofMat);
  roofFront.position.set(0, h + totalRise / 2, halfDepthWithOverhang / 2);
  roofFront.rotation.x = ROOF_PITCH;
  roofFront.castShadow = true;
  group.add(roofFront);

  const roofBack = new THREE.Mesh(roofSlopeGeo, roofMat);
  roofBack.position.set(0, h + totalRise / 2, -halfDepthWithOverhang / 2);
  roofBack.rotation.x = -ROOF_PITCH;
  roofBack.castShadow = true;
  group.add(roofBack);

  // Door + windows on both long (front/back) faces — protrudes slightly past the wall plane
  // (a small epsilon) so it never z-fights with the wall behind it.
  const doorW = Math.min(0.9, hx * 0.5);
  const doorH = Math.min(h * 0.75, 2.1);
  const doorGeo = new THREE.BoxGeometry(doorW, doorH, 0.06);
  const windowGeo = new THREE.BoxGeometry(Math.min(0.6, hx * 0.3), 0.6, 0.05);

  for (const faceZ of [hz + 0.03, -(hz + 0.03)]) {
    const door = new THREE.Mesh(doorGeo, trimMat);
    door.position.set(0, doorH / 2, faceZ);
    group.add(door);

    const windowCount = Math.max(2, Math.floor(hx));
    const windowY = Math.min(h * 0.6, h - 0.5);
    for (let i = 0; i < windowCount; i++) {
      const t = (i + 0.5) / windowCount - 0.5;
      const wx = t * (hx * 2 - 1.2);
      if (Math.abs(wx) < doorW) continue; // skip a window that would overlap the door
      const win = new THREE.Mesh(windowGeo, trimMat);
      win.position.set(wx, windowY, faceZ);
      group.add(win);
    }
  }

  // Gable end caps — triangular wall panels closing the gap between the flat wall-top and
  // the roof ridge at each end of the building. Without these the box body (solid up to
  // height h) and the two roof slabs (meeting only along the ridge, sloping down to the eave
  // lines) leave the two ends of the "attic" completely open — visible as a hole straight
  // through the building when viewed from the side/end. Built as a flat extruded triangle
  // (a real BufferGeometry primitive isn't available for an arbitrary triangle) matching the
  // roof's own eave overhang so it fully covers the gap with no sliver left at the tips.
  const gableShape = new THREE.Shape();
  const gableHalfSpan = hz + ROOF_OVERHANG_DEPTH;
  gableShape.moveTo(-gableHalfSpan, 0);
  gableShape.lineTo(gableHalfSpan, 0);
  gableShape.lineTo(0, totalRise);
  gableShape.closePath();
  const gableGeo = new THREE.ExtrudeGeometry(gableShape, { depth: GABLE_THICKNESS, bevelEnabled: false });
  const gableMat = new THREE.MeshStandardMaterial({
    color: wallColor,
    roughness: 0.88,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });

  const gableEast = new THREE.Mesh(gableGeo, gableMat);
  gableEast.rotation.y = Math.PI / 2;
  gableEast.position.set(hx, h, 0);
  gableEast.castShadow = true;
  group.add(gableEast);

  const gableWest = new THREE.Mesh(gableGeo, gableMat);
  gableWest.rotation.y = Math.PI / 2;
  gableWest.position.set(-hx - GABLE_THICKNESS, h, 0);
  gableWest.castShadow = true;
  group.add(gableWest);

  return { group, roofPeakHeight: h + totalRise };
}

const STORY_HEIGHT = 2.8; // matches this file's existing single-story building height convention
const WALL_HALF_THICKNESS = 0.12; // matches ROOF_THICKNESS — a believably solid-looking wall
const DOOR_GAP_HALF_WIDTH = 0.85; // total 1.7 units — comfortably more than 2x the player's 0.9 diameter
const STAIR_HALF_WIDTH = 0.75;
const STAIR_HALF_RUN = 2.2; // rise (STORY_HEIGHT) over run (2*STAIR_HALF_RUN) gives a slope close to ROOF_PITCH — proven walkable via the roof
const STAIR_GAP_MARGIN = 0.15; // clearance between the stair's own footprint and the floor-slab opening around it
const STAIR_STEP_COUNT = 8;

// A walkable multi-story building: unlike buildBuildingMesh (a single solid box — every
// existing map's buildings stay exactly that, unchanged), this is built from several separate
// wall/floor pieces with real gaps, so the player can actually walk through the door and up the
// stairs instead of the door/windows being cosmetic overlays on an otherwise-solid box. Returns
// `{ group, pieces, roofPeakHeight }` — `pieces` are plain **local-space** descriptors (offsets
// from the building's own center, before the caller's own position/rotY is applied), since this
// function has no idea where in the world the building actually sits; buildWorld's obstacle loop
// rotates each piece's local offset into world space via the existing `localOffsetToWorld` helper
// (the exact same technique it already uses for the car's cabin offset) and pushes it via
// `pushObstaclePiece`/`pushRoofPrism`/`pushRamp`.
//
// Key simplification found while designing this: walls do NOT need to be split per story. A
// wall spans the building's FULL height (ground to roof) and uses the *exact same* `slopeGate`
// release the existing single-story roof already proves works — a player standing on an upper
// floor is only ever near a wall at the floor's own inset interior edge, never inside the wall's
// own (much thinner) footprint band, so the same "released only right at/above the real roof
// height" rule that already works for a single story works unchanged for every story stacked
// under it. Only the floor SLABS (one per internal story boundary) and the STAIR ramps connecting
// them are genuinely new per-story pieces.
function buildMultiStoryBuilding(hx, hz, stories, wallColor, roofColor, trimColor) {
  const group = new THREE.Group();
  const wallMat = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.88, metalness: 0.04 });
  const floorMat = new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.75, metalness: 0.05 });
  const trimMat = new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.6, metalness: 0.1 });
  const stepMat = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.7, metalness: 0.08 });

  const totalHeight = stories * STORY_HEIGHT;
  const pieces = [];

  // --- Exterior walls: full building height, front wall split in two for the entrance gap ---
  const frontHalfW = (hx - DOOR_GAP_HALF_WIDTH) / 2;
  const wallSegs = [
    { localX: -(DOOR_GAP_HALF_WIDTH + frontHalfW), localZ: hz - WALL_HALF_THICKNESS, wHx: frontHalfW, wHz: WALL_HALF_THICKNESS },
    { localX: DOOR_GAP_HALF_WIDTH + frontHalfW, localZ: hz - WALL_HALF_THICKNESS, wHx: frontHalfW, wHz: WALL_HALF_THICKNESS },
    { localX: 0, localZ: -(hz - WALL_HALF_THICKNESS), wHx: hx, wHz: WALL_HALF_THICKNESS },
    { localX: -(hx - WALL_HALF_THICKNESS), localZ: 0, wHx: WALL_HALF_THICKNESS, wHz: hz },
    { localX: hx - WALL_HALF_THICKNESS, localZ: 0, wHx: WALL_HALF_THICKNESS, wHz: hz },
  ];
  for (const seg of wallSegs) {
    const body = new THREE.Mesh(new THREE.BoxGeometry(seg.wHx * 2, totalHeight, seg.wHz * 2), wallMat);
    body.position.set(seg.localX, totalHeight / 2, seg.localZ);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);
    pieces.push({ kind: "wall", localX: seg.localX, localZ: seg.localZ, hx: seg.wHx, hz: seg.wHz, top: totalHeight });
  }

  // A window row on the left/right walls at each story's mid-height — purely decorative, same
  // flat-panel-just-outside-the-wall-plane technique buildBuildingMesh already uses; skipped on
  // the front/back walls since the front already has the real doorway and this keeps the window
  // count (and per-story authoring complexity) modest for a first pass.
  const windowGeo = new THREE.BoxGeometry(0.05, 0.6, Math.min(0.6, hz * 0.3));
  for (let i = 0; i < stories; i++) {
    const winY = i * STORY_HEIGHT + STORY_HEIGHT * 0.55;
    for (const side of [-1, 1]) {
      const win = new THREE.Mesh(windowGeo, trimMat);
      win.position.set(side * (hx + 0.03), winY, 0);
      group.add(win);
    }
  }

  // --- Floor slabs at each internal story boundary, split around a stairwell gap flush
  // against the left wall's inner face ---
  const interiorHx = hx - WALL_HALF_THICKNESS * 2;
  const interiorHz = hz - WALL_HALF_THICKNESS * 2;
  const stairGapMinX = -interiorHx;
  const stairGapMaxX = stairGapMinX + STAIR_HALF_WIDTH * 2 + STAIR_GAP_MARGIN * 2;
  const stairGapHalfD = STAIR_HALF_RUN + STAIR_GAP_MARGIN;
  const stairCenterX = (stairGapMinX + stairGapMaxX) / 2;

  for (let i = 1; i < stories; i++) {
    const floorY = i * STORY_HEIGHT;
    const floorPieces = [];
    // Big piece: everything to the right of the stairwell, full depth.
    const rightHx = (interiorHx - stairGapMaxX) / 2;
    if (rightHx > 0.05) {
      floorPieces.push({ localX: (stairGapMaxX + interiorHx) / 2, localZ: 0, hx: rightHx, hz: interiorHz });
    }
    // Front/back strips over the stairwell's own X-range, outside its Z-range.
    if (interiorHz > stairGapHalfD + 0.05) {
      const stripHz = (interiorHz - stairGapHalfD) / 2;
      const stripHx = (stairGapMaxX - stairGapMinX) / 2;
      floorPieces.push({ localX: stairCenterX, localZ: (stairGapHalfD + interiorHz) / 2, hx: stripHx, hz: stripHz });
      floorPieces.push({ localX: stairCenterX, localZ: -(stairGapHalfD + interiorHz) / 2, hx: stripHx, hz: stripHz });
    }
    for (const fp of floorPieces) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(fp.hx * 2, WALL_HALF_THICKNESS * 2, fp.hz * 2), floorMat);
      slab.position.set(fp.localX, floorY, fp.localZ);
      slab.castShadow = true;
      slab.receiveShadow = true;
      group.add(slab);
      pieces.push({ kind: "floor", localX: fp.localX, localZ: fp.localZ, hx: fp.hx, hz: fp.hz, top: floorY });
    }

    // --- Stair ramp connecting story i-1 to story i, plus a stepped visual on top of the one
    // smooth ramp collision volume (the same simplification the roof's own slope already makes:
    // a more detailed visual riding on one simple collision shape). ---
    const wallTop = floorY - STORY_HEIGHT;
    pieces.push({
      kind: "ramp",
      localX: stairCenterX,
      localZ: 0,
      hx: STAIR_HALF_WIDTH,
      hz: STAIR_HALF_RUN,
      wallTop,
      peakTop: floorY,
    });
    const stepRise = STORY_HEIGHT / STAIR_STEP_COUNT;
    const stepRun = (STAIR_HALF_RUN * 2) / STAIR_STEP_COUNT;
    for (let k = 0; k < STAIR_STEP_COUNT; k++) {
      const stepZ = -STAIR_HALF_RUN + (k + 0.5) * stepRun;
      const stepY = wallTop + (k + 0.5) * stepRise;
      const step = new THREE.Mesh(new THREE.BoxGeometry(STAIR_HALF_WIDTH * 2, stepRise, stepRun), stepMat);
      step.position.set(stairCenterX, stepY, stepZ);
      step.castShadow = true;
      group.add(step);
    }
  }

  // --- Roof on the top story only — identical technique to buildBuildingMesh's roof + gable
  // caps, just built at `totalHeight` instead of a single story's height. Kept as a direct
  // duplicate rather than a shared refactor to avoid touching buildBuildingMesh's proven,
  // already-shipped code for every existing single-story map.
  const halfDepthWithOverhang = hz + ROOF_OVERHANG_DEPTH;
  const slopeLen = halfDepthWithOverhang / Math.cos(ROOF_PITCH);
  const totalRise = halfDepthWithOverhang * Math.tan(ROOF_PITCH);
  const ridgeLen = hx * 2 + ROOF_OVERHANG_RIDGE * 2;
  const roofMat = new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.75, metalness: 0.05 });
  const roofSlopeGeo = new THREE.BoxGeometry(ridgeLen, ROOF_THICKNESS, slopeLen);

  const roofFront = new THREE.Mesh(roofSlopeGeo, roofMat);
  roofFront.position.set(0, totalHeight + totalRise / 2, halfDepthWithOverhang / 2);
  roofFront.rotation.x = ROOF_PITCH;
  roofFront.castShadow = true;
  group.add(roofFront);

  const roofBack = new THREE.Mesh(roofSlopeGeo, roofMat);
  roofBack.position.set(0, totalHeight + totalRise / 2, -halfDepthWithOverhang / 2);
  roofBack.rotation.x = -ROOF_PITCH;
  roofBack.castShadow = true;
  group.add(roofBack);

  const gableShape = new THREE.Shape();
  const gableHalfSpan = hz + ROOF_OVERHANG_DEPTH;
  gableShape.moveTo(-gableHalfSpan, 0);
  gableShape.lineTo(gableHalfSpan, 0);
  gableShape.lineTo(0, totalRise);
  gableShape.closePath();
  const gableGeo = new THREE.ExtrudeGeometry(gableShape, { depth: GABLE_THICKNESS, bevelEnabled: false });
  const gableMat = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.88, metalness: 0.04, side: THREE.DoubleSide });

  const gableEast = new THREE.Mesh(gableGeo, gableMat);
  gableEast.rotation.y = Math.PI / 2;
  gableEast.position.set(hx, totalHeight, 0);
  gableEast.castShadow = true;
  group.add(gableEast);

  const gableWest = new THREE.Mesh(gableGeo, gableMat);
  gableWest.rotation.y = Math.PI / 2;
  gableWest.position.set(-hx - GABLE_THICKNESS, totalHeight, 0);
  gableWest.castShadow = true;
  group.add(gableWest);

  return { group, pieces, roofPeakHeight: totalHeight + totalRise, totalHeight };
}

// A simple sedan: a lower body, a smaller cabin box on top, and four wheels. Faces +Z (its
// "front") by default — callers rotate the returned group to face any direction.
function buildCarMesh(bodyColor) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.45, metalness: 0.35 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x1c2630, roughness: 0.2, metalness: 0.6 });
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x14120f, roughness: 0.9, metalness: 0.1 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x0d0f12, roughness: 0.6, metalness: 0.3 });

  const wheelRadius = 0.35;
  const carWidth = 1.7;
  const carLength = 3.6;

  const lowerBody = new THREE.Mesh(new THREE.BoxGeometry(carWidth, 0.9, carLength), bodyMat);
  lowerBody.position.y = wheelRadius + 0.45;
  lowerBody.castShadow = true;
  group.add(lowerBody);

  const bumperGeo = new THREE.BoxGeometry(carWidth * 0.95, 0.22, 0.18);
  const bumperFront = new THREE.Mesh(bumperGeo, trimMat);
  bumperFront.position.set(0, wheelRadius + 0.25, carLength / 2 - 0.05);
  group.add(bumperFront);
  const bumperBack = new THREE.Mesh(bumperGeo, trimMat);
  bumperBack.position.set(0, wheelRadius + 0.25, -(carLength / 2 - 0.05));
  group.add(bumperBack);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(carWidth * 0.82, 0.55, carLength * 0.5), bodyMat);
  cabin.position.set(0, wheelRadius + 0.9 + 0.275, -carLength * 0.05);
  cabin.castShadow = true;
  group.add(cabin);

  const windshield = new THREE.Mesh(new THREE.BoxGeometry(carWidth * 0.78, 0.5, 0.06), glassMat);
  windshield.position.set(0, wheelRadius + 0.9 + 0.28, -carLength * 0.05 + carLength * 0.25 - 0.03);
  windshield.rotation.x = -0.35;
  group.add(windshield);

  const rearWindow = new THREE.Mesh(new THREE.BoxGeometry(carWidth * 0.78, 0.45, 0.06), glassMat);
  rearWindow.position.set(0, wheelRadius + 0.9 + 0.26, -carLength * 0.05 - carLength * 0.25 + 0.03);
  rearWindow.rotation.x = 0.3;
  group.add(rearWindow);

  const wheelGeo = new THREE.CylinderGeometry(wheelRadius, wheelRadius, 0.26, 12);
  const wheelX = carWidth / 2 + 0.02;
  const wheelZ = carLength / 2 - 0.55;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(sx * wheelX, wheelRadius, sz * wheelZ);
      wheel.castShadow = true;
      group.add(wheel);
    }
  }

  return group;
}

// A soft-edged glowing disc, drawn once per map load onto a canvas (same technique as the
// RemotePlayer name tag — CanvasTexture -> SpriteMaterial -> Sprite, which auto-billboards to
// face the camera for free). "sun" gets a warm core, "moon" a cooler/dimmer one — a plain
// circle-with-halo, no surface texture (an earlier attempt added crater shading; it read as
// lumpy/blobby rather than a clean disc, so it was removed).
function buildCelestialSprite(body) {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const c = size / 2;

  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  if (body === "moon") {
    grad.addColorStop(0, "rgba(240,245,255,1)");
    grad.addColorStop(0.34, "rgba(222,232,250,0.98)");
    grad.addColorStop(0.55, "rgba(180,200,235,0.32)");
    grad.addColorStop(1, "rgba(180,200,235,0)");
  } else {
    grad.addColorStop(0, "rgba(255,253,240,1)");
    grad.addColorStop(0.32, "rgba(255,242,195,1)");
    grad.addColorStop(0.55, "rgba(255,220,140,0.38)");
    grad.addColorStop(1, "rgba(255,220,140,0)");
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  // fog: false — SpriteMaterial applies scene fog by default, and at this placement distance
  // a foggier map's density would wash the sun/moon out almost entirely (verified: Nightfall's
  // density alone reduces visibility to ~0.01% at 250 units under FogExp2's math) — same
  // reasoning the sky dome's own shader already gets for free by never implementing fog at all.
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
  const sprite = new THREE.Sprite(mat);
  const scale = body === "moon" ? 24 : 30;
  sprite.scale.set(scale, scale, 1);
  sprite.renderOrder = -999; // just after the sky dome, well before any real scene geometry
  return sprite;
}

// One shared cloud-puff texture per buildClouds() call — several overlapping soft radial
// blobs make an irregular silhouette instead of one obviously-perfect circle. Reused across
// every cloud sprite for that map (cheap: it's the same CanvasTexture object on every
// material), with each sprite getting its own SpriteMaterial instance so opacity/tint can
// still vary a little per cloud for a less uniform, hand-scattered look.
function buildCloudTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const blobs = [
    [0.5, 0.55, 0.34],
    [0.32, 0.5, 0.24],
    [0.68, 0.5, 0.24],
    [0.42, 0.38, 0.2],
    [0.6, 0.4, 0.2],
    [0.5, 0.66, 0.22],
  ];
  for (const [bx, by, br] of blobs) {
    const cx = bx * size, cy = by * size, r = br * size;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, "rgba(255,255,255,0.95)");
    grad.addColorStop(0.7, "rgba(255,255,255,0.55)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

// Scatters `count` cloud sprites across the upper sky dome at a fixed distance, each with a
// randomized position/size/opacity — purely decorative, so plain Math.random() is fine here
// (unlike rocks/trees, nothing needs to reproduce or match a cloud's placement elsewhere).
// Returns one {sprite, dir, dist} "sky follower" per cloud — see updateSkyFollowers below for
// why these need to be re-centered on the camera every frame rather than left at a fixed
// world position (a big enough arena makes 250 units nowhere near "infinitely far" relative
// to how far the player can actually walk).
function buildClouds(scene, cloudColor, count) {
  const followers = [];
  const texture = buildCloudTexture();
  const color = new THREE.Color(cloudColor);
  // Placement/scale are tied to the camera's actual far plane (main.js: 300), not a "realistic"
  // sky distance — see the celestial sprite's comment for why (a point far beyond the far
  // clip plane gets frustum-culled/clipped outright; the sky dome is exempt only because its
  // huge bounding sphere always encloses the camera itself, which a single distant sprite
  // doesn't get for free).
  const distance = 250;
  for (let i = 0; i < count; i++) {
    const mat = new THREE.SpriteMaterial({
      map: texture,
      color,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false, // see buildCelestialSprite's fog comment — same reasoning applies here
      opacity: 0.55 + Math.random() * 0.35,
    });
    const sprite = new THREE.Sprite(mat);

    // Full circle of azimuth, elevation biased to mid-high altitude (not right at the
    // horizon where fog would hide it anyway, not directly overhead where it'd look odd).
    const azimuth = Math.random() * Math.PI * 2;
    const elevation = THREE.MathUtils.degToRad(20 + Math.random() * 45);
    const dir = new THREE.Vector3(
      Math.cos(elevation) * Math.cos(azimuth),
      Math.sin(elevation),
      Math.cos(elevation) * Math.sin(azimuth)
    );
    sprite.position.copy(dir).multiplyScalar(distance);

    const scale = 70 + Math.random() * 90;
    sprite.scale.set(scale, scale * (0.45 + Math.random() * 0.15), 1);
    sprite.renderOrder = -998;
    scene.add(sprite);
    followers.push({ sprite, dir, dist: distance });
  }
  return followers;
}

function buildSky(scene, topColor, bottomColor, celestialBody = "sun") {
  // A simple vertical-gradient sky dome rather than a physically-based atmosphere shader —
  // predictable final colors, no HDR/tonemapping fighting to get a clean bright-day look.
  const uniforms = {
    topColor: { value: new THREE.Color(topColor) },
    bottomColor: { value: new THREE.Color(bottomColor) },
    offset: { value: 60 },
    exponent: { value: 0.55 },
  };
  const skyGeo = new THREE.SphereGeometry(4000, 16, 16);
  const skyMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w; // pin to the far plane so it's never clipped, like three/addons Sky
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform float offset;
      uniform float exponent;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
        gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  // Explicitly first in render order — this material is opaque (no transparent:true) with
  // depthWrite:false, so whatever rendered *before* it at a given pixel (the sun/moon/cloud
  // sprites, which also skip depthWrite to avoid transparency-sorting fights) gets silently
  // painted over the moment the sky itself draws, since there's no depth information left to
  // block it. Sky must render first so anything meant to sit "on" it (renderOrder above this)
  // draws afterward and stays visible instead of being overwritten.
  sky.renderOrder = -10000;
  scene.add(sky);

  const sun = new THREE.Vector3();
  const phi = THREE.MathUtils.degToRad(90 - 42);
  const theta = THREE.MathUtils.degToRad(170);
  sun.setFromSphericalCoords(1, phi, theta);

  // The visible disc sits along the exact same direction as the DirectionalLight built from
  // sunDir right after this call returns — so the sun/moon you see is always where the actual
  // light (and its shadows) are actually coming from, day or night, never decorative-only.
  //
  // Placement distance (250) is deliberately small relative to the sky dome's radius (4000) —
  // the camera's actual far clip plane (main.js: 300) would otherwise frustum-cull/clip a
  // sprite placed further out. The sky dome itself dodges this entirely: it's a giant sphere
  // that always *encloses* the camera, so it can never be trivially culled regardless of the
  // numeric far value; a single point far out in one direction gets no such exemption. Scale
  // (below) is sized to look right at this closer distance, not at the sky dome's true scale.
  //
  // This initial position is only a placeholder until the first real frame — buildWorld's
  // updateSky(camera) re-centers this (and every cloud) on the camera every frame after, since
  // 250 units is nowhere near "at infinity" relative to how far a player can actually walk in
  // a big arena (see updateSky's own comment for the parallax problem this solves).
  const celestialSprite = buildCelestialSprite(celestialBody);
  celestialSprite.position.copy(sun).multiplyScalar(250);
  scene.add(celestialSprite);

  return { sunDir: sun, skyMesh: sky, celestialSprite };
}

// Streets/sidewalks — purely decorative, no collision entries at all. Ground is always one
// uniform PlaneGeometry+material for the whole map (see buildWorld's single `ground` mesh), so
// a paved road can't be painted onto it directly; this lays flat asphalt + sidewalk rectangles
// slightly above y=0 instead (the same small-offset-to-avoid-z-fighting trick already used
// elsewhere in this file), matching this project's all-flat-color aesthetic — no new texture
// assets, same technique buildBuildingMesh's door/window overlays already use.
const STREET_Y = 0.02;
const SIDEWALK_Y = 0.035;
const SIDEWALK_WIDTH = 1.4;
function buildStreets(scene, added, streetLayout, asphaltColor, sidewalkColor) {
  if (!streetLayout || !streetLayout.length) return;
  const asphaltMat = new THREE.MeshStandardMaterial({ color: asphaltColor, roughness: 0.95, metalness: 0.02 });
  const sidewalkMat = new THREE.MeshStandardMaterial({ color: sidewalkColor, roughness: 0.9, metalness: 0.02 });
  streetLayout.forEach((s, idx) => {
    // Two crossing streets (e.g. a "+" intersection) would otherwise sit exactly coplanar and
    // z-fight in the overlap — a tiny per-segment Y step avoids it without being visible.
    const y = STREET_Y + idx * 0.003;
    const road = new THREE.Mesh(new THREE.BoxGeometry(s.width, 0.04, s.length), asphaltMat);
    road.position.set(s.x, y, s.z);
    road.rotation.y = s.rotY || 0;
    road.receiveShadow = true;
    scene.add(road);
    added.push(road);

    const sidewalkGeo = new THREE.BoxGeometry(SIDEWALK_WIDTH, 0.06, s.length);
    for (const side of [-1, 1]) {
      const sidewalk = new THREE.Mesh(sidewalkGeo, sidewalkMat);
      const offset = localOffsetToWorld(side * (s.width / 2 + SIDEWALK_WIDTH / 2), 0, s.rotY || 0);
      sidewalk.position.set(s.x + offset.x, SIDEWALK_Y + idx * 0.003, s.z + offset.z);
      sidewalk.rotation.y = s.rotY || 0;
      sidewalk.receiveShadow = true;
      scene.add(sidewalk);
      added.push(sidewalk);
    }
  });
}

function buildTrees(scene, obstacles, treeLayout, trunkColor, foliageColor) {
  const added = [];
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.26, 2.2, 7);
  const trunkMat = new THREE.MeshStandardMaterial({ color: trunkColor, roughness: 0.95 });

  const foliageGeo = new THREE.ConeGeometry(1.5, 3, 8);
  const foliageMat = new THREE.MeshStandardMaterial({ color: foliageColor, roughness: 0.9 });
  // openEnded: true — this cone's base overlaps the lower cone's surface (stacked-pine look),
  // and a capped base there would show as a flat disc sticking out through the lower foliage.
  const foliageGeo2 = new THREE.ConeGeometry(1.15, 2.3, 8, 1, true);

  for (const t of treeLayout) {
    const group = new THREE.Group();

    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = 1.1;
    trunk.castShadow = true;
    group.add(trunk);

    const foliageLower = new THREE.Mesh(foliageGeo, foliageMat);
    foliageLower.position.y = 2.6;
    foliageLower.castShadow = true;
    group.add(foliageLower);

    const foliageUpper = new THREE.Mesh(foliageGeo2, foliageMat);
    foliageUpper.position.y = 3.9;
    foliageUpper.castShadow = true;
    group.add(foliageUpper);

    const rotY = (t.x * 12.9898 + t.z * 78.233) % (Math.PI * 2);
    group.position.set(t.x, 0, t.z);
    group.scale.setScalar(t.s);
    group.rotation.y = rotY;
    scene.add(group);
    added.push(group);

    // No `top` here (unlike rocks/buildings/cars) — a tree is never meant to be jumped onto,
    // so it should always block horizontally regardless of height, not just below some ledge.
    // The hitbox (for bullets) still needs *some* vertical extent to hit, sized to roughly
    // cover the trunk+foliage silhouette even though movement collision ignores height here.
    // "ellipse" shape since a trunk/canopy silhouette reads as round, not square (hx=hz here
    // so it doesn't change the footprint's *size*, only the F4 overlay's shape/feel).
    const hitboxMesh = buildHitbox(t.x, t.z, 0.3 * t.s, 0.3 * t.s, 4.4 * t.s, rotY, "ellipse");
    scene.add(hitboxMesh);
    added.push(hitboxMesh);

    obstacles.push({ x: t.x, z: t.z, hx: 0.3 * t.s, hz: 0.3 * t.s, shape: "ellipse", hitboxMesh });
  }

  return added;
}

// Recursively disposes every mesh's geometry/material (and any material's textures) under
// `obj`, then removes `obj` itself from the scene — used to fully tear down one map's meshes
// before building the next, since obstacles/trees/ground/sky are otherwise plain Object3Ds
// with no automatic cleanup.
function disposeObject3D(scene, obj) {
  obj.traverse((child) => {
    // THREE.Sprite instances all share one module-level static geometry (verified directly
    // against node_modules/three/src/objects/Sprite.js — a lazily-created `_geometry` singleton
    // assigned to `this.geometry` for every Sprite ever constructed, not a per-instance one).
    // Disposing it here would free that shared buffer out from under every *other* sprite
    // still in the scene (health bars, name tags, sun/moon/clouds) for the rest of the session.
    // Materials/textures are still per-instance and safe to dispose normally.
    if (child.geometry && !child.isSprite) child.geometry.dispose();
    if (child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        for (const key of ["map", "roughnessMap", "metalnessMap", "normalMap"]) {
          if (mat[key]) mat[key].dispose();
        }
        mat.dispose();
      }
    }
  });
  scene.remove(obj);
}

// --- Class abilities: Assault's Shield Wall, Demolition's Proximity Mine, Recon's Pulse ---
// (Scout's Overclock and Assassin's Invisibility need no new geometry — pure stat/timer effects,
// not placed objects.) These are placed at runtime
// during a match, not at map-build time, so they live outside buildWorld/obstacleLayout — the
// caller (main.js) is responsible for pushing/removing the returned pieces from its own live
// `obstacles`/`obstacleMeshes` arrays; these functions only build the THREE.js objects.

const SHIELD_HX = 1.4; // half-width (the long dimension you actually hide behind)
const SHIELD_HZ = 0.18; // half-thickness — thin, so it reads as a "wall", not a "box"
const SHIELD_H = 2.1; // tall enough to block a standing player's whole silhouette

// A solid slab of grey gunmetal — a plain color, not the weapon viewmodels' own textured
// metalMat (weapon.js), since that texture's UV layout is built for a gun's geometry and
// would just look smeared/stretched across a flat wall panel this size. metalness:0 (fully
// diffuse) rather than anything close to the weapon material's metalness:1 — nothing in this
// scene sets `scene.environment` (a reflection map), so a metallic surface only reads as bright
// where a specular highlight from the sun DirectionalLight actually lands on it; any face just
// slightly off that angle (e.g. facing away from the sun, or lit only by the HemisphereLight's
// ambient) falls back to a near-black diffuse response scaled by (1-metalness), which crushed
// to a near-black/dark-navy panel at metalness 0.85, 0.35, AND 0.15 alike (confirmed via
// screenshot each time) — metalness was never the right knob to tune here, since ANY nonzero
// value has this failure mode on an ambient-only face. A small flat emissive floor (0x2c2f33)
// guarantees a visible grey-metal base tone on every face regardless of which way it's lit or
// facing, which is what actually fixes it — the base color (0x9aa0a6, brighter than the earlier
// 0x8a8f94 attempts to read clearly as light gunmetal even under the darkest ambient-only face)
// still receives full diffuse shading on top for real light/shadow contrast between faces.
// Opaque now (an earlier translucent sci-fi-glow version read as a decoration, not a real
// physical barrier) — solid to both movement collision and hitscan (the caller pushes
// hitboxMesh into obstacleMeshes), same `{x,z,hx,hz,top,rotY}` shape every other obstacle uses
// via the shared buildHitbox already used for the map itself.
export function buildShieldWall(scene, x, z, rotY) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x9aa0a6,
    emissive: 0x2c2f33,
    roughness: 0.5,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const geo = new THREE.BoxGeometry(SHIELD_HX * 2, SHIELD_H, SHIELD_HZ * 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, SHIELD_H / 2, z);
  mesh.rotation.y = rotY;
  scene.add(mesh);

  const hitboxMesh = buildHitbox(x, z, SHIELD_HX, SHIELD_HZ, SHIELD_H, rotY, "box");
  scene.add(hitboxMesh);

  const entry = { x, z, hx: SHIELD_HX, hz: SHIELD_HZ, top: SHIELD_H, rotY, shape: "box", mesh, hitboxMesh };
  return { mesh, hitboxMesh, entry };
}

// Disposes a handle returned by buildShieldWall (mesh + hitbox + scene removal) — the caller
// is still responsible for splicing `handle.entry`/`handle.hitboxMesh` out of its own
// `obstacles`/`obstacleMeshes` arrays first, same division of responsibility as buildWorld's
// own dispose() vs. the arrays it hands back.
export function removeShieldWall(scene, handle) {
  disposeObject3D(scene, handle.mesh);
  disposeObject3D(scene, handle.hitboxMesh);
}

// A small low-poly proximity mine — deliberately NOT added to the obstacles/obstacleMeshes
// collision system at all (it's meant to be walked over, not blocked by), so the caller just
// positions and scene.add()s this directly and runs its own proximity check each frame.
export function buildMineMesh() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2a26, roughness: 0.7, metalness: 0.3 });
  const lightMat = new THREE.MeshStandardMaterial({ color: 0x1a0a0a, emissive: 0xff2a2a, emissiveIntensity: 1.4, roughness: 0.4 });

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.12, 8), bodyMat);
  base.position.y = 0.06;
  base.castShadow = true;
  group.add(base);

  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.05, 8), bodyMat);
  cap.position.y = 0.14;
  group.add(cap);

  const light = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), lightMat);
  light.position.y = 0.18;
  group.add(light);

  return group;
}

// Recon's ability marker — a glowing diamond that hovers above a revealed target, rendered
// through walls (depthTest:false, high renderOrder, same technique as the sun/moon/cloud
// sprites) so "recon" actually means something: you can tell where an enemy is even with a
// wall between you. One shared canvas texture per sprite instance (small/cheap, and this is
// only ever a handful of sprites alive at once, unlike the many cloud sprites sharing one
// texture) rather than plumbing a module-level cache through for something this infrequent.
export function buildReconMarkerSprite() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const c = size / 2;
  ctx.translate(c, c);
  ctx.rotate(Math.PI / 4);
  const grad = ctx.createLinearGradient(-c * 0.6, -c * 0.6, c * 0.6, c * 0.6);
  grad.addColorStop(0, "rgba(255,90,90,1)");
  grad.addColorStop(1, "rgba(255,180,90,1)");
  ctx.fillStyle = grad;
  ctx.fillRect(-c * 0.55, -c * 0.55, c * 1.1, c * 1.1);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 4;
  ctx.strokeRect(-c * 0.55, -c * 0.55, c * 1.1, c * 1.1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  // fog: false — a marker meant to reveal a *distant* enemy through fog/walls would otherwise
  // fade out with distance exactly like the sun/moon/clouds did before that same fix, defeating
  // the entire point of it being visible at range in the first place.
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.4, 0.4, 1);
  sprite.renderOrder = 998; // just under the F4 hitbox overlay, well above ordinary scene geometry
  return sprite;
}

// Builds one map's meshes/lighting/fog into `scene` and returns everything a caller needs to
// run gameplay against it (`obstacles`, for collision/spawn code) plus a `dispose()` to fully
// tear it down again before building a different map — swapping the map mid-session is just
// dispose-the-old-one then buildWorld-the-new-one.
export function buildWorld(scene, mapId = DEFAULT_MAP_ID) {
  const map = getMapDef(mapId);
  // Most maps share the default footprint; a map can opt into a larger one via `arenaBound`
  // (e.g. Dunes/Nightfall, to fit their fuller cluster layouts) — everything below derives
  // from this per-map value rather than the fixed export, and it's returned alongside
  // `obstacles` so callers can pass it on to randomSpawnPoint()/resolveCollisions() too.
  const arenaBound = map.arenaBound ?? ARENA_BOUND;
  const added = []; // every top-level Object3D/light this call added directly to the scene

  const { sunDir, skyMesh, celestialSprite } = buildSky(scene, map.sky.top, map.sky.bottom, map.sky.body);
  added.push(skyMesh, celestialSprite);

  const cloudFollowers = buildClouds(scene, map.sky.cloudColor ?? 0xffffff, map.sky.cloudCount ?? 10);
  added.push(...cloudFollowers.map((f) => f.sprite));

  // Every sky element that isn't the dome itself (sun/moon disc, clouds) needs to be
  // re-centered on the camera every frame, unlike the sky dome which can just sit fixed at
  // the world origin. The dome's radius (4000) so vastly dwarfs any arena (up to ~192 units
  // across) that walking the whole map only ever shifts it by a few percent — imperceptible.
  // These sprites sit at only 250 units (forced close by the camera's actual far clip plane,
  // see buildCelestialSprite's comment) — a fraction close enough to the arena's own size that
  // walking across a big map would visibly swing them across the sky and out of where the
  // player left them, reading as "clouds disappearing" when they'd really just parallax-shifted
  // to a different apparent direction. Re-centering on the camera every frame (same direction
  // and distance, just recomputed from wherever the camera currently is) makes them behave
  // like they're genuinely at infinity, the same as the dome, regardless of player movement.
  const skyFollowers = [{ sprite: celestialSprite, dir: sunDir.clone(), dist: 250 }, ...cloudFollowers];
  function updateSky(camera) {
    for (const f of skyFollowers) {
      f.sprite.position.copy(camera.position).addScaledVector(f.dir, f.dist);
    }
  }

  scene.fog = new THREE.FogExp2(map.fog.color, map.fog.density);

  const hemi = new THREE.HemisphereLight(map.hemi.sky, map.hemi.ground, map.hemi.intensity);
  scene.add(hemi);
  added.push(hemi);

  const sun = new THREE.DirectionalLight(map.sun.color, map.sun.intensity);
  sun.position.copy(sunDir).multiplyScalar(80);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -arenaBound - 5;
  sun.shadow.camera.right = arenaBound + 5;
  sun.shadow.camera.top = arenaBound + 5;
  sun.shadow.camera.bottom = -arenaBound - 5;
  sun.shadow.camera.far = 200;
  scene.add(sun);
  added.push(sun);

  const groundMatOpts = { color: map.groundColor, roughness: 0.95, metalness: 0 };
  if (map.groundTextured) {
    const groundTex = textureLoader.load("/textures/ground.jpg");
    groundTex.colorSpace = THREE.SRGBColorSpace;
    groundTex.wrapS = THREE.RepeatWrapping;
    groundTex.wrapT = THREE.RepeatWrapping;
    const groundTiles = Math.round((arenaBound * 2) / 6);
    groundTex.repeat.set(groundTiles, groundTiles);
    groundTex.anisotropy = 4;
    groundMatOpts.map = groundTex;
  }
  const groundGeo = new THREE.PlaneGeometry(arenaBound * 2, arenaBound * 2);
  const groundMat = new THREE.MeshStandardMaterial(groundMatOpts);
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  added.push(ground);

  buildStreets(scene, added, map.streetLayout, map.streetColor ?? 0x3a3a3e, map.sidewalkColor ?? 0x9a9a94);

  const obstacles = [];

  const wallH = 3.2;
  const wallDefs = [
    { x: 0, z: -arenaBound, hx: arenaBound, hz: 0.5 },
    { x: 0, z: arenaBound, hx: arenaBound, hz: 0.5 },
    { x: -arenaBound, z: 0, hx: 0.5, hz: arenaBound },
    { x: arenaBound, z: 0, hx: 0.5, hz: arenaBound },
  ];
  for (const w of wallDefs) {
    const mesh = buildBoxMesh(w.hx, w.hz, wallH, map.wallColor);
    mesh.position.x = w.x;
    mesh.position.z = w.z;
    scene.add(mesh);
    added.push(mesh);
    const hitboxMesh = buildHitbox(w.x, w.z, w.hx, w.hz, wallH);
    scene.add(hitboxMesh);
    added.push(hitboxMesh);
    obstacles.push({ x: w.x, z: w.z, hx: w.hx, hz: w.hz, top: wallH, mesh, hitboxMesh });
  }

  // A fully-indoor map (e.g. the hospital) caps the whole arena with a flat ceiling at wall
  // height — purely visual, no collision entry at all (a double-jump apex is well under half
  // this height, so there's no risk of a false mid-air block) — plus a handful of interior
  // point-light fixtures, since a ceiling blocks the sun and hemi-only ambient would otherwise
  // read as near-black indoors. Every outdoor map simply omits both fields.
  if (map.ceiling) {
    const ceilingMat = new THREE.MeshStandardMaterial({ color: map.wallColor, roughness: 0.9, metalness: 0.02, side: THREE.DoubleSide });
    const ceiling = new THREE.Mesh(new THREE.BoxGeometry(arenaBound * 2, 0.1, arenaBound * 2), ceilingMat);
    ceiling.position.y = wallH;
    scene.add(ceiling);
    added.push(ceiling);
  }
  for (const l of map.interiorLights || []) {
    const light = new THREE.PointLight(l.color ?? 0xdceeff, l.intensity ?? 1.3, l.distance ?? 10);
    light.position.set(l.x, l.y ?? wallH - 0.4, l.z);
    scene.add(light);
    added.push(light);
  }

  // Pushes one collision piece (box or ellipse) sharing `mesh` for reference/disposal
  // grouping — a "compound" obstacle (a building's walls + ridge, a car's body + cabin) is
  // just several of these sharing one visual mesh, since every consumer (movement collision,
  // hitscan raycasts, the F4 overlay) already treats `obstacles` as a flat list of primitives
  // with no notion of "these N belong to one logical object" needed.
  function pushObstaclePiece(x, z, hx, hz, top, rotY, mesh, shape = "box", { standable = true, slopeGate = null, groundOnly = false } = {}) {
    const hitboxMesh = buildHitbox(x, z, hx, hz, top, rotY, shape);
    scene.add(hitboxMesh);
    added.push(hitboxMesh);
    const entry = { x, z, hx, hz, rotY, shape, mesh, hitboxMesh };
    // `standable: false` (buildings' wall box) omits `top` entirely — same convention trees
    // already use — so getGroundHeight never treats it as a ledge to land on. The hitbox mesh
    // itself still gets `top` for sizing (bullets/F4 should still see the wall's true height),
    // only the gameplay-facing obstacle entry drops it.
    if (standable) entry.top = top;
    // `slopeGate` (buildings' wall box) replaces the flat-`top` ledge-tolerance threshold with
    // the roof's own sloped height at the query's actual (x,z) — see the shared
    // `roofSlopeEffectiveTop` helper and its callers in resolveCollisions/collideProjectile for
    // why a flat gate here was a real bug, not just an approximation.
    if (slopeGate) entry.slopeGate = slopeGate;
    // `groundOnly` (a multi-story building's interior floor slabs) makes resolveCollisions/
    // collideProjectile skip this obstacle's horizontal push entirely, regardless of height — a
    // floor/ceiling has no horizontal solidity of its own; only real walls should ever block
    // sideways movement. Without this, a standable-but-not-groundOnly floor slab is (correctly,
    // for something like a rock or car) solid below its own top for anyone approaching from
    // outside its footprint — which is exactly wrong for an interior floor, since it would seal
    // the ground floor off from ever reaching the floor's own footprint at all (including
    // through the building's actual doorway), the moment a player at ground level tried to walk
    // under it from any horizontal direction.
    if (groundOnly) entry.groundOnly = true;
    obstacles.push(entry);
  }

  // A building's roof, as a real sloped standing surface: no single `top` (the standing
  // height, and the horizontal-push ledge threshold, both vary with distance from the ridge —
  // see the `shape === "roofPrism"` branches in getGroundHeight/resolveCollisions/
  // collideProjectile), so it's a dedicated push rather than a pushObstaclePiece call.
  function pushRoofPrism(x, z, hx, hzRoof, wallTop, peakTop, rotY, mesh) {
    const hitboxMesh = buildHitbox(x, z, hx, hzRoof, peakTop, rotY, "roofPrism", wallTop);
    scene.add(hitboxMesh);
    added.push(hitboxMesh);
    obstacles.push({
      x,
      z,
      hx,
      hz: hzRoof,
      wallTop,
      peakRise: peakTop - wallTop,
      rotY,
      shape: "roofPrism",
      mesh,
      hitboxMesh,
    });
  }

  // A staircase ramp, as a real one-directional sloped standing surface — see the `shape ===
  // "ramp"` branches in getGroundHeight/resolveCollisions/collideProjectile. Mirrors
  // pushRoofPrism exactly (a dedicated push rather than pushObstaclePiece, since standing
  // height/ledge threshold both vary by position), just a monotonic ramp instead of a
  // symmetric ridge.
  function pushRamp(x, z, hx, hzRamp, wallTop, peakTop, rotY, mesh) {
    const hitboxMesh = buildHitbox(x, z, hx, hzRamp, peakTop, rotY, "ramp", wallTop);
    scene.add(hitboxMesh);
    added.push(hitboxMesh);
    obstacles.push({
      x,
      z,
      hx,
      hz: hzRamp,
      wallTop,
      peakRise: peakTop - wallTop,
      rotY,
      shape: "ramp",
      mesh,
      hitboxMesh,
    });
  }

  const ROCK_COLLISION_HEIGHT_FACTOR = 0.48;
  const rockTint = new THREE.Color(map.rockTint);
  const rockEmissive = new THREE.Color(map.rockEmissive);
  const carColors = map.carColors || [0xa33030, 0x2a4a7a, 0xd8d4c8, 0x1a1a1a, 0x8a8f94];
  let carIndex = 0;
  // Every rock built below, so upgradeRockVisuals() (see the returned object) can swap a
  // still-procedural instance's mesh over to the real model once it finishes loading — see the
  // comment at that function for why this can't just happen once, up front.
  const rockVisualEntries = [];
  for (const o of map.obstacleLayout) {
    const type = o.type || "rock";
    let mesh;

    // One rotation, decided up front and applied identically to the visual mesh AND every
    // collision piece below. Rocks always get a random visual spin (for variety) using the
    // same position-hash trick buildTrees already uses (deterministic, not Math.random()) so
    // a rock's spin is reproducible and shared with its hitbox instead of being cosmetic-only.
    const rotY = type === "rock" ? (o.x * 12.9898 + o.z * 78.233) % (Math.PI * 2) : o.rotY || 0;

    // Walkable multi-story building — a genuinely different construction (separate wall/floor
    // pieces with real gaps) from the single solid-box path below, so it's its own branch
    // entirely rather than a tweak to it; every existing map's `stories`-less buildings fall
    // through to the unchanged path underneath, byte-identical to before.
    if (type === "building" && (o.stories || 1) > 1) {
      const built = buildMultiStoryBuilding(
        o.hx,
        o.hz,
        o.stories,
        map.buildingWallColor ?? map.wallColor,
        map.buildingRoofColor ?? map.rockTint,
        map.buildingTrimColor ?? map.rockEmissive
      );
      mesh = built.group;
      mesh.position.set(o.x, 0, o.z);
      mesh.rotation.y = rotY;
      scene.add(mesh);
      added.push(mesh);

      const roofHalfDepth = o.hz + ROOF_OVERHANG_DEPTH;
      const roofPeakRise = built.roofPeakHeight - built.totalHeight;
      for (const piece of built.pieces) {
        const worldOffset = localOffsetToWorld(piece.localX, piece.localZ, rotY);
        const worldX = o.x + worldOffset.x;
        const worldZ = o.z + worldOffset.z;
        if (piece.kind === "ramp") {
          pushRamp(worldX, worldZ, piece.hx, piece.hz, piece.wallTop, piece.peakTop, rotY, mesh);
        } else if (piece.kind === "wall") {
          // Every wall piece spans the building's full height (see buildMultiStoryBuilding's
          // comment on why walls don't need per-story splitting) — same slopeGate treatment
          // the single-story path below already uses, just gating against this building's
          // actual total height instead of a single story's.
          pushObstaclePiece(worldX, worldZ, piece.hx, piece.hz, piece.top, rotY, mesh, "box", {
            standable: false,
            slopeGate: { hz: roofHalfDepth, wallTop: built.totalHeight, peakRise: roofPeakRise },
          });
        } else {
          // Floor slabs — standable (getGroundHeight offers them as a landing height) but
          // `groundOnly` so they never block horizontal movement (see pushObstaclePiece) —
          // without this, the ground floor would be sealed off from ever reaching its own
          // interior at all, including through the actual doorway, since a plain standable box
          // is solid for anyone approaching its footprint from outside at a lower height.
          pushObstaclePiece(worldX, worldZ, piece.hx, piece.hz, piece.top, rotY, mesh, "box", { groundOnly: true });
        }
      }
      pushRoofPrism(o.x, o.z, o.hx, roofHalfDepth, built.totalHeight, built.roofPeakHeight, rotY, mesh);
      continue;
    }

    if (type === "building") {
      const built = buildBuildingMesh(
        o.hx,
        o.hz,
        o.h,
        map.buildingWallColor ?? map.wallColor,
        map.buildingRoofColor ?? map.rockTint,
        map.buildingTrimColor ?? map.rockEmissive
      );
      mesh = built.group;
      mesh.position.set(o.x, 0, o.z);
      mesh.rotation.y = rotY;
      scene.add(mesh);
      added.push(mesh);

      // Compound shape: the solid walls (a box, matching the walls exactly — a sloped roof
      // is NOT a solid block up to its peak, so it no longer pretends to be one), plus a
      // true triangular-prism piece matching the roof's actual sloped cross-section (base at
      // wall height spanning the full roofed depth, apex at the ridge). A flat-topped strip at
      // the ridge only supported standing exactly on the ridge line — one step off it and there
      // was nothing between wall-top and ridge height, so a player fell straight through empty
      // space past the visibly-solid sloped roof mesh ("phasing through the roof"). The prism
      // gives every point under the roof the correct standing height for its distance from the
      // ridge, matching the visual slope instead of a single flat plane.
      //
      // The wall box is pushed `standable: false` — every building's roof fully covers its
      // whole footprint, so the flat wall-top height was never a real walkable spot anyway
      // (anywhere off the exact eave line, "standing" there put your head inside the solid
      // roof above you). It also gets a `slopeGate`: instead of the wall's own flat height
      // gating its horizontal push (the earlier bug — a high-enough jump could reach that flat
      // window with nothing solid there to catch it, flying straight through), the gate now
      // uses the *roof's own sloped height* at the query's actual (x,z). This closes that
      // exploit (almost everywhere below the roof's real surface, the wall still blocks) while
      // fixing a second bug the flat "always solid" version introduced: someone genuinely
      // standing on the roof is, footprint-wise, still standing *inside* the wall's smaller
      // (x,z) rectangle — an unconditionally-solid wall kept fighting them anywhere they walked
      // near the wall's own footprint edge (which sits well inside the visually-walkable roof),
      // pushing back against completely legitimate movement on top of the building.
      const roofHalfDepth = o.hz + ROOF_OVERHANG_DEPTH;
      const roofPeakRise = built.roofPeakHeight - o.h;
      pushObstaclePiece(o.x, o.z, o.hx, o.hz, o.h, rotY, mesh, "box", {
        standable: false,
        slopeGate: { hz: roofHalfDepth, wallTop: o.h, peakRise: roofPeakRise },
      });
      pushRoofPrism(o.x, o.z, o.hx, roofHalfDepth, o.h, built.roofPeakHeight, rotY, mesh);
      continue;
    }

    if (type === "car") {
      const color = o.color ?? carColors[carIndex++ % carColors.length];
      mesh = buildCarMesh(color);
      mesh.position.set(o.x, 0, o.z);
      mesh.rotation.y = rotY;
      scene.add(mesh);
      added.push(mesh);

      // Compound shape: a low, long body box (matching the lower body's real footprint/
      // height) plus a smaller cabin box on top — the cabin's own local offset (matches
      // buildCarMesh's `cabin.position.z`) is rotated into world space same as everything
      // else. The cabin box still reaches down to the ground rather than floating at its
      // true (raised) bottom — the collision system has no notion of a floating box, but
      // since the cabin's footprint sits entirely inside the body's footprint, extending it
      // down doesn't add any wrongness: that space is already solid via the body box.
      pushObstaclePiece(o.x, o.z, 0.9, 1.85, 1.25, rotY, mesh);
      const cabinOffset = localOffsetToWorld(0, -0.18, rotY);
      pushObstaclePiece(o.x + cabinOffset.x, o.z + cabinOffset.z, 0.72, 0.95, 1.8, rotY, mesh);
      continue;
    }

    // A plain interior wall segment (see room() above) — a solid box up to the same height as
    // this arena's own perimeter walls, no roof/door/slope-gate machinery at all, since nothing
    // ever stands above it (an indoor map's ceiling sits well out of jump reach) and it's
    // already split with real door gaps at the authoring level, not here.
    if (type === "wall") {
      const wallMat = new THREE.MeshStandardMaterial({ color: map.wallColor, roughness: 0.9, metalness: 0.03 });
      mesh = new THREE.Mesh(new THREE.BoxGeometry(o.hx * 2, wallH, o.hz * 2), wallMat);
      mesh.position.set(o.x, wallH / 2, o.z);
      mesh.rotation.y = rotY;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      added.push(mesh);
      pushObstaclePiece(o.x, o.z, o.hx, o.hz, wallH, rotY, mesh);
      continue;
    }

    // Rocks (and, below, trees) are round-ish blobs, not rectangles — an ellipse inscribed
    // in the same hx/hz hugs their actual silhouette far better than a box does.
    const rockVariant = rotY < Math.PI ? 0 : 1;
    mesh = buildRockMesh(o.hx, o.hz, o.h, rockTint, rockEmissive, rockVariant);
    mesh.position.set(o.x, 0, o.z);
    mesh.rotation.y = rotY;
    scene.add(mesh);
    added.push(mesh);
    const rockEntry = { o, rotY, rockVariant, mesh };
    rockVisualEntries.push(rockEntry);
    // Collision top is intentionally lower than the visual mesh's own scale height (o.h). The
    // rock is a jittered, subdivided icosahedron, not a smooth dome — it only reaches its full
    // scaled height at whichever vertex happens to land nearest the pole, and that vertex is
    // essentially never exactly above the footprint's center (where a player actually stands).
    // A flat collision top at the full o.h reads as standing well above the visible surface
    // ("floating"); ROCK_COLLISION_HEIGHT_FACTOR pulls it down to roughly where the surface
    // really sits near the center — measured directly (raycasting straight down onto each
    // rock's actual visual mesh at its footprint center across the full obstacle set), which
    // came out to ~0.42-0.53x the full scaled height (avg ~0.47x), not eyeballed.
    pushObstaclePiece(o.x, o.z, o.hx, o.hz, o.h * ROCK_COLLISION_HEIGHT_FACTOR, rotY, mesh, "ellipse");
    rockEntry.obstacleEntry = obstacles[obstacles.length - 1];
  }

  const treeGroups = buildTrees(scene, obstacles, map.treeLayout, map.treeTrunkColor, map.treeFoliageColor);
  added.push(...treeGroups);

  function dispose() {
    for (const obj of added) disposeObject3D(scene, obj);
    scene.fog = null;
  }

  // preloadRockModels() runs fire-and-forget from app init, in parallel with this very
  // buildWorld() call (the default map loads synchronously at startup, before that fetch has
  // any chance to finish) — so on a typical session every rock above just got built from the
  // procedural fallback, and loadMap() only rebuilds the whole world on an actual map *change*.
  // Without this, those rocks would stay procedural for the rest of the session even after the
  // real models finish loading a moment later. Called once the preload resolves (see main.js);
  // a no-op if this particular world was already replaced by then, or if every rock in it
  // already upgraded (e.g. this is the second call after a slow/failed load resolved late).
  function upgradeRockVisuals() {
    for (const entry of rockVisualEntries) {
      if (entry.mesh.userData.rockKind === "model") continue;
      const newMesh = buildRockMesh(entry.o.hx, entry.o.hz, entry.o.h, rockTint, rockEmissive, entry.rockVariant);
      if (newMesh.userData.rockKind !== "model") return; // models still aren't ready; try again later
      newMesh.position.copy(entry.mesh.position);
      newMesh.rotation.y = entry.rotY;
      scene.add(newMesh);
      const addedIdx = added.indexOf(entry.mesh);
      if (addedIdx !== -1) added[addedIdx] = newMesh;
      if (entry.obstacleEntry) entry.obstacleEntry.mesh = newMesh;
      disposeObject3D(scene, entry.mesh);
      entry.mesh = newMesh;
    }
  }

  return {
    obstacles,
    groundMaterial: groundMat,
    arenaBound,
    // Passed straight into Player.update's ceilingHeight param (see player.js) — Infinity for
    // every outdoor map (no cap at all), the ceiling's own real height for an indoor one, so
    // hitting it actually stops upward movement instead of just looking solid.
    ceilingHeight: map.ceiling ? wallH : Infinity,
    dispose,
    updateSky,
    upgradeRockVisuals,
  };
}

const LEDGE_TOLERANCE = 0.4; // how far short of a platform's top a jump can still catch it

// Every collision check below needs to work against a *rotated* footprint now (buildings/
// cars placed with an explicit rotY, and rocks — see buildWorld — which always get some
// rotation for visual variety), not just an axis-aligned one. Rather than re-deriving the
// same rotate-into-local-space math three times (and risking the three copies drifting out
// of sync), both helpers below are shared by getGroundHeight, resolveCollisions, and
// collideProjectile.
//
// Rotating a world-space offset (dx, dz) from an obstacle's center by -o.rotY (the inverse
// of however the obstacle itself is rotated) gives that same offset in the obstacle's own
// local axes, where its footprint is the plain axis-aligned rectangle [-hx,hx]x[-hz,hz] —
// this is the standard "transform the query into the box's local space" trick for oriented-
// box collision. Verified algebraically (composing the forward+inverse rotation returns the
// original point unchanged) rather than assumed.
function worldOffsetToLocal(dx, dz, rotY) {
  if (!rotY) return { x: dx, z: dz };
  const c = Math.cos(rotY), s = Math.sin(rotY);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

// Inverse of worldOffsetToLocal — rotates a local-space offset back by +o.rotY.
function localOffsetToWorld(lx, lz, rotY) {
  if (!rotY) return { x: lx, z: lz };
  const c = Math.cos(rotY), s = Math.sin(rotY);
  return { x: lx * c + lz * s, z: -lx * s + lz * c };
}

// The sloped roof's standing height at a world-space offset (dx, dz) from its building's
// center — a linear ramp from the ridge (wallTop + peakRise, at localZ=0) down to wallTop at
// the eave (|localZ| = gate.hz), clamped so points beyond the roof's own footprint still get a
// sensible (eave-height) answer rather than extrapolating past it. Shared by both the roof
// prism piece itself (gate = the roofPrism obstacle) and the wall box below it (gate =
// o.slopeGate) — see pushObstaclePiece's `slopeGate` option for why the wall needs this too:
// its horizontal-push ledge threshold must follow the *roof's* real height, not its own flat
// one, or a jump could slip through where neither piece happens to be blocking, and standing on
// the roof would fight against the wall's smaller footprint underneath it.
function roofSlopeEffectiveTop(dx, dz, rotY, gate) {
  const local = worldOffsetToLocal(dx, dz, rotY);
  const clampedZ = Math.max(-gate.hz, Math.min(gate.hz, local.z));
  return gate.wallTop + gate.peakRise * (1 - Math.abs(clampedZ) / gate.hz);
}

// A staircase ramp's standing height — monotonic, not peaked like a roof: wallTop at local
// z=-hz, rising linearly to wallTop+peakRise at local z=+hz. Clamped the same way
// roofSlopeEffectiveTop is, for the same reason (a sensible answer just past the ramp's own
// footprint rather than extrapolating past it).
function rampEffectiveTop(dx, dz, rotY, gate) {
  const local = worldOffsetToLocal(dx, dz, rotY);
  const clampedZ = Math.max(-gate.hz, Math.min(gate.hz, local.z));
  return gate.wallTop + gate.peakRise * ((clampedZ + gate.hz) / (2 * gate.hz));
}

// True if world point (x, z) falls within obstacle o's (possibly rotated) footprint. Two
// footprint shapes: "box" (a plain rectangle, unchanged) and "ellipse" (an ellipse inscribed
// in the same hx/hz half-extents) — rocks and trees are round-ish, not rectangular, so an
// ellipse hugs their actual silhouette much better than a box does.
function isInsideObstacleFootprint(x, z, o) {
  const local = worldOffsetToLocal(x - o.x, z - o.z, o.rotY);
  if (o.shape === "ellipse") {
    const nx = local.x / o.hx, nz = local.z / o.hz;
    return nx * nx + nz * nz <= 1;
  }
  return local.x >= -o.hx && local.x <= o.hx && local.z >= -o.hz && local.z <= o.hz;
}

// Closest point *in* obstacle o's (possibly rotated, possibly elliptical) solid footprint to
// world point (o.x + dx, o.z + dz), returned as a world-space offset from o's center. Matches
// the box case's existing convention: if the query point is already inside, the "closest
// point" is the point itself (zero distance — this solid-region convention, not a surface-
// only one, is what keeps the push-out math below well-defined for a point that's barely
// overlapping); only genuinely outside points get projected onto the boundary.
//
// The ellipse projection (normalize by half-extents onto a unit circle, then scale back) is
// an approximation — anisotropic scaling distorts true Euclidean distance along the boundary
// — but it's the standard, cheap technique for ellipse collision and reads as convincingly
// "rounded" rather than boxy, which is the actual goal here.
function closestOffsetOnObstacle(dx, dz, o) {
  const local = worldOffsetToLocal(dx, dz, o.rotY);
  if (o.shape === "ellipse") {
    const nx = local.x / o.hx, nz = local.z / o.hz;
    const nLenSq = nx * nx + nz * nz;
    if (nLenSq <= 1) return { x: dx, z: dz }; // already inside
    const nLen = Math.sqrt(nLenSq);
    return localOffsetToWorld((nx / nLen) * o.hx, (nz / nLen) * o.hz, o.rotY);
  }
  const clampedX = Math.max(-o.hx, Math.min(o.hx, local.x));
  const clampedZ = Math.max(-o.hz, Math.min(o.hz, local.z));
  return localOffsetToWorld(clampedX, clampedZ, o.rotY);
}

// Resolves the standing height at (x, z): 0 for bare ground, or a platform's top if the
// player is already roughly at/above that height (i.e. jumped up there) — walking into the
// side of a platform at ground level does NOT snap the player up onto it.
export function getGroundHeight(x, z, feetYBeforeLanding, obstacles) {
  let ground = 0;
  for (const o of obstacles) {
    if (o.shape === "roofPrism" || o.shape === "ramp") {
      // Standing height matches the visible slope (roof or staircase — see
      // roofSlopeEffectiveTop/rampEffectiveTop) — a player walking across it lands exactly on
      // the visible surface instead of the single flat height a plain box/ellipse obstacle
      // would give. Still requires being inside the shape's actual (x,z) footprint first
      // (unlike resolveCollisions' gate, which clamps instead — see that function for why the
      // two need different edge behavior here).
      const local = worldOffsetToLocal(x - o.x, z - o.z, o.rotY);
      if (Math.abs(local.x) > o.hx || Math.abs(local.z) > o.hz) continue;
      const effectiveTop =
        o.shape === "ramp" ? rampEffectiveTop(x - o.x, z - o.z, o.rotY, o) : roofSlopeEffectiveTop(x - o.x, z - o.z, o.rotY, o);
      if (feetYBeforeLanding >= effectiveTop - LEDGE_TOLERANCE) {
        ground = Math.max(ground, effectiveTop);
      }
      continue;
    }
    if (o.top === undefined) continue;
    if (!isInsideObstacleFootprint(x, z, o)) continue;
    if (feetYBeforeLanding >= o.top - LEDGE_TOLERANCE) {
      ground = Math.max(ground, o.top);
    }
  }
  return ground;
}

export function resolveCollisions(pos, radius, obstacles, feetY = 0, arenaBound = ARENA_BOUND) {
  for (const o of obstacles) {
    if (o.groundOnly) continue; // a floor/ceiling slab — never blocks sideways movement, see pushObstaclePiece
    const dx = pos.x - o.x;
    const dz = pos.z - o.z;

    if (o.shape === "roofPrism" || o.shape === "ramp" || o.slopeGate) {
      // Both the roof prism itself and the wall box beneath it (via `slopeGate`) gate their
      // horizontal push on the *roof's* real sloped height at this (x,z), not a flat value —
      // using the clamped (not footprint-checked) form, unlike getGroundHeight, so a query
      // just past the roof's own edge still gets a sensible falling-off-toward-eave threshold
      // instead of abruptly having no gate at all right at the boundary. A staircase ramp
      // (`shape: "ramp"`) is its own self-contained obstacle, same as roofPrism — it never
      // appears as a `slopeGate` on some other piece, since nothing needs to be "released" by
      // a staircase the way a wall needs releasing by the roof above it.
      //
      // This matters two ways: (1) a flat threshold on either piece alone left a height band
      // where a well-timed jump could slip past both with nothing solid to catch it, flying
      // through the wall; (2) making the wall *unconditionally* solid instead (an earlier,
      // simpler attempt) fixed that but broke standing on the roof itself — someone legitimately
      // up there is still, footprint-wise, standing inside the wall's smaller rectangle
      // underneath, so an unconditional wall kept fighting completely normal movement anywhere
      // near its own footprint edge (well inside the visually-walkable roof surface). Gating
      // both pieces on the *same* real roof height fixes both at once.
      const gate = o.shape === "roofPrism" || o.shape === "ramp" ? o : o.slopeGate;
      const effectiveTop = o.shape === "ramp" ? rampEffectiveTop(dx, dz, o.rotY, gate) : roofSlopeEffectiveTop(dx, dz, o.rotY, gate);
      if (feetY >= effectiveTop - LEDGE_TOLERANCE) continue;
      // A roof prism's own footprint (hx x hz+overhang) covers the *whole* building, including
      // straight through any doorway gap in the walls beneath it — the roof was never meant to
      // block anything at ground level (only to catch/support someone already up near roof
      // height), that just happened to never matter for a single-story solid-box building where
      // the wall already covered the same footprint underneath anyway. A real walkable multi-
      // story building's doorway would otherwise be silently blocked by the roof piece even
      // though the wall piece beneath it correctly has a gap — skip the roof prism entirely
      // for anyone clearly below the eave; the wall's own (gap-aware) piece is what actually
      // governs blocking down there. Doesn't apply to `ramp`/`slopeGate`-only pieces, which have
      // no such "empty space directly underneath" case (a ramp is real stairs; a wall gated by a
      // roof's slope is still exactly that wall's own true footprint, doorway gaps and all).
      if (o.shape === "roofPrism" && feetY < gate.wallTop - LEDGE_TOLERANCE) continue;
    } else if (o.top !== undefined && feetY >= o.top - LEDGE_TOLERANCE) {
      // Same threshold as getGroundHeight's ledge catch — otherwise the horizontal push keeps
      // the player out of the footprint during the exact window a jump would otherwise catch it.
      continue;
    }

    const close = closestOffsetOnObstacle(dx, dz, o);
    const diffX = dx - close.x;
    const diffZ = dz - close.z;
    const distSq = diffX * diffX + diffZ * diffZ;
    if (distSq < radius * radius) {
      const dist = Math.sqrt(distSq) || 0.0001;
      const push = radius - dist;
      pos.x += (diffX / dist) * push;
      pos.z += (diffZ / dist) * push;
    }
  }
  const b = arenaBound - radius - 0.6;
  pos.x = Math.max(-b, Math.min(b, pos.x));
  pos.z = Math.max(-b, Math.min(b, pos.z));
}

// Query-only version of the height-gating logic collideProjectile uses below, for a
// projectile that should detonate on contact (a rocket) rather than bounce off it (a
// grenade) — same shape/height rules, just a true/false "did it touch something" instead of
// a position/velocity mutation.
export function projectileHitsObstacle(pos, radius, obstacles) {
  for (const o of obstacles) {
    if (o.groundOnly) continue;
    const dx = pos.x - o.x;
    const dz = pos.z - o.z;

    if (o.shape === "roofPrism" || o.shape === "ramp" || o.slopeGate) {
      const gate = o.shape === "roofPrism" || o.shape === "ramp" ? o : o.slopeGate;
      const effectiveTop = o.shape === "ramp" ? rampEffectiveTop(dx, dz, o.rotY, gate) : roofSlopeEffectiveTop(dx, dz, o.rotY, gate);
      if (pos.y >= effectiveTop) continue;
      if (o.shape === "roofPrism" && pos.y < gate.wallTop) continue;
    } else if (o.top !== undefined && pos.y >= o.top) {
      continue;
    }

    const close = closestOffsetOnObstacle(dx, dz, o);
    const diffX = dx - close.x;
    const diffZ = dz - close.z;
    if (diffX * diffX + diffZ * diffZ < radius * radius) return true;
  }
  return false;
}

// Circle-vs-box collision for a free-flying projectile (grenade): pushes it out of the
// obstacle's footprint and reflects its horizontal velocity off the contact normal, so it
// bounces off a rock's side instead of rolling through it. Skipped once the projectile is
// above the obstacle's top — it's sailing over, not hitting the side.
export function collideProjectile(pos, velocity, radius, obstacles, restitution = 0.4) {
  for (const o of obstacles) {
    if (o.groundOnly) continue; // a floor/ceiling slab — never blocks sideways movement, see pushObstaclePiece
    const dx = pos.x - o.x;
    const dz = pos.z - o.z;

    if (o.shape === "roofPrism" || o.shape === "ramp" || o.slopeGate) {
      // Same reasoning as resolveCollisions — gate against the real sloped roof/ramp height at
      // this (x,z), not a flat value.
      const gate = o.shape === "roofPrism" || o.shape === "ramp" ? o : o.slopeGate;
      const effectiveTop = o.shape === "ramp" ? rampEffectiveTop(dx, dz, o.rotY, gate) : roofSlopeEffectiveTop(dx, dz, o.rotY, gate);
      if (pos.y >= effectiveTop) continue;
      // Same reasoning as resolveCollisions — a roof prism's own footprint spans the whole
      // building regardless of any doorway gap in the walls beneath it; skip it entirely below
      // the eave so a grenade/rocket can fly through the door same as a player can walk through it.
      if (o.shape === "roofPrism" && pos.y < gate.wallTop) continue;
    } else if (o.top !== undefined && pos.y >= o.top) {
      continue;
    }

    const close = closestOffsetOnObstacle(dx, dz, o);
    const diffX = dx - close.x;
    const diffZ = dz - close.z;
    const distSq = diffX * diffX + diffZ * diffZ;
    if (distSq >= radius * radius || distSq === 0) continue;

    const dist = Math.sqrt(distSq);
    const nx = diffX / dist;
    const nz = diffZ / dist;
    pos.x += nx * (radius - dist);
    pos.z += nz * (radius - dist);

    const vDotN = velocity.x * nx + velocity.z * nz;
    if (vDotN < 0) {
      velocity.x -= (1 + restitution) * vDotN * nx;
      velocity.z -= (1 + restitution) * vDotN * nz;
    }
  }
}
