// Image processing worker: keeps heavy pixel work off the UI thread.
import { processPage, detectDocumentCorners, applyFilter, resize, autoCrop } from './imaging.js';

const toTransfer = (img) => [img.data.buffer];

self.onmessage = (e) => {
  const { id, type, payload } = e.data;
  try {
    let result;
    let transfer = [];
    switch (type) {
      case 'process': {
        result = processPage(payload.img, payload.page);
        transfer = toTransfer(result);
        break;
      }
      case 'detect': {
        result = detectDocumentCorners(payload.img);
        break;
      }
      case 'autocrop': {
        result = autoCrop(payload.img);
        break;
      }
      case 'filters': {
        // Small previews of every filter for the filter strip.
        const base = resize(payload.img, payload.size || 160);
        result = payload.filters.map((f) => applyFilter(base, f, payload.adjust));
        transfer = result.flatMap(toTransfer);
        break;
      }
      default:
        throw new Error(`Unknown task ${type}`);
    }
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
