import sharp from 'sharp'
import { readFileSync } from 'node:fs'
const jobs = [
  ['brand/logo.svg', 'brand/logo.png', 512, 512],
  ['brand/banner.svg', 'brand/banner.png', 640, 360],
]
for (const [src, out, w, h] of jobs) {
  try {
    await sharp(readFileSync(src)).resize(w, h).png({ compressionLevel: 9 }).toFile(out)
    const m = await sharp(out).metadata()
    console.log(`ok  ${out}  ${m.width}x${m.height}  ${(m.size/1024).toFixed(1)}kb`)
  } catch (e) { console.log(`skip ${src}: ${e.message}`) }
}
