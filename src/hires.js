// Sharp close-ups (as on the original): when a work (in the lane or the stream) grows taller than HI_PX on screen, a
// high-resolution copy is fetched and laid exactly over its atlas tile, fading in. Decoding happens off the main thread
// (createImageBitmap) and at most one new texture goes to the GPU per frame, so arrivals never hitch the flight.
import * as THREE from "three"

const HI_PX = 120          // on-screen height (CSS px) from which a work shows its sharp copy
const FETCH_PX = 50        // ... and from which its sharp copy starts loading, so it is there in time
const PREFETCH = 8         // the next lane works ahead always have their sharp copy fetched in advance
const MAX_MESHES = 20      // close-ups shown at once
const CACHE = 64           // sharp textures kept (least recently used ones are dropped)
const LOADING = 4          // fetches at once

const vertexShader = /* glsl */ `
  uniform vec3 uPiece;     // x, y, distance along the flight
  uniform float uH, uTravel, uFly, uFade;
  varying vec2 vUv, vLocal;
  varying float vAlpha, vDim;
  void main() {
    float z = uPiece.z - uTravel;
    vec3 p = vec3(uPiece.xy, -z + 0.02);   // a hair in front of its atlas tile
    vec4 mv = viewMatrix * vec4(p + vec3(position.xy * uH, 0.0), 1.0);
    float dist = -mv.z;
    // the same near dissolve as the field (see field.js), so the pair passes the camera as one
    float nearT = 1.0 - smoothstep(uH * 1.0, uH * 2.2, dist);
    vAlpha = uFade * smoothstep(0.25, 0.9, uFly) * smoothstep(uH * 1.0, uH * 3.0, dist);
    vDim = 1.0 - 0.45 * nearT;
    vLocal = uv;
    vUv = uv;
    gl_Position = projectionMatrix * mv;
  }`

const fragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec2 uCrop;      // cover-crop scale (the photo's aspect vs the 4:3 tile)
  uniform vec3 uBg;
  varying vec2 vUv, vLocal;
  varying float vAlpha, vDim;
  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
  void main() {
    if (vAlpha < 0.999 && ign(gl_FragCoord.xy) > vAlpha) discard;
    vec2 q = abs((vLocal - 0.5) * vec2(1.3333, 1.0)) - vec2(0.6667, 0.5) + 0.06;   // rounded corners
    if (length(max(q, 0.0)) > 0.06) discard;
    vec2 uv = 0.5 + (vUv - 0.5) * uCrop;
    vec3 c = texture2D(uMap, vec2(uv.x, 1.0 - uv.y)).rgb;   // bitmaps are not flipped on upload
    gl_FragColor = vec4(mix(uBg, c, vDim), 1.0);
  }`

export function createHiRes(scene, shared) {
  const geo = new THREE.PlaneGeometry(4 / 3, 1)
  const pool = Array.from({ length: MAX_MESHES }, () => {
    const mat = new THREE.ShaderMaterial({
      vertexShader, fragmentShader,
      uniforms: {
        uMap: { value: null }, uCrop: { value: new THREE.Vector2(1, 1) },
        uPiece: { value: new THREE.Vector3() }, uH: { value: 1 }, uFade: { value: 0 },
        uTravel: shared.uTravel, uFly: shared.uFly, uBg: shared.uBg,
      },
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false
    mesh.visible = false
    mesh.userData = { key: null, fade: 0 }
    scene.add(mesh)
    return mesh
  })

  const cache = new Map()   // url -> { state: "loading" | "ready" | "failed", bitmap, texture, crop, used }
  let loading = 0

  function fetchSharp(url) {
    const entry = { state: "loading", used: performance.now() }
    cache.set(url, entry)
    loading++
    fetch(url, { mode: "cors" })
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.blob() })
      .then((blob) => createImageBitmap(blob))
      .then((bitmap) => {
        entry.bitmap = bitmap
        const a = bitmap.width / bitmap.height, tile = 4 / 3
        entry.crop = a > tile ? new THREE.Vector2(tile / a, 1) : new THREE.Vector2(1, a / tile)
        entry.state = "decoded"
      })
      .catch(() => { entry.state = "failed" })
      .finally(() => { loading-- })
  }

  function trim() {
    if (cache.size <= CACHE) return
    const inUse = new Set(pool.filter((m) => m.visible).map((m) => m.userData.url))
    const old = [...cache].filter(([u, e]) => !inUse.has(u) && e.state !== "loading").sort((a, b) => a[1].used - b[1].used)
    for (const [u, e] of old.slice(0, cache.size - CACHE)) {
      e.texture?.dispose()
      e.bitmap?.close?.()
      cache.delete(u)
    }
  }

  // lane: the lane pieces (field.js updateLane: { li, x, y, z, h, j }); stream: the other visible tiles at least
  // FETCH_PX tall (field.js streamPieces: { key, x, y, z, h, j, px }); z is the distance along the flight;
  // focal: CSS px per world unit at distance 1
  function update(lane, stream, tiles, travel, focal, dt, active) {
    const now = performance.now()
    let uploaded = false
    const wanted = new Map()   // key -> piece: the biggest on screen
    if (active) {
      const all = lane.map((pc) => ({ ...pc, key: "L" + pc.li, px: (pc.h * focal) / Math.max(0.01, pc.z - travel) }))
        .concat(stream)
        .filter((pc) => pc.z - travel > 1 && tiles[pc.j]?.hi)
      // fetch ahead: the next few works down the lane, and anything already growing on screen, biggest first
      const ahead = all.filter((pc) => typeof pc.key === "string").sort((a, b) => a.z - b.z).slice(0, PREFETCH)
      const growing = all.filter((pc) => pc.px > FETCH_PX).sort((a, b) => b.px - a.px)
      for (const pc of ahead.concat(growing)) {
        if (loading >= LOADING) break
        const url = tiles[pc.j].hi
        if (!cache.has(url)) fetchSharp(url)
      }
      all.filter((pc) => pc.px > HI_PX)
        .sort((a, b) => b.px - a.px)
        .slice(0, MAX_MESHES)
        .forEach((pc) => wanted.set(pc.key, pc))
    }

    // keep shown close-ups in step with their tile (stream tiles move on wrap), fade out the rest, free their mesh
    for (const m of pool) {
      if (!m.visible) continue
      const pc = wanted.get(m.userData.key)
      const keep = !!pc && tiles[pc.j]?.hi === m.userData.url
      m.userData.fade = Math.max(0, Math.min(1, m.userData.fade + (keep ? dt : -dt) * 4))
      m.material.uniforms.uFade.value = m.userData.fade
      if (keep) {
        m.material.uniforms.uPiece.value.set(pc.x, pc.y, pc.z)
        m.material.uniforms.uH.value = pc.h
        wanted.delete(m.userData.key)   // already shown
      } else if (m.userData.fade <= 0) { m.visible = false; m.userData.key = null }
    }

    for (const pc of wanted.values()) {
      const url = tiles[pc.j].hi
      const e = cache.get(url)
      if (!e) { if (loading < LOADING) fetchSharp(url); continue }
      e.used = now
      if (e.state === "decoded" && !uploaded) {
        // one texture per frame goes to the GPU
        e.texture = new THREE.Texture(e.bitmap)
        e.texture.colorSpace = THREE.NoColorSpace
        e.texture.flipY = false
        e.texture.generateMipmaps = true
        e.texture.minFilter = THREE.LinearMipmapLinearFilter
        e.texture.anisotropy = 8
        e.texture.needsUpdate = true
        e.state = "ready"
        uploaded = true
      }
      if (e.state !== "ready") continue
      const m = pool.find((x) => !x.visible)
      if (!m) break
      const u = m.material.uniforms
      u.uMap.value = e.texture
      u.uCrop.value.copy(e.crop)
      u.uPiece.value.set(pc.x, pc.y, pc.z)
      u.uH.value = pc.h
      u.uFade.value = 0
      m.userData = { key: pc.key, fade: 0, url }
      m.visible = true
    }
    trim()
  }

  return { update }
}
