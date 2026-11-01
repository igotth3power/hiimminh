import * as THREE from "three"
import GUI from "lil-gui"
import { buildProceduralAtlas, buildAtlasFromFiles, buildOnlineAtlas, PHOTO_SOURCES, CAPACITY } from "./atlas.js"
import { proceduralPortrait, sampleCells } from "./portrait.js"
import { createMaterial, buildGeometry, updateLane, streamPieces, D0, PH } from "./field.js"
import { createHiRes } from "./hires.js"
import { removeBackground, trimTransparent } from "./segment.js"
import { createSignature } from "./signature.js"
import { createLoader } from "./loader.js"

THREE.ColorManagement.enabled = false   // colours used exactly as authored (sRGB in, sRGB out)

const BG = 0x0a0a0b
const PHOTO_DEADLINE = 25000   // ms; matches buildOnlineAtlas's default deadline
const RELEASE = 150            // travel over which the first scroll out of the portrait is slowed
const RESTORE_SCROLL = 120     // scroll distance (fly units: ~5 wheel notches) that fully restores a scrambled portrait
let restore = 0                // 0..1: how far scrolling has brought the scrambled portrait together
let pointerScatter = 0         // how scattered the real pointer position would make the portrait (0..1)
let sigScatter = 0             // the signature's eased view of how scattered the portrait is
let restoreS = 0               // the same, smoothed: the pieces drift back rather than jump
const RESTORED = 0.985         // restoreS from which the restore counts as complete (and scrolling may fly)
let lastScroll = 0
const $ = (s) => document.querySelector(s)
// the page shows no text: status messages are kept off-screen (inspect statusEl.textContent when debugging)
const statusEl = document.createElement("p")
// the settings panel only with ?gui in the address
const SHOW_GUI = new URLSearchParams(location.search).has("gui")

// ---------- renderer, scene, camera ----------
// transparent canvas: the signature layer underneath shows between the tiles
const renderer = new THREE.WebGLRenderer({ canvas: $("#c"), antialias: true, alpha: true, powerPreference: "high-performance" })
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2))
renderer.outputColorSpace = THREE.LinearSRGBColorSpace
renderer.setClearColor(BG, 0)
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 4000)
const signature = createSignature($("#sig"))

// ---------- state ----------
const params = {
  rows: 200,
  spread: 9,
  threshold: 0.06,
  gamma: 1.8,
  invert: false,
  floor: 0.08,
  vcut: true,
  vStart: 0.7,
  vBottom: 0,
  minSize: 0.2,
  vFlare: 0.8,
  vAsym: -0.4,
  removeBg: true,
  photoSource: "wikimedia",
  tint: 0,
  mono: 1,
  accent: 0.3,
  parallax: 0.35,
  blur: 1,
  chaos: true,        // break the portrait apart unless the pointer is on the restore point
  chaosAmount: 1,
  chaosRandom: false, // restore point at a random place (else the centre of the window)
  alive: 1,           // the tiles stir even when the portrait is whole
  chaosZone: 0.05,    // radius around the restore point where the face is whole (pointer units)
  home: () => goHome(),
}

let source = null   // set in init(): the bundled cut-out photo, or the drawn bust as a fallback
let atlas = buildProceduralAtlas()   // replaced by random online photos (params.photoSource) once they load
const { material, uniforms, texture } = createMaterial(atlas.canvas, BG)
const hiRes = createHiRes(scene, uniforms)
let mesh = null
let frame = { width: 80, height: 60 }   // portrait size on the reference plane, for framing
let travel = 0, target = 0
let rewind = null      // { from, t0, dur } while flying back to the portrait
let introEnd = 3.5     // seconds until the last tile has landed
// chaos mode: a restore point (pointer units, -1..1, y up; the centre unless chaosRandom); away from it the portrait
// breaks apart, fully at the edge or with the pointer off the page. Until the mouse first moves, it rests on it.
const sweet = { x: 0, y: 0 }
function newRestorePoint() {
  sweet.x = params.chaosRandom ? (Math.random() - 0.5) * 1.2 : 0
  sweet.y = params.chaosRandom ? (Math.random() - 0.5) * 1.0 : 0
}
const pointer = { x: 0, y: 0, sx: 0, sy: 0 }
newRestorePoint()
if (params.chaos) { pointer.x = pointer.sx = sweet.x; pointer.y = pointer.sy = sweet.y }
const timer = new THREE.Timer()

function rebuild() {
  const portrait = sampleCells(source, params)
  const built = buildGeometry(portrait, atlas.tiles, params)
  if (mesh) {
    mesh.geometry.dispose()
    mesh.geometry = built.geometry
  } else {
    mesh = new THREE.Mesh(built.geometry, material)
    mesh.frustumCulled = false   // positions are computed in the shader
    scene.add(mesh)
  }
  frame = built
  uniforms.uPeriod.value = built.period
  uniforms.uTileCount.value = atlas.tiles.length
  uniforms.uArrive.value = timer.getElapsed()
  introEnd = built.introEnd
  travel = target = 0
  rewind = null
  resize()
  statusEl.textContent = `${built.portraitCount.toLocaleString()} ảnh trên chân dung (${built.haloCount.toLocaleString()} ở viền) · ${atlas.tiles.length} tác phẩm`
}

function setAtlas(next) {
  atlas = next
  texture.image = next.canvas
  texture.needsUpdate = true
  rebuild()
}

// ---------- framing: fit the portrait into the window, centred ----------
// The projection centre moves there with setViewOffset (an off-axis frustum), so the illusion still lines up
// exactly from the camera.
function resize() {
  const w = innerWidth, h = innerHeight
  const top = 40, bottom = 40   // breathing room above and below the portrait
  const avail = Math.max(120, h - top - bottom)
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  const halfH = Math.max((frame.height / 2) * (h / avail) / 0.94, frame.width / 2 / 0.92 / camera.aspect)
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(halfH / D0))
  camera.setViewOffset(w, h, 0, h / 2 - (top + avail / 2), w, h)
  camera.updateProjectionMatrix()

  // where the portrait sits on screen (from the camera's home position), for the signature behind it
  const home = camera.position.clone()
  camera.position.set(0, 0, 0)
  camera.updateMatrixWorld()
  const c = new THREE.Vector3(0, 0, -D0).project(camera)
  const crown = new THREE.Vector3(0, PH / 2, -D0).project(camera)
  camera.position.copy(home)
  camera.updateMatrixWorld()
  // the window on the reference plane (where scattered pieces spread out): centre and half size
  const onPlane = (nx, ny) => {
    const v = new THREE.Vector3(nx, ny, 0.5).unproject(camera)
    return v.multiplyScalar(-D0 / v.z)
  }
  camera.position.set(0, 0, 0); camera.updateMatrixWorld()
  const c0 = onPlane(0, 0), c1 = onPlane(1, 1)
  camera.position.copy(home); camera.updateMatrixWorld()
  uniforms.uScreenC.value.set(c0.x, c0.y)
  uniforms.uScreenR.value.set(c1.x - c0.x, c1.y - c0.y)
  const toPx = (v) => [(v.x + 1) / 2 * w, (1 - v.y) / 2 * h]
  const [cx, cy] = toPx(c), [, ty] = toPx(crown)
  signature.resize(w, h, { x: cx, y: cy, h: (cy - ty) * 2 })
}
addEventListener("resize", resize)

// ---------- input: scroll / drag / keys fly; pointer gives parallax ----------
const fly = (dy) => {
  // scrolling restores a scrambled portrait first: at home, the scroll only brings the view back to the restore
  // point (pieces together, parallax lined up), gradually; only once that is complete on screen does it fly on
  lastScroll = performance.now()
  // only when the portrait is visibly scattered; the more scattered, the more scroll it takes (1 to ~5 notches)
  const scattered = params.chaos && travel < 1 && !rewind && pointerScatter > 0.06
  if (scattered && dy > 0 && restoreS < RESTORED) {
    restore = Math.min(1, restore + dy / (RESTORE_SCROLL * Math.max(0.2, pointerScatter)))
    return
  }
  if (dy > 0) restore = 1
  if (rewind) { rewind = null; target = travel }   // scrolling takes over from a flight home
  // leaving the portrait is slow and deliberate: near it a scroll moves only part of the usual distance
  target = Math.max(0, target + dy * (0.4 + 0.6 * THREE.MathUtils.smoothstep(target, 0, RELEASE)))
}
addEventListener("wheel", (e) => { e.preventDefault(); fly(e.deltaY * (e.deltaMode === 1 ? 16 : 1) * 0.25) }, { passive: false })
let touchY = null
addEventListener("touchstart", (e) => { touchY = e.touches[0].clientY }, { passive: true })
addEventListener("touchmove", (e) => {
  if (touchY === null) return
  const y = e.touches[0].clientY
  fly((touchY - y) * 0.6)
  touchY = y
}, { passive: true })
addEventListener("touchend", () => { touchY = null })
// a click (or tap) anywhere while away flies back to the portrait; a drag isn't a click
let downAt = null
addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY] })
addEventListener("click", (e) => {
  if (e.target.closest?.(".lil-gui")) return
  if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 8) return
  if (travel > 1 || target > 1) goHome()
})
addEventListener("keydown", (e) => {
  if (e.target.closest?.(".lil-gui")) return
  if (e.key === "ArrowDown" || e.key === " ") fly(60)
  else if (e.key === "ArrowUp") fly(-60)
  else if (e.key === "Home") goHome()
})
addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch") return   // a finger scrolls; it doesn't steer the parallax / chaos
  pointer.x = (e.clientX / innerWidth) * 2 - 1
  pointer.y = -((e.clientY / innerHeight) * 2 - 1)
})
// the pointer left the page: as if it had gone on past the edge, so the portrait breaks apart (it comes back
// together with the pointer in the middle)
document.documentElement.addEventListener("pointerleave", (e) => {
  if (e.pointerType === "touch") return
  if (!params.chaos) { pointer.x = pointer.y = 0; return }
  let dx = pointer.x - sweet.x, dy = pointer.y - sweet.y
  const len = Math.hypot(dx, dy)
  if (len < 0.05) { const a = Math.random() * Math.PI * 2; dx = Math.cos(a); dy = Math.sin(a) } else { dx /= len; dy /= len }
  pointer.x = sweet.x + dx * 1.4
  pointer.y = sweet.y + dy * 1.4
})

// back to the portrait: a fast reverse flight back through everything passed, which streams back into place
function goHome() {
  target = travel
  if (travel < 1) { travel = target = 0; return }
  rewind = { from: travel, t0: timer.getElapsed(), dur: Math.min(2.6, 1.2 + Math.sqrt(travel) * 0.014) }
}

// ---------- UI: files, webcam, drag and drop ----------
// a new photo: cut the person out of its background first (when enabled), then build the portrait from it
async function usePortrait(img) {
  if (params.removeBg) {
    statusEl.textContent = "Đang tách nền…"
    try {
      img = trimTransparent(await removeBackground(img))
    } catch (err) {
      console.warn("background removal failed", err)
      statusEl.textContent = "Không tách được nền, dùng ảnh gốc."
    }
  }
  source = img
  rebuild()
}

async function portraitFromFile(file) {
  let img
  try { img = await createImageBitmap(file) } catch { statusEl.textContent = "Không đọc được ảnh này."; return }
  await usePortrait(img)
}

async function tilesFromFiles(files) {
  statusEl.textContent = "Đang dựng atlas…"
  const next = await buildAtlasFromFiles(files)
  if (!next) { statusEl.textContent = "Không đọc được ảnh nào."; return }
  setAtlas(next)
  if (files.length > CAPACITY) statusEl.textContent += ` (chỉ dùng ${CAPACITY}/${files.length} ảnh đầu)`
}

const drop = $("#drop")
let dragDepth = 0
addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; drop.classList.add("on") })
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove("on") } })
addEventListener("dragover", (e) => e.preventDefault())
addEventListener("drop", (e) => {
  e.preventDefault()
  dragDepth = 0
  drop.classList.remove("on")
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"))
  if (files.length === 1) portraitFromFile(files[0])
  else if (files.length > 1) tilesFromFiles(files)
})

// ---------- controls ----------
const gui = new GUI({ title: "Thông số" })
const rb = () => rebuild()
gui.add(params, "rows", 40, 200, 1).name("Mật độ (hàng)").onFinishChange(rb)
gui.add(params, "spread", 2, 14, 0.5).name("Độ sâu").onFinishChange(rb)
gui.add(params, "threshold", 0, 0.6, 0.01).name("Ngưỡng tối").onFinishChange(rb)
gui.add(params, "gamma", 0.3, 2.5, 0.05).name("Gamma").onFinishChange(rb)
gui.add(params, "invert").name("Đảo sáng/tối").onChange(rb)
gui.add(params, "floor", 0, 0.5, 0.01).name("Sáng tối thiểu (chủ thể)").onFinishChange(rb)
gui.add(params, "minSize", 0, 0.6, 0.01).name("Cỡ ô tối thiểu").onFinishChange(rb)
gui.add(params, "vcut").name("Đáy hình chữ V").onChange(rb)
gui.add(params, "vStart", 0.3, 0.95, 0.01).name("V bắt đầu từ").onFinishChange(rb)
gui.add(params, "vFlare", 0, 1, 0.01).name("Độ bè cạnh V").onFinishChange(rb)
gui.add(params, "vAsym", -0.5, 0.5, 0.01).name("Lệch bè (phải +)").onFinishChange(rb)
gui.add(params, "vBottom", 0, 0.6, 0.01).name("Đuôi V rộng").onFinishChange(rb)
gui.add(params, "removeBg").name("Tách nền ảnh mới (AI)")
gui.add(params, "photoSource", Object.fromEntries(Object.entries(PHOTO_SOURCES).map(([k, v]) => [v.label, k])))
  .name("Nguồn ảnh").onChange(async () => { const pics = await loadPhotos(); if (pics) setAtlas(pics) })
gui.add(params, "tint", 0, 1, 0.01).name("Nhuộm màu").onChange((v) => { uniforms.uTint.value = v })
gui.add(params, "mono", 0, 1, 0.01).name("Trắng đen (chân dung)")
gui.add(params, "accent", 0, 0.6, 0.005).name("Tỉ lệ điểm màu").onChange((v) => { uniforms.uAccent.value = v })
gui.add(params, "parallax", 0, 3, 0.05).name("Parallax chuột")
gui.add(params, "blur", 0, 1.5, 0.01).name("Mờ xa (DoF)").onChange((v) => { uniforms.uBlur.value = v })
gui.add(params, "alive", 0, 3, 0.01).name("Độ sống động").onChange((v) => { uniforms.uAlive.value = v })
gui.add(params, "chaos").name("Nhiễu loạn theo chuột")
gui.add(params, "chaosAmount", 0, 2, 0.01).name("Mức nhiễu loạn")
gui.add(params, "chaosZone", 0, 0.6, 0.01).name("Vùng hồi phục")
gui.add(params, "chaosRandom").name("Điểm khôi phục ngẫu nhiên").onChange(() => { newRestorePoint() })
gui.add(params, "home").name("Về chân dung")
if (innerWidth < 600) gui.close()
if (!SHOW_GUI) gui.hide()

// ---------- frame loop ----------
function tick(rafTime) {
  timer.update(rafTime)
  const dt = Math.min(timer.getDelta(), 0.1)
  if (rewind) {
    const t = Math.min(1, (timer.getElapsed() - rewind.t0) / rewind.dur)
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2   // ease in-out cubic
    travel = target = rewind.from * (1 - e)
    if (t >= 1) { rewind = null; travel = target = 0 }
  } else {
    // ... and the camera eases after the scroll more gently there too
    travel += (target - travel) * (1 - Math.exp(-dt * (2 + 2 * THREE.MathUtils.smoothstep(travel, 0, RELEASE))))
    if (Math.abs(target - travel) < 0.01) travel = target
  }

  pointer.sx += (pointer.x - pointer.sx) * (1 - Math.exp(-dt * 3))
  pointer.sy += (pointer.y - pointer.sy) * (1 - Math.exp(-dt * 3))
  // a whisper of parallax at the portrait (it must stay legible), much more once flying (as on the original)
  const drift = params.parallax * (1 + 5 * THREE.MathUtils.smoothstep(travel, 0, 72))
  // in chaos mode the parallax is measured from the restore point too, so on it the portrait lines up exactly
  const ox = params.chaos ? sweet.x : 0, oy = params.chaos ? sweet.y : 0
  restoreS += (restore - restoreS) * (1 - Math.exp(-dt * 4))
  if (restore >= 1 && restoreS > RESTORED) restoreS = 1
  // while restoring (at the portrait), the effective pointer is pulled onto the restore point; in flight the real
  // pointer steers the parallax again
  const pull = params.chaos ? THREE.MathUtils.smoothstep(restoreS, 0, 1) * (1 - THREE.MathUtils.smoothstep(travel, 0, 72)) : 0
  const ex = pointer.sx + (ox - pointer.sx) * pull, ey = pointer.sy + (oy - pointer.sy) * pull
  camera.position.set((ex - ox) * drift, (ey - oy) * drift, 0)
  // back home and idle for a moment: the scroll's restoring wears off and the pointer steers the chaos again
  if (travel < 1 && !rewind && performance.now() - lastScroll > 1500) restore = Math.max(0, restore - dt * 0.35)
  uniforms.uChaos.value = params.chaos ? params.chaosAmount : 0
  uniforms.uChaosZone.value = params.chaosZone
  uniforms.uScatter.value.set(ex - ox, ey - oy)

  const now = timer.getElapsed()
  const fly = THREE.MathUtils.smoothstep(travel, 0, 72)   // 0 at the portrait, 1 a little way in
  // motes join once most of the portrait has landed, and only near it
  const ramp = THREE.MathUtils.clamp(((now - uniforms.uArrive.value) / introEnd - 0.35) / 0.65, 0, 1)
  uniforms.uTime.value = now
  uniforms.uTravel.value = travel
  uniforms.uFly.value = fly
  document.body.style.cursor = travel > 15 && !rewind ? "pointer" : ""   // a click takes you home
  // the lane, placed on the CPU, and sharp copies of the works that come close
  if (mesh) {
    const pieces = updateLane(frame, atlas.tiles, travel)
    const focal = innerHeight / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
    const active = fly > 0.97   // the stream's places are only exact in full flight
    const stream = active ? streamPieces(frame, travel, uniforms.uPeriod.value, focal, 50, innerWidth / 2, innerHeight / 2) : []
    hiRes.update(pieces, stream, atlas.tiles, travel, focal, dt, active)
  }
  uniforms.uMotes.value = (1 - fly) * ramp * ramp
  uniforms.uMono.value = params.mono * (1 - fly)   // black and white is the portrait's look; the flight is in colour
  // sign once most of the portrait has landed, only while at home
  // how scattered the portrait is (as in the shader), eased over ~0.6 s: the signature comes forward as it breaks up
  const offC = Math.hypot(ex - ox, ey - oy)
  const scatterRamp = (d) => THREE.MathUtils.clamp((d - params.chaosZone) / Math.max(0.05, 0.42 - params.chaosZone), 0, 1)
  pointerScatter = params.chaos ? Math.min(1, params.chaosAmount) * scatterRamp(Math.hypot(pointer.sx - ox, pointer.sy - oy)) : 0
  const scatterNow = params.chaos ? Math.min(1, params.chaosAmount) * scatterRamp(offC) * (1 - fly) : 0
  sigScatter += (scatterNow - sigScatter) * (1 - Math.exp(-dt * 3.5))
  signature.update(now, !!mesh && travel < 1 && !rewind && now - uniforms.uArrive.value > introEnd * 0.6, THREE.MathUtils.smoothstep(sigScatter, 0, 1))

  renderer.render(scene, camera)
  requestAnimationFrame(tick)
}

// random photos from the chosen free source; null (with a note in the status line) if they can't be fetched.
// A newer request supersedes an older one still loading.
let photoRequest = 0
async function loadPhotos(onProgress) {
  const id = ++photoRequest
  const { label } = PHOTO_SOURCES[params.photoSource]
  statusEl.textContent = `Đang tải ảnh từ ${label}…`
  const pics = await buildOnlineAtlas(params.photoSource, {
    onProgress: (n, total) => {
      if (id !== photoRequest) return
      statusEl.textContent = `Đang tải ảnh từ ${label}… ${n}/${total}`
      onProgress?.(n, total)
    },
  }).catch(() => null)
  if (id !== photoRequest) return null
  if (!pics) statusEl.textContent = `Không tải được ảnh từ ${label}.`
  return pics
}

// The intro screen covers the loading: photos are most of the progress (and the clock, since loading stops at a
// deadline whatever has arrived), then building the portrait. The portrait gathers the moment the screen lifts.
async function init() {
  requestAnimationFrame(tick)
  const loader = createLoader($("#loader"))
  const { label } = PHOTO_SOURCES[params.photoSource]
  gui.hide()
  const t0 = performance.now()
  let photoShare = 0
  const clock = setInterval(() => loader.set(0.85 * Math.max(photoShare, (performance.now() - t0) / PHOTO_DEADLINE)), 200)
  // the portrait ships as data, not a photo: a grid of RGBA cells (public/portrait.json), drawn into a small canvas
  const portrait = (async () => {
    try {
      const r = await fetch("/portrait.json")
      if (!r.ok) throw new Error(r.status)
      const { w, h, rgba } = await r.json()
      const bytes = Uint8ClampedArray.from(atob(rgba), (ch) => ch.charCodeAt(0))
      const c = document.createElement("canvas")
      c.width = w
      c.height = h
      c.getContext("2d").putImageData(new ImageData(bytes, w, h), 0, 0)
      return c
    } catch {
      return proceduralPortrait()
    }
  })()
  const photos = loadPhotos((n, total) => {
    photoShare = n / total
    loader.set(0.85 * photoShare)
  })
  const [img, pics] = await Promise.all([portrait, photos])
  clearInterval(clock)
  loader.set(0.9)
  await new Promise((r) => requestAnimationFrame(r))   // let the note paint before the heavy build
  source = img
  if (pics) {
    atlas = pics
    texture.image = pics.canvas
    texture.needsUpdate = true
  }
  rebuild()
  if (!pics) statusEl.textContent += ` (không tải được ${label}, dùng ảnh tự sinh)`
  loader.set(1)
  await loader.done
  loader.hide()
  if (SHOW_GUI) gui.show()
  uniforms.uArrive.value = timer.getElapsed()   // the portrait gathers now, in view
}
init()

if (import.meta.env.DEV) window.__demo = { params, rebuild, uniforms, sweet, scene, camera, get state() { return { travel, restore, restoreS } } }   // for tuning from the console / tests
