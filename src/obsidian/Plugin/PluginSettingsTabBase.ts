/**
 * @packageDocumentation PluginSettingsTabBase
 * This module defines a base class for creating plugin setting tabs in Obsidian.
 * It provides a utility method to bind value components to plugin settings and handle changes.
 */

import { PluginSettingTab } from 'obsidian';

import type { PluginSettingsBase } from './PluginSettingsBase.ts';

import { PluginBase } from './PluginBase.ts';

/**
 * Type representing the constructor for plugin settings tabs.
 *
 * @typeParam Plugin - The type of the plugin that extends PluginBase.
 * @typeParam PluginSettings - The type of the plugin settings.
 * @typeParam PluginSettingsTab - The type of the plugin settings tab.
 */
export type PluginSettingsTabConstructor<
  Plugin extends PluginBase<PluginSettings>,
  PluginSettings extends PluginSettingsBase,
  PluginSettingsTab extends PluginSettingsTabBase<Plugin, PluginSettings>
> = new (plugin: Plugin) => PluginSettingsTab;

/**
 * Base class for creating plugin settings tabs in Obsidian.
 * Provides a method for binding value components to plugin settings and handling changes.
 *
 * @typeParam TPlugin - The type of the plugin that extends PluginBase.
 * @typeParam PluginSettings - The type of the plugin settings object.
 */
export abstract class PluginSettingsTabBase<
  TPlugin extends PluginBase<PluginSettings>,
  PluginSettings extends PluginSettingsBase = TPlugin extends PluginBase<infer P> ? P : never
> extends PluginSettingTab {
  public constructor(public override plugin: TPlugin) {
    super(plugin.app, plugin);
  }
}
