/**
 * The portal's release number, for the About screen (#1411).
 *
 * `__APP_VERSION__` is a build-time constant: `vite.config.ts` defines it from
 * `RELEASE_VERSION` when `scripts/release.sh` builds (step 0 exports it before
 * the hosting predeploy runs `vite build`), otherwise from `package.json` plus
 * "-dev", so a local build never looks like a release. That is the same rule
 * `mytribe/build.gradle.kts` `appVersionName()` applies to the Android
 * versionName, so both clients show one number for one release.
 *
 * `vitest.config.ts` is standalone and does not define the constant, so under
 * test it is undeclared and this reads as ''. The About screen omits the row
 * for '', never prints a made-up number.
 */
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__.trim() : '';
