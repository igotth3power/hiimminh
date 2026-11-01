// The image field. Camera sits at the origin looking down -z. A portrait cell at (x0, y0) on the reference plane
// z = -D0 gets a tile placed at a random depth d on the ray from the camera through that cell: position scaled by
// d / D0, size scaled by d / D0. Every tile then projects exactly onto its cell, so from the origin the field reads
// as one flat portrait; any camera movement pulls it apart.
// Scrolling moves the tiles toward the camera (uTravel) and wraps them to the far end (mod uPeriod): an endless
// flight. Since only travel mod period matters, returning to travel 0 restores the portrait exactly.
//
// Convergence (all computed in the vertex shader from time, no per-frame CPU work):
//  - intro: every tile flies in from the dark, the centre settling first
//  - halo: tiles on the silhouette's edge never rest; they keep flowing in from further out through a slow swirl,
//    fade as they arrive and set off again
//  - motes: a few hundred small images drift in from the dark and settle into the face
//  - grow: at the portrait tiles have their halftone size; flying in, they grow to full size
import * as THREE from "three"
import { TILE_W, TILE_H, ATLAS, COLS, mulberry32 } from "./atlas.js"

export const D0 = 100          // distance of the reference plane
export const PH = 60           // portrait height on the reference plane (world units)
export const NEAR = 1
const UNIT = PH / 100          // the motion constants below are tuned for a portrait 100 units tall
const ATMOSPHERE = 1800        // extra tiles that only appear once you fly in
const MOTES = 260              // small images drifting in to join the portrait
const FILLER = 0.82             // share of portrait tiles that only belong to the portrait (as on the original)
// the lane: the works one after another, straight ahead, in order (the original's numbers, scaled to these units)
const LANE = { n: 52, z0: 170, step: 34, h: 4.7, x: 7.5, y: 4.4, rx: 19, ry: 14 }
const STREAM_R = 160            // outer radius of the tunnel the stream and atmosphere fly through
// the original's distribution of halftone sizes (share of the full tile), at every 5th percentile: many small dots,
// a broad middle, a few near-full tiles in the highlights. Cells are ranked by brightness and given the size at their
// rank, so the portrait has the same rhythm of sizes and gaps whatever the photo.
const HS_QUANTILES = [0.056, 0.128, 0.179, 0.211, 0.241, 0.270, 0.294, 0.314, 0.335, 0.352, 0.372, 0.392, 0.416, 0.446,
  0.485, 0.543, 0.644, 0.764, 0.887, 0.971, 1.0]
const MATCH_K = 6              // a cell picks randomly among its K closest tiles by colour
const HALO_DIM = [0, 0.3, 0.55, 0.8]   // brightness of halo tiles by distance (cells) to the silhouette's edge

// accent colours (the original's pops of blue, violet, cyan, green, magenta, amber)
const PALETTE = ["#3b5bff", "#8a4dff", "#19d3ff", "#2ee86a", "#ff3da5", "#ffc21a"]

const KIND_PORTRAIT = 0, KIND_ATMOSPHERE = 1, KIND_MOTE = 2, KIND_LANE = 3

const vertexShader = /* glsl */ `
  #define UNIT ${UNIT.toFixed(4)}
  #define FILLER ${FILLER.toFixed(2)}
  #define LANE_N ${LANE.n}.0
  #define LANE_Z0 ${LANE.z0.toFixed(1)}
  #define LANE_STEP ${LANE.step.toFixed(1)}
  #define LANE_H ${LANE.h.toFixed(2)}
  #define LANE_X ${LANE.x.toFixed(2)}
  #define LANE_Y ${LANE.y.toFixed(2)}
  #define LANE_RX ${LANE.rx.toFixed(1)}
  #define LANE_RY ${LANE.ry.toFixed(1)}
  #define STREAM_R ${STREAM_R.toFixed(1)}
  #define ATLAS_COLS ${COLS}.0
  attribute vec3 aPos;     // x0, y0 on the reference plane, depth d
  attribute vec2 aSize;    // full tile height on the reference plane, share of it shown at the portrait (halftone)
  attribute vec2 aSlot;    // atlas: left u, top v
  attribute vec3 aMean;    // tile mean colour
  attribute vec3 aCell;    // portrait cell colour
  attribute float aSeed;
  attribute float aKind;   // 0 portrait, 1 atmosphere, 2 mote, 3 lane (aPos.x: its slot)
  attribute float aDim;    // 1 core of the portrait, < 1 halo on its edge
  attribute vec2 aIntro;   // arrival delay and duration (s)
  uniform float uD0, uTravel, uPeriod, uNear, uTime, uArrive, uFly, uBlur, uMotes, uHaloY, uAccent, uTileCount, uChaos, uChaosZone, uAlive;
  uniform vec2 uScatter;   // pointer minus the restore point (screen units, -1..1)
  uniform vec2 uScreenC, uScreenR;   // the window's centre and half size on the reference plane
  uniform vec2 uTileUV, uTilePx;
  varying vec2 vUv, vLocal;
  varying vec3 vMean, vCell;
  varying float vAlpha, vBias, vFar, vDim, vAccent, vPal;

  float hash(float n) { return fract(sin(n) * 43758.5453123); }
  // an integer hash with an exact twin in JS (streamPieces below), so the CPU knows where every streaming tile is
  uint ihash(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
  float rnd(uint a, uint b) { return float(ihash(a * 0x9e3779b9u + ihash(b))) / 4294967296.0; }
  // a soft swirl: a few rotating sine waves (same field as the original, in its units)
  vec2 flow(vec2 p, float t) {
    p /= UNIT;
    return vec2(sin(p.y * 0.045 + t * 0.35) + 0.6 * sin((p.x + p.y) * 0.03 - t * 0.27),
                cos(p.x * 0.045 - t * 0.31) + 0.6 * cos((p.x - p.y) * 0.03 + t * 0.23));
  }

  void main() {
    float t = uTime - uArrive;                 // seconds since this portrait was built
    float still = 1.0 - uFly;                  // convergence motion only lives near the portrait
    float k = aPos.z / uD0;
    float z = uNear + mod(aPos.z - uTravel - uNear, uPeriod);
    // generation: 0 on the first pass (the portrait), then 1, 2… each time the tile wraps round to the far end
    float gen = -floor((aPos.z - uTravel - uNear) / uPeriod);
    uint iid = uint(gl_InstanceID);
    float filler = step(rnd(iid, 0u), FILLER);   // portrait-only: dissolves as you fly in, never streams
    vec2 ref = aPos.xy;
    float size = aSize.x * mix(aSize.y, 1.0, uFly);
    float dim = 1.0;
    float alpha = 1.0;
    vec2 slot = aSlot;
    vec3 p;

    if (aKind > 2.5) {
      // ---- lane: placed on the CPU (updateLane), so the close-ups can follow it: aPos = (x, y, distance along the
      // flight), aSize.x = height, aSlot = its work in the atlas ----
      z = aPos.z - uTravel;
      p = vec3(aPos.xy, -z);
      size = aSize.x / k;   // s = size * k below gives the height back
      alpha = smoothstep(0.25, 0.9, uFly);   // appears once you leave the portrait
    } else if (aKind > 1.5) {
      // ---- mote: endless trips from far out in the dark to its place on the face ----
      float dur = 5.0 + hash(aSeed * 1.3) * 4.0;
      float L = dur + 0.3 + hash(aSeed * 2.9) * 1.5;
      float tt = t - hash(aSeed * 3.7) * 6.0;           // first trips are staggered
      float n = floor(tt / L);
      float pm = (tt - n * L) / dur;
      float hn = aSeed + n * 17.13;                      // every trip starts somewhere new
      float ang = hash(hn * 1.1) * 6.2831853;
      float rad = (110.0 + hash(hn * 2.2) * 140.0) * UNIT * k;
      vec3 to = vec3(ref * k, -z);
      vec3 from = vec3(cos(ang) * rad, sin(ang) * rad * 0.8, -z * (1.3 + hash(hn * 3.3) * 0.6));
      float e = pm < 0.5 ? 2.0 * pm * pm : 1.0 - pow(-2.0 * pm + 2.0, 2.0) / 2.0;
      p = mix(from, to, e);
      float kz = -p.z / uD0;
      p.xy += flow(p.xy / kz, uTime + aSeed) * (1.0 - e) * 12.0 * UNIT * kz;   // carried by the same currents
      size = aSize.x * (0.4 + hash(hn * 4.4) * 0.5) * (1.0 - 0.3 * e);
      dim = clamp(pm / 0.3, 0.0, 1.0) * clamp((1.0 - pm) / 0.15, 0.0, 1.0) * 0.9;
      alpha = (tt < 0.0 || pm > 1.0 || uMotes < 0.01) ? 0.0 : 1.0;
      dim *= uMotes;
    } else {
      if (gen > 0.5) {
        // ---- wrapped: streams through the tunnel at a new random place every round, never back on the portrait ----
        uint ug = uint(gen) * 4u;
        float ang = rnd(iid, ug + 1u) * 6.2831853;
        float rad = LANE_RX + pow(rnd(iid, ug + 2u), 0.8) * (STREAM_R - LANE_RX);   // never in the lane
        ref = vec2(cos(ang) * rad, sin(ang) * rad * 0.8) / k;   // world position, kept on the reference plane
        size = (2.0 + pow(rnd(iid, ug + 3u), 2.2) * 9.0) * UNIT / k;
        if (aKind < 0.5) alpha = 1.0 - filler;
      } else if (aKind < 0.5 && aDim < 1.0) {
        // ---- halo: an endless trip in toward its place on the silhouette ----
        float u = fract(uTime * (0.05 + hash(aSeed * 2.3) * 0.07) + hash(aSeed * 4.1));   // 0 far out, 1 home
        float o = pow(1.0 - u, 1.6) * still;
        vec2 b = ref - vec2(0.0, uHaloY);
        vec2 dir = b / max(length(b), 1e-3);
        float R0 = (20.0 + hash(aSeed * 6.7) * 40.0 + (1.0 - aDim) * 40.0) * UNIT;
        ref += dir * o * R0 + flow(ref, uTime + hash(aSeed * 8.9) * 40.0) * o * R0 * 0.35;
        dim = mix(aDim * min(1.0, u / 0.3) * (1.0 - max(0.0, (u - 0.82) / 0.18) * 0.85), 1.0, uFly);
        size *= mix(0.6 + 0.4 * u, 1.0, uFly);
      }
      // alive: even when the portrait is whole every tile stirs, a small loop of its own (a fraction of its size,
      // so the face stays legible) and a slow breath in size; it settles as you fly in
      if (aKind < 0.5 && gen < 0.5 && uAlive > 0.0) {
        float w1 = 0.9 + hash(aSeed * 9.71) * 1.6, w2 = 0.7 + hash(aSeed * 4.93) * 1.4;
        float pa = hash(aSeed * 2.39) * 6.2831853;
        float al = uAlive * still;
        ref += vec2(sin(uTime * w1 + pa) + 0.35 * sin(uTime * w2 * 2.3 + pa * 3.1),
                    cos(uTime * w2 + pa * 1.7) + 0.35 * cos(uTime * w1 * 1.9 + pa * 2.2)) * aSize.x * 0.38 * al;
        size *= 1.0 + 0.16 * al * sin(uTime * (w1 + w2) * 0.6 + pa * 2.3);
      }
      p = vec3(ref * k, -z);
      // ... and drifts a little along its own line of sight: no change on screen, but layers slide past each other
      // as the pointer moves
      if (aKind < 0.5 && gen < 0.5 && uAlive > 0.0) p *= 1.0 + 0.06 * uAlive * still * sin(uTime * 0.7 + hash(aSeed * 6.61) * 6.2831853);

      // ---- intro: out of the dark, further back and off to the side, each on its own time ----
      float ip = clamp((t - aIntro.x) / aIntro.y, 0.0, 1.0);
      ip = 1.0 - pow(1.0 - ip, 3.0);
      float ia = hash(aSeed * 5.9) * 6.2831853;
      float ir = (60.0 + hash(aSeed * 7.1) * 120.0) * UNIT * k;
      vec3 from = vec3(cos(ia) * ir, sin(ia) * ir, -z * (1.4 + hash(aSeed * 9.3) * 1.2));
      p = mix(from, p, ip);

      // ---- chaos: the further the pointer is from the centre, the more the portrait breaks apart (fully at the
      // edge of the window, or with the pointer off the page); each tile flies its own way (the pointer's offset
      // turned by the tile's own angle, and some depth), and while scattered the pieces drift freely ----
      if (aKind < 0.5 && gen < 0.5 && uChaos > 0.0) {
        float off = length(uScatter);
        // inside uChaosZone of the centre the face is whole; beyond it, it breaks up, completely 0.32 out (about a third of the way to the edge)
        float m = uChaos * pow(clamp((off - uChaosZone) / max(0.05, 0.32 - uChaosZone), 0.0, 1.0), 0.9) * still;
        // each piece heads for its own random spot, spread evenly over the whole window (centred on it): placed on
        // the reference plane and carried along the tile's own line of sight, so the spread is even on screen
        vec2 spot = uScreenC + (vec2(rnd(iid, 7u), rnd(iid, 8u)) * 2.0 - 1.0) * uScreenR * 1.05;
        p.xy = mix(p.xy, spot * k, m);
        p.z -= (hash(aSeed * 2.71) - 0.5) * 60.0 * UNIT * k * m;
        // free drift: each piece wanders on its own slow loop (own speeds and phases), carried by a shared swirl
        float f1 = 0.15 + hash(aSeed * 1.91) * 0.35, f2 = 0.12 + hash(aSeed * 3.17) * 0.3;
        float ph = hash(aSeed * 5.53) * 6.2831853;
        vec2 wander = vec2(sin(uTime * f1 + ph), cos(uTime * f2 + ph * 1.3)) * (0.5 + hash(aSeed * 6.29));
        vec2 swirl = flow(ref * 0.8 + vec2(uTime * 6.0, -uTime * 4.0) * UNIT, uTime * 0.5 + hash(aSeed * 7.07) * 6.0);
        p.xy += (wander * 22.0 + swirl * 14.0) * UNIT * k * m;
        p.z += sin(uTime * (f1 + f2) * 0.7 + ph * 2.0) * 18.0 * UNIT * k * m;
      }
      dim *= min(1.0, ip * 1.6);
      size *= 0.35 + 0.65 * ip;
      if (aKind > 0.5) alpha = uFly;           // atmosphere only once you fly in
      else if (gen < 0.5) {
        // most of the portrait dissolves as you fly in, and so does anything in the lane's way
        float inLane = step(abs(p.x), LANE_RX) * step(abs(p.y), LANE_RY);
        alpha *= 1.0 - max(filler, inLane) * uFly;
      }
    }

    float s = size * k;
    vec4 mv = viewMatrix * vec4(p + vec3(position.xy * s, 0.0), 1.0);
    float dist = -mv.z;

    // about to pass the camera: while it breaks up into noise, the image also goes out of focus and darkens
    // (1 right in front of the camera, 0 once it is ~2 of its own heights away: until then it stays sharp)
    // (close works are sharpened by hires.js, which repeats these numbers)
    float nearT = 1.0 - smoothstep(s * 1.0, s * 2.2, dist);
    vAlpha = alpha * smoothstep(s * 1.0, s * 3.0, dist);
    vDim = dim * (1.0 - 0.45 * nearT);
    vFar = smoothstep(uPeriod * 0.45, uPeriod * 0.92, z) * uFly;   // far tiles sink into the background (hides the wrap)

    // depth of field: far tiles sample smaller mip levels; pad keeps blurred samples inside their own atlas tile
    vBias = uBlur * (pow(smoothstep(30.0, uPeriod, dist), 0.75) * 4.0 + nearT * nearT * 2.5);   // far: soft; passing: defocused
    vec2 pad = 0.5 * exp2(vBias) / uTilePx + 0.002;
    vec2 inset = mix(pad, 1.0 - pad, uv);
    vUv = vec2(slot.x + inset.x * uTileUV.x, slot.y - (1.0 - inset.y) * uTileUV.y);
    vLocal = uv;
    vMean = aMean;
    vCell = aCell;
    // a random share become colour accents, each in one colour of the palette
    vAccent = step(hash(aSeed * 7.77), uAccent);
    vPal = floor(hash(aSeed * 3.33) * ${PALETTE.length}.0);
    gl_Position = projectionMatrix * mv;
  }`

const fragmentShader = /* glsl */ `
  uniform sampler2D uAtlas;
  uniform vec3 uBg;
  uniform float uTint, uMono;
  uniform vec3 uPalette[${PALETTE.length}];
  varying vec2 vUv, vLocal;
  varying vec3 vMean, vCell;
  varying float vAlpha, vBias, vFar, vDim, vAccent, vPal;
  // interleaved gradient noise: an order-free dissolve, no sorting or blending needed
  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
  void main() {
    if (vAlpha < 0.999 && ign(gl_FragCoord.xy) > vAlpha) discard;
    vec2 q = abs((vLocal - 0.5) * vec2(1.3333, 1.0)) - vec2(0.6667, 0.5) + 0.06;   // rounded corners
    if (length(max(q, 0.0)) > 0.06) discard;
    vec3 c = texture2D(uAtlas, vUv, vBias).rgb;
    c = clamp(c + (vCell - vMean) * uTint, 0.0, 1.0);   // optional pull toward the portrait's colour
    // black and white like a print: levels stretched and lifted, so photos read as bright as the original's logos
    float g = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float gm = pow(clamp((g - 0.06) / 0.64, 0.0, 1.0), 0.8);
    // accents: a gradient map black -> palette colour -> white keeps the photo's detail in a vivid colour,
    // with a little of the photo's own colour left in
    vec3 pal = uPalette[int(vPal + 0.5)];
    // the colour holds most of the range (only the brightest third lifts toward white, and not all the way)
    vec3 gmap = gm < 0.65 ? mix(vec3(0.0), pal, gm / 0.65) : mix(pal, vec3(1.0), (gm - 0.65) / 0.35 * 0.5);
    vec3 look = mix(vec3(gm), mix(c, gmap, 0.8), vAccent);
    c = mix(c, look, uMono);
    c = mix(uBg, c, vDim);                              // halo, motes and arrivals fade in from the background
    c = mix(c, uBg, vFar);
    gl_FragColor = vec4(c, 1.0);
  }`

export function createMaterial(atlasCanvas, bg) {
  const texture = new THREE.CanvasTexture(atlasCanvas)
  texture.generateMipmaps = true
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.anisotropy = 8
  const uniforms = {
    uAtlas: { value: texture },
    uBg: { value: new THREE.Color(bg) },
    uTint: { value: 0 },
    uMono: { value: 1 },        // 0 full colour, 1 black and white
    uTileCount: { value: 1 },   // works in the atlas (the lane walks through them in order)
    uAccent: { value: 0.3 },    // share of tiles that become colour accents
    uPalette: { value: PALETTE.map((c) => new THREE.Color(c)) },
    uD0: { value: D0 },
    uTravel: { value: 0 },
    uPeriod: { value: 800 },
    uNear: { value: NEAR },
    uTime: { value: 0 },
    uArrive: { value: 0 },
    uFly: { value: 0 },
    uBlur: { value: 1 },
    uMotes: { value: 0 },
    uChaos: { value: 0 },
    uChaosZone: { value: 0.02 },
    uAlive: { value: 1 },
    uScatter: { value: new THREE.Vector2() },
    uScreenC: { value: new THREE.Vector2() },
    uScreenR: { value: new THREE.Vector2(50, 30) },
    uHaloY: { value: PH * 0.1 },   // the halo streams in toward a point a little above the portrait's centre
    uTileUV: { value: new THREE.Vector2(TILE_W / ATLAS, TILE_H / ATLAS) },
    uTilePx: { value: new THREE.Vector2(TILE_W, TILE_H) },
  }
  const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms })
  return { material, uniforms, texture }
}

function nearestTiles(rgb, tiles, k) {
  const best = []   // [dist, index], ascending, at most k
  for (let i = 0; i < tiles.length; i++) {
    const m = tiles[i].mean
    const dr = m[0] - rgb[0], dg = m[1] - rgb[1], db = m[2] - rgb[2]
    const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11
    if (best.length < k || d < best[best.length - 1][0]) {
      best.push([d, i])
      best.sort((a, b) => a[0] - b[0])
      if (best.length > k) best.pop()
    }
  }
  return best
}

export function buildGeometry(portrait, tiles, { spread, minSize = 0.2 }, seed = 1) {
  const rand = mulberry32(seed)
  const { cols, rows, cells } = portrait
  const cellH = PH / rows
  const cellW = cellH * (4 / 3)
  const fullH = cellH * 0.94
  const period = D0 * spread + 60
  const n = cells.length + ATMOSPHERE + MOTES + LANE.n

  const aPos = new Float32Array(n * 3)
  const aSize = new Float32Array(n * 2)
  const aSlot = new Float32Array(n * 2)
  const aMean = new Float32Array(n * 3)
  const aCell = new Float32Array(n * 3)
  const aSeed = new Float32Array(n)
  const aKind = new Float32Array(n)
  const aDim = new Float32Array(n).fill(1)
  const aIntro = new Float32Array(n * 2)
  const tileOf = new Int32Array(n).fill(-1)   // which work each tile shows (for the sharp close-ups)
  const delayPerCell = 0.009 * (110 / cols)   // the centre settles first (tuned for a 110-column portrait)
  let introEnd = 0

  const put = (i, x0, y0, d, h, hs, tile, cellRgb, kind) => {
    aPos.set([x0, y0, d], i * 3)
    aSize.set([h, hs], i * 2)
    aSlot.set([tile.u0, tile.v0], i * 2)
    tileOf[i] = tiles.indexOf(tile)
    aMean.set(tile.mean, i * 3)
    aCell.set(cellRgb || tile.mean, i * 3)
    aSeed[i] = rand() * 1000
    aKind[i] = kind
  }

  // brightness rank of every cell (ties broken at random, so flat areas get a natural mix of sizes) -> halftone size
  const order = cells.map((c, i) => [c.L + rand() * 1e-3, i]).sort((a, b) => a[0] - b[0])
  const halftone = new Float32Array(cells.length)
  order.forEach(([, i], r) => {
    const u = (r / Math.max(1, cells.length - 1)) * (HS_QUANTILES.length - 1)
    const q = Math.min(HS_QUANTILES.length - 2, Math.floor(u))
    halftone[i] = HS_QUANTILES[q] + (HS_QUANTILES[q + 1] - HS_QUANTILES[q]) * (u - q)
  })

  const core = []
  cells.forEach((c, i) => {
    const near = nearestTiles(c.rgb, tiles, Math.min(MATCH_K, tiles.length))
    const tile = tiles[near[Math.floor(rand() * near.length)][1]]
    // exactly on the grid: the regular dot-matrix rows are part of the look
    const x0 = (c.col - cols / 2 + 0.5) * cellW
    const y0 = (rows / 2 - c.row - 0.5) * cellH
    // depth spread evenly from 0.35 D0 to `spread` D0 (as on the original): most tiles sit well behind the
    // reference plane, so the portrait survives a little camera movement
    const d = D0 * (0.35 + (spread - 0.35) * rand())
    const hs = Math.max(minSize, halftone[i])   // dark parts of the subject still draw its outline
    put(i, x0, y0, d, fullH, hs, tile, c.rgb, KIND_PORTRAIT)
    if (c.edge < HALO_DIM.length) aDim[i] = HALO_DIM[c.edge]
    else core.push(i)
    const delay = rand() * 1.5 + Math.hypot(c.col - cols / 2, c.row - rows * 0.4) * delayPerCell
    const dur = 1.3 + rand() * 0.9
    aIntro.set([delay, dur], i * 2)
    introEnd = Math.max(introEnd, delay + dur)
  })

  let i = cells.length
  for (let j = 0; j < ATMOSPHERE; j++, i++) {
    const d = 20 + rand() * (period - 20)
    const r = LANE.rx + Math.sqrt(rand()) * (STREAM_R - LANE.rx)   // keeps out of the lane
    const a = rand() * Math.PI * 2
    const h = 4 + rand() * 6
    const s = D0 / d   // store on the reference plane so the shader's d / D0 scale gives world values back
    put(i, Math.cos(a) * r * s, Math.sin(a) * r * s, d, h * s, 1, tiles[Math.floor(rand() * tiles.length)], null, KIND_ATMOSPHERE)
    aIntro.set([0, 0.01], i * 2)
  }

  // motes land on core cells (not the halo), each with its own image
  for (let j = 0; j < MOTES && core.length; j++, i++) {
    const t = core[Math.floor(rand() * core.length)]
    put(i, aPos[t * 3], aPos[t * 3 + 1], aPos[t * 3 + 2], fullH, 1, tiles[Math.floor(rand() * tiles.length)], null, KIND_MOTE)
    aIntro.set([0, 0.01], i * 2)
  }

  // the lane: LANE.n slots, placed each frame by updateLane
  const laneBase = i
  for (let j = 0; j < LANE.n; j++, i++) {
    put(i, j, 0, D0, 1, 1, { u0: 0, v0: 1, mean: [0.5, 0.5, 0.5] }, null, KIND_LANE)
    aIntro.set([0, 0.01], i * 2)
  }

  const base = new THREE.PlaneGeometry(4 / 3, 1)
  const g = new THREE.InstancedBufferGeometry()
  g.index = base.index
  g.setAttribute("position", base.attributes.position)
  g.setAttribute("uv", base.attributes.uv)
  const attrs = { aPos: [aPos, 3], aSize: [aSize, 2], aSlot: [aSlot, 2], aMean: [aMean, 3], aCell: [aCell, 3],
    aSeed: [aSeed, 1], aKind: [aKind, 1], aDim: [aDim, 1], aIntro: [aIntro, 2] }
  for (const [name, [arr, size]] of Object.entries(attrs)) g.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size))
  g.instanceCount = i
  const haloCount = cells.length - core.length
  return { geometry: g, tileOf, laneBase, laneLi: new Int32Array(LANE.n).fill(-1), period, introEnd, width: cols * cellW, height: PH, portraitCount: cells.length, haloCount }
}

// ---------- the lane, on the CPU ----------
// Work li sits at LANE.z0 + li * LANE.step along the flight, in a loose cluster round the centre, in order; each of
// the LANE.n slots takes every LANE.n-th work, the next one still ahead of the camera.
export function lanePiece(li, tileCount) {
  const r = mulberry32(li * 7919 + 1013)
  const a = r() * Math.PI * 2, rr = Math.sqrt(r())
  return {
    li,
    x: Math.cos(a) * rr * LANE.x,
    y: Math.sin(a) * rr * LANE.y,
    z: LANE.z0 + li * LANE.step,     // distance along the flight
    h: LANE.h * (0.85 + 0.3 * r()),
    j: li % tileCount,                // its work in the atlas
  }
}

// places the lane slots for this travel; returns the pieces currently in the lane
export function updateLane(built, tiles, travel) {
  const g = built.geometry, pos = g.attributes.aPos, size = g.attributes.aSize, slot = g.attributes.aSlot
  const pieces = []
  let changed = false
  for (let s = 0; s < LANE.n; s++) {
    const li = Math.max(s, s + LANE.n * Math.ceil((travel + NEAR - LANE.z0 - s * LANE.step) / (LANE.n * LANE.step)))
    const pc = lanePiece(li, tiles.length)
    pieces.push(pc)
    if (built.laneLi[s] === li) continue
    built.laneLi[s] = li
    const i = built.laneBase + s, t = tiles[pc.j]
    pos.setXYZ(i, pc.x, pc.y, pc.z)
    size.setX(i, pc.h)
    slot.setXY(i, t.u0, t.v0)
    changed = true
  }
  if (changed) pos.needsUpdate = size.needsUpdate = slot.needsUpdate = true
  return pieces
}

// ---------- the streaming tiles, on the CPU ----------
// The exact twin of the shader's ihash / rnd, so positions computed here match the GPU's.
function ihash(x) {
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16
  return x >>> 0
}
const rnd = (a, b) => Math.fround(ihash((Math.imul(a, 0x9e3779b9) + ihash(b)) >>> 0)) / 4294967296

// Every tile of the field that is visible in flight (portrait tiles that stay, atmosphere, the stream) with its
// current place, as pieces for hires.js: those at least minPx tall on screen. Only valid while flying (fly = 1).
export function streamPieces(built, travel, period, focal, minPx, halfW, halfH) {
  const g = built.geometry, pos = g.attributes.aPos.array, size = g.attributes.aSize.array, kind = g.attributes.aKind.array
  const out = []
  for (let i = 0; i < built.laneBase; i++) {
    const kd = kind[i]
    if (kd > 1.5) continue                              // motes (only at the portrait)
    const d = pos[i * 3 + 2]
    const u = d - travel - NEAR
    const z = NEAR + (((u % period) + period) % period)
    if (z < 2) continue
    const gen = -Math.floor(u / period)
    const filler = rnd(i, 0) < FILLER
    if (kd < 0.5 && filler) continue                    // dissolved in flight
    const k = d / D0
    let x, y, h
    if (gen > 0) {
      const ug = gen * 4
      const ang = rnd(i, ug + 1) * Math.PI * 2
      const rad = LANE.rx + Math.pow(rnd(i, ug + 2), 0.8) * (STREAM_R - LANE.rx)
      x = Math.cos(ang) * rad; y = Math.sin(ang) * rad * 0.8
      h = (2 + Math.pow(rnd(i, ug + 3), 2.2) * 9) * UNIT
    } else {
      x = pos[i * 3] * k; y = pos[i * 3 + 1] * k
      h = size[i * 2] * k
      if (kd < 0.5 && Math.abs(x) < LANE.rx && Math.abs(y) < LANE.ry) continue   // cleared from the lane's way
    }
    const px = (h * focal) / z
    if (px < minPx) continue
    // on screen at all? (a big tile passing beside the camera is no use)
    const sx = Math.abs(x) * focal / z, sy = Math.abs(y) * focal / z
    if (sx - px * 0.67 > halfW || sy - px * 0.5 > halfH) continue
    out.push({ key: i * 4096 + gen, x, y, z: z + travel, h, j: built.tileOf[i], px })
  }
  return out
}
