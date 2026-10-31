// Types for api-proxy.mjs, which vite.config.ts imports (it is typechecked).
export declare const ADMIN_API_REWRITES: Readonly<Record<string, string>>;
export declare const DEFAULT_FUNCTIONS_REGION: string;
export interface RealServicesProxyEntry {
  target: string;
  changeOrigin: boolean;
  rewrite: (path: string) => string;
}
export declare function realServicesApiProxy(
  env: Record<string, string | undefined>,
): Record<string, RealServicesProxyEntry>;
