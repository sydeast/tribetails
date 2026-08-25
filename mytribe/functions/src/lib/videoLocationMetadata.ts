/**
 * #593: location metadata does not survive on an uploaded video.
 *
 * WHY THIS IS OURS AND NOT CLOUDINARY'S
 * -------------------------------------
 * #583/PR #590 closed this for photos by folding `fl_force_strip` into the
 * signed upload params. That flag is documented "clear all IMAGE metadata"
 * and the transformation reference tags it `[images]`; there is no documented
 * video equivalent, and Cloudinary's docs say nothing at all about what a
 * video transcode does to container metadata.
 *
 * It was tempting to assume a transcode strips it. It does not follow. A
 * default ffmpeg re-encode of an mp4 DROPS `creation_time` but KEEPS the
 * `location` tag — measured, see the PR body. So "the derivative lost its
 * creation_time, therefore it lost its coordinates" is exactly the wrong
 * inference, and a fix built on it could be a silent no-op forever.
 *
 * So the strip is done here, on the bytes, by rules we can state and test,
 * and Cloudinary is only asked to store the result.
 *
 * WHAT CARRIES COORDINATES IN AN MP4/MOV
 * --------------------------------------
 * All three known forms live under the `moov` box, never in `mdat`:
 *
 *   moov/udta/`©xyz`   QuickTime / iOS. ISO-6709 text, e.g. "+37.7749-122.4194/"
 *   moov/udta/`loci`   3GPP / Android. Fixed-point binary, plus a place name.
 *   moov/meta/ilst     Apple key/value, incl. com.apple.quicktime.location.ISO6709
 *
 * `udta` ("user data") and `meta` are pure metadata containers. Nothing in a
 * media file addresses their contents: sample tables (`stco`/`co64`) address
 * `mdat`, and `moov`'s own structural boxes (`mvhd`, `trak`, `mdia`, `minf`)
 * are found by walking, not by offset. So they can be destroyed without
 * touching playback.
 *
 * HOW THE STRIP WORKS: LENGTH-PRESERVING NEUTRALISATION
 * -----------------------------------------------------
 * We do NOT delete the boxes. Deleting bytes shortens `moov`, and in a
 * faststart file (`moov` before `mdat`) that shifts every chunk offset in
 * `stco`/`co64` and silently breaks the video unless all of them are
 * rewritten. Instead each metadata box is neutralised IN PLACE:
 *
 *   - its 4-byte size field is left exactly as it was,
 *   - its 4-byte type is rewritten to `free`, the ISO/IEC 14496-12 skip box
 *     that every demuxer is required to ignore,
 *   - its entire body is overwritten with zeroes.
 *
 * Not one byte moves, so every offset in the file stays valid, in both
 * `moov`-first and `mdat`-first layouts. And zeroing matters as much as
 * retyping: leaving the coordinates sitting inside an ignored box would hide
 * them from a player while a hex editor still read them straight off. This is
 * a privacy fix, so the bytes go.
 *
 * There is no re-encode. Not one video or audio sample is touched, so the
 * output is the same quality, the same codec and (exactly) the same size as
 * what the phone recorded. That is the whole reason to do it this way rather
 * than through a transformation.
 *
 * IT IS ALL-OR-NOTHING WITHIN THOSE BOXES, like the photo path. `udta`/`meta`
 * also hold the device make/model, the recording software and any title or
 * description the camera wrote, and those go with the coordinates: there is no
 * coordinates-only atom to remove.
 *
 * What SURVIVES is the movie header. `creation_time` lives in `mvhd`/`mdhd`,
 * which are structural boxes the strip does not touch, so a stripped video
 * still reports when it was recorded. That is deliberate and it is the
 * difference from the photo path, where `fl_force_strip` takes the capture
 * time too. #593 is about location; a recording date is not a location.
 */

/** Boxes we descend into looking for metadata containers. Everything else is
 *  either a leaf or something we have no business walking. */
const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'udta', 'meta', 'ilst']);

/** Metadata containers to neutralise wherever they appear inside `moov`. */
const METADATA_BOXES = new Set(['udta', 'meta']);

/** A `meta` box is a FullBox: 4 bytes of version+flags before its children. */
const FULLBOX_EXTRA_HEADER = 4;

export interface Mp4Box {
  type: string;
  /** Offset of the box's first byte (its size field). */
  start: number;
  /** Total box length in bytes, header included. */
  size: number;
  /** Header length: 8 normally, 16 for a 64-bit extended size. */
  header: number;
}

/**
 * Reads the sibling boxes in [start, end). Stops (rather than throwing) at the
 * first malformed or over-long box, returning what it read: a truncated or
 * exotic file yields fewer boxes, never a crash and never an out-of-range
 * write. Callers treat "found nothing" as a refusal to strip, not as success.
 */
export function readBoxes(buf: Buffer, start: number, end: number): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      // 64-bit extended size, stored in the 8 bytes after the type.
      if (offset + 16 > end) return boxes;
      const large = buf.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return boxes;
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      // "to end of file", per ISO/IEC 14496-12.
      size = end - offset;
    }
    if (size < header || offset + size > end) return boxes;
    boxes.push({ type, start: offset, size, header });
    offset += size;
  }
  return boxes;
}

/** The top-level `moov` box, or null if this is not a box-structured file. */
export function findMoov(buf: Buffer): Mp4Box | null {
  for (const box of readBoxes(buf, 0, buf.length)) {
    if (box.type === 'moov') return box;
  }
  return null;
}

function childrenStart(box: Mp4Box): number {
  return box.start + box.header + (box.type === 'meta' ? FULLBOX_EXTRA_HEADER : 0);
}

/**
 * Every `udta` / `meta` box reachable inside `moov`, at any depth: the
 * movie-level ones and the per-track ones both. Cameras are not consistent
 * about where they write the location, so we take all of them.
 */
export function collectMetadataBoxes(buf: Buffer, moov: Mp4Box): Mp4Box[] {
  const found: Mp4Box[] = [];
  const visit = (box: Mp4Box): void => {
    for (const child of readBoxes(buf, childrenStart(box), box.start + box.size)) {
      if (METADATA_BOXES.has(child.type)) {
        found.push(child);
      } else if (CONTAINER_BOXES.has(child.type)) {
        visit(child);
      }
    }
  };
  visit(moov);
  return found;
}

/** Byte signatures that mean "this region names a place or a coordinate". */
const LOCATION_SIGNATURES: ReadonlyArray<{ label: string; bytes: Buffer }> = [
  // QuickTime/iOS ISO-6709 user-data atom: 0xA9 'x' 'y' 'z'.
  { label: 'udta/©xyz', bytes: Buffer.from([0xa9, 0x78, 0x79, 0x7a]) },
  // 3GPP location-information atom (Android's camera writes this one).
  { label: 'udta/loci', bytes: Buffer.from('loci', 'latin1') },
  // Apple's key-value form, spelled out in full in the `keys` box.
  { label: 'ilst/com.apple.quicktime.location', bytes: Buffer.from('com.apple.quicktime.location', 'latin1') },
  // Older Apple/Android GPS key spellings seen in the wild.
  { label: 'ilst/location.ISO6709', bytes: Buffer.from('location.ISO6709', 'latin1') },
  { label: 'xmp/exif:GPSLatitude', bytes: Buffer.from('GPSLatitude', 'latin1') },
  { label: 'xmp/exif:GPSLongitude', bytes: Buffer.from('GPSLongitude', 'latin1') },
];

/**
 * Everything that looks like location metadata in this file, as a list of
 * human-readable labels. Empty means clean.
 *
 * SCOPE IS DELIBERATE. Signature matching runs over the `moov` region only,
 * never over `mdat`. Compressed video samples are effectively random bytes, so
 * a four-byte needle like `loci` turns up in them by chance often enough to
 * make a whole-file scan useless — it would report a coordinate-free video as
 * dirty and get the strip marked failed forever. `moov` is where the metadata
 * actually lives, and it is small.
 *
 * A file with no `moov` at all reports `no-moov`: not a coordinate, but not
 * something we are willing to call clean either. The caller must treat any
 * non-empty result as "do not trust this asset".
 */
export function findLocationMetadata(buf: Buffer): string[] {
  const moov = findMoov(buf);
  if (moov === null) return ['no-moov'];
  const region = buf.subarray(moov.start, moov.start + moov.size);
  const hits: string[] = [];
  for (const sig of LOCATION_SIGNATURES) {
    if (region.indexOf(sig.bytes) !== -1) hits.push(sig.label);
  }
  return hits;
}

export interface StripResult {
  /** The rewritten file. Same length as the input, always. */
  buffer: Buffer;
  /** Labels of the boxes neutralised, e.g. ["udta@5303+132"]. */
  neutralised: string[];
}

/**
 * Returns a copy of `buf` with every `moov` metadata container neutralised.
 *
 * Throws rather than returning something half-done: a video we cannot parse
 * must NOT be uploaded back over the original, because a corrupt overwrite
 * loses the only copy. The caller records the failure and leaves the asset
 * alone.
 */
export function stripLocationMetadata(buf: Buffer): StripResult {
  const moov = findMoov(buf);
  if (moov === null) {
    throw new Error('Not an ISO base media file: no top-level moov box.');
  }
  const targets = collectMetadataBoxes(buf, moov);
  const out = Buffer.from(buf);
  const neutralised: string[] = [];
  for (const box of targets) {
    // Size field untouched; type -> 'free'; body -> zeroes. No byte moves.
    out.write('free', box.start + 4, 4, 'latin1');
    out.fill(0, box.start + box.header, box.start + box.size);
    neutralised.push(`${box.type}@${box.start}+${box.size}`);
  }
  if (out.length !== buf.length) {
    // Unreachable by construction; asserted because the whole safety argument
    // for skipping stco/co64 rewriting rests on the length never changing.
    throw new Error('Strip changed the file length; refusing to upload.');
  }
  return { buffer: out, neutralised };
}

/**
 * Strip, then prove it. Returns the clean buffer or throws.
 *
 * The verification is the point. `stripLocationMetadata` neutralises the boxes
 * it recognises; this refuses to hand back a buffer that still matches a
 * location signature, whatever the reason — an unrecognised container, a
 * spelling we have not seen, a future camera. A strip that silently missed
 * something is the exact failure mode #593 is about.
 */
export function stripAndVerify(buf: Buffer): StripResult {
  const result = stripLocationMetadata(buf);
  const remaining = findLocationMetadata(result.buffer);
  if (remaining.length > 0) {
    throw new Error(`Location metadata survived the strip: ${remaining.join(', ')}`);
  }
  return result;
}
