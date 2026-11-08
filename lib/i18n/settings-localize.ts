import type { SettingsField, SettingsTab } from "../settings-api";
import type { Locale } from "./types";

export interface SettingsTextTranslation {
  label: string;
  description?: string;
}

export interface SettingsFieldTranslation extends SettingsTextTranslation {
  options?: Record<string, SettingsTextTranslation>;
}

/** SDK paths and group names remain stable identities; only display text changes. */
export interface SettingsLocale {
  tabs: Record<string, string>;
  groups: Record<string, string>;
  fields: Record<string, SettingsFieldTranslation>;
}

export async function loadSettingsLocale(locale: Locale): Promise<SettingsLocale | null> {
  if (locale === "en") return null;
  // Keep the Chinese dictionary in its own browser chunk; English never downloads it.
  return (await import("./settings/zh-CN.json")).default;
}

export function localizeField(field: SettingsField, dict: SettingsLocale | null): SettingsField {
  const translation = dict?.fields[field.path];
  if (!translation) return field;
  return {
    ...field,
    label: translation.label ?? field.label,
    description: translation.description ?? field.description,
    options: field.options?.map((option) => {
      const text = translation.options?.[option.value];
      return text ? { ...option, label: text.label ?? option.label, description: text.description ?? option.description } : option;
    }),
  };
}

export function localizeTab(tab: SettingsTab, dict: SettingsLocale | null): SettingsTab {
  const label = dict?.tabs[tab.id];
  return label === undefined ? tab : { ...tab, label };
}

export function localizeGroup(group: string, dict: SettingsLocale | null): string {
  return dict?.groups[group] ?? group;
}
