// Portrait sources (a drawn bust, a photo, a webcam frame) and the halftone sampling that turns one into cells.

function makeCanvas(w, h) {
  const c = document.createElement("canvas")
  c.width = w
  c.height = h
  return c
}

function ellipse(ctx, x, y, rx, ry, fill) {
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2)
  ctx.fill()
}

// A lit bust on black, drawn on a canvas so the demo works offline. Light comes from the upper left.
export function proceduralPortrait() {
  const W = 600, H = 800
  const c = makeCanvas(W, H)
  const ctx = c.getContext("2d")
  ctx.fillStyle = "#000"
  ctx.fillRect(0, 0, W, H)

  // shoulders
  let g = ctx.createLinearGradient(0, 600, W, 800)
  g.addColorStop(0, "#6f6a66"); g.addColorStop(0.55, "#2c2927"); g.addColorStop(1, "#080808")
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.moveTo(10, H)
  ctx.bezierCurveTo(30, 660, 170, 630, 240, 600)
  ctx.lineTo(360, 600)
  ctx.bezierCurveTo(430, 630, 570, 660, 590, H)
  ctx.closePath()
  ctx.fill()

  // neck
  g = ctx.createLinearGradient(240, 0, 360, 0)
  g.addColorStop(0, "#b48c74"); g.addColorStop(1, "#3a2a22")
  ctx.fillStyle = g
  ctx.fillRect(248, 470, 104, 150)

  // hair behind the head
  g = ctx.createRadialGradient(230, 210, 20, 300, 330, 230)
  g.addColorStop(0, "#5a4434"); g.addColorStop(0.6, "#251a13"); g.addColorStop(1, "#0b0806")
  ellipse(ctx, 300, 330, 172, 205, g)

  // face
  g = ctx.createRadialGradient(240, 320, 10, 285, 380, 210)
  g.addColorStop(0, "#f6e2d2"); g.addColorStop(0.45, "#d8b096"); g.addColorStop(0.8, "#7a5644"); g.addColorStop(1, "#2a1c16")
  ellipse(ctx, 300, 385, 138, 178, g)

  // fringe over the forehead
  ctx.fillStyle = "#1f1610"
  ctx.beginPath()
  ctx.moveTo(150, 330)
  ctx.bezierCurveTo(160, 190, 300, 150, 440, 250)
  ctx.bezierCurveTo(420, 270, 360, 250, 300, 265)
  ctx.bezierCurveTo(230, 280, 180, 290, 150, 330)
  ctx.fill()

  // features, softened
  ctx.filter = "blur(4px)"
  ellipse(ctx, 248, 372, 34, 13, "rgba(45,28,22,0.95)")   // eyes
  ellipse(ctx, 356, 372, 34, 13, "rgba(35,22,18,0.95)")
  ellipse(ctx, 248, 340, 40, 7, "rgba(40,26,18,0.9)")     // brows
  ellipse(ctx, 356, 340, 40, 7, "rgba(30,20,14,0.9)")
  ellipse(ctx, 322, 440, 14, 44, "rgba(70,40,30,0.45)")   // nose shadow
  ellipse(ctx, 302, 478, 26, 8, "rgba(70,40,30,0.6)")     // nostrils
  ellipse(ctx, 302, 525, 42, 11, "rgba(130,52,48,0.9)")   // mouth
  ellipse(ctx, 380, 450, 45, 70, "rgba(40,25,20,0.35)")   // cheek in shade
  ctx.filter = "none"
  ellipse(ctx, 240, 368, 4, 4, "rgba(255,255,255,0.9)")   // catchlights
  ellipse(ctx, 348, 368, 4, 4, "rgba(255,255,255,0.8)")
  return c
}

// Halftone sampling: a grid of 4:3 cells; each cell gets its mean colour and a brightness 0..1 (levels stretched
// between the 2nd and 98th percentile, then gamma). Cells at or under the threshold get no tile.
// Sources with transparency (a cut-out person): mostly transparent cells are empty, and every cell of the subject
// keeps at least `floor` brightness, so dark clothes and hair still draw the silhouette with small tiles.
export function sampleCells(src, { rows, threshold, gamma, invert, floor = 0, vcut = false, vStart = 0.7, vBottom = 0, vFlare = 0.8, vAsym = 0 }) {
  const sw = src.width, sh = src.height
  const cols = Math.max(4, Math.round(rows * (sw / sh) * 0.75))
  const S = 3   // sub-samples per cell side
  const c = makeCanvas(cols * S, rows * S)
  const ctx = c.getContext("2d", { willReadFrequently: true })
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(src, 0, 0, cols * S, rows * S)
  const px = ctx.getImageData(0, 0, cols * S, rows * S).data

  const n = cols * rows
  const rgb = new Float32Array(n * 3)
  const lum = new Float32Array(n)
  const alpha = new Float32Array(n)
  let hasAlpha = false
  for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
    let R = 0, G = 0, B = 0, A = 0
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const k = ((r * S + y) * cols * S + q * S + x) * 4
      const a = px[k + 3]
      R += px[k] * a; G += px[k + 1] * a; B += px[k + 2] * a; A += a   // alpha-weighted mean colour
    }
    const i = r * cols + q, d = Math.max(A, 1) * 255
    rgb[i * 3] = R / d; rgb[i * 3 + 1] = G / d; rgb[i * 3 + 2] = B / d
    lum[i] = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2]
    alpha[i] = A / (S * S * 255)
    if (alpha[i] < 0.99) hasAlpha = true
  }

  // levels are stretched over the subject only (transparent cells would drag the low percentile down)
  const subject = Float32Array.from(lum.filter((_, i) => alpha[i] >= 0.5)).sort()
  const m = subject.length || 1
  const lo = subject[Math.floor(m * 0.02)] ?? 0, hi = subject[Math.floor(m * 0.98)] ?? 1
  const level = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (alpha[i] < 0.5) continue   // background of a cut-out: empty
    let L = Math.min(1, Math.max(0, (lum[i] - lo) / (hi - lo + 1e-6)))
    if (invert) L = 1 - L
    L = Math.pow(L, gamma)
    if (hasAlpha) L = Math.max(L, floor)
    level[i] = L
  }

  // V-cut bust (as on the original): from row vStart down, the bust narrows from the subject's width at that row to
  // vBottom of the image width at the bottom (0: a point), centred on the subject; the last rows fade. vFlare bows
  // the sides outward (0: straight lines, 1: 1 - t², a shield), yet they still meet the tip at an angle, so it
  // stays sharp. vAsym flares one side more than the other (+: the right), the tip stays centred
  if (vcut) {
    const r0 = Math.min(rows - 1, Math.floor(vStart * rows))
    let x0 = cols, x1 = -1
    for (let r = Math.max(0, r0 - 2); r <= Math.min(rows - 1, r0 + 2); r++) for (let q = 0; q < cols; q++) {
      if (level[r * cols + q] > threshold) { x0 = Math.min(x0, q); x1 = Math.max(x1, q) }
    }
    const cx = x1 >= 0 ? (x0 + x1 + 1) / 2 : cols / 2
    const hw0 = x1 >= 0 ? (x1 - x0 + 1) / 2 : cols / 2
    const hw1 = (vBottom * cols) / 2
    for (let r = r0; r < rows; r++) {
      const t = (r - r0) / Math.max(1, rows - 1 - r0)
      const side = (flare) => hw1 + (hw0 - hw1) * (1 - t) * (1 + flare * t)
      const hwL = side(vFlare - vAsym), hwR = side(vFlare + vAsym)
      const fade = 1 - 0.5 * Math.max(0, (t - 0.85) / 0.15)
      for (let q = 0; q < cols; q++) {
        const i = r * cols + q
        const dx = q + 0.5 - cx
        if (dx < 0 ? -dx > hwL : dx > hwR) level[i] = 0
        else level[i] *= fade
      }
    }
  }

  // distance (in cells, 8-neighbour) from every kept cell to the nearest empty one; outside the image counts as
  // empty. Small distances mark the silhouette's edge, where the halo lives.
  const edge = new Int32Array(n)
  for (let i = 0; i < n; i++) edge[i] = level[i] > threshold ? 1e6 : 0
  const at = (q, r) => (q < 0 || r < 0 || q >= cols || r >= rows ? 0 : edge[r * cols + q])
  for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
    const i = r * cols + q
    if (edge[i]) edge[i] = Math.min(edge[i], at(q - 1, r) + 1, at(q - 1, r - 1) + 1, at(q, r - 1) + 1, at(q + 1, r - 1) + 1)
  }
  for (let r = rows - 1; r >= 0; r--) for (let q = cols - 1; q >= 0; q--) {
    const i = r * cols + q
    if (edge[i]) edge[i] = Math.min(edge[i], at(q + 1, r) + 1, at(q + 1, r + 1) + 1, at(q, r + 1) + 1, at(q - 1, r + 1) + 1)
  }

  const cells = []
  for (let i = 0; i < n; i++) {
    if (!edge[i]) continue
    cells.push({ col: i % cols, row: Math.floor(i / cols), L: level[i], edge: edge[i], rgb: [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]] })
  }
  return { cols, rows, cells }
}
