// Canvas model shared by live drawing, late joiners, undo and the replay player.
// The drawing is a stack of actions (strokes, fills, clears). Undo pops the stack and the canvas is
// re-rendered from it, so every client ends up with exactly the same picture the server holds.
export const W = 800;
export const H = 600;

export const newModel = () => ({ actions: [], byId: new Map() });

export function setModel(model, actions) {
  model.actions = actions.map((a) => ({ ...a, pts: a.pts ? a.pts.slice() : undefined }));
  model.byId = new Map(model.actions.filter((a) => a.k === 's').map((a) => [a.id, a]));
}

export function clearCanvas(ctx) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
}

function style(ctx, a) {
  const c = a.tool === 'eraser' ? '#ffffff' : a.color; // the eraser paints with the background colour
  ctx.strokeStyle = c;
  ctx.fillStyle = c;
  ctx.lineWidth = a.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}
function dot(ctx, a, x, y) {
  style(ctx, a);
  ctx.beginPath();
  ctx.arc(x, y, a.size / 2, 0, Math.PI * 2);
  ctx.fill();
}
function segment(ctx, a, x0, y0, x1, y1) {
  style(ctx, a);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

// Scanline flood fill. Tolerance absorbs the anti-aliased fringe around strokes.
export function floodFill(ctx, sx, sy, hex) {
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const fr = parseInt(hex.slice(1, 3), 16), fg = parseInt(hex.slice(3, 5), 16), fb = parseInt(hex.slice(5, 7), 16);
  const si = (sy * W + sx) * 4;
  const tr = d[si], tg = d[si + 1], tb = d[si + 2];
  if (Math.abs(tr - fr) + Math.abs(tg - fg) + Math.abs(tb - fb) < 8) return; // already that colour
  const TOL = 90;
  const match = (k) => {
    const i = k * 4;
    return Math.abs(d[i] - tr) + Math.abs(d[i + 1] - tg) + Math.abs(d[i + 2] - tb) <= TOL;
  };
  const seen = new Uint8Array(W * H);
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    let x0 = x;
    while (x0 >= 0 && !seen[y * W + x0] && match(y * W + x0)) x0--;
    x0++;
    let up = false, down = false;
    for (let xi = x0; xi < W && !seen[y * W + xi] && match(y * W + xi); xi++) {
      const k = y * W + xi;
      seen[k] = 1;
      const i = k * 4;
      d[i] = fr; d[i + 1] = fg; d[i + 2] = fb; d[i + 3] = 255;
      if (y > 0) {
        const m = !seen[k - W] && match(k - W);
        if (m && !up) { stack.push(xi, y - 1); up = true; } else if (!m) up = false;
      }
      if (y < H - 1) {
        const m = !seen[k + W] && match(k + W);
        if (m && !down) { stack.push(xi, y + 1); down = true; } else if (!m) down = false;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

function paintAction(ctx, a) {
  if (a.k === 's') {
    dot(ctx, a, a.pts[0], a.pts[1]);
    for (let i = 2; i < a.pts.length; i += 2) segment(ctx, a, a.pts[i - 2], a.pts[i - 1], a.pts[i], a.pts[i + 1]);
  } else if (a.k === 'f') floodFill(ctx, a.x, a.y, a.color);
  else if (a.k === 'c') clearCanvas(ctx);
}

export function renderAll(ctx, actions) {
  clearCanvas(ctx);
  for (const a of actions) paintAction(ctx, a);
}

// Apply one drawing operation to the model and paint it incrementally. Returns false if it refers to
// a stroke we don't know (the caller then asks the server for a fresh snapshot).
export function applyOp(model, ctx, op) {
  switch (op.o) {
    case 'ds': {
      const a = { k: 's', id: op.id, tool: op.tool, color: op.color, size: op.size, pts: [op.x, op.y], open: true };
      model.actions.push(a);
      model.byId.set(op.id, a);
      dot(ctx, a, op.x, op.y);
      return true;
    }
    case 'dp': {
      const a = model.byId.get(op.id);
      if (!a) return false;
      let px = a.pts[a.pts.length - 2], py = a.pts[a.pts.length - 1];
      for (let i = 0; i < op.pts.length; i += 2) {
        segment(ctx, a, px, py, op.pts[i], op.pts[i + 1]);
        px = op.pts[i]; py = op.pts[i + 1];
        a.pts.push(px, py);
      }
      return true;
    }
    case 'de': {
      const a = model.byId.get(op.id);
      if (a) a.open = false;
      return true;
    }
    case 'fill':
      model.actions.push({ k: 'f', x: op.x, y: op.y, color: op.color });
      floodFill(ctx, op.x, op.y, op.color);
      return true;
    case 'clear':
      model.actions.push({ k: 'c' });
      clearCanvas(ctx);
      return true;
    case 'undo': {
      const a = model.actions.pop();
      if (a && a.k === 's') model.byId.delete(a.id);
      renderAll(ctx, model.actions);
      return true;
    }
  }
  return true;
}
