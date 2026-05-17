import { parseEndpointId } from '@fal-ai/client';

/**
 * Values for `POST https://rest.fal.ai/tokens/` → `allowed_apps`.
 *
 * Must match {@link https://github.com/fal-ai/fal-js/blob/main/libs/client/src/auth.ts `@fal-ai/client` `getTemporaryAuthToken`}:
 * the parsed **alias** only (e.g. `flux-2` for `fal-ai/flux-2/klein/realtime`).
 * Using the full endpoint path can return a JWT that the realtime WebSocket
 * rejects (close frame reason **Forbidden**).
 */
export function falTokenAllowedApps(app: string): string[] {
  return [parseEndpointId(app).alias];
}
