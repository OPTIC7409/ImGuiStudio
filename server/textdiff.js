// Line-based Myers diff producing unified diff hunks.

function myers(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  const off = max + 1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, off, d);
    }
  }
  return [];
}

function backtrack(trace, a, b, off, dEnd) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const prevX = v[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: '=', a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (x === prevX) ops.push({ t: '+', b: prevY });
    else ops.push({ t: '-', a: prevX });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ t: '=', a: x - 1, b: y - 1 });
    x--;
    y--;
  }
  return ops.reverse();
}

function splitLines(text) {
  if (text == null || text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function unifiedDiff(oldText, newText, { fromFile = 'a', toFile = 'b', context = 3 } = {}) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length * b.length > 25_000_000) return `--- ${fromFile}\n+++ ${toFile}\n@@ file too large to diff @@\n`;
  const ops = myers(a, b);
  if (!ops.some((o) => o.t !== '=')) return '';
  const hunks = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t === '=') {
      i++;
      continue;
    }
    let start = Math.max(0, i - context);
    let end = i;
    while (end < ops.length) {
      if (ops[end].t !== '=') {
        end++;
        continue;
      }
      let run = 0;
      while (end + run < ops.length && ops[end + run].t === '=') run++;
      if (end + run >= ops.length || run > context * 2) {
        end = Math.min(ops.length, end + context);
        break;
      }
      end += run;
    }
    hunks.push(ops.slice(start, end));
    i = end;
  }
  let out = `--- ${fromFile}\n+++ ${toFile}\n`;
  for (const h of hunks) {
    let aStart = null, bStart = null, aCount = 0, bCount = 0;
    const body = [];
    for (const o of h) {
      if (o.t === '=') {
        if (aStart === null) aStart = o.a;
        if (bStart === null) bStart = o.b;
        aCount++;
        bCount++;
        body.push(` ${a[o.a]}`);
      } else if (o.t === '-') {
        if (aStart === null) aStart = o.a;
        aCount++;
        body.push(`-${a[o.a]}`);
      } else {
        if (bStart === null) bStart = o.b;
        bCount++;
        body.push(`+${b[o.b]}`);
      }
    }
    if (aStart === null) aStart = 0;
    if (bStart === null) bStart = 0;
    out += `@@ -${aCount ? aStart + 1 : aStart},${aCount} +${bCount ? bStart + 1 : bStart},${bCount} @@\n${body.join('\n')}\n`;
  }
  return out;
}

export function diffStats(oldText, newText) {
  const ops = myers(splitLines(oldText), splitLines(newText));
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.t === '+') added++;
    else if (o.t === '-') removed++;
  }
  return { added, removed };
}
