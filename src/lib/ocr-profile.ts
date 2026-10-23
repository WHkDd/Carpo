import { t } from "@/i18n";
import { getSecret } from "@/lib/tauri";
import type { NonSecretSettings, Provider, SecretKey } from "@/lib/ipc-types";

/** Preview DPI the canvas is actually rendered at today. The OCR-grade
 *  render DPI is now owned entirely by the backend (see
 *  `OcrProfile::ocr_dpi` in Rust); the frontend only needs to tell the
 *  backend what DPI it drew at so block coordinates can be scaled
 *  correctly. The `preview_dpi` field on OCR requests is sourced from
 *  this constant. */
export const ACTIVE_PREVIEW_DPI = 150;

const PROVIDER_SECRET_KEY: Record<Provider, SecretKey> = {
  paddleocr: "paddle_token",
  openai: "openai_key",
  openrouter: "openrouter_key",
  openai_compatible: "openai_compatible_key",
};

/** Why an OCR job for the active provider would be refused before it is
 *  sent, or null when the provider is usable. Async: the key probe is an
 *  IPC round trip. Shared by both OCR triggers and the batch runner. */
export async function providerSetupError(
  settings: NonSecretSettings
): Promise<string | null> {
  if (
    settings.provider === "openai_compatible" &&
    !settings.openai_compatible_base_url
  ) {
    return t("trigger.compatBaseUrlMissing");
  }
  const secretKey = PROVIDER_SECRET_KEY[settings.provider];
  if (!(await getSecret(secretKey))) {
    return t("trigger.secretMissing", {
      provider: settings.provider,
      key: secretKey,
    });
  }
  return null;
}
