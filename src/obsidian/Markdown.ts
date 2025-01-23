/**
 * @packageDocumentation Markdown
 * This module provides utility functions for processing Markdown content in Obsidian.
 */

import type { EmbeddableConstructor } from 'obsidian-typings';

import { around } from 'monkey-around';
import {
  App,
  Component,
  MarkdownRenderer
} from 'obsidian';

/**
 * Render the markdown and embeds.
 *
 * @param app - The Obsidian app instance.
 * @param markdown - The Markdown string to render.
 * @param el - The HTMLElement to render to.
 * @param sourcePath - The source path to resolve relative links.
 * @param component - The Component instance.
 */
export async function fullRender(app: App, markdown: string, el: HTMLElement, sourcePath: string, component: Component): Promise<void> {
  const uninstall = around(app.embedRegistry.embedByExtension, {
    md: (next: EmbeddableConstructor): EmbeddableConstructor => (context, file, path) => {
      context.displayMode = false;
      return next(context, file, path);
    }
  });

  try {
    await MarkdownRenderer.render(app, markdown, el, sourcePath, component);
  } finally {
    uninstall();
  }
}

/**
 * Converts Markdown to HTML.
 *
 * @param app - The Obsidian app instance.
 * @param markdown - The Markdown string to convert.
 * @param sourcePath - (optional) The source path to resolve relative links.
 * @returns The HTML string.
 */
export async function markdownToHtml(app: App, markdown: string, sourcePath?: string): Promise<string> {
  const component = new Component();
  component.load();
  const renderDiv = createDiv();
  await MarkdownRenderer.render(app, markdown, renderDiv, sourcePath ?? '', component);
  const html = renderDiv.innerHTML;
  component.unload();
  return html;
}
