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
 *
 * ONE REGISTRY, ONE TRIAD OF FILES: the invoice surface and the booking
 * surface (ADR-0003's follow-up) are two separate registries so that
 * `INVOICE_CONTRACT_REGISTRY` stays exactly the 19 callables PR #112 gave
 * response schemas, unchanged by anything that lands after it. Each registry
 * gets its own `ArtifactPaths`, so the two never contend for the same
 * generated file or the same Kotlin class names.
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

/** Where one registry's triad of generated files lands. */
export interface ArtifactPaths {
  /** The kinfolk portal's copy. */
  portal: string;
  /** The AuntieOS React admin's copy. */
  admin: string;
  /** The Android admin's copy, in the package `emitKotlin.KOTLIN_PACKAGE` names. */
  androidKotlin: string;
}

export const INVOICE_ARTIFACT_PATHS: ArtifactPaths = {
  portal: 'mytribe/web/src/contracts/invoiceContracts.generated.ts',
  admin: 'auntieos-admin/src/contracts/invoiceContracts.generated.ts',
  androidKotlin:
    'auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/contracts/InvoiceContracts.generated.kt',
};

/** Back-compat aliases: several call sites and tests import these by name directly. */
export const PORTAL_TYPES_PATH = INVOICE_ARTIFACT_PATHS.portal;
export const ADMIN_TYPES_PATH = INVOICE_ARTIFACT_PATHS.admin;
export const ANDROID_KOTLIN_PATH = INVOICE_ARTIFACT_PATHS.androidKotlin;

export const BOOKING_ARTIFACT_PATHS: ArtifactPaths = {
  portal: 'mytribe/web/src/contracts/bookingContracts.generated.ts',
  admin: 'auntieos-admin/src/contracts/bookingContracts.generated.ts',
  androidKotlin:
    'auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/contracts/BookingContracts.generated.kt',
};

/**
 * Reads the registry and renders every artifact. Pure: no filesystem, so the
 * unit tests exercise exactly what the CLI writes.
 */
export function generateArtifacts(
  registry: ContractRegistry,
  paths: ArtifactPaths = INVOICE_ARTIFACT_PATHS,
): GeneratedArtifact[] {
  const model = readModel(registry);
  const typescript = emitTypeScript(model);
  return [
    { path: paths.portal, contents: typescript, consumer: 'kinfolk portal' },
    { path: paths.admin, contents: typescript, consumer: 'AuntieOS admin (React)' },
    { path: paths.androidKotlin, contents: emitKotlin(model), consumer: 'AuntieOS admin (Android)' },
  ];
}
