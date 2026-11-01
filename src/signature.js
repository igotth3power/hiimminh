// The signature: Minh, signed behind the portrait as it settles, again each time you come back.
//
// - The ink is drawn from the pen's path (traced by hand from Minh's signature; no image ships), with a pen's
//   pressure: thicker on the down strokes, finer going up. It is baked ONCE (per resize) into a bitmap in ivory ink.
// - The writing is a plain stroke along the same path, used as a mask that reveals the ink in the order it was
//   written.
// - The pen does not move at one speed: it travels fast on long straight strokes, slows into loops and tight turns,
//   starts from rest and lifts off gently. That speed profile is worked out once from the path's curvature.
// - Two looks, blended by how scattered the portrait is (0..1, eased by the caller): gathered, the ink is faint and
//   behind the transparent WebGL canvas, with a soft hole round the face; scattered, it is whole, bright and in front
//   (the layer swaps sides halfway, when the pieces are already apart). It never takes the pointer.

// the pen's path (units: the traced signature's pixels): M (lead-in curl, three diagonals, exit), into the i, n, h;
// then the i's dot
const STROKES = [
  {
    d: "M 188 190 C 183 191, 178 195, 181 198 C 184 201, 196 200, 205 197 C 230 188, 262 166, 287 144 L 237 196 " +
       "L 300 153 L 258 198 C 266 190, 280 184, 288 182.5 C 295 181.5, 301 182, 304 184.5 C 300 186, 294 190, 297 194 C 300 197, 312 196, 324 194 " +
       "L 338 181 L 330 193 L 348 180 C 343 182, 336 188, 339 192 C 342 196, 360 195, 370 194 L 398 163 L 377 188 " +
       "C 381 184, 387 181, 390 183 C 391 187, 391 193, 398 196 C 406 197, 414 192, 421 187",
    dur: 3.0, lift: 0,
  },
  { d: "M 307 180 L 314 176", dur: 0.12, lift: 0.25 },
]
const TILT = -16 * Math.PI / 180     // the whole signature rises diagonally across the portrait
const INK = [239, 233, 223]          // ivory
const INK_ALPHA = 0.9
const GATHERED_ALPHA = 0.4           // the ink's strength while the portrait is whole (scattered: 1)
const MASK_W = 7                     // the revealing stroke (path units), wide enough to cover the ink
const PEN = [1.2, 2.7]               // ink width going up .. coming down (path units)
const SVG_NS = "http://www.w3.org/2000/svg"

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

// time -> length table for one stroke: speed falls with curvature, ramps up from rest, eases out at the end
function speedProfile(pathEl, duration) {
  const total = pathEl.getTotalLength()
  const N = 900
  const pts = []
  for (let i = 0; i <= N; i++) pts.push(pathEl.getPointAtLength((total * i) / N))
  const ds = total / N
  const curv = new Float32Array(N + 1)
  for (let i = 1; i < N; i++) {
    const a1 = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x)
    const a2 = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x)
    let d = Math.abs(a2 - a1)
    if (d > Math.PI) d = 2 * Math.PI - d
    curv[i] = d / ds
  }
  // smooth the curvature so the pen anticipates a turn instead of braking on the spot
  const W = 12, sm = new Float32Array(N + 1)
  for (let i = 0; i <= N; i++) {
    let s = 0, n = 0
    for (let j = Math.max(0, i - W); j <= Math.min(N, i + W); j++) { s += curv[j]; n++ }
    sm[i] = s / n
  }
  const time = new Float32Array(N + 1)
  for (let i = 1; i <= N; i++) {
    const u = i / N
    const v = (1 / (1 + 4 * sm[i])) * (0.2 + 0.8 * smoothstep(0, 0.04, u)) * (0.35 + 0.65 * (1 - smoothstep(0.92, 1, u)))
    time[i] = time[i - 1] + ds / v
  }
  const k = duration / time[N]
  for (let i = 0; i <= N; i++) time[i] *= k
  return {
    total,
    lengthAt(t) {
      if (t <= 0) return 0
      if (t >= duration) return total
      let lo = 0, hi = N
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (time[m] < t) lo = m; else hi = m }
      const f = (t - time[lo]) / (time[hi] - time[lo] || 1)
      return ((lo + f) / N) * total
    },
  }
}

export function createSignature(canvas) {
  const ctx = canvas.getContext("2d")

  // hidden SVG paths, only for lengths and points along them
  const svg = document.createElementNS(SVG_NS, "svg")
  svg.setAttribute("width", "0")
  svg.setAttribute("height", "0")
  svg.style.position = "absolute"
  document.body.append(svg)
  const els = STROKES.map(({ d }) => { const p = document.createElementNS(SVG_NS, "path"); p.setAttribute("d", d); svg.append(p); return p })
  const paths = STROKES.map(({ d }) => new Path2D(d))
  const profiles = STROKES.map(({ dur }, i) => speedProfile(els[i], dur))
  const starts = [], ends = []
  STROKES.reduce((t, { dur, lift }) => { starts.push(t + lift); ends.push(t + lift + dur); return t + lift + dur }, 0)
  const lastEnd = ends[ends.length - 1]
  const finished = lastEnd + 0.8

  // the signature's extent (path units, with a margin), for framing
  const source = (() => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const el of els) { const bb = el.getBBox(); x0 = Math.min(x0, bb.x); y0 = Math.min(y0, bb.y); x1 = Math.max(x1, bb.x + bb.width); y1 = Math.max(y1, bb.y + bb.height) }
    const m = 6
    return { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m }
  })()
  let ink = null                 // baked bitmap at screen size
  let layout = null              // [a, b, c, d, e, f]: source pixels -> CSS px (scale, tilt, centring)
  let scale = 1
  let dpr = 1
  let start = -1                 // time the pen started, -1 while not signing
  let drawnT = -1                // timeline position last drawn
  let opacity = 0
  let lastSize = null
  let hole = null                // { x, y, rx, ry } soft hole round the face, CSS px
  let scatter = 0, drawnScatter = -1

  const toScreen = (p) => {
    const [a, b, c, d, e, f] = layout
    return [a * p.x + c * p.y + e, b * p.x + d * p.y + f]
  }

  // the ink: each stroke drawn in short pieces whose width follows the pen's direction (pressure), opaque on a
  // scratch layer, then laid down at the ink's strength with a faint glow
  function bake(w, h) {
    const W = Math.round(w * dpr), H = Math.round(h * dpr)
    const raw = document.createElement("canvas")
    raw.width = W
    raw.height = H
    const rg = raw.getContext("2d")
    const [a, b, c, d, e, f] = layout
    rg.setTransform(dpr * a, dpr * b, dpr * c, dpr * d, dpr * e, dpr * f)
    rg.strokeStyle = `rgb(${INK.join(", ")})`
    rg.lineCap = "round"
    for (const el of els) {
      const total = el.getTotalLength(), n = Math.max(2, Math.ceil(total / 0.6))
      let p0 = el.getPointAtLength(0)
      for (let i = 1; i <= n; i++) {
        const p1 = el.getPointAtLength((total * i) / n)
        const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1
        const down = smoothstep(-0.6, 0.9, (p1.y - p0.y) / len)   // 0 going up, 1 coming down
        rg.lineWidth = PEN[0] + (PEN[1] - PEN[0]) * down
        rg.beginPath(); rg.moveTo(p0.x, p0.y); rg.lineTo(p1.x, p1.y); rg.stroke()
        p0 = p1
      }
    }
    const bmp = document.createElement("canvas")
    bmp.width = W
    bmp.height = H
    const bg = bmp.getContext("2d")
    bg.globalAlpha = INK_ALPHA
    bg.shadowColor = `rgba(${INK.join(", ")}, 0.35)`   // a faint glow, as if the ink caught the light
    bg.shadowBlur = 6 * dpr
    bg.drawImage(raw, 0, 0)
    ink = bmp
    drawnT = -1
  }

  // portrait: its centre and height on screen (CSS px). The signature spans the window behind the bust.
  function resize(w, h, portrait) {
    lastSize = [w, h, portrait]
    dpr = Math.min(devicePixelRatio || 1, 2)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    hole = { x: portrait.x, y: portrait.y - portrait.h * 0.08, rx: portrait.h * 0.3, ry: portrait.h * 0.36 }
    ink = null
    const width = Math.min(w * 0.8, portrait.h * 1.9)
    scale = width / source.w
    // rotate(TILT) * scale, then the signature's centre lands on the portrait's centre
    const cos = Math.cos(TILT), sin = Math.sin(TILT)
    const a = cos * scale, b = sin * scale, c = -sin * scale, d = cos * scale
    const cx = source.x + source.w / 2, cy = source.y + source.h / 2
    layout = [a, b, c, d, portrait.x - (a * cx + c * cy), portrait.y - (b * cx + d * cy)]
    bake(w, h)
  }

  function draw(t, now) {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = "source-over"
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (!ink || t <= 0) return
    const m = layout
    const lens = profiles.map((p, i) => p.lengthAt(t - starts[i]))

    // the mask: what has been written so far
    ctx.setTransform(dpr * m[0], dpr * m[1], dpr * m[2], dpr * m[3], dpr * m[4], dpr * m[5])
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.lineWidth = MASK_W
    ctx.strokeStyle = "#fff"
    lens.forEach((L, i) => {
      if (L <= 0) return
      ctx.setLineDash([L, profiles[i].total + 10])
      ctx.stroke(paths[i])
    })
    ctx.setLineDash([])

    // keep the ink only there
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = "source-in"
    ctx.drawImage(ink, 0, 0)

    // gathered: a soft hole round the face, so the ink doesn't run across it (it closes as the portrait scatters)
    const holeA = 1 - scatter
    if (hole && holeA > 0.01) {
      ctx.globalCompositeOperation = "destination-out"
      ctx.save()
      ctx.translate(hole.x * dpr, hole.y * dpr)
      ctx.scale(hole.rx * dpr, hole.ry * dpr)
      const hg = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
      hg.addColorStop(0, `rgba(0,0,0,${holeA})`)
      hg.addColorStop(0.65, `rgba(0,0,0,${0.9 * holeA})`)
      hg.addColorStop(1, "rgba(0,0,0,0)")
      ctx.fillStyle = hg
      ctx.fillRect(-1, -1, 2, 2)
      ctx.restore()
    }
    ctx.globalCompositeOperation = "source-over"

    // the nib: a soft glow at the pen's tip while it writes, fading once the signature is done
    const fade = t < lastEnd ? 1 : 1 - Math.min(1, (t - lastEnd) / 0.7)
    if (fade <= 0) return
    let active = starts.findIndex((s0, i) => t >= s0 && t < ends[i])
    if (active < 0) { if (t < lastEnd) return; active = STROKES.length - 1 }
    const [px, py] = toScreen(els[active].getPointAtLength(lens[active]))
    const x = px * dpr, y = py * dpr
    const r = 14 * dpr * (0.7 + 0.3 * Math.sin(now * 20) ** 2)
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r)
    glow.addColorStop(0, `rgba(255, 250, 240, ${0.95 * fade})`)
    glow.addColorStop(0.35, `rgba(255, 240, 220, ${0.4 * fade})`)
    glow.addColorStop(1, "rgba(255, 240, 220, 0)")
    ctx.fillStyle = glow
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r)
  }

  // show: the portrait is formed and the camera is home. Leaving wipes the page, so coming back signs anew.
  // s: how scattered the portrait is, 0 gathered .. 1 scattered (already eased)
  function update(now, show, s = 0) {
    scatter = s
    if (show && start < 0) start = now
    opacity += ((show ? 1 : 0) - opacity) * (show ? 0.08 : 0.15)
    if (!show && opacity < 0.01) { opacity = 0; start = -1 }
    canvas.style.opacity = (opacity * (GATHERED_ALPHA + (1 - GATHERED_ALPHA) * scatter)).toFixed(3)
    canvas.style.zIndex = scatter > 0.5 ? "1" : ""   // in front of the portrait once it is apart
    const t = start < 0 ? 0 : now - start
    const sChanged = Math.abs(scatter - drawnScatter) > 0.01
    if (t === 0 && drawnT === 0) return                                // blank and already cleared
    if (t > finished && drawnT > finished && !sChanged) return         // finished and already on screen
    draw(t, now)
    drawnT = t
    drawnScatter = scatter
  }

  return { resize, update }
}
