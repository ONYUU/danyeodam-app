import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const mobileRoot = fileURLToPath(new URL('../', import.meta.url));
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const scaffoldHashes = new Set([
  '7a667804bb80a6a424a5daf18a2599c4f32237cf06fe78fc0de45dbb09e0eccf',
  '9e3d0315a33c6799de601dd34cd8bf8cc3a8d16f3bf75592baec2ceb7240b391',
  'a4e030697a7571b3e95d31860e4da55d2f98e5e861e2b55e414f45a8556828ba',
  '6371fc2c12e33ad2215a86c281db3d682a81bebe7c957a842c13b8bf00cceb83',
  'fb139c2dee362ebf2070e23b96da6fc0d43f8492de38b8af1fd7223e19b5861d',
]);

const assets = [
  { path: 'assets/images/icon.png', width: 1024, height: 1024, colorType: 2 },
  { path: 'assets/images/favicon.png', width: 256, height: 256, colorType: 2 },
];

const removedScaffoldAssets = [
  'assets/images/android-icon-background.png',
  'assets/images/android-icon-monochrome.png',
];

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function decodeRgbaAlphaBounds(bytes, width, height) {
  const idat = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (type === 'IDAT') idat.push(bytes.subarray(dataStart, dataStart + length));
    offset = dataStart + length + 4;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const expectedLength = height * (stride + 1);
  if (raw.length !== expectedLength) {
    throw new Error('Android foreground must be a non-interlaced 8-bit RGBA PNG.');
  }

  let previous = Buffer.alloc(stride);
  let cursor = 0;
  let transparentPixels = 0;
  let opaquePixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const scanline = Buffer.allocUnsafe(stride);
    for (let x = 0; x < stride; x += 1) {
      const encoded = raw[cursor + x];
      const left = x >= bytesPerPixel ? scanline[x - bytesPerPixel] : 0;
      const above = previous[x];
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      let predictor;
      switch (filter) {
        case 0: predictor = 0; break;
        case 1: predictor = left; break;
        case 2: predictor = above; break;
        case 3: predictor = Math.floor((left + above) / 2); break;
        case 4: predictor = paethPredictor(left, above, upperLeft); break;
        default: throw new Error(`Unsupported PNG filter ${filter}.`);
      }
      scanline[x] = (encoded + predictor) & 0xff;
    }
    cursor += stride;

    for (let x = 0; x < width; x += 1) {
      const alpha = scanline[(x * bytesPerPixel) + 3];
      if (alpha === 0) transparentPixels += 1;
      if (alpha === 255) opaquePixels += 1;
      if (alpha > 16) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    previous = scanline;
  }

  return { transparentPixels, opaquePixels, minX, minY, maxX, maxY };
}

for (const asset of assets) {
  const bytes = await readFile(new URL(asset.path, new URL('../', import.meta.url)));
  if (!bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new Error(`${asset.path} is not a PNG.`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  if (
    width !== asset.width
    || height !== asset.height
    || bitDepth !== 8
    || colorType !== asset.colorType
    || bytes.includes(Buffer.from('tRNS'))
  ) {
    throw new Error(`${asset.path} must be ${asset.width}x${asset.height} 8-bit RGB without alpha.`);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (scaffoldHashes.has(digest)) {
    throw new Error(`${asset.path} still contains an Expo scaffold asset.`);
  }
}

const foregroundPath = 'assets/images/android-icon-foreground.png';
const foreground = await readFile(new URL(foregroundPath, new URL('../', import.meta.url)));
if (!foreground.subarray(0, pngSignature.length).equals(pngSignature)) {
  throw new Error(`${foregroundPath} is not a PNG.`);
}
const foregroundWidth = foreground.readUInt32BE(16);
const foregroundHeight = foreground.readUInt32BE(20);
const foregroundBitDepth = foreground[24];
const foregroundColorType = foreground[25];
const foregroundInterlace = foreground[28];
if (
  foregroundWidth !== 1024
  || foregroundHeight !== 1024
  || foregroundBitDepth !== 8
  || foregroundColorType !== 6
  || foregroundInterlace !== 0
) {
  throw new Error(`${foregroundPath} must be a 1024x1024 non-interlaced 8-bit RGBA PNG.`);
}
const foregroundDigest = createHash('sha256').update(foreground).digest('hex');
if (scaffoldHashes.has(foregroundDigest)) {
  throw new Error(`${foregroundPath} still contains an Expo scaffold asset.`);
}
const bounds = decodeRgbaAlphaBounds(foreground, foregroundWidth, foregroundHeight);
const totalPixels = foregroundWidth * foregroundHeight;
const safeInset = Math.ceil(foregroundWidth * (21 / 108));
if (
  bounds.transparentPixels < totalPixels * 0.2
  || bounds.opaquePixels < totalPixels * 0.05
  || bounds.minX < safeInset
  || bounds.minY < safeInset
  || bounds.maxX >= foregroundWidth - safeInset
  || bounds.maxY >= foregroundHeight - safeInset
) {
  throw new Error(`${foregroundPath} must contain real transparency and keep visible artwork inside the Android 66/108 safe zone.`);
}

for (const assetPath of removedScaffoldAssets) {
  try {
    await access(new URL(assetPath, new URL('../', import.meta.url)));
    throw new Error(`${assetPath} is an unapproved Expo scaffold asset and must be removed.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

const appConfig = await readFile(new URL('../app.config.ts', import.meta.url), 'utf8');
if (appConfig.includes('monochromeImage')) {
  throw new Error('Android monochromeImage must not point at an unapproved scaffold asset.');
}

console.log(`Brand assets passed platform PNG, adaptive safe-zone, alpha, and scaffold checks in ${mobileRoot}.`);
