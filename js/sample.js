// Generates a realistic "photo of a document on a desk" so people can try the app without a camera.
import { canvasToBlob } from './render.js';

function drawDocument() {
  const W = 1240;
  const H = 1754; // A4 at 150 dpi
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fbfaf7';
  g.fillRect(0, 0, W, H);
  const ink = '#1d2230';
  g.fillStyle = ink;
  g.font = '700 64px Georgia, serif';
  g.fillText('INVOICE', 110, 190);
  g.font = '400 26px Helvetica, Arial, sans-serif';
  g.fillStyle = '#4a5160';
  g.fillText('Harbor Lane Print Shop · 14 Quay Street · Portsmouth', 110, 240);
  g.fillStyle = ink;
  g.font = '600 28px Helvetica, Arial, sans-serif';
  g.fillText('Invoice no.', 760, 170); g.fillText('Date', 760, 215); g.fillText('Due', 760, 260);
  g.font = '400 28px Helvetica, Arial, sans-serif';
  g.fillText('2026-0412', 930, 170); g.fillText('3 Oct 2026', 930, 215); g.fillText('2 Nov 2026', 930, 260);
  g.fillRect(110, 300, W - 220, 4);
  g.font = '600 28px Helvetica, Arial, sans-serif';
  g.fillText('Bill to', 110, 370);
  g.font = '400 28px Helvetica, Arial, sans-serif';
  ['Marta Okafor', 'Okafor Design Studio', '7 Elm Row, Bristol BS1 4DJ'].forEach((t, i) => g.fillText(t, 110, 412 + i * 40));
  const rows = [
    ['Business cards, 400gsm matt', '500', '0.18', '90.00'],
    ['A2 posters, silk', '40', '3.25', '130.00'],
    ['Letterheads, 120gsm', '1000', '0.09', '90.00'],
    ['Design proof revisions', '2', '25.00', '50.00'],
    ['Delivery', '1', '12.50', '12.50'],
  ];
  let y = 600;
  g.fillStyle = '#e9ebf0';
  g.fillRect(110, y - 42, W - 220, 60);
  g.fillStyle = ink;
  g.font = '600 26px Helvetica, Arial, sans-serif';
  g.fillText('Description', 130, y); g.fillText('Qty', 700, y); g.fillText('Unit £', 820, y); g.fillText('Amount £', 980, y);
  g.font = '400 26px Helvetica, Arial, sans-serif';
  y += 70;
  for (const r of rows) {
    g.fillText(r[0], 130, y); g.fillText(r[1], 700, y); g.fillText(r[2], 820, y); g.fillText(r[3], 980, y);
    g.fillStyle = '#d6d9e0'; g.fillRect(110, y + 22, W - 220, 2); g.fillStyle = ink;
    y += 66;
  }
  y += 30;
  g.font = '600 30px Helvetica, Arial, sans-serif';
  g.fillText('Subtotal', 760, y); g.fillText('372.50', 980, y);
  g.fillText('VAT 20%', 760, y + 48); g.fillText('74.50', 980, y + 48);
  g.font = '700 36px Helvetica, Arial, sans-serif';
  g.fillText('Total', 760, y + 112); g.fillText('£447.00', 980, y + 112);
  g.font = '400 24px Helvetica, Arial, sans-serif';
  g.fillStyle = '#4a5160';
  const notes = [
    'Payment by bank transfer within 30 days. Sort code 20-45-77, account 6031 8842.',
    'Please quote the invoice number as your payment reference.',
    'Thank you for your business.',
  ];
  notes.forEach((t, i) => g.fillText(t, 110, 1430 + i * 38));
  // Signature in blue ink.
  g.strokeStyle = '#2346b8';
  g.lineWidth = 4;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(130, 1630);
  g.bezierCurveTo(170, 1560, 200, 1660, 240, 1600);
  g.bezierCurveTo(270, 1560, 290, 1650, 330, 1610);
  g.bezierCurveTo(360, 1580, 380, 1640, 440, 1615);
  g.stroke();
  // Red "PAID" stamp.
  g.save();
  g.translate(930, 1600);
  g.rotate(-0.18);
  g.strokeStyle = 'rgba(200, 40, 40, .85)';
  g.lineWidth = 7;
  g.strokeRect(-120, -55, 240, 110);
  g.fillStyle = 'rgba(200, 40, 40, .85)';
  g.font = '800 64px Helvetica, Arial, sans-serif';
  g.textAlign = 'center';
  g.fillText('PAID', 0, 22);
  g.restore();
  return c;
}

// Draws `src` into the quad (tl, tr, br, bl) using thin vertical strips (approximate perspective).
function drawQuad(g, src, q) {
  const strips = 240;
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  for (let i = 0; i < strips; i++) {
    const t0 = i / strips;
    const t1 = (i + 1) / strips;
    const top0 = lerp(q[0], q[1], t0);
    const bot0 = lerp(q[3], q[2], t0);
    const top1 = lerp(q[0], q[1], t1);
    const sx = t0 * src.width;
    const sw = src.width / strips;
    g.save();
    g.setTransform(
      (top1.x - top0.x) / sw, (top1.y - top0.y) / sw,
      (bot0.x - top0.x) / src.height, (bot0.y - top0.y) / src.height,
      top0.x, top0.y,
    );
    g.drawImage(src, sx, 0, sw + 0.6, src.height, 0, 0, sw + 0.6, src.height);
    g.restore();
  }
}

export async function makeSamplePhoto() {
  const W = 1600;
  const H = 2000;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  // Desk: dark walnut wood with grain.
  const desk = g.createLinearGradient(0, 0, W, H);
  desk.addColorStop(0, '#4a3426');
  desk.addColorStop(1, '#2c1e16');
  g.fillStyle = desk;
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 160; i++) {
    g.strokeStyle = `rgba(${20 + Math.random() * 40}, ${12 + Math.random() * 20}, 8, ${0.15 + Math.random() * 0.2})`;
    g.lineWidth = 1 + Math.random() * 3;
    const y = Math.random() * H;
    g.beginPath();
    g.moveTo(0, y);
    g.bezierCurveTo(W * 0.3, y + Math.random() * 40 - 20, W * 0.7, y + Math.random() * 40 - 20, W, y + Math.random() * 30 - 15);
    g.stroke();
  }
  const quad = [{ x: 300, y: 250 }, { x: 1330, y: 330 }, { x: 1440, y: 1780 }, { x: 170, y: 1700 }];
  // Soft drop shadow under the page.
  g.save();
  g.shadowColor = 'rgba(0,0,0,.55)';
  g.shadowBlur = 40;
  g.shadowOffsetY = 18;
  g.fillStyle = '#000';
  g.beginPath();
  quad.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.closePath();
  g.fill();
  g.restore();
  drawQuad(g, drawDocument(), quad);
  // Warm indoor light + a phone-shaped shadow across one corner.
  g.globalCompositeOperation = 'multiply';
  const light = g.createRadialGradient(W * 0.7, H * 0.2, 100, W * 0.5, H * 0.5, W * 1.1);
  light.addColorStop(0, '#fff6df');
  light.addColorStop(1, '#a8957a');
  g.fillStyle = light;
  g.fillRect(0, 0, W, H);
  const shadow = g.createLinearGradient(0, H, W * 0.55, H * 0.45);
  shadow.addColorStop(0, 'rgba(70,60,55,1)');
  shadow.addColorStop(0.55, 'rgba(150,140,130,1)');
  shadow.addColorStop(1, 'rgba(255,255,255,1)');
  g.fillStyle = shadow;
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over';
  // Sensor noise.
  const id = g.getImageData(0, 0, W, H);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 10;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(id, 0, 0);
  return { blob: await canvasToBlob(c, 'image/jpeg', 0.9), width: W, height: H };
}
