// Background removal in the browser with MediaPipe Selfie Segmentation. Runtime and model are served locally
// from /mediapipe/ (copied there from node_modules on install), so it works offline.

let segmenterPromise = null
let pending = null   // resolver of the frame being segmented (one at a time)

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script")
    s.src = src
    s.onload = resolve
    s.onerror = () => reject(new Error(`could not load ${src}`))
    document.head.append(s)
  })
}

function getSegmenter() {
  segmenterPromise ??= (async () => {
    // the package is a closure-compiled global script, not an ES module: load it as a plain script
    await loadScript("/mediapipe/selfie_segmentation.js")
    const seg = new window.SelfieSegmentation({ locateFile: (f) => `/mediapipe/${f}` })
    seg.setOptions({ modelSelection: 0, selfieMode: false })   // 0: general model (256x256), better for photos
    seg.onResults((r) => { pending?.(r.segmentationMask); pending = null })
    await seg.initialize()
    return seg
  })().catch((err) => { segmenterPromise = null; throw err })
  return segmenterPromise
}

function makeCanvas(w, h) {
  const c = document.createElement("canvas")
  c.width = w
  c.height = h
  return c
}

// Returns a canvas of the same size with everything but the person made transparent (soft-edged).
export async function removeBackground(src) {
  const seg = await getSegmenter()
  const w = src.width, h = src.height
  const input = makeCanvas(w, h)
  input.getContext("2d").drawImage(src, 0, 0, w, h)
  const mask = await new Promise((resolve) => { pending = resolve; seg.send({ image: input }) })

  const out = makeCanvas(w, h)
  const ctx = out.getContext("2d")
  ctx.drawImage(mask, 0, 0, w, h)                 // mask alpha = confidence that the pixel is the person
  ctx.globalCompositeOperation = "source-in"
  ctx.drawImage(input, 0, 0)
  return out
}

// crop to the visible content (plus a small margin), so the portrait fills the frame
export function trimTransparent(c, margin = 0.03) {
  const ctx = c.getContext("2d", { willReadFrequently: true })
  const { width: w, height: h } = c
  const a = ctx.getImageData(0, 0, w, h).data
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    if (a[(y * w + x) * 4 + 3] > 64) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  }
  if (x1 < 0) return c
  const m = Math.round(Math.max(w, h) * margin)
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w, x1 + m); y1 = Math.min(h, y1 + m)
  const out = makeCanvas(x1 - x0, y1 - y0)
  out.getContext("2d").drawImage(c, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0)
  return out
}
