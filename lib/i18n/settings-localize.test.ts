import assert from "node:assert/strict";
import { test } from "node:test";
import { orderedSettings } from "@oh-my-pi/pi-coding-agent/config/all-settings";
import { SETTING_TABS } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import type { SettingsField, SettingsTab } from "../settings-api";
import { loadSettingsLocale, localizeField, localizeGroup, localizeTab, type SettingsLocale } from "./settings-localize";
import chineseSettings from "./settings/zh-CN.json";

const field: SettingsField = {
  path: "modelRoleStorage",
  tab: "model",
  group: "Prompt",
  label: "Model Role Storage",
  description: "Where model selector role assignments are saved",
  type: "select",
  value: "global",
  defaultValue: "global",
  configured: true,
  options: [
    { value: "global", label: "Global", description: "Save globally" },
    { value: "project", label: "Per-project", description: "Save per project" },
  ],
};
const tab: SettingsTab = { id: "model", label: "Model", groups: ["Prompt"] };
const dictionary: SettingsLocale = {
  tabs: { model: "模型" },
  groups: { Prompt: "提示词" },
  fields: {
    modelRoleStorage: {
      label: "模型角色存储",
      options: { global: { label: "全局" } },
    },
  },
};

test("missing dictionaries and field entries preserve the SDK text", () => {
  assert.equal(localizeField(field, null), field);
  assert.equal(localizeField(field, { tabs: {}, groups: {}, fields: {} }), field);
  const localized = localizeField(field, dictionary);
  assert.equal(localized.label, "模型角色存储");
  assert.equal(localized.description, field.description);
  assert.equal(localized.group, "Prompt");
  assert.equal(localized.path, field.path);
  assert.equal(field.label, "Model Role Storage");
});

test("option translations preserve values and untranslated option text", () => {
  const localized = localizeField(field, dictionary);
  assert.deepEqual(localized.options, [
    { value: "global", label: "全局", description: "Save globally" },
    { value: "project", label: "Per-project", description: "Save per project" },
  ]);
  const described: SettingsLocale = {
    ...dictionary,
    fields: { modelRoleStorage: { label: "模型角色存储", description: "保存模型角色分配的位置", options: { project: { label: "按项目", description: "保存到项目配置" } } } },
  };
  assert.equal(localizeField(field, described).description, "保存模型角色分配的位置");
  assert.deepEqual(localizeField(field, described).options?.[1], { value: "project", label: "按项目", description: "保存到项目配置" });
  assert.equal(field.options?.[0].label, "Global");
});

test("tabs and groups translate display text while keeping group identities", () => {
  assert.deepEqual(localizeTab(tab, dictionary), { ...tab, label: "模型" });
  assert.equal(localizeTab(tab, dictionary).groups, tab.groups);
  assert.equal(localizeTab(tab, null), tab);
  assert.equal(localizeTab({ ...tab, id: "unknown" }, dictionary).label, "Model");
  assert.equal(localizeGroup("Prompt", dictionary), "提示词");
  assert.equal(localizeGroup("Unknown", dictionary), "Unknown");
  assert.equal(localizeGroup("Prompt", null), "Prompt");
});

test("locale loading keeps English canonical and loads the real Chinese dictionary", async () => {
  assert.equal(await loadSettingsLocale("en"), null);
  assert.deepEqual(await loadSettingsLocale("zh-CN"), chineseSettings);
});

test("the Chinese dictionary only names current SDK settings, options and tabs", () => {
  const settings = new Map(orderedSettings().map((setting) => [setting.id, setting]));
  const dictionary: SettingsLocale = chineseSettings;
  for (const [id, translation] of Object.entries(dictionary.fields)) {
    const setting = settings.get(id);
    assert.ok(setting, `Stale translated setting: ${id}`);
    for (const value of Object.keys(translation.options ?? {})) {
      const options = setting.ui?.options;
      assert.ok(Array.isArray(options) && options.some((option) => option.value === value), `Stale translated option: ${id}=${value}`);
    }
  }
  const tabs = new Set<string>(SETTING_TABS);
  for (const id of Object.keys(dictionary.tabs)) {
    assert.ok(tabs.has(id), `Stale translated tab: ${id}`);
  }
});
