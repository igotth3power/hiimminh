// Copies the MediaPipe Selfie Segmentation runtime and model into public/, so background removal works offline
// (served by Vite from /mediapipe/). Runs on postinstall.
import { cpSync, mkdirSync, readdirSync } from "node:fs"

const from = new URL("../node_modules/@mediapipe/selfie_segmentation/", import.meta.url)
const to = new URL("../public/mediapipe/", import.meta.url)
mkdirSync(to, { recursive: true })
for (const f of readdirSync(from)) {
  if (/\.(js|wasm|data|tflite|binarypb)$/.test(f)) cpSync(new URL(f, from), new URL(f, to))
}
console.log("mediapipe assets copied to public/mediapipe/")
