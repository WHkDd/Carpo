import { invoke } from "@tauri-apps/api/core";
import type { NonSecretSettings, SecretKey } from "./ipc-types";

/**
 * Typed wrappers around invoke<>(). One thin function per command keeps the
 * tauri::command surface explicit — when a backend signature changes, TypeScript
 * compilation breaks loudly here rather than at every call site.
 */

export async function ping(): Promise<string> {
  return invoke<string>("ping");
}

export async function getSettings(): Promise<NonSecretSettings> {
  return invoke<NonSecretSettings>("get_settings");
}

export async function setSettings(s: NonSecretSettings): Promise<void> {
  return invoke("set_settings", { s });
}

export async function getSecret(key: SecretKey): Promise<boolean> {
  return invoke<boolean>("get_secret", { key });
}

export async function setSecret(key: SecretKey, value: string): Promise<void> {
  return invoke("set_secret", { key, value });
}

export async function deleteSecret(key: SecretKey): Promise<void> {
  return invoke("delete_secret", { key });
}
