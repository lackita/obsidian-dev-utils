/**
 * @packageDocumentation Link
 * This module provides utilities for handling and updating links within Obsidian vaults. It includes
 * functions to split paths, update links in files, and generate markdown links with various options.
 * The functions integrate with Obsidian's API to ensure that links are managed correctly within the vault.
 **/

import type {
  Link,
  Text
} from 'mdast';
import type {
  App,
  Reference,
  TFile
} from 'obsidian';

import {
  normalizePath,
  parseLinktext
} from 'obsidian';
import { remark } from 'remark';
import remarkParse from 'remark-parse';
import { wikiLinkPlugin } from 'remark-wiki-link';

import type { MaybePromise } from '../Async.ts';
import type { FileChange } from './FileChange.ts';
import type { PathOrFile } from './FileSystem.ts';
import type { ProcessOptions } from './Vault.ts';

import {
  normalizeOptionalProperties,
  toJson
} from '../Object.ts';
import {
  basename,
  dirname,
  extname,
  join,
  relative
} from '../Path.ts';
import {
  normalize,
  trimStart
} from '../String.ts';
import { isUrl } from '../url.ts';
import { applyFileChanges } from './FileChange.ts';
import {
  getFile,
  getPath,
  isCanvasFile,
  isMarkdownFile,
  trimMarkdownExtension
} from './FileSystem.ts';
import {
  getAllLinks,
  getBacklinksForFileSafe,
  getCacheSafe,
  tempRegisterFileAndRun
} from './MetadataCache.ts';
import {
  shouldUseRelativeLinks,
  shouldUseWikilinks
} from './ObsidianSettings.ts';
import { referenceToFileChange } from './Reference.ts';

/**
 * Regular expression for special link symbols.
 */
// eslint-disable-next-line no-control-regex
const SPECIAL_LINK_SYMBOLS_REGEXP = /[\\\x00\x08\x0B\x0C\x0E-\x1F ]/g;

/**
 * Regular expression for special markdown link symbols.
 */
const SPECIAL_MARKDOWN_LINK_SYMBOLS_REGEX = /[\\[\]<>_*~=`$]/g;

/**
 * Options for converting a link.
 */
export interface ConvertLinkOptions {
  /**
   * The Obsidian app instance.
   */
  app: App;

  /**
   * The reference for the link.
   */
  link: Reference;

  /**
   * The source file containing the link.
   */
  newSourcePathOrFile: PathOrFile;

  /**
   * The old path of the link.
   */
  oldSourcePathOrFile?: PathOrFile;

  /**
   * Whether to force markdown links.
   */
  shouldForceMarkdownLinks?: boolean;

  /**
   * Whether to update filename alias. Defaults to `true`.
   */
  shouldUpdateFilenameAlias?: boolean;
}

/**
 * Wrapper for default options for generating markdown links.
 */
export interface GenerateMarkdownLinkDefaultOptionsWrapper {
  /**
   * The default options for generating markdown links.
   */
  defaultOptionsFn: () => Partial<GenerateMarkdownLinkOptions>;
}

/**
 * Options for generating a markdown link.
 */
export interface GenerateMarkdownLinkOptions {
  /**
   * The alias for the link.
   */
  alias?: string;

  /**
   * The Obsidian app instance.
   */
  app: App;

  /**
   * Indicates if the link should be embedded. If not provided, it will be inferred based on the file type.
   */
  isEmbed?: boolean;

  /**
   * Whether to allow an empty alias for embeds. Defaults to `true`.
   */
  isEmptyEmbedAliasAllowed?: boolean;

  /**
   * Whether to allow non-existing files. If `false` and `pathOrFile` is a non-existing file, an error will be thrown. Defaults to `false`.
   */
  isNonExistingFileAllowed?: boolean;

  /**
   * Indicates if the link should be a wikilink. If not provided, it will be inferred based on the Obsidian settings.
   */
  isWikilink?: boolean;

  /**
    * The original link text. If provided, it will be used to infer the values of `isEmbed`, `isWikilink`, `useLeadingDot`, and `useAngleBrackets`.
    * These inferred values will be overridden by corresponding settings if specified.
    */
  originalLink?: string;

  /**
   * Indicates if the link should be relative. If not provided or `false`, it will be inferred based on the Obsidian settings.
   */
  shouldForceRelativePath?: boolean;

  /**
   * Whether to include the attachment extension in the embed alias. Has no effect if `allowEmptyEmbedAlias` is `true`. Defaults to `false`.
   */
  shouldIncludeAttachmentExtensionToEmbedAlias?: boolean;

  /**
   * Indicates if the link should use angle brackets. Defaults to `false`. Has no effect if `isWikilink` is `true`
   */
  shouldUseAngleBrackets?: boolean;

  /**
   * Indicates if the link should use a leading dot. Defaults to `false`. Has no effect if `isWikilink` is `true` or `isRelative` is `false`.
   */
  shouldUseLeadingDot?: boolean;

  /**
   * The source path of the link.
   */
  sourcePathOrFile: PathOrFile;

  /**
   * The subpath of the link.
   */
  subpath?: string;

  /**
   * The target path or file.
   */
  targetPathOrFile: PathOrFile;
}

/**
 * The result of parsing a link.
 */
export interface ParseLinkResult {
  /**
   * The alias of the link.
   */
  alias?: string;

  /**
   * Indicates if the link has angle brackets.
   */
  hasAngleBrackets?: boolean;

  /**
   * Indicates if the link is an embed link.
   */
  isEmbed: boolean;

  /**
   * Indicates if the link is external.
   */
  isExternal?: boolean;

  /**
   * Indicates if the link is a wikilink.
   */
  isWikilink: boolean;

  /**
   * The title of the link.
   */
  title?: string;

  /**
   * The URL of the link.
   */
  url: string;
}

/**
 * Options for determining if the alias of a link should be reset.
 */
export interface ShouldResetAliasOptions {
  /**
   * The Obsidian app instance.
   */
  app: App;

  /**
   * The display text of the link.
   */
  displayText: string | undefined;

  /**
   * Indicates if the link is a wikilink.
   */
  isWikilink?: boolean;

  /**
   * The source path of the link.
   */
  newSourcePathOrFile: PathOrFile;

  /**
   * The old source file containing the link.
   */
  oldSourcePathOrFile?: PathOrFile;

  /**
   * The old target path of the link.
   */
  oldTargetPath: PathOrFile;

  /**
   * The target path or file.
   */
  targetPathOrFile: PathOrFile;
}

/**
 * Splits a link into its link path and subpath.
 */
export interface SplitSubpathResult {
  /**
   * The link path.
   */
  linkPath: string;

  /**
   * The subpath.
   */
  subpath: string;
}

/**
 * Options for updating a link.
 */
export interface UpdateLinkOptions {
  /**
   * The Obsidian app instance.
   */
  app: App;

  /**
   * The reference for the link.
   */
  link: Reference;

  /**
   * The source file containing the link.
   */
  newSourcePathOrFile: PathOrFile;

  /**
   * The file associated with the link.
   */
  newTargetPathOrFile: PathOrFile;

  /**
   * The old source file containing the link.
   */
  oldSourcePathOrFile?: PathOrFile;

  /**
   * The old path of the file.
   */
  oldTargetPathOrFile?: PathOrFile;

  /**
   * Whether to force markdown links.
   */
  shouldForceMarkdownLinks?: boolean;

  /**
   * Whether to update filename alias. Defaults to `true`.
   */
  shouldUpdateFilenameAlias?: boolean;
}

/**
 * Options for updating links in a file.
 */
export interface UpdateLinksInFileOptions extends ProcessOptions {
  /**
   * The obsidian app instance.
   */
  app: App;

  /**
   * The file to update the links in.
   */
  newSourcePathOrFile: PathOrFile;

  /**
   * The old path of the file.
   */
  oldSourcePathOrFile?: PathOrFile;

  /**
   * Whether to force the links to be in Markdown format.
   */
  shouldForceMarkdownLinks?: boolean;

  /**
   * Whether to update only embedded links.
   */
  shouldUpdateEmbedOnlyLinks?: boolean;

  /**
   * Whether to update filename alias. Defaults to `true`.
   */
  shouldUpdateFilenameAlias?: boolean;
}

interface WikiLinkNode {
  data: {
    alias: string;
  };
  value: string;
}

/**
 * Converts a link to a new path.
 *
 * @param options - The options for converting the link.
 * @returns The converted link.
 */
export function convertLink(options: ConvertLinkOptions): string {
  const targetFile = extractLinkFile(options.app, options.link, options.oldSourcePathOrFile ?? options.newSourcePathOrFile);
  if (!targetFile) {
    return options.link.original;
  }

  return updateLink(normalizeOptionalProperties<UpdateLinkOptions>({
    app: options.app,
    link: options.link,
    newSourcePathOrFile: options.newSourcePathOrFile,
    newTargetPathOrFile: targetFile,
    oldSourcePathOrFile: options.oldSourcePathOrFile,
    shouldForceMarkdownLinks: options.shouldForceMarkdownLinks,
    shouldUpdateFilenameAlias: options.shouldUpdateFilenameAlias
  }));
}

/**
 * Edits the backlinks for a file or path.
 *
 * @param app - The Obsidian application instance.
 * @param pathOrFile - The path or file to edit the backlinks for.
 * @param linkConverter - The function that converts each link.
 * @param processOptions - Optional options for retrying the operation.
 * @returns A promise that resolves when the backlinks have been edited.
 */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
export async function editBacklinks(app: App, pathOrFile: PathOrFile, linkConverter: (link: Reference) => MaybePromise<string | void>, processOptions: ProcessOptions = {}): Promise<void> {
  const backlinks = await getBacklinksForFileSafe(app, pathOrFile, processOptions);
  for (const backlinkNotePath of backlinks.keys()) {
    const currentLinks = backlinks.get(backlinkNotePath) ?? [];
    const linkJsons = new Set<string>(currentLinks.map((link) => toJson(link)));
    await editLinks(app, backlinkNotePath, (link) => {
      const linkJson = toJson(link);
      if (!linkJsons.has(linkJson)) {
        return;
      }

      return linkConverter(link);
    }, processOptions);
  }
}

/**
 * Edits the links in the specified file or path using the provided link converter function.
 *
 * @param app - The Obsidian application instance.
 * @param pathOrFile - The path or file to edit the links in.
 * @param linkConverter - The function that converts each link.
 * @param processOptions - Optional options for processing/retrying the operation.
 * @returns A promise that resolves when the links have been edited.
 */
export async function editLinks(
  app: App,
  pathOrFile: PathOrFile,
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  linkConverter: (link: Reference) => MaybePromise<string | void>,
  processOptions: ProcessOptions = {}): Promise<void> {
  await applyFileChanges(app, pathOrFile, async () => {
    const cache = await getCacheSafe(app, pathOrFile);
    if (!cache) {
      return [];
    }

    const changes: FileChange[] = [];

    for (const link of getAllLinks(cache)) {
      const newContent = await linkConverter(link);
      if (newContent === undefined) {
        continue;
      }

      changes.push(referenceToFileChange(link, newContent));
    }

    return changes;
  }, processOptions);
}

/**
 * Extracts the file associated with a link.
 *
 * @param app - The Obsidian application instance.
 * @param link - The reference cache for the link.
 * @param sourcePathOrFile - The source path or file.
 * @returns The file associated with the link, or null if not found.
 */
export function extractLinkFile(app: App, link: Reference, sourcePathOrFile: PathOrFile): null | TFile {
  const { linkPath } = splitSubpath(link.link);
  return app.metadataCache.getFirstLinkpathDest(linkPath, getPath(app, sourcePathOrFile));
}

/**
 * Generates a markdown link based on the provided parameters.
 *
 * @param options - The options for generating the markdown link.
 * @returns The generated markdown link.
 */
export function generateMarkdownLink(options: GenerateMarkdownLinkOptions): string {
  const { app } = options;

  const configurableDefaultOptionsFn = (app.fileManager.generateMarkdownLink as Partial<GenerateMarkdownLinkDefaultOptionsWrapper>).defaultOptionsFn ?? ((): Partial<GenerateMarkdownLinkOptions> => ({}));
  const configurableDefaultOptions = configurableDefaultOptionsFn();

  const DEFAULT_OPTIONS: Partial<GenerateMarkdownLinkOptions> = {
    isEmptyEmbedAliasAllowed: true
  };

  options = { ...DEFAULT_OPTIONS, ...configurableDefaultOptions, ...options };

  const targetFile = getFile(app, options.targetPathOrFile, options.isNonExistingFileAllowed);

  return tempRegisterFileAndRun(app, targetFile, () => {
    const sourcePath = getPath(app, options.sourcePathOrFile);
    const subpath = options.subpath ?? '';
    let alias = options.alias ?? '';
    const isEmbed = options.isEmbed ?? (options.originalLink ? testEmbed(options.originalLink) : undefined) ?? !isMarkdownFile(app, targetFile);
    const isWikilink = options.isWikilink ?? (options.originalLink ? testWikilink(options.originalLink) : undefined) ?? shouldUseWikilinks(app);
    const shouldForceRelativePath = options.shouldForceRelativePath ?? shouldUseRelativeLinks(app);
    const shouldUseLeadingDot = options.shouldUseLeadingDot ?? (options.originalLink ? testLeadingDot(options.originalLink) : undefined) ?? false;
    const shouldUseAngleBrackets = options.shouldUseAngleBrackets ?? (options.originalLink ? testAngleBrackets(options.originalLink) : undefined) ?? false;

    let linkText = targetFile.path === sourcePath && subpath
      ? subpath
      : shouldForceRelativePath
        ? relative(dirname(sourcePath), isWikilink ? trimMarkdownExtension(app, targetFile) : targetFile.path) + subpath
        : app.metadataCache.fileToLinktext(targetFile, sourcePath, isWikilink) + subpath;

    if (shouldForceRelativePath && shouldUseLeadingDot && !linkText.startsWith('.') && !linkText.startsWith('#')) {
      linkText = './' + linkText;
    }

    const embedPrefix = isEmbed ? '!' : '';

    if (!isWikilink) {
      if (shouldUseAngleBrackets) {
        linkText = `<${linkText}>`;
      } else {
        linkText = linkText.replace(SPECIAL_LINK_SYMBOLS_REGEXP, function (specialLinkSymbol) {
          return encodeURIComponent(specialLinkSymbol);
        });
      }

      if (!alias && (!isEmbed || !options.isEmptyEmbedAliasAllowed)) {
        alias = !options.shouldIncludeAttachmentExtensionToEmbedAlias || isMarkdownFile(app, targetFile) ? targetFile.basename : targetFile.name;
      }

      alias = alias.replace(SPECIAL_MARKDOWN_LINK_SYMBOLS_REGEX, '\\$&');

      return `${embedPrefix}[${alias}](${linkText})`;
    } else {
      if (alias && alias.toLowerCase() === linkText.toLowerCase()) {
        linkText = alias;
        alias = '';
      }

      const aliasPart = alias ? `|${alias}` : '';
      return `${embedPrefix}[[${linkText}${aliasPart}]]`;
    }
  });
}

/**
 * Parses a link into its components.
 *
 * @param str - The link to parse.
 * @returns The parsed link.
 */
export function parseLink(str: string): null | ParseLinkResult {
  if (isUrl(str)) {
    return {
      isEmbed: false,
      isExternal: true,
      isWikilink: false,
      url: str
    };
  }

  const EMBED_PREFIX = '!';
  const OPEN_ANGLE_BRACKET = '<';
  const LINK_ALIAS_SUFFIX = '](';
  const LINK_SUFFIX = ')';
  const WIKILINK_DIVIDER = '|';

  const isEmbed = str.startsWith(EMBED_PREFIX);
  if (isEmbed) {
    str = trimStart(str, EMBED_PREFIX);
  }
  const processor = remark().use(remarkParse).use(wikiLinkPlugin, { aliasDivider: WIKILINK_DIVIDER });
  const root = processor.parse(str);

  if (root.children.length !== 1) {
    return null;
  }

  const paragraph = root.children[0];

  if (paragraph?.type !== 'paragraph') {
    return null;
  }

  if (paragraph.children.length !== 1) {
    return null;
  }

  const node = paragraph.children[0];

  if (node?.position?.start.offset !== 0) {
    return null;
  }

  if (node.position.end.offset !== str.length) {
    return null;
  }

  switch (node.type as string) {
    case 'link': {
      const linkNode = node as Link;
      const aliasNode = linkNode.children[0] as Text | undefined;
      const rawUrl = str.slice((aliasNode?.position?.end.offset ?? 1) + LINK_ALIAS_SUFFIX.length, (linkNode.position?.end.offset ?? 0) - LINK_SUFFIX.length);
      const hasAngleBrackets = str.startsWith(OPEN_ANGLE_BRACKET) || rawUrl.startsWith(OPEN_ANGLE_BRACKET);
      const isExternal = isUrl(linkNode.url);
      let url = linkNode.url;
      if (!isExternal) {
        if (!hasAngleBrackets) {
          try {
            url = decodeURIComponent(url);
          } catch (error) {
            console.error(`Failed to decode URL ${url}`, error);
          }
        }
      }
      return normalizeOptionalProperties<ParseLinkResult>({
        alias: aliasNode?.value,
        hasAngleBrackets,
        isEmbed,
        isExternal,
        isWikilink: false,
        title: linkNode.title ?? undefined,
        url
      });
    }
    case 'wikiLink': {
      const wikiLinkNode = node as unknown as WikiLinkNode;
      return normalizeOptionalProperties<ParseLinkResult>({
        alias: str.includes(WIKILINK_DIVIDER) ? wikiLinkNode.data.alias : undefined,
        isEmbed,
        isWikilink: true,
        url: wikiLinkNode.value
      });
    }
    default:
      return null;
  }
}

/**
 * Determines if the alias of a link should be reset.
 *
 * @param options - The options for determining if the alias should be reset.
 * @returns Whether the alias should be reset.
 */
export function shouldResetAlias(options: ShouldResetAliasOptions): boolean {
  const {
    app,
    displayText,
    isWikilink,
    newSourcePathOrFile,
    oldSourcePathOrFile,
    oldTargetPath,
    targetPathOrFile
  } = options;
  if (isWikilink === false) {
    return false;
  }

  if (!displayText) {
    return true;
  }

  const targetFile = getFile(app, targetPathOrFile, true);
  const newSourcePath = getPath(app, newSourcePathOrFile);
  const oldSourcePath = getPath(app, oldSourcePathOrFile ?? newSourcePathOrFile);
  const newSourceDir = dirname(newSourcePath);
  const oldSourceDir = dirname(oldSourcePath);
  const aliasesToReset = new Set<string>();

  for (const pathOrFile of [targetFile.path, oldTargetPath]) {
    if (!pathOrFile) {
      continue;
    }

    const path = getPath(app, pathOrFile);
    aliasesToReset.add(path);
    aliasesToReset.add(basename(path));
    aliasesToReset.add(relative(newSourceDir, path));
    aliasesToReset.add(relative(oldSourceDir, path));
  }

  for (const sourcePath of [oldSourcePath, newSourcePath]) {
    aliasesToReset.add(app.metadataCache.fileToLinktext(targetFile, sourcePath, false));
  }

  const cleanDisplayText = normalizePath(displayText.split(' > ')[0] ?? '').replace(/^\.\//, '').toLowerCase();

  for (const alias of aliasesToReset) {
    if (alias.toLowerCase() === cleanDisplayText) {
      return true;
    }

    const dir = dirname(alias);
    const base = basename(alias, extname(alias));
    if (join(dir, base).toLowerCase() === cleanDisplayText) {
      return true;
    }
  }

  return false;
}

/**
 * Splits a link into its link path and subpath.
 *
 * @param link - The link to split.
 * @returns An object containing the link path and subpath.
 */
export function splitSubpath(link: string): SplitSubpathResult {
  const parsed = parseLinktext(normalize(link));
  return {
    linkPath: parsed.path,
    subpath: parsed.subpath
  };
}

/**
 * Tests whether a link uses angle brackets, possibly embed:
 * `[title](<link>)`, `![title](<link>)`.
 *
 * @param link - Link to test
 * @returns Whether the link uses angle brackets
 */
export function testAngleBrackets(link: string): boolean {
  const parseLinkResult = parseLink(link);
  return parseLinkResult?.hasAngleBrackets ?? false;
}

/**
 * Tests whether a link is an embed link:
 * `![[link]]`, `![title](link)`.
 *
 * @param link - Link to test
 * @returns Whether the link is an embed link
 */
export function testEmbed(link: string): boolean {
  const parseLinkResult = parseLink(link);
  return parseLinkResult?.isEmbed ?? false;
}

/**
 * Tests whether a link has a leading dot, possibly embed:
 * `[[./link]]`, `[title](./link)`, `[title](<./link>)`,
 * `![[./link]]`, `![title](./link)`, `![title](<./link>)`.
 *
 * @param link - Link to test
 * @returns Whether the link has a leading dot
 */
export function testLeadingDot(link: string): boolean {
  const parseLinkResult = parseLink(link);
  return parseLinkResult?.url.startsWith('./') ?? false;
}

/**
 * Tests whether a link is a wikilink, possibly embed:
 * `[[link]]`, `![[link]]`.
 *
 * @param link - Link to test
 * @returns Whether the link is a wikilink
 */
export function testWikilink(link: string): boolean {
  const parseLinkResult = parseLink(link);
  return parseLinkResult?.isWikilink ?? false;
}

/**
 * Updates a link based on the provided parameters.
 *
 * @param options - The options for updating the link.
 * @returns The updated link.
 */
export function updateLink(options: UpdateLinkOptions): string {
  const {
    app,
    link,
    newSourcePathOrFile: newSourcePathOrFile,
    newTargetPathOrFile,
    oldSourcePathOrFile,
    oldTargetPathOrFile,
    shouldForceMarkdownLinks,
    shouldUpdateFilenameAlias
  } = options;
  if (!newTargetPathOrFile) {
    return link.original;
  }
  const targetFile = getFile(app, newTargetPathOrFile, true);
  const oldTargetPath = getPath(app, oldTargetPathOrFile ?? newTargetPathOrFile);
  const isWikilink = testWikilink(link.original) && shouldForceMarkdownLinks !== true;
  const { subpath } = splitSubpath(link.link);

  if (isCanvasFile(app, newSourcePathOrFile)) {
    return targetFile.path + subpath;
  }

  let alias = shouldResetAlias(normalizeOptionalProperties<ShouldResetAliasOptions>({
    app,
    displayText: link.displayText,
    isWikilink,
    newSourcePathOrFile,
    oldSourcePathOrFile,
    oldTargetPath,
    targetPathOrFile: targetFile
  }))
    ? undefined
    : link.displayText;

  if (shouldUpdateFilenameAlias ?? true) {
    if (alias === basename(oldTargetPath, extname(oldTargetPath))) {
      alias = targetFile.basename;
    } else if (alias === basename(oldTargetPath)) {
      alias = targetFile.name;
    }
  }

  const newLink = generateMarkdownLink(normalizeOptionalProperties<GenerateMarkdownLinkOptions>({
    alias,
    app,
    isWikilink: shouldForceMarkdownLinks ? false : undefined,
    originalLink: link.original,
    sourcePathOrFile: newSourcePathOrFile,
    subpath,
    targetPathOrFile: targetFile
  }));
  return newLink;
}

/**
 * Updates the links in a file based on the provided parameters.
 *
 * @param options - The options for updating the links.
 * @returns A promise that resolves when the links are updated.
 */
export async function updateLinksInFile(options: UpdateLinksInFileOptions): Promise<void> {
  const {
    app,
    newSourcePathOrFile,
    oldSourcePathOrFile,
    shouldForceMarkdownLinks,
    shouldUpdateEmbedOnlyLinks,
    shouldUpdateFilenameAlias
  } = options;

  if (isCanvasFile(app, newSourcePathOrFile) && !app.internalPlugins.getEnabledPluginById('canvas')) {
    return;
  }

  await editLinks(app, newSourcePathOrFile, (link) => {
    const isEmbedLink = testEmbed(link.original);
    if (shouldUpdateEmbedOnlyLinks !== undefined && shouldUpdateEmbedOnlyLinks !== isEmbedLink) {
      return;
    }
    return convertLink(normalizeOptionalProperties<ConvertLinkOptions>({
      app,
      link,
      newSourcePathOrFile,
      oldSourcePathOrFile,
      shouldForceMarkdownLinks,
      shouldUpdateFilenameAlias
    }));
  }, options);
}
