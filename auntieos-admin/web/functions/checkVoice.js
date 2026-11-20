#!/usr/bin/env node
// Checks the voice files this codebase would deploy, before they are deployed.
//
//   node checkVoice.js [dir]      dir defaults to ./voice beside this file
//
// It asks the question a generate asks on its first request
// (`voiceWithoutNames` in sampleNames.js), so a samples file that would stop
// every draft is found before it ships instead of after:
//
//   exit 0   the files are there and every declared name is replaced
//   exit 1   the files are there and cannot be used; the reason is printed
//   exit 3   the files are not there (they are gitignored, so a fresh
//            checkout has none)
//
// The output is a reason and counts. It never prints a line of a voice file:
// a release log can be read by anyone.
//
// Nothing here needs node_modules, so it runs on a checkout that has not been
// installed yet.

const fs = require('fs');
const path = require('path');
const { SampleNamesError, voiceWithoutNames } = require('./sampleNames');

const VOICE_FILES = ['01_Voice_Bible.md', '02_Channel_Playbook.md', path.join('corpus', 'exemplars.md')];

/** `{ status: 'ok' | 'absent' | 'refused', code?, message }` for the voice files under `dir`. */
function checkVoice(dir) {
  const missing = VOICE_FILES.filter((f) => !fs.existsSync(path.join(dir, f)));
  if (missing.length) {
    return {
      status: 'absent',
      code: 'voice_source_missing',
      message: `${missing.length} of ${VOICE_FILES.length} voice files are not in this checkout`,
    };
  }
  try {
    const voice = voiceWithoutNames(VOICE_FILES.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')));
    const forms = voice.entries.reduce((n, e) => n + e.forms.length, 0);
    return {
      status: 'ok',
      message: `${voice.entries.length} declared (${forms} spellings), ${voice.replaced} replaced, none left`,
    };
  } catch (e) {
    if (!(e instanceof SampleNamesError)) throw e;
    return { status: 'refused', code: e.code, message: e.message };
  }
}

if (require.main === module) {
  const result = checkVoice(process.argv[2] || path.join(__dirname, 'voice'));
  if (result.status === 'ok') {
    console.log(`voice: sample names ${result.message}`);
  } else {
    console.error(`voice: ${result.status} (${result.code}): ${result.message}`);
  }
  process.exit({ ok: 0, refused: 1, absent: 3 }[result.status]);
}

module.exports = { checkVoice, VOICE_FILES };
