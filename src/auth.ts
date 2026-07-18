import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";

import { KEY_MANAGEMENT_URL, LOG_PREFIX, PROVIDER_LABEL } from "./config.js";
import { validateApiKey } from "./zenmux-api.js";
import type { ApiKeyValidationResult } from "./zenmux-api.js";

// ZenMux API keys are long-lived, so credentials get a far-future expiry and
// refreshToken returns them unchanged.
const NON_EXPIRING_MS = 9_999_999_999_999;

/**
 * Pi `/login` flow for ZenMux. The documented models endpoint validates the
 * key without sending a prompt or consuming model tokens.
 */
export type ApiKeyValidator = (
  apiKey: string,
) => Promise<ApiKeyValidationResult>;

export function createZenMuxOAuth(
  validator: ApiKeyValidator = validateApiKey,
): {
  name: string;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
  refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
  getApiKey(credentials: OAuthCredentials): string;
} {
  return {
    name: PROVIDER_LABEL,

    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      const key = (
        await callbacks.onPrompt({
          message: `Paste your ZenMux API key (from ${KEY_MANAGEMENT_URL}):`,
        })
      ).trim();

      if (!key) {
        throw new Error(`${LOG_PREFIX} No API key entered.`);
      }
      const validation = await validator(key);
      if (validation.status === "invalid") {
        throw new Error(
          `${LOG_PREFIX} ZenMux rejected this key. Double-check it was copied ` +
            `correctly from ${KEY_MANAGEMENT_URL}.`,
        );
      }
      if (validation.status === "indeterminate") {
        throw new Error(
          `${LOG_PREFIX} Could not validate the key right now: ` +
            `${validation.detail}. Try again shortly.`,
        );
      }

      return { access: key, refresh: key, expires: NON_EXPIRING_MS };
    },

    async refreshToken(
      credentials: OAuthCredentials,
    ): Promise<OAuthCredentials> {
      return credentials;
    },

    getApiKey(credentials: OAuthCredentials): string {
      return credentials.access;
    },
  };
}

export const zenmuxOAuth = createZenMuxOAuth();
