/**
 * The admin's own `/api/*` endpoints, routed to the functions emulator for the
 * real-services Cypress run (#1201, part of #1089).
 *
 * In production `firebase.json` rewrites two paths to `onRequest` functions in
 * the admin's own codebase (`auntieos-admin/web/functions`):
 *
 *   /api/cloudinary/sign-upload  ->  signCloudinaryUpload
 *   /api/generate                ->  generateAuntieCopy
 *
 * The vite dev server has no hosting rewrites, so without this nothing answers
 * them and every admin upload fails before it reaches Cloudinary. The
 * real-services run serves that codebase (`e2e.real.firebase.json`, codebase
 * `default`), and this table forwards each path to the function's emulator URL,
 * `http://127.0.0.1:<port>/<project>/us-central1/<function>`. The admin
 * functions set no region, so they run in the default one.
 *
 * ONLY FOR THAT RUN. `vite.config.ts` asks for the table with `process.env`,
 * and it is empty unless BOTH variables the `e2e:real:server` script sets are
 * present, and the project id is a `demo-` one: the same lock `run.sh` relies on,
 * so a proxy can never point a dev server at a function serving a real project.
 * `npm run dev`, the PR-time suites and the hosting build get no proxy.
 *
 * Kept in `scripts/e2e-real/` beside the rest of the run, as plain JS so it is
 * tested by the same vitest include as the preflight.
 */

/** Path on the admin's origin -> function name in the `default` codebase. Mirrors firebase.json's rewrites. */
export const ADMIN_API_REWRITES = {
  '/api/cloudinary/sign-upload': 'signCloudinaryUpload',
  '/api/generate': 'generateAuntieCopy',
};

/** The emulator's region for functions that set none. */
export const DEFAULT_FUNCTIONS_REGION = 'us-central1';

/**
 * Vite `server.proxy` entries for the real-services run, or `{}` anywhere else.
 *
 * Keys are anchored regexes (vite treats a key starting with `^` as one), so
 * `/api/generate` does not also capture `/api/generated-thing`. A query string
 * is carried over unchanged.
 *
 * @param {Record<string, string | undefined>} env normally `process.env`
 */
export function realServicesApiProxy(env) {
  const projectId = env.VITE_E2E_PROJECT_ID ?? '';
  const port = env.VITE_E2E_FUNCTIONS_PORT ?? '';
  const host = env.VITE_E2E_EMULATOR ?? '';
  if (projectId === '' || port === '' || host === '') return {};
  if (!projectId.startsWith('demo-')) {
    throw new Error(`VITE_E2E_PROJECT_ID=${projectId} is not a demo- project id; refusing to proxy /api/* to it`);
  }
  if (!/^\d+$/.test(port)) {
    throw new Error(`VITE_E2E_FUNCTIONS_PORT=${port} is not a port number`);
  }
  const target = `http://${host}:${port}`;
  return Object.fromEntries(
    Object.entries(ADMIN_API_REWRITES).map(([path, fn]) => {
      const functionPath = `/${projectId}/${DEFAULT_FUNCTIONS_REGION}/${fn}`;
      return [
        `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\?.*)?$`,
        {
          target,
          changeOrigin: true,
          rewrite: (requested) => requested.replace(/^[^?]*/, functionPath),
        },
      ];
    }),
  );
}
