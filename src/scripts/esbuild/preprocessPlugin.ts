/**
 * @packageDocumentation preprocessPlugin
 * This module defines a custom esbuild plugin that preprocesses JavaScript and TypeScript files.
 * The preprocessing includes replacing `import(dot)meta(dot)url` with a Node.js-compatible alternative,
 * ensuring compatibility with Obsidian's plugin system, and adding a basic `process` object for environments
 * where `process` is not available (like mobile or web environments).
 *
 * @remarks
 * We cannot use `.` instead of `(dot)` in the above description because the file itself is preprocessed with the same rule.
 */

import type { Plugin } from 'esbuild';

import {
  FunctionHandlingMode,
  toJson
} from '../../Object.ts';
import {
  makeValidVariableName,
  replaceAll
} from '../../String.ts';
import { readFile } from '../NodeModules.ts';

interface EsmModule {
  __esModule: boolean;
  default: unknown;
}

interface RequirePatched extends NodeJS.Require {
  __isPatched: boolean;
}

/**
 * Creates an esbuild plugin that preprocesses JavaScript and TypeScript files.
 *
 * This plugin performs the following tasks:
 * - Replaces instances of `import(dot)meta(dot)url` with a Node.js-compatible `__filename` alternative.
 * - Modifies the `sourceMappingURL` comment to ensure compatibility with Obsidian's plugin system.
 * - Adds a basic `process` object to the global scope if `process` is referenced but not defined.
 *
 * @returns An esbuild `Plugin` object that handles the preprocessing.
 */
export function preprocessPlugin(): Plugin {
  const replacements = {
    [replaceAll('import(dot)meta(dot)url', '(dot)', '.')]: (): string => {
      if (typeof __filename === 'string') {
        // eslint-disable-next-line import-x/no-nodejs-modules, @typescript-eslint/no-require-imports
        const url = require('node:url') as typeof import('node:url');
        return url.pathToFileURL(__filename).href;
      }

      if (typeof window !== 'undefined') {
        return window.location.href;
      }

      // Fallback to an empty string if the environment is unknown
      return '';
    }
  };

  return {
    name: 'preprocess',
    setup(build): void {
      build.initialOptions.define ??= {};

      for (const key of Object.keys(replacements)) {
        build.initialOptions.define[key] = `__${makeValidVariableName(key)}`;
      }

      build.initialOptions.banner ??= {};
      build.initialOptions.banner['js'] ??= '';
      build.initialOptions.banner['js'] += `\n(${init.toString()})()\n`;

      build.onLoad({ filter: /\.(?:js|ts|cjs|mjs|cts|mts)$/ }, async (args) => {
        let contents = await readFile(args.path, 'utf-8');

        for (const [key, value] of Object.entries(replacements)) {
          const variable = `__${makeValidVariableName(key)}`;
          if (!contents.includes(key)) {
            continue;
          }
          const valueStr = typeof value === 'function' ? `(${value.toString()})()` : toJson(value, { functionHandlingMode: FunctionHandlingMode.Full });
          if (contents.includes(`var ${variable}`)) {
            continue;
          }
          contents = `var ${variable} = globalThis['${key}'] ?? ${valueStr};\n${contents}`;
        }

        // HACK: The ${''} part is used to ensure Obsidian loads the plugin properly,
        // Otherwise, it stops loading after the first line of the sourceMappingURL comment.
        // eslint-disable-next-line no-template-curly-in-string
        contents = replaceAll(contents, /`\r?\n\/\/# sourceMappingURL/g, '`\n//#${\'\'} sourceMappingURL');

        return {
          contents,
          loader: 'ts'
        };
      });
    }
  };
}

function init(): void {
  const globalThisRecord = globalThis as unknown as Record<string, unknown>;
  globalThisRecord['__name'] ??= name;

  if (!(require as Partial<RequirePatched>).__isPatched) {
    const originalRequire = require;
    require = Object.assign(
      (id: string) => requirePatched(id, originalRequire),
      originalRequire,
      {
        __isPatched: true
      }
    ) as RequirePatched;
  }

  const newFuncs: Record<string, () => unknown> = {
    __extractDefault: () => extractDefault,
    process: () => ({
      browser: true,
      cwd: () => '/',
      env: {},
      platform: 'android'
    })
  };

  for (const key of Object.keys(newFuncs)) {
    globalThisRecord[key] ??= newFuncs[key]?.();
  }

  function name(obj: unknown): unknown {
    return obj;
  }

  function extractDefault(module: Partial<EsmModule> | undefined): unknown {
    return module && module.__esModule && module.default ? module.default : module;
  }

  function requirePatched(id: string, originalRequire: NodeJS.Require): unknown {
    const module = originalRequire(id) as (Partial<EsmModule> | undefined);
    if (module) {
      return extractDefault(module);
    }

    if (id === 'process' || id === 'node:process') {
      console.error(`Module not found: ${id}. Fake process object is returned instead.`);
      return globalThis.process;
    }

    console.error(`Module not found: ${id}. Empty object is returned instead.`);
    return {};
  }
}
