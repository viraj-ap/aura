import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { extractTextFromImage, isSupported as ocrSupported } from 'expo-text-extractor';
import type { AttachmentInput } from '@aura/core';
import { runInWeb } from '../web/HiddenWeb';
import { PDFJS_LIB, PDFJS_WORKER } from './pdfjs.generated';

// Everything here runs on the phone: photos are read by the OS text recognizer (ML Kit on Android,
// Apple Vision on iOS) and PDFs by a bundled pdf.js in the hidden WebView. The extracted
// text is what goes into memory; the files themselves stay where they are.

export type Picked = { kind: 'pdf' | 'image'; name: string; uri: string };

const MAX_PDF_BYTES = 30 * 1024 ** 2;
const MAX_PDF_PAGES = 300;
/** Pages with (almost) no text layer are scans: render and OCR at most this many. */
const MAX_OCR_PAGES = 20;

export async function pickPdf(): Promise<Picked | null> {
  const r = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true });
  const a = r.canceled ? null : r.assets[0];
  if (!a) return null;
  if (a.size && a.size > MAX_PDF_BYTES) throw new Error('PDFs up to 30 MB are supported.');
  return { kind: 'pdf', name: a.name, uri: a.uri };
}

export async function pickImage(source: 'library' | 'camera'): Promise<Picked | null> {
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.9 };
  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error('Camera permission is needed to take a photo.');
  }
  const r = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  const a = r.canceled ? null : r.assets[0];
  if (!a) return null;
  return { kind: 'image', name: a.fileName ?? `photo-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.jpg`, uri: a.uri };
}

export async function extract(p: Picked): Promise<AttachmentInput> {
  if (p.kind === 'image') return { kind: 'image', name: p.name, text: await ocr(p.uri) };
  const { pages, texts, scans } = await readPdf(p.uri);
  // Fill in scanned pages with OCR, in page order.
  for (const s of scans) {
    const tmp = new File(Paths.cache, `aura-scan-${s.page}.jpg`);
    tmp.write(Uint8Array.from(atob(s.jpeg), (c) => c.charCodeAt(0)));
    try { texts[s.page - 1] = await ocr(tmp.uri); } finally { tmp.delete(); }
  }
  const text = texts.map((t, i) => (t.trim() ? `[page ${i + 1}]\n${t.trim()}` : '')).filter(Boolean).join('\n\n');
  return { kind: 'pdf', name: p.name, text, pages };
}

async function ocr(uri: string): Promise<string> {
  if (!ocrSupported) throw new Error('Text recognition is not available on this device.');
  return (await extractTextFromImage(uri)).join('\n');
}

interface PdfResult { pages: number; texts: string[]; scans: { page: number; jpeg: string }[] }

async function readPdf(uri: string): Promise<PdfResult> {
  const b64 = await new File(uri).base64();
  return runInWeb<PdfResult>({
    timeoutMs: 120_000,
    script: `
      const blobUrl = (src) => URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const pdfjs = await import(blobUrl(${JSON.stringify(PDFJS_LIB)}));
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(blobUrl(${JSON.stringify(PDFJS_WORKER)}), { type: 'module' });
      const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
      const doc = await pdfjs.getDocument({ data: bin, isEvalSupported: false }).promise;
      const n = Math.min(doc.numPages, ${MAX_PDF_PAGES});
      const texts = [], scans = [];
      for (let i = 1; i <= n; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        const text = tc.items.map((it) => (it.str || '') + (it.hasEOL ? '\\n' : ' ')).join('').replace(/[ \\t]+/g, ' ');
        texts.push(text);
        if (text.trim().length < 20 && scans.length < ${MAX_OCR_PAGES}) {
          const vp = page.getViewport({ scale: 2 });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width; canvas.height = vp.height;
          await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
          scans.push({ page: i, jpeg: canvas.toDataURL('image/jpeg', 0.85).split(',')[1] });
        }
        page.cleanup();
      }
      return { pages: doc.numPages, texts, scans };`,
  });
}
