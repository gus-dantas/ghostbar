// Copies the pages Gus Assistant shares with its Chrome extension
// (~/Projects/gus-screenshot) into src/ext, then swaps in the app's own
// storage layer (src/ext-platform/store.js) for the Chrome one.
import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync, appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = process.env.GUS_EXTENSION_DIR || join(homedir(), 'Projects', 'gus-screenshot');
const out = join(root, 'src', 'ext');
if (!existsSync(join(ext, 'manifest.json'))) {
  if (existsSync(out)) { console.log(`sync-extension: ${ext} not found, keeping the last copy`); process.exit(0); }
  throw new Error(`sync-extension: the extension isn't at ${ext}`);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'lib'), { recursive: true });
const files = ['ui.css', 'editor.html', 'editor.css', 'editor.js', 'video.html', 'video.css', 'video.js', 'library.css',
  'lib/icons.js', 'lib/trim.js', 'lib/mp4.js', 'lib/gif-worker.js', 'lib/prompter.js'];
for (const f of files) copyFileSync(join(ext, f), join(out, f));
// The app's own look goes on top of the extension's shared stylesheet.
appendFileSync(join(out, 'ui.css'), readFileSync(join(root, 'src', 'ext-platform', 'ui-brand.css')));
cpSync(join(ext, 'lib', 'gifenc'), join(out, 'lib', 'gifenc'), { recursive: true });
cpSync(join(ext, 'icons'), join(out, 'icons'), { recursive: true });
copyFileSync(join(root, 'src', 'ext-platform', 'store.js'), join(out, 'lib', 'store.js'));
console.log(`sync-extension: ${files.length} files + gifenc + icons from ${ext}`);
