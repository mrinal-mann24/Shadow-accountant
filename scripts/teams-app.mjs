// Builds the Teams app package for the Shadow bot: teams-app/dist/shadow-teams-app.zip
// (manifest.json, color.png, outline.png at the zip root). Plain Node, no dependencies.
//
//   node scripts/teams-app.mjs <APP_ID> [SITE_URL]
//
// APP_ID is the Microsoft App ID (client id) of the Azure Bot. SITE_URL defaults to the production site.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const DEFAULT_SITE = 'https://shadow-accountant-two.vercel.app'
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACCENT = [0x31, 0x4d, 0xd0]

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'teams-app')
const dist = join(root, 'dist')

function fail(message) {
  console.error(message)
  console.error('Usage: node scripts/teams-app.mjs <APP_ID> [SITE_URL]')
  process.exit(1)
}

// ---------------------------------------------------------------- CRC32 (PNG chunks and zip entries)

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------- PNG (RGBA, 8 bit)

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** pixel(x, y) returns [r, g, b, a]. */
function png(size, pixel) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  let o = 0
  for (let y = 0; y < size; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y)
      raw[o++] = r
      raw[o++] = g
      raw[o++] = b
      raw[o++] = a
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// A block 'S' on a 5 x 7 grid.
const S = ['#####', '#....', '#....', '#####', '....#', '....#', '#####']

/** True when (x, y) falls on the 'S', drawn with square cells of `cell` px, centred in `size`. */
function onGlyph(x, y, size, cell) {
  const ox = (size - 5 * cell) / 2
  const oy = (size - 7 * cell) / 2
  const cx = Math.floor((x - ox) / cell)
  const cy = Math.floor((y - oy) / cell)
  return x >= ox && y >= oy && cy < 7 && cx < 5 && S[cy][cx] === '#'
}

const WHITE = [255, 255, 255, 255]
const colorPng = png(192, (x, y) => (onGlyph(x, y, 192, 16) ? WHITE : [...ACCENT, 255]))
const outlinePng = png(32, (x, y) => (onGlyph(x, y, 32, 4) ? WHITE : [0, 0, 0, 0]))

// ---------------------------------------------------------------- ZIP (stored, no compression)

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

function zip(files) {
  const { time, date } = dosTime(new Date())
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method: stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18) // compressed size
    local.writeUInt32LE(data.length, 22) // size
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    locals.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    // extra, comment, disk, internal attrs, external attrs stay 0
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

// ---------------------------------------------------------------- main

const [appId, siteArg] = process.argv.slice(2)
if (!appId || !GUID.test(appId)) fail(`APP_ID must be a GUID like 00000000-0000-0000-0000-000000000000, got: ${appId ?? '(none)'}`)

let site
try {
  site = new URL(siteArg ?? DEFAULT_SITE)
} catch {
  fail(`SITE_URL is not a valid URL: ${siteArg}`)
}
if (site.protocol !== 'https:') fail(`SITE_URL must use https: ${site.href}`)
const siteUrl = site.origin + site.pathname.replace(/\/+$/, '')

const template = readFileSync(join(root, 'manifest.template.json'), 'utf8')
const manifestText = template
  .replaceAll('{{APP_ID}}', appId.toLowerCase())
  .replaceAll('{{SITE_URL}}', siteUrl)
  .replaceAll('{{SITE_HOST}}', site.host)
if (/\{\{[A-Z_]+\}\}/.test(manifestText)) fail('manifest.template.json has a placeholder this script does not fill')
JSON.parse(manifestText) // throws on a broken template
const manifest = Buffer.from(manifestText, 'utf8')

mkdirSync(dist, { recursive: true })
writeFileSync(join(dist, 'manifest.json'), manifest)
writeFileSync(join(dist, 'color.png'), colorPng)
writeFileSync(join(dist, 'outline.png'), outlinePng)

const zipPath = join(dist, 'shadow-teams-app.zip')
writeFileSync(
  zipPath,
  zip([
    { name: 'manifest.json', data: manifest },
    { name: 'color.png', data: colorPng },
    { name: 'outline.png', data: outlinePng },
  ]),
)
console.log(zipPath)
