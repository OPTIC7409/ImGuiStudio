// Raster helpers for captures and comparisons (RGBA8 images: { width, height, data: Uint8Array }).
import pngjs from 'pngjs';
import jpeg from 'jpeg-js';

const { PNG } = pngjs;

export function createImage(width, height, fill = [0, 0, 0, 255]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = fill[3];
  }
  return { width, height, data };
}

export function decodeImage(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const png = PNG.sync.read(b);
    return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
  }
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) {
    const img = jpeg.decode(b, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    return { width: img.width, height: img.height, data: img.data };
  }
  throw new Error('Unsupported image format (expected PNG or JPEG)');
}

export function encodePng(img) {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  return PNG.sync.write(png, { colorType: 6 });
}

// Composite over an opaque background (removes alpha for comparisons).
export function flatten(img, bg = [0, 0, 0]) {
  const out = new Uint8Array(img.data.length);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    out[i] = Math.round(d[i] * a + bg[0] * (1 - a));
    out[i + 1] = Math.round(d[i + 1] * a + bg[1] * (1 - a));
    out[i + 2] = Math.round(d[i + 2] * a + bg[2] * (1 - a));
    out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

export function crop(img, r) {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(img.width, Math.ceil(r.x + r.width));
  const y1 = Math.min(img.height, Math.ceil(r.y + r.height));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h && y0 + y < img.height; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    out.set(img.data.subarray(src, src + Math.min(w, img.width - x0) * 4), y * w * 4);
  }
  return { width: w, height: h, data: out };
}

export function resizeBilinear(img, w, h) {
  if (w === img.width && h === img.height) return img;
  const out = new Uint8Array(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.min(img.height - 1, Math.floor(fy));
    const y1 = Math.min(img.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.min(img.width - 1, Math.floor(fx));
      const x1 = Math.min(img.width - 1, x0 + 1);
      const tx = fx - x0;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = d[(y0 * img.width + x0) * 4 + c];
        const b = d[(y0 * img.width + x1) * 4 + c];
        const cc = d[(y1 * img.width + x0) * 4 + c];
        const dd = d[(y1 * img.width + x1) * 4 + c];
        out[o + c] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + dd * tx) * ty);
      }
    }
  }
  return { width: w, height: h, data: out };
}

// Area-average downscale (better than bilinear for thumbnails).
export function downscale(img, w, h) {
  if (w >= img.width && h >= img.height) return resizeBilinear(img, w, h);
  const out = new Uint8Array(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const ys = Math.floor(y * sy);
    const ye = Math.max(ys + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const xs = Math.floor(x * sx);
      const xe = Math.max(xs + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = ys; yy < ye; yy++) {
        let i = (yy * img.width + xs) * 4;
        for (let xx = xs; xx < xe; xx++, i += 4) {
          r += img.data[i];
          g += img.data[i + 1];
          b += img.data[i + 2];
          a += img.data[i + 3];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out };
}

export function scaleNearest(img, factor) {
  const f = Math.max(1, Math.round(factor));
  if (f === 1) return img;
  const w = img.width * f;
  const h = img.height * f;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y / f);
    for (let x = 0; x < w; x++) {
      const si = (sy * img.width + Math.floor(x / f)) * 4;
      const o = (y * w + x) * 4;
      out[o] = img.data[si];
      out[o + 1] = img.data[si + 1];
      out[o + 2] = img.data[si + 2];
      out[o + 3] = img.data[si + 3];
    }
  }
  return { width: w, height: h, data: out };
}

export function thumbnail(img, maxW = 320, maxH = 200) {
  const s = Math.min(1, maxW / img.width, maxH / img.height);
  return downscale(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)));
}

export function blit(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const si = (y * src.width + x) * 4;
      const di = (ty * dst.width + tx) * 4;
      const a = src.data[si + 3] / 255;
      if (a >= 1) {
        dst.data[di] = src.data[si];
        dst.data[di + 1] = src.data[si + 1];
        dst.data[di + 2] = src.data[si + 2];
        dst.data[di + 3] = 255;
      } else if (a > 0) {
        dst.data[di] = src.data[si] * a + dst.data[di] * (1 - a);
        dst.data[di + 1] = src.data[si + 1] * a + dst.data[di + 1] * (1 - a);
        dst.data[di + 2] = src.data[si + 2] * a + dst.data[di + 2] * (1 - a);
        dst.data[di + 3] = 255;
      }
    }
  }
}

export function fillRect(img, x, y, w, h, color) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(img.width, Math.round(x + w));
  const y1 = Math.min(img.height, Math.round(y + h));
  const a = (color[3] ?? 255) / 255;
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const i = (yy * img.width + xx) * 4;
      img.data[i] = color[0] * a + img.data[i] * (1 - a);
      img.data[i + 1] = color[1] * a + img.data[i + 1] * (1 - a);
      img.data[i + 2] = color[2] * a + img.data[i + 2] * (1 - a);
      img.data[i + 3] = 255;
    }
  }
}

export function strokeRect(img, x, y, w, h, color, t = 1) {
  fillRect(img, x, y, w, t, color);
  fillRect(img, x, y + h - t, w, t, color);
  fillRect(img, x, y, t, h, color);
  fillRect(img, x + w - t, y, t, h, color);
}

// 5x7 bitmap font for annotations (labels on composites, filmstrip timestamps).
const GLYPHS = {
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110', C: '01110100011000010000100001000101110',
  D: '11110100011000110001100011000111110', E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001', I: '01110001000010000100001000010001110',
  J: '00111000100001000010000101001001100', K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001', N: '10001100011100110101100111000110001', O: '01110100011000110001100011000101110',
  P: '11110100011000111110100001000010000', Q: '01110100011000110001101011001001101', R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100', U: '10001100011000110001100011000101110',
  V: '10001100011000110001100010101000100', W: '10001100011000110101101011010101010', X: '10001100010101000100010101000110001',
  Y: '10001100010101000100001000010000100', Z: '11111000010001000100010001000011111',
  0: '01110100011001110101110011000101110', 1: '00100011000010000100001000010001110', 2: '01110100010000100010001000100011111',
  3: '11111000100010000010000011000101110', 4: '00010001100101010010111110001000010', 5: '11111100001111000001000011000101110',
  6: '00110010001000011110100011000101110', 7: '11111000010001000100010000100001000', 8: '01110100011000101110100011000101110',
  9: '01110100011000101111000010001001100',
  ' ': '00000000000000000000000000000000000', '.': '00000000000000000000000000110001100', ',': '00000000000000000000001100010001000',
  ':': '00000011000110000000011000110000000', '-': '00000000000000011111000000000000000', '_': '00000000000000000000000000000011111',
  '=': '00000000001111100000111110000000000', '+': '00000001000010011111001000010000000', '/': '00000000010001000100010001000000000',
  '(': '00010001000100001000010000010000010', ')': '01000001000001000010000100010001000', '%': '11000110010001000100010001001100011',
  '#': '01010010101111101010111110101001010', '|': '00100001000010000100001000010000100', '<': '00010001000100010000010000010000010',
  '>': '01000001000001000001000100010001000', '[': '01110010000100001000010000100001110', ']': '01110000100001000010000100001001110',
  "'": '00100001000100000000000000000000000', '*': '00000001001010101110101010010000000', '@': '01110100011011110111101101000001110',
  '?': '01110100010000100010001000000000100', '!': '00100001000010000100001000000000100',
};

export function drawText(img, text, x, y, color = [230, 233, 240, 255], scale = 1) {
  let cx = x;
  for (const ch of String(text).toUpperCase()) {
    const g = GLYPHS[ch] || GLYPHS['?'];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (g[row * 5 + col] === '1') fillRect(img, cx + col * scale, y + row * scale, scale, scale, color);
      }
    }
    cx += 6 * scale;
  }
  return cx - x;
}

export function textWidth(text, scale = 1) {
  return String(text).length * 6 * scale;
}

const PANEL_BG = [22, 24, 30, 255];
const LABEL_FG = [200, 205, 215, 255];

// Lay out images horizontally (or in a grid) with labels above each tile.
export function compose(tiles, { gap = 8, columns = 0, labelScale = 2, background = PANEL_BG, maxWidth = 0 } = {}) {
  const n = tiles.length;
  const cols = columns > 0 ? Math.min(columns, n) : n;
  const rows = Math.ceil(n / cols);
  const labelH = tiles.some((t) => t.label) ? 7 * labelScale + 8 : 0;
  const cellW = Math.max(...tiles.map((t) => Math.max(t.image.width, t.label ? textWidth(t.label, labelScale) : 0)));
  const cellH = Math.max(...tiles.map((t) => t.image.height)) + labelH;
  const W = cols * cellW + (cols + 1) * gap;
  const H = rows * cellH + (rows + 1) * gap;
  const out = createImage(W, H, background);
  tiles.forEach((t, i) => {
    const cx = gap + (i % cols) * (cellW + gap);
    const cy = gap + Math.floor(i / cols) * (cellH + gap);
    if (t.label) drawText(out, t.label, cx, cy + 2, t.labelColor || LABEL_FG, labelScale);
    blit(out, t.image, cx, cy + labelH);
    if (t.border) strokeRect(out, cx - 1, cy + labelH - 1, t.image.width + 2, t.image.height + 2, t.border);
  });
  if (maxWidth && out.width > maxWidth) {
    const s = maxWidth / out.width;
    return downscale(out, maxWidth, Math.round(out.height * s));
  }
  return out;
}

export function toBase64Png(img) {
  return encodePng(img).toString('base64');
}
