const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'src', 'renderer');
const destDir = path.join(root, 'dist', 'renderer');

function copyFile(name) {
  const src = path.join(srcDir, name);
  const dest = path.join(destDir, name);
  if (!fs.existsSync(src)) {
    console.warn(`Asset not found: ${src}`);
    return;
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`Copied ${src} -> ${dest}`);
}

/**
 * Copy a file from a dependency into dist/renderer/.
 *
 * The renderer is sandboxed (contextIsolation, no nodeIntegration, no
 * bundler), so third-party libraries cannot be imported by renderer code:
 * they are vendored here and loaded with plain <script src> tags, which the
 * page CSP (script-src 'self') allows because they are same-origin files.
 */
function vendorIntoRenderer(src, label) {
  if (!fs.existsSync(src)) {
    console.warn(`Vendored asset not found: ${src}`);
    return;
  }
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(src));
  fs.copyFileSync(src, dest);
  console.log(`Vendored ${label}: ${src} -> ${dest}`);
}

copyFile('index.html');
copyFile('styles.css');

// Markdown rendering for the summary preview (workstream 2).
vendorIntoRenderer(path.join(root, 'node_modules', 'marked', 'lib', 'marked.umd.js'), 'marked');
vendorIntoRenderer(path.join(root, 'node_modules', 'marked', 'lib', 'marked.umd.js.map'), 'marked sourcemap');
vendorIntoRenderer(path.join(root, 'node_modules', 'dompurify', 'dist', 'purify.min.js'), 'dompurify');
vendorIntoRenderer(path.join(root, 'node_modules', 'dompurify', 'dist', 'purify.min.js.map'), 'dompurify sourcemap');
