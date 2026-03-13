import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'vendor_docx_template.py');

async function withTempDir(fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vendor-docx-'));
  try {
    return await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runPython(args) {
  const { stdout } = await execFileAsync('python', [SCRIPT_PATH, ...args], {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

export async function parseVendorDocxTemplate({ buffer, filename, contentType }) {
  return withTempDir(async (tempDir) => {
    const inputPath = path.join(tempDir, filename || 'template.docx');
    await fs.writeFile(inputPath, buffer);
    const stdout = await runPython(['parse', inputPath]);
    const parsed = JSON.parse(String(stdout || '{}'));
    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      template: {
        kind: 'docx_vendor_form',
        sourceFilename: String(filename || '').trim(),
        uiHeaders: {
          item: 'Item Name',
          quantity: 'Qty',
          note: 'Note',
          total: 'Total Qty',
          date: 'Date',
        },
        docxMap: parsed.docxMap || {},
        originalFile: {
          filename: String(filename || '').trim(),
          contentType: String(contentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
          base64: buffer.toString('base64'),
        },
      },
    };
  });
}

export async function renderVendorDocxTemplate({ template, storeName, dateText, quantitiesByCode }) {
  if (!template || !template.originalFile || !template.originalFile.base64) {
    throw new Error('Missing original .docx template');
  }
  return withTempDir(async (tempDir) => {
    const inputFilename = template.originalFile.filename || 'template.docx';
    const outputFilename = inputFilename.toLowerCase().endsWith('.docx') ? inputFilename : `${inputFilename}.docx`;
    const inputPath = path.join(tempDir, outputFilename);
    const payloadPath = path.join(tempDir, 'payload.json');
    const outputPath = path.join(tempDir, `rendered-${outputFilename}`);

    await fs.writeFile(inputPath, Buffer.from(template.originalFile.base64, 'base64'));
    await fs.writeFile(
      payloadPath,
      JSON.stringify({
        storeName,
        dateText,
        quantitiesByCode: quantitiesByCode || {},
        docxMap: template.docxMap || {},
      }),
      'utf8'
    );
    await runPython(['render', inputPath, payloadPath, outputPath]);
    const buffer = await fs.readFile(outputPath);
    return {
      buffer,
      filename: outputFilename,
      contentType: template.originalFile.contentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
  });
}
