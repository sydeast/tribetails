// Copies the woff2 files the public KinTale share page (`/share/<token>`,
// rendered by mytribe/functions/src/share/getSharedKinTalePage.ts) needs into
// public/share-assets/fonts/, at stable, unhashed names (#1278).
//
// The share page is HTML from a Cloud Function, not part of the Vite bundle,
// so it cannot reference the hashed font files Vite emits for the portal. The
// hosting CSP refuses Google Fonts (`font-src 'self'`), so the page uses these
// same-origin copies of the @fontsource files the portal already ships.
//
// FILES must match SHARE_FONT_FILES in getSharedKinTalePage.ts; a functions
// test reads this file and fails if a name the page references is missing.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

export const FILES = {
  '@fontsource/young-serif': [
    'young-serif-latin-400-normal.woff2',
    'young-serif-latin-ext-400-normal.woff2',
  ],
  '@fontsource/bricolage-grotesque': [
    'bricolage-grotesque-latin-400-normal.woff2',
    'bricolage-grotesque-latin-ext-400-normal.woff2',
    'bricolage-grotesque-latin-500-normal.woff2',
    'bricolage-grotesque-latin-ext-500-normal.woff2',
    'bricolage-grotesque-latin-600-normal.woff2',
    'bricolage-grotesque-latin-ext-600-normal.woff2',
    'bricolage-grotesque-latin-700-normal.woff2',
    'bricolage-grotesque-latin-ext-700-normal.woff2',
  ],
  '@fontsource/dm-mono': [
    'dm-mono-latin-400-normal.woff2',
    'dm-mono-latin-ext-400-normal.woff2',
    'dm-mono-latin-500-normal.woff2',
    'dm-mono-latin-ext-500-normal.woff2',
  ],
};

export function copyShareFonts(outDir = join(here, '..', 'public', 'share-assets', 'fonts')) {
  mkdirSync(outDir, { recursive: true });
  const copied = [];
  for (const [pkg, files] of Object.entries(FILES)) {
    const pkgDir = dirname(require.resolve(`${pkg}/package.json`));
    for (const file of files) {
      const src = join(pkgDir, 'files', file);
      // Fail the build loudly: a missing font is a page that silently falls
      // back to a system face, which is the bug this script exists to fix.
      if (!existsSync(src)) throw new Error(`copy-share-fonts: ${src} not found`);
      copyFileSync(src, join(outDir, file));
      copied.push(file);
    }
  }
  return copied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const copied = copyShareFonts();
  console.log(`copy-share-fonts: ${copied.length} files -> public/share-assets/fonts/`);
}
