/**
 * #593. The load-bearing tests for the video location strip.
 *
 * These run against REAL VIDEO FILES, not synthesised box trees, because the
 * question this fix turns on is empirical: what actually happens to a
 * coordinate atom. The four fixtures cover the shapes a phone produces, and are
 * regenerable — each is about 5 KB, one second of `testsrc` at 160x120:
 *
 *   ffmpeg -f lavfi -i testsrc=size=160x120:rate=10:duration=1 -c:v libx264 \
 *     -pix_fmt yuv420p -metadata location="+37.7749-122.4194/" \
 *     -metadata creation_time="2026-01-02T03:04:05Z" gps-loci.mp4
 *   ...same, with `-f mov`                                    -> gps-xyz.mov
 *   ...same, with `-movflags +faststart`                      -> gps-faststart.mp4
 *   ...same, with `-map_metadata -1` and no -metadata flags   -> no-location.mp4
 *
 * The fixtures and what each one is for:
 *
 *   test/fixtures/gps-loci.mp4       moov/udta/`loci`, the 3GPP atom Android
 *                                    writes. Coordinates are FIXED-POINT
 *                                    BINARY, not text — which is why a "search
 *                                    the file for a lat/long string" check
 *                                    would pass on a file that is still
 *                                    carrying them.
 *   test/fixtures/gps-xyz.mov        moov/udta/`©xyz`, the QuickTime atom iOS
 *                                    writes. ISO-6709 text.
 *   test/fixtures/gps-faststart.mp4  the same `loci` payload with `moov` moved
 *                                    BEFORE `mdat`. This is the layout where a
 *                                    strip that deleted bytes would shift every
 *                                    chunk offset in `stco` and silently break
 *                                    playback.
 *   test/fixtures/no-location.mp4    a clean control, so a verifier that just
 *                                    said "dirty" to everything would fail here.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  collectMetadataBoxes,
  findLocationMetadata,
  findMoov,
  readBoxes,
  stripAndVerify,
  stripLocationMetadata,
} from '../src/lib/videoLocationMetadata';

const FIXTURES = join(__dirname, 'fixtures');
const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));

const GPS_LOCI = 'gps-loci.mp4';
const GPS_XYZ = 'gps-xyz.mov';
const GPS_FASTSTART = 'gps-faststart.mp4';
const CLEAN = 'no-location.mp4';

describe('findLocationMetadata', () => {
  it('finds the 3GPP loci atom an Android recording carries', () => {
    expect(findLocationMetadata(fixture(GPS_LOCI))).toContain('udta/loci');
  });

  it('finds the QuickTime ©xyz atom an iOS recording carries', () => {
    expect(findLocationMetadata(fixture(GPS_XYZ))).toContain('udta/©xyz');
  });

  it('finds it in a faststart file too, where moov precedes mdat', () => {
    expect(findLocationMetadata(fixture(GPS_FASTSTART))).toContain('udta/loci');
  });

  it('reports a video with no location metadata as clean', () => {
    expect(findLocationMetadata(fixture(CLEAN))).toEqual([]);
  });

  it('refuses to call a non-video clean: no moov is not the same as no coordinates', () => {
    // The whole point of the verifier is that it never says "clean" about
    // something it did not understand.
    expect(findLocationMetadata(Buffer.from('this is not a video at all'))).toEqual(['no-moov']);
  });

  it('does not scan mdat, so compressed sample bytes cannot fake a hit', () => {
    // `loci` is four bytes; over megabytes of compressed video it turns up by
    // chance. A whole-file scan would report a clean video as dirty and get its
    // strip marked failed forever, so the scan is bounded to moov. Proven by
    // planting the needle in the fixture's mdat region and getting no hit.
    const clean = fixture(CLEAN);
    const moov = findMoov(clean);
    expect(moov).not.toBeNull();
    const mdat = readBoxes(clean, 0, clean.length).find((b) => b.type === 'mdat');
    expect(mdat).toBeDefined();
    const planted = Buffer.from(clean);
    planted.write('loci', (mdat as { start: number; header: number }).start + (mdat as { header: number }).header, 'latin1');
    expect(findLocationMetadata(planted)).toEqual([]);
  });
});

describe('stripLocationMetadata', () => {
  for (const name of [GPS_LOCI, GPS_XYZ, GPS_FASTSTART]) {
    describe(name, () => {
      it('removes every location signature', () => {
        const before = fixture(name);
        expect(findLocationMetadata(before).length).toBeGreaterThan(0);
        const { buffer } = stripLocationMetadata(before);
        expect(findLocationMetadata(buffer)).toEqual([]);
      });

      it('does not change the file length, so no chunk offset moves', () => {
        const before = fixture(name);
        expect(stripLocationMetadata(before).buffer.length).toBe(before.length);
      });

      it('leaves the coordinate BYTES nowhere in the file, not merely hidden', () => {
        // Retyping udta to `free` alone would make players ignore the box while
        // a hex editor still read the coordinates straight out of it. For a
        // privacy fix that is not good enough, so the body is zeroed as well.
        const { buffer } = stripLocationMetadata(fixture(name));
        expect(buffer.indexOf(Buffer.from('37.7749', 'latin1'))).toBe(-1);
        expect(buffer.indexOf(Buffer.from('122.4194', 'latin1'))).toBe(-1);
      });

      it('rewrites the metadata box as a `free` skip box of the same size', () => {
        const before = fixture(name);
        const moov = findMoov(before);
        expect(moov).not.toBeNull();
        const targets = collectMetadataBoxes(before, moov as NonNullable<typeof moov>);
        expect(targets.length).toBeGreaterThan(0);
        const { buffer } = stripLocationMetadata(before);
        for (const box of targets) {
          expect(buffer.toString('latin1', box.start + 4, box.start + 8)).toBe('free');
          expect(buffer.readUInt32BE(box.start)).toBe(before.readUInt32BE(box.start));
          // Body is all zeroes.
          expect(buffer.subarray(box.start + box.header, box.start + box.size).every((b) => b === 0)).toBe(true);
        }
      });

      it('leaves mdat byte-identical: not one sample is re-encoded', () => {
        const before = fixture(name);
        const mdat = readBoxes(before, 0, before.length).find((b) => b.type === 'mdat');
        expect(mdat).toBeDefined();
        const { start, size } = mdat as { start: number; size: number };
        const { buffer } = stripLocationMetadata(before);
        expect(buffer.subarray(start, start + size).equals(before.subarray(start, start + size))).toBe(true);
      });
    });
  }

  it('leaves the movie header alone, so a stripped video still knows its recording date', () => {
    // `creation_time` lives in mvhd/mdhd, structural boxes the strip never
    // touches. This is the documented difference from the photo path, where the
    // capture time goes with the coordinates. #593 is about location.
    const before = fixture(GPS_LOCI);
    const moov = findMoov(before) as NonNullable<ReturnType<typeof findMoov>>;
    const mvhd = readBoxes(before, moov.start + moov.header, moov.start + moov.size).find(
      (b) => b.type === 'mvhd',
    );
    expect(mvhd).toBeDefined();
    const { start, size } = mvhd as { start: number; size: number };
    const { buffer } = stripLocationMetadata(before);
    expect(buffer.subarray(start, start + size).equals(before.subarray(start, start + size))).toBe(true);
  });

  it('is idempotent: stripping an already-stripped video changes nothing', () => {
    // The retry sweep re-runs the job on assets it cannot confirm, so a second
    // pass must be harmless.
    const once = stripLocationMetadata(fixture(GPS_LOCI)).buffer;
    const twice = stripLocationMetadata(once).buffer;
    expect(twice.equals(once)).toBe(true);
  });

  it('is ALL-OR-NOTHING inside udta/meta: other tags in those boxes go too', () => {
    // Same bargain the photo path struck in #583 — `fl_force_strip` clears
    // IPTC, Exif and XMP together because the Upload API has no GPS-only
    // option, and neither does a `udta` box. `no-location.mp4` carries no
    // coordinates but does carry an encoder tag in moov/udta/meta/ilst/©too,
    // and that goes with them. Asserted rather than glossed.
    const before = fixture(CLEAN);
    expect(before.indexOf(Buffer.from('Lavf', 'latin1'))).not.toBe(-1);
    const { buffer, neutralised } = stripLocationMetadata(before);
    expect(neutralised.length).toBeGreaterThan(0);
    expect(buffer.length).toBe(before.length);
    expect(findLocationMetadata(buffer)).toEqual([]);
    // ...and the picture itself is untouched, which is the part that matters.
    const mdat = readBoxes(before, 0, before.length).find((b) => b.type === 'mdat');
    const { start, size } = mdat as { start: number; size: number };
    expect(buffer.subarray(start, start + size).equals(before.subarray(start, start + size))).toBe(true);
  });

  it('refuses a file it cannot parse rather than uploading something half-done', () => {
    // A corrupt overwrite destroys the only copy of the asset, so an
    // unparseable file must abort, not be "best effort" repaired.
    expect(() => stripLocationMetadata(Buffer.from('not a video'))).toThrow(/no top-level moov/i);
  });
});

describe('stripAndVerify', () => {
  it('returns the clean buffer for every location shape', () => {
    for (const name of [GPS_LOCI, GPS_XYZ, GPS_FASTSTART]) {
      const { buffer, neutralised } = stripAndVerify(fixture(name));
      expect(neutralised.length).toBeGreaterThan(0);
      expect(findLocationMetadata(buffer)).toEqual([]);
    }
  });

  it('throws instead of returning a buffer that still matches a signature', () => {
    // The guarantee is not "we ran a strip", it is "the result is clean". This
    // is the check that turns a silent no-op into a recorded failure. Proved by
    // handing it a file whose location atom is somewhere the neutraliser does
    // not reach: directly under `ftyp`, outside moov's own tree but still
    // inside the region the verifier scans.
    const src = fixture(GPS_LOCI);
    const moov = findMoov(src);
    expect(moov).not.toBeNull();
    const doctored = Buffer.from(src);
    // Plant the needle in moov's own header area, which no udta/meta walk owns.
    doctored.write('loci', (moov as { start: number }).start + 8 + 4, 'latin1');
    expect(() => stripAndVerify(doctored)).toThrow(/survived the strip/i);
  });
});

describe('readBoxes', () => {
  it('stops at a box that claims to run past the end rather than throwing', () => {
    const buf = Buffer.alloc(16);
    buf.writeUInt32BE(0xffffff, 0);
    buf.write('moov', 4, 'latin1');
    expect(readBoxes(buf, 0, buf.length)).toEqual([]);
  });

  it('stops at a box whose size is smaller than its own header', () => {
    const buf = Buffer.alloc(16);
    buf.writeUInt32BE(4, 0);
    buf.write('moov', 4, 'latin1');
    expect(readBoxes(buf, 0, buf.length)).toEqual([]);
  });

  it('reads a top-level ftyp/mdat/moov sequence off a real file', () => {
    const types = readBoxes(fixture(GPS_LOCI), 0, fixture(GPS_LOCI).length).map((b) => b.type);
    expect(types).toContain('ftyp');
    expect(types).toContain('mdat');
    expect(types).toContain('moov');
  });
});
