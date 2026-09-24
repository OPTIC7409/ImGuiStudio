// Visual comparison metrics between a reference design and a rendered capture.
//
// The numbers are meant to *direct attention* (where, and roughly how, the two
// images differ), not to replace looking at the images.
import { createImage, crop, downscale, flatten, resizeBilinear } from './images.js';

function luminance(img) {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) out[i] = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
  return out;
}

function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const LIN = new Float32Array(256).map((_, i) => srgbToLinear(i));

function rgbToLab(r, g, b) {
  const R = LIN[r];
  const G = LIN[g];
  const B = LIN[b];
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x);
  y = f(y);
  z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function deltaE(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function hex(rgb) {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

// k-means palette in RGB space on a downsampled copy.
function palette(img, k = 6) {
  const small = downscale(img, Math.min(img.width, 96), Math.min(img.height, 64));
  const px = [];
  for (let i = 0; i < small.data.length; i += 4) px.push([small.data[i], small.data[i + 1], small.data[i + 2]]);
  const centers = [];
  // Deterministic init: pick pixels spread over the luminance range.
  const sorted = px.slice().sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  for (let i = 0; i < k; i++) centers.push(sorted[Math.floor(((i + 0.5) / k) * (sorted.length - 1))].slice());
  const assign = new Int32Array(px.length);
  for (let iter = 0; iter < 12; iter++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < px.length; i++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = (px[i][0] - centers[c][0]) ** 2 + (px[i][1] - centers[c][1]) ** 2 + (px[i][2] - centers[c][2]) ** 2;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      assign[i] = best;
      const s = sums[best];
      s[0] += px[i][0];
      s[1] += px[i][1];
      s[2] += px[i][2];
      s[3]++;
    }
    for (let c = 0; c < centers.length; c++) if (sums[c][3]) centers[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
  }
  const counts = new Array(centers.length).fill(0);
  for (let i = 0; i < assign.length; i++) counts[assign[i]]++;
  return centers
    .map((c, i) => ({ color: hex(c), rgb: c.map(Math.round), share: Math.round((counts[i] / px.length) * 1000) / 1000, lab: rgbToLab(...c.map(Math.round)) }))
    .filter((c) => c.share > 0.004)
    .sort((a, b) => b.share - a.share);
}

function sobel(lum, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1] + lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1];
      const gy = -lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1] + lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1];
      out[i] = Math.hypot(gx, gy);
    }
  }
  return out;
}

function edgeMap(lum, w, h, threshold = 60) {
  const mag = sobel(lum, w, h);
  const e = new Uint8Array(w * h);
  for (let i = 0; i < e.length; i++) e[i] = mag[i] > threshold ? 1 : 0;
  return e;
}

function dilate(map, w, h, r) {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r) && !v; k++) v = map[y * w + k];
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r) && !v; k++) v = tmp[k * w + x];
      out[y * w + x] = v;
    }
  }
  return out;
}

function ssim(la, lb, w, h) {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const win = 8;
  const stride = 4;
  let total = 0;
  let count = 0;
  for (let y = 0; y + win <= h; y += stride) {
    for (let x = 0; x + win <= w; x += stride) {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let j = 0; j < win; j++) {
        let i = (y + j) * w + x;
        for (let k = 0; k < win; k++, i++) {
          const a = la[i];
          const b = lb[i];
          sa += a;
          sb += b;
          saa += a * a;
          sbb += b * b;
          sab += a * b;
        }
      }
      const n = win * win;
      const ma = sa / n;
      const mb = sb / n;
      const va = saa / n - ma * ma;
      const vb = sbb / n - mb * mb;
      const cov = sab / n - ma * mb;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      count++;
    }
  }
  return count ? total / count : 1;
}

function bestShift(a, b, maxShift) {
  // Normalized cross-correlation of two 1D profiles; returns shift s so that b[i + s] ~ a[i].
  const n = a.length;
  const mean = (v) => v.reduce((x, y) => x + y, 0) / v.length;
  const ma = mean(a);
  const mb = mean(b);
  let best = 0;
  let bestScore = -Infinity;
  for (let s = -maxShift; s <= maxShift; s++) {
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      const j = i + s;
      if (j < 0 || j >= n) continue;
      const x = a[i] - ma;
      const y = b[j] - mb;
      num += x * y;
      da += x * x;
      db += y * y;
    }
    const score = da && db ? num / Math.sqrt(da * db) : 0;
    if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && Math.abs(s) < Math.abs(best))) {
      bestScore = score;
      best = s;
    }
  }
  return { shift: best, score: bestScore };
}

function hotspots(diff, w, h, { block = 8, threshold = 18, max = 8 } = {}) {
  const bw = Math.ceil(w / block);
  const bh = Math.ceil(h / block);
  const grid = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let s = 0, n = 0;
      for (let y = by * block; y < Math.min(h, (by + 1) * block); y++) {
        for (let x = bx * block; x < Math.min(w, (bx + 1) * block); x++) {
          s += diff[y * w + x];
          n++;
        }
      }
      grid[by * bw + bx] = s / n;
    }
  }
  const seen = new Uint8Array(bw * bh);
  const spots = [];
  for (let i = 0; i < grid.length; i++) {
    if (seen[i] || grid[i] < threshold) continue;
    const stack = [i];
    seen[i] = 1;
    let minx = bw, miny = bh, maxx = 0, maxy = 0, sum = 0, cells = 0;
    while (stack.length) {
      const c = stack.pop();
      const cx = c % bw;
      const cy = (c - cx) / bw;
      minx = Math.min(minx, cx);
      maxx = Math.max(maxx, cx);
      miny = Math.min(miny, cy);
      maxy = Math.max(maxy, cy);
      sum += grid[c];
      cells++;
      for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const ni = ny * bw + nx;
        if (!seen[ni] && grid[ni] >= threshold) {
          seen[ni] = 1;
          stack.push(ni);
        }
      }
    }
    const x = minx * block;
    const y = miny * block;
    spots.push({
      x,
      y,
      width: Math.min(w, (maxx + 1) * block) - x,
      height: Math.min(h, (maxy + 1) * block) - y,
      mean_diff: Math.round((sum / cells / 255) * 1000) / 1000,
      weight: sum,
    });
  }
  spots.sort((a, b) => b.weight - a.weight);
  return spots.slice(0, max).map(({ weight, ...s }) => s);
}

function heatmap(cur, diff) {
  const out = createImage(cur.width, cur.height);
  for (let i = 0, p = 0; i < diff.length; i++, p += 4) {
    const g = (0.2126 * cur.data[p] + 0.7152 * cur.data[p + 1] + 0.0722 * cur.data[p + 2]) * 0.35;
    const a = Math.min(1, diff[i] / 64);
    out.data[p] = g * (1 - a) + 255 * a;
    out.data[p + 1] = g * (1 - a) + 64 * a;
    out.data[p + 2] = g * (1 - a) + 80 * a;
    out.data[p + 3] = 255;
  }
  return out;
}

const r3 = (v) => Math.round(v * 1000) / 1000;

export function alignSizes(ref, cur, fit = 'auto') {
  const aspectRef = ref.width / ref.height;
  const aspectCur = cur.width / cur.height;
  const aspectClose = Math.abs(aspectRef - aspectCur) / aspectCur < 0.03;
  let mode = fit;
  if (fit === 'auto') mode = ref.width === cur.width && ref.height === cur.height ? 'none' : aspectClose ? 'stretch' : 'crop';
  if (mode === 'stretch') {
    const r = ref.width > cur.width ? downscale(ref, cur.width, cur.height) : resizeBilinear(ref, cur.width, cur.height);
    return { ref: r, cur, mode, note: ref.width !== cur.width || ref.height !== cur.height ? `reference resized from ${ref.width}x${ref.height} to ${cur.width}x${cur.height}` : null };
  }
  if (mode === 'crop' || mode === 'none') {
    const w = Math.min(ref.width, cur.width);
    const h = Math.min(ref.height, cur.height);
    const same = ref.width === cur.width && ref.height === cur.height;
    return {
      ref: same ? ref : crop(ref, { x: 0, y: 0, width: w, height: h }),
      cur: same ? cur : crop(cur, { x: 0, y: 0, width: w, height: h }),
      mode: same ? 'none' : 'crop',
      note: same ? null : `sizes differ (reference ${ref.width}x${ref.height}, current ${cur.width}x${cur.height}); compared the top-left ${w}x${h}`,
    };
  }
  throw new Error(`Unknown fit mode ${fit}`);
}

export function compareImages(refIn, curIn, { fit = 'auto', threshold = 24, maxShift = 48, withHotspots = true } = {}) {
  const aligned = alignSizes(flatten(refIn), flatten(curIn), fit);
  const ref = aligned.ref;
  const cur = aligned.cur;
  const w = cur.width;
  const h = cur.height;
  const n = w * h;
  const diff = new Float32Array(n);
  let mismatch = 0;
  let sumAbs = 0;
  let sumSq = 0;
  let sumDE = 0;
  let deCount = 0;
  let briRef = 0;
  let briCur = 0;
  const colorStep = Math.max(1, Math.floor(Math.sqrt(n / 120000)));
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const dr = Math.abs(ref.data[p] - cur.data[p]);
    const dg = Math.abs(ref.data[p + 1] - cur.data[p + 1]);
    const db = Math.abs(ref.data[p + 2] - cur.data[p + 2]);
    const m = Math.max(dr, dg, db);
    diff[i] = m;
    if (m > threshold) mismatch++;
    sumAbs += (dr + dg + db) / 3;
    sumSq += (dr * dr + dg * dg + db * db) / 3;
    const x = i % w;
    const y = (i - x) / w;
    if (x % colorStep === 0 && y % colorStep === 0) {
      sumDE += deltaE(rgbToLab(ref.data[p], ref.data[p + 1], ref.data[p + 2]), rgbToLab(cur.data[p], cur.data[p + 1], cur.data[p + 2]));
      deCount++;
    }
    briRef += 0.2126 * ref.data[p] + 0.7152 * ref.data[p + 1] + 0.0722 * ref.data[p + 2];
    briCur += 0.2126 * cur.data[p] + 0.7152 * cur.data[p + 1] + 0.0722 * cur.data[p + 2];
  }
  const mse = sumSq / n;
  const lumRef = luminance(ref);
  const lumCur = luminance(cur);
  const ssimVal = ssim(lumRef, lumCur, w, h);

  const eRef = edgeMap(lumRef, w, h);
  const eCur = edgeMap(lumCur, w, h);
  const dRef = dilate(eRef, w, h, 2);
  const dCur = dilate(eCur, w, h, 2);
  let nRef = 0, nCur = 0, hitCur = 0, hitRef = 0;
  for (let i = 0; i < n; i++) {
    if (eRef[i]) {
      nRef++;
      if (dCur[i]) hitRef++;
    }
    if (eCur[i]) {
      nCur++;
      if (dRef[i]) hitCur++;
    }
  }
  const precision = nCur ? hitCur / nCur : nRef ? 0 : 1;
  const recall = nRef ? hitRef / nRef : nCur ? 0 : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  const colRef = new Float32Array(w), colCur = new Float32Array(w), rowRef = new Float32Array(h), rowCur = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      colRef[x] += eRef[i];
      colCur[x] += eCur[i];
      rowRef[y] += eRef[i];
      rowCur[y] += eCur[i];
    }
  }
  const sx = bestShift(colRef, colCur, Math.min(maxShift, Math.floor(w / 4)));
  const sy = bestShift(rowRef, rowCur, Math.min(maxShift, Math.floor(h / 4)));

  const palRef = palette(ref);
  const palCur = palette(cur);
  const paletteMatches = palRef.slice(0, 6).map((pr) => {
    let best = null;
    for (const pc of palCur) {
      const d = deltaE(pr.lab, pc.lab);
      if (!best || d < best.delta_e) best = { reference: pr.color, current: pc.color, delta_e: Math.round(d * 10) / 10, reference_share: pr.share };
    }
    return best;
  });

  const meanDE = deCount ? sumDE / deCount : 0;
  const mismatchRatio = mismatch / n;
  const similarity = Math.max(0, Math.min(100, 100 * (0.45 * Math.max(0, ssimVal) + 0.25 * (1 - mismatchRatio) + 0.2 * f1 + 0.1 * (1 - Math.min(1, meanDE / 25)))));

  const result = {
    similarity: Math.round(similarity * 10) / 10,
    size: { reference: [refIn.width, refIn.height], current: [curIn.width, curIn.height], compared: [w, h], fit: aligned.mode, note: aligned.note },
    pixel: { mismatch_ratio: r3(mismatchRatio), mean_abs_error: r3(sumAbs / n / 255), psnr_db: mse > 0 ? Math.round(10 * Math.log10((255 * 255) / mse) * 10) / 10 : null, threshold },
    perceptual: { ssim: r3(ssimVal) },
    color: {
      mean_delta_e: Math.round(meanDE * 10) / 10,
      brightness: { reference: Math.round(briRef / n), current: Math.round(briCur / n) },
      reference_palette: palRef.map(({ lab, rgb, ...p }) => p),
      current_palette: palCur.map(({ lab, rgb, ...p }) => p),
      palette_matches: paletteMatches.filter(Boolean),
    },
    edges: { precision: r3(precision), recall: r3(recall), f1: r3(f1), tolerance_px: 2 },
    layout: {
      estimated_offset: { dx: -sx.shift, dy: -sy.shift },
      confidence: { x: r3(sx.score), y: r3(sy.score) },
      hint: 'estimated_offset is how far the current build must move to line up with the reference (positive dx = move right)',
    },
  };
  if (withHotspots) result.hotspots = hotspots(diff, w, h);
  return { result, ref, cur, diff, heat: heatmap(cur, diff) };
}

export function describeComparison(r) {
  const lines = [];
  lines.push(`similarity ${r.similarity}/100 (ssim ${r.perceptual.ssim}, edge F1 ${r.edges.f1}, ${Math.round(r.pixel.mismatch_ratio * 100)}% pixels differ, mean dE ${r.color.mean_delta_e})`);
  const o = r.layout.estimated_offset;
  if ((o.dx || o.dy) && (r.layout.confidence.x > 0.5 || r.layout.confidence.y > 0.5)) lines.push(`layout appears offset: move by dx=${o.dx}px dy=${o.dy}px to align`);
  const bri = r.color.brightness;
  if (Math.abs(bri.reference - bri.current) > 8) lines.push(`overall brightness: reference ${bri.reference} vs current ${bri.current}`);
  for (const m of r.color.palette_matches.slice(0, 4)) if (m.delta_e > 6) lines.push(`colour ${m.reference} (${Math.round(m.reference_share * 100)}% of reference) closest match ${m.current} (dE ${m.delta_e})`);
  if (r.size.note) lines.push(r.size.note);
  return lines;
}
