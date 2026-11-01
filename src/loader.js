// The intro screen while the works load: the M of the signature is written in white neon exactly as fast as the
// site loads, in step with the percentage, over the faint unlit tube of the whole letter. Progress comes from the
// photos as they arrive (most of it), then building the portrait. The pen follows that progress smoothly and never
// faster than a natural hand (~1.6 s for the whole M). At 100% the neon flickers on, like a sign switched on, and
// the site appears.

// the M of Minh's signature, in the signature image's pixels (same trace as in signature.js)
const MARK = "M 188 190 C 183 191, 178 195, 181 198 C 184 201, 196 200, 205 197 C 230 188, 262 166, 287 144 " +
  "L 237 196 L 300 153 L 258 198 C 266 190, 280 184, 291 182"
import "@fontsource/allura/latin-400.css"   // the counter's flowing script (self-hosted, works offline)

const HAND = 1.6   // seconds for the whole M at the fastest
// the switch-on flicker at 100%: [seconds from the end of the stroke, brightness]
const FLICKER = [[0, 1], [0.08, 0.25], [0.14, 1], [0.24, 0.45], [0.3, 1], [0.36, 0.8], [0.46, 1]]

export function createLoader(el) {
  el.innerHTML = `
    <svg class="loader-mark" viewBox="168 134 140 74" aria-hidden="true">
      <defs>
        <!-- white neon: a white core over three widening glows, the outer ones a little cool -->
        <filter id="neon" x="-30%" y="-60%" width="160%" height="220%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="0.6" result="b1"/>
          <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="b2"/>
          <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="b3"/>
          <feColorMatrix in="b2" type="matrix" values="0.9 0 0 0 0  0 0.94 0 0 0  0 0 1 0 0  0 0 0 1.4 0" result="g2"/>
          <feColorMatrix in="b3" type="matrix" values="0.78 0 0 0 0  0 0.86 0 0 0  0 0 1 0 0  0 0 0 1.1 0" result="g3"/>
          <feMerge><feMergeNode in="g3"/><feMergeNode in="g2"/><feMergeNode in="b1"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <path class="loader-trace" d="${MARK}"/>
      <path class="loader-ink" d="${MARK}" filter="url(#neon)"/>
    </svg>
    <p class="loader-pct"><span class="d"></span><span class="d"></span><span class="d">0</span>%</p>`
  const ink = el.querySelector(".loader-ink")
  // each digit sits in its own fixed slot: script figures have different widths, the counter must not jump
  const digits = [...el.querySelectorAll(".loader-pct .d")]
  let lastPct = -1
  const len = ink.getTotalLength()
  ink.style.strokeDasharray = `${len}`
  ink.style.strokeDashoffset = `${len}`

  let target = 0, shown = 0, last = performance.now(), full = -1
  let resolveDone
  const done = new Promise((r) => { resolveDone = r })

  function frame(now) {
    // the first frame's timestamp can be earlier than the clock read at setup: never step backwards
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000))
    last = now
    // ease toward the real progress, but no faster than the hand
    const step = Math.min(dt / HAND, Math.max(0, target - shown) * (1 - Math.exp(-dt * 6)) + dt * 0.02)
    shown = Math.min(target, shown + step)
    ink.style.strokeDashoffset = `${len * (1 - shown)}`
    const pct = Math.floor(shown * 100)
    if (pct !== lastPct) {
      lastPct = pct
      const str = String(pct).padStart(3, " ")
      digits.forEach((d, i) => { d.textContent = str[i] === " " ? "" : str[i] })
    }
    if (target >= 1 && shown >= 0.999) {
      // fully written: the neon flickers on, then the page can go
      if (full < 0) full = now
      const t = (now - full) / 1000
      const i = FLICKER.findIndex(([at]) => at > t)
      el.style.setProperty("--neon", `${i < 0 ? 1 : FLICKER[i - 1][1]}`)
      if (i < 0) { resolveDone(); return }
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  return {
    // p: 0..1 (never goes backwards)
    set(p) {
      target = Math.max(target, Math.min(1, p))
    },
    done,   // resolves once the M is fully written and its neon has flickered on
    hide() {
      el.classList.add("is-done")
      setTimeout(() => el.remove(), 1000)
    },
  }
}
