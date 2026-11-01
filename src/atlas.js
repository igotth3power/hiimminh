// Image atlas: every "work" is one 256x192 (4:3) tile in a single 4096x4096 texture, so the whole field is one
// texture and one draw call. Tiles are big enough to stay sharp when they fly close to the camera. Each tile also keeps its mean colour, used to match tiles to portrait cells.

export const TILE_W = 256
export const TILE_H = 192
export const ATLAS = 4096
export const COLS = Math.floor(ATLAS / TILE_W)   // 16
export const ROWS = Math.floor(ATLAS / TILE_H)   // 21
export const CAPACITY = COLS * ROWS              // 336

export function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeCanvas(w, h) {
  const c = document.createElement("canvas")
  c.width = w
  c.height = h
  return c
}

function tileOrigin(i) {
  return [(i % COLS) * TILE_W, Math.floor(i / COLS) * TILE_H]
}

// ---------- procedural works: small logo-like cards in many colours ----------

const SYLLABLES = ["no", "ve", "ra", "lu", "ki", "so", "ta", "mi", "zen", "or", "ax", "el", "fy", "qu", "dra", "lo"]
const LETTERS = "ABCDEFGHJKLMNOPRSTUVWXYZ"

function drawWork(ctx, rand) {
  const W = TILE_W, H = TILE_H, cx = W / 2, cy = H / 2
  const h = rand() * 360
  const s = 15 + rand() * 75
  const l = 5 + Math.pow(rand(), 0.85) * 88   // spread of lightness, so dark and light cells both find matches
  const fl = Math.min(97, Math.max(3, l > 55 ? l - 35 - rand() * 25 : l + 35 + rand() * 25))
  const fh = (h + (rand() < 0.5 ? 0 : 150 + rand() * 60)) % 360
  const bg = `hsl(${h} ${s}% ${l}%)`
  const fg = `hsl(${fh} ${20 + rand() * 70}% ${fl}%)`
  const R = H * (0.2 + rand() * 0.12)

  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = fg
  ctx.strokeStyle = fg
  ctx.lineCap = "round"

  switch (Math.floor(rand() * 8)) {
    case 0: {   // circle with a bite out of it
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = bg
      const a = rand() * Math.PI * 2
      ctx.beginPath(); ctx.arc(cx + Math.cos(a) * R * 0.7, cy + Math.sin(a) * R * 0.7, R * 0.55, 0, Math.PI * 2); ctx.fill()
      break
    }
    case 1: {   // ring and dot
      ctx.lineWidth = R * 0.28
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke()
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.22, 0, Math.PI * 2); ctx.fill()
      break
    }
    case 2: {   // monogram
      ctx.font = `700 ${Math.round(H * 0.58)}px Georgia, serif`
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText(LETTERS[Math.floor(rand() * LETTERS.length)], cx, cy + H * 0.04)
      break
    }
    case 3: {   // striped disc
      ctx.save()
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.15, 0, Math.PI * 2); ctx.clip()
      ctx.translate(cx, cy); ctx.rotate(rand() * Math.PI)
      ctx.lineWidth = 4 + rand() * 3
      for (let x = -R * 1.5; x < R * 1.5; x += 10) { ctx.beginPath(); ctx.moveTo(x, -R * 1.5); ctx.lineTo(x, R * 1.5); ctx.stroke() }
      ctx.restore()
      break
    }
    case 4: {   // dot grid
      const n = 3 + Math.floor(rand() * 3)
      const step = (R * 2.4) / n
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const r = step * (0.15 + 0.3 * ((i + j) / (2 * n - 2)))
        ctx.beginPath(); ctx.arc(cx - R * 1.2 + step * (i + 0.5), cy - R * 1.2 + step * (j + 0.5), r, 0, Math.PI * 2); ctx.fill()
      }
      break
    }
    case 5: {   // two overlapping forms
      ctx.globalAlpha = 0.85
      ctx.beginPath(); ctx.arc(cx - R * 0.45, cy, R * 0.9, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = `hsl(${(fh + 40) % 360} 70% ${fl}%)`
      ctx.beginPath(); ctx.arc(cx + R * 0.45, cy, R * 0.9, 0, Math.PI * 2); ctx.fill()
      ctx.globalAlpha = 1
      break
    }
    case 6: {   // wordmark
      let word = ""
      const n = 2 + Math.floor(rand() * 2)
      for (let i = 0; i < n; i++) word += SYLLABLES[Math.floor(rand() * SYLLABLES.length)]
      ctx.font = `600 ${Math.round(H * 0.2)}px system-ui, sans-serif`
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText(word, cx + H * 0.08, cy)
      ctx.fillRect(cx - ctx.measureText(word).width / 2 - H * 0.12, cy - H * 0.07, H * 0.14, H * 0.14)
      break
    }
    default: {  // quarter arcs
      const q = R * 0.9
      ctx.lineWidth = q * 0.35
      for (let i = 0; i < 4; i++) {
        const ox = cx + (i % 2 ? q / 2 : -q / 2), oy = cy + (i < 2 ? -q / 2 : q / 2)
        const a0 = Math.floor(rand() * 4) * Math.PI / 2
        ctx.beginPath(); ctx.arc(ox, oy, q * 0.4, a0, a0 + Math.PI); ctx.stroke()
      }
    }
  }
}

// mean colour of every tile (0..1 sRGB): the atlas is shrunk to 16x12 px per tile (in two halving-ish steps,
// so the browser averages instead of skipping pixels), then those are averaged; far cheaper than reading 64 MB back
function finish(canvas, count) {
  const D = 16, d = Math.round(D * 0.75)
  const mid = makeCanvas(COLS * D * 4, ROWS * d * 4)
  const mctx = mid.getContext("2d")
  mctx.imageSmoothingQuality = "high"
  mctx.drawImage(canvas, 0, 0, COLS * TILE_W, ROWS * TILE_H, 0, 0, mid.width, mid.height)
  const small = makeCanvas(COLS * D, ROWS * d)
  const sctx = small.getContext("2d", { willReadFrequently: true })
  sctx.imageSmoothingQuality = "high"
  sctx.drawImage(mid, 0, 0, small.width, small.height)
  const data = sctx.getImageData(0, 0, small.width, small.height).data
  const tiles = []
  for (let i = 0; i < count; i++) {
    const [x0, y0] = tileOrigin(i)
    const sx = (i % COLS) * D, sy = Math.floor(i / COLS) * d
    let r = 0, g = 0, b = 0, n = 0
    for (let y = sy; y < sy + d; y++) for (let x = sx; x < sx + D; x++) {
      const k = (y * small.width + x) * 4
      r += data[k]; g += data[k + 1]; b += data[k + 2]; n++
    }
    tiles.push({
      u0: x0 / ATLAS,
      v0: 1 - y0 / ATLAS,               // top edge in texture space (canvas textures are flipped)
      mean: [r / n / 255, g / n / 255, b / n / 255],
    })
  }
  return { canvas, tiles }
}

export function buildProceduralAtlas(seed = 7) {
  const canvas = makeCanvas(ATLAS, ATLAS)
  const ctx = canvas.getContext("2d")
  const rand = mulberry32(seed)
  for (let i = 0; i < CAPACITY; i++) {
    const [x, y] = tileOrigin(i)
    ctx.save()
    ctx.translate(x, y)
    ctx.beginPath(); ctx.rect(0, 0, TILE_W, TILE_H); ctx.clip()
    drawWork(ctx, rand)
    ctx.restore()
  }
  return finish(canvas, CAPACITY)
}

// cover-crop one image into tile i of the atlas
function drawCover(ctx, img, i) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height
  const s = Math.max(TILE_W / iw, TILE_H / ih)
  const w = iw * s, h = ih * s
  const [x, y] = tileOrigin(i)
  ctx.save()
  ctx.beginPath(); ctx.rect(x, y, TILE_W, TILE_H); ctx.clip()
  ctx.drawImage(img, x + (TILE_W - w) / 2, y + (TILE_H - h) / 2, w, h)
  ctx.restore()
}

function newAtlasCanvas() {
  const canvas = makeCanvas(ATLAS, ATLAS)
  const ctx = canvas.getContext("2d")
  ctx.imageSmoothingQuality = "high"
  return { canvas, ctx }
}

// the visitor's own images: each one cover-cropped into a 4:3 tile; at most CAPACITY are used
export async function buildAtlasFromFiles(files) {
  const { canvas, ctx } = newAtlasCanvas()
  let count = 0
  for (const file of files) {
    if (count >= CAPACITY) break
    let bmp
    try { bmp = await createImageBitmap(file) } catch { continue }   // skip formats the browser can't decode
    drawCover(ctx, bmp, count++)
    bmp.close()
  }
  if (!count) return null
  return finish(canvas, count)
}

function loadImage(url, timeout) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = "anonymous"   // every source below sends CORS headers; without this the canvas could not be read
    const timer = setTimeout(() => { img.src = ""; reject(new Error("timeout")) }, timeout)
    img.onload = () => { clearTimeout(timer); resolve(img) }
    img.onerror = () => { clearTimeout(timer); reject(new Error(`could not load ${url}`)) }
    img.src = url
  })
}

const nonce = () => Math.random().toString(36).slice(2, 8)

async function getJson(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  return r.json()
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

// Free image sources that need no API key and send CORS headers (checked 2026-11). Each returns `count` image URLs,
// a fresh random set on every call.
export const PHOTO_SOURCES = {
  picsum: {
    label: "picsum.photos",
    urls: async (count) => {
      const n = nonce()
      return Array.from({ length: count }, (_, i) => `https://picsum.photos/seed/${n}-${i}/${TILE_W}/${TILE_H}`)
    },
    hi: (url) => url.replace(`/${TILE_W}/${TILE_H}`, "/1024/768"),
  },
  wikimedia: {
    // Featured pictures on Wikimedia Commons (~22k): pages of 50 search hits at random offsets (search offsets stop
    // at 10000), with ready-made thumbnails. 250 px is a standard thumbnail step, usually cached; other widths get
    // rounded up to a step that often has to be rendered first (up to ~15 s each)
    label: "Wikimedia Commons (ảnh chọn lọc)",
    urls: async (count) => {
      const pages = Math.ceil(count / 50) + 1
      const batches = await Promise.all(Array.from({ length: pages }, () => {
        const offset = Math.floor(Math.random() * 9950)
        return getJson("https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search" +
          "&gsrnamespace=6&gsrsearch=incategory:Featured_pictures_on_Wikimedia_Commons%20filemime:image/jpeg" +
          `&gsrlimit=50&gsroffset=${offset}&prop=imageinfo&iiprop=url&iiurlwidth=250`)
          .then((d) => Object.values(d.query?.pages ?? {}).map((p) => p.imageinfo?.[0]?.thumburl).filter(Boolean))
          .catch(() => [])
      }))
      return shuffle([...new Set(batches.flat())]).slice(0, count)
    },
    hi: (url) => url.replace(/\/250px-/, "/960px-"),   // 960 is a standard (usually cached) thumbnail step
  },
  dogs: {
    label: "Chó (dog.ceo)",
    urls: async (count) => {
      const batches = await Promise.all(Array.from({ length: Math.ceil(count / 50) }, () =>
        getJson("https://dog.ceo/api/breeds/image/random/50").then((d) => d.message).catch(() => [])))
      return [...new Set(batches.flat())].slice(0, count)
    },
    hi: (url) => url,   // already the full image
  },
}

// Random photos from one of PHOTO_SOURCES, fetched a few at a time. Half again as many URLs are asked for as
// needed, so slow or failing ones can simply be skipped; it stops at `count` images, or at the deadline with whatever
// has arrived. Returns null if too few arrive (offline, source down).
export async function buildOnlineAtlas(source = "picsum", { count = CAPACITY, concurrency = 16, timeout = 10000, deadline = 25000, onProgress } = {}) {
  const urls = await PHOTO_SOURCES[source].urls(Math.ceil(count * 1.5))
  const images = []
  let next = 0, stop = false
  const worker = async () => {
    while (!stop && next < urls.length && images.length < count) {
      const url = urls[next++]
      try {
        const img = await loadImage(url, timeout)
        if (!stop && images.length < count) images.push(img)
      } catch { /* skip it */ }
      if (!stop) onProgress?.(images.length, count)
    }
  }
  await Promise.race([
    Promise.all(Array.from({ length: concurrency }, worker)),
    new Promise((resolve) => setTimeout(resolve, deadline)),
  ])
  stop = true
  if (images.length < 24) return null
  const { canvas, ctx } = newAtlasCanvas()
  images.forEach((img, i) => drawCover(ctx, img, i))
  const atlas = finish(canvas, images.length)
  // where to fetch a sharp copy when a work comes close to the camera
  atlas.tiles.forEach((t, i) => { t.hi = PHOTO_SOURCES[source].hi?.(images[i].src) })
  return atlas
}
