/**
 * Which files the Contracts module is, and where they live (ADR-0001
 * decision 3).
 *
 * EACH CONSUMING PROJECT GETS ITS OWN COPY, inside its own source tree. The
 * three projects have three toolchains, three lockfiles and no workspace
 * linking them; a single shared file would need a path alias in two tsconfigs,
 * two Vite configs and a Gradle source set before anything could import it.
 * Copies would normally be the drift this ADR exists to end, except that
 * `contracts:check` regenerates all of them from the one schema and fails on
 * any difference, so they cannot disagree for longer than a CI run.
 *
 * The Kotlin file lands in the Android app's MAIN source set, so
 * `compileDebugKotlin` type-checks the generated decoders on every build.
 */
import { emitKotlin } from './emitKotlin';
import { emitTypeScript } from './emitTypeScript';
import { readModel } from './readModel';
import type { ContractRegistry } from './registry';

/** One generated file: a repo-relative path and its complete contents. */
export interface GeneratedArtifact {
  /** POSIX path relative to the repository root. */
  path: string;
  contents: string;
  /** For the CLI's report. */
  consumer: string;
}

/** The kinfolk portal's copy. */
export const PORTAL_TYPES_PATH = 'mytribe/web/src/contracts/invoiceContracts.generated.ts';

/** The AuntieOS React admin's copy. */
export const ADMIN_TYPES_PATH = 'auntieos-admin/src/contracts/invoiceContracts.generated.ts';

/** The Android admin's copy, in the package `emitKotlin.KOTLIN_PACKAGE` names. */
export const ANDROID_KOTLIN_PATH =
  'auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/contracts/InvoiceContracts.generated.kt';

/**
 * Reads the registry and renders every artifact. Pure: no filesystem, so the
 * unit tests exercise exactly what the CLI writes.
 */
export function generateArtifacts(registry: ContractRegistry): GeneratedArtifact[] {
  const model = readModel(registry);
  const typescript = emitTypeScript(model);
  return [
    { path: PORTAL_TYPES_PATH, contents: typescript, consumer: 'kinfolk portal' },
    { path: ADMIN_TYPES_PATH, contents: typescript, consumer: 'AuntieOS admin (React)' },
    { path: ANDROID_KOTLIN_PATH, contents: emitKotlin(model), consumer: 'AuntieOS admin (Android)' },
  ];
}
