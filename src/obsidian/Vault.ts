/**
 * @packageDocumentation Vault
 * This module provides utility functions for working with the Obsidian Vault.
 */

import type { ListedFiles } from 'obsidian';
import {
  App,
  Notice,
  TFile,
  TFolder
} from 'obsidian';

import type { RetryOptions } from '../Async.ts';
import { retryWithTimeout } from '../Async.ts';
import {
  printError,
  throwExpression
} from '../Error.ts';
import { deepEqual } from '../Object.ts';
import { dirname } from '../Path.ts';
import type { ValueProvider } from '../ValueProvider.ts';
import { resolveValue } from '../ValueProvider.ts';
import { getBacklinksForFileSafe } from './MetadataCache.ts';
import type { PathOrAbstractFile } from './TAbstractFile.ts';
import {
  getAbstractFileOrNull,
  getPath
} from './TAbstractFile.ts';
import type { PathOrFile } from './TFile.ts';
import { getFile } from './TFile.ts';
import type { PathOrFolder } from './TFolder.ts';
import { getFolderOrNull } from './TFolder.ts';

/**
 * Represents a file change in the Vault.
 */
export interface FileChange {
  /**
   * The start index of the change in the file content.
   */
  startIndex: number;

  /**
   * The end index of the change in the file content.
   */
  endIndex: number;

  /**
   * The old content that will be replaced.
   */
  oldContent: string;

  /**
   * The new content to replace the old content.
   */
  newContent: string;
}

/**
 * Retrieves an array of Markdown files from the app's vault and sorts them alphabetically by their file path.
 *
 * @param app - The Obsidian app instance.
 * @returns An array of Markdown files sorted by file path.
 */
export function getMarkdownFilesSorted(app: App): TFile[] {
  return app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Processes a file with retry logic, updating its content based on a provided value or function.
 *
 * @param app - The application instance, typically used for accessing the vault.
 * @param pathOrFile - The path or file to be processed. It can be a string representing the path or a file object.
 * @param newContentProvider - A value provider that returns the new content based on the old content of the file.
 * It can be a string or a function that takes the old content as an argument and returns the new content.
 * If function is provided, it should return `null` if the process should be retried.
 * @param retryOptions - Optional. Configuration options for retrying the process. If not provided, default options will be used.
 *
 * @returns A promise that resolves once the process is complete.
 *
 * @throws Will throw an error if the process fails after the specified number of retries or timeout.
 */
export async function processWithRetry(app: App, pathOrFile: PathOrFile, newContentProvider: ValueProvider<string | null, [string]>, retryOptions: Partial<RetryOptions> = {}): Promise<void> {
  const file = getFile(app, pathOrFile);
  const DEFAULT_RETRY_OPTIONS: Partial<RetryOptions> = { timeoutInMilliseconds: 60000 };
  const overriddenOptions: Partial<RetryOptions> = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };
  await retryWithTimeout(async () => {
    const oldContent = await app.vault.read(file);
    const newContent = await resolveValue(newContentProvider, oldContent);
    if (newContent === null) {
      return false;
    }
    let success = true;
    await app.vault.process(file, (content) => {
      if (content !== oldContent) {
        console.warn('Content has changed since it was read. Retrying...', {
          path: file.path,
          expectedContent: oldContent,
          actualContent: content
        });
        success = false;
        return content;
      }

      return newContent;
    });

    return success;
  }, overriddenOptions);
}

/**
 * Applies a series of file changes to the specified file or path within the application.
 *
 * @param app - The application instance where the file changes will be applied.
 * @param pathOrFile - The path or file to which the changes should be applied.
 * @param changesProvider - A provider that returns an array of file changes to apply.
 * @param retryOptions - Optional settings that determine how the operation should retry on failure.
 *
 * @returns A promise that resolves when the file changes have been successfully applied.
 */
export async function applyFileChanges(app: App, pathOrFile: PathOrFile, changesProvider: ValueProvider<FileChange[]>, retryOptions: Partial<RetryOptions> = {}): Promise<void> {
  const DEFAULT_RETRY_OPTIONS: Partial<RetryOptions> = { timeoutInMilliseconds: 60000 };
  const overriddenOptions: Partial<RetryOptions> = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };
  await processWithRetry(app, pathOrFile, async (content) => {
    let changes = await resolveValue(changesProvider);

    for (const change of changes) {
      const actualContent = content.slice(change.startIndex, change.endIndex);
      if (actualContent !== change.oldContent) {
        console.warn('Content mismatch', {
          startIndex: change.startIndex,
          endIndex: change.endIndex,
          path: getPath(pathOrFile),
          expectedContent: change.oldContent,
          actualContent
        });

        return null;
      }
    }

    changes.sort((a, b) => a.startIndex - b.startIndex);

    // BUG: https://forum.obsidian.md/t/bug-duplicated-links-in-metadatacache-inside-footnotes/85551
    changes = changes.filter((change, index) => {
      if (index === 0) {
        return true;
      }
      return !deepEqual(change, changes[index - 1]);
    });

    for (let i = 1; i < changes.length; i++) {
      const change = changes[i] ?? throwExpression(new Error('Change not found'));
      const previousChange = changes[i - 1] ?? throwExpression(new Error('Previous change not found'));
      if (previousChange.endIndex > change.startIndex) {
        console.warn('Overlapping changes', {
          previousChange,
          change
        });
        return null;
      }
    }

    let newContent = '';
    let lastIndex = 0;

    for (const change of changes) {
      newContent += content.slice(lastIndex, change.startIndex);
      newContent += change.newContent;
      lastIndex = change.endIndex;
    }

    newContent += content.slice(lastIndex);
    return newContent;
  }, overriddenOptions);
}

/**
 * Deletes abstract file safely from the vault.
 *
 * @param app - The Obsidian application instance.
 * @param pathOrFile - The path or abstract file to delete.
 * @param deletedNotePath - Optional. The path of the note that triggered the removal.
 * @param shouldReportUsedAttachments - Optional. If `true`, a notice will be shown for each attachment that is still used by other notes.
 * @param shouldDeleteEmptyFolders - Optional. If `true`, empty folders will be deleted.
 * @returns A promise that resolves to a boolean indicating whether the removal was successful.
 */
export async function deleteSafe(app: App, pathOrFile: PathOrAbstractFile, deletedNotePath?: string, shouldReportUsedAttachments?: boolean, shouldDeleteEmptyFolders?: boolean): Promise<boolean> {
  const file = getAbstractFileOrNull(app, pathOrFile);

  if (!file) {
    return false;
  }

  let canDelete = file instanceof TFile || (shouldDeleteEmptyFolders ?? true);

  if (file instanceof TFile) {
    const backlinks = await getBacklinksForFileSafe(app, file);
    if (deletedNotePath) {
      backlinks.removeKey(deletedNotePath);
    }
    if (backlinks.count() !== 0) {
      if (shouldReportUsedAttachments) {
        new Notice(`Attachment ${file.path} is still used by other notes. It will not be deleted.`);
      }
      canDelete = false;
    }
  } else if (file instanceof TFolder) {
    for (const child of file.children) {
      canDelete &&= await deleteSafe(app, child.path, deletedNotePath, shouldReportUsedAttachments);
    }

    canDelete &&= await isEmptyFolder(app, file);
  }

  if (canDelete) {
    try {
      await app.fileManager.trashFile(file);
    } catch (e) {
      if (await app.vault.exists(file.path)) {
        printError(new Error(`Failed to delete ${file.path}`, { cause: e }));
        canDelete = false;
      }
    }
  }

  return canDelete;
}

/**
 * Creates a folder safely in the specified path.
 *
 * @param app - The application instance.
 * @param path - The path of the folder to create.
 * @returns A promise that resolves to a boolean indicating whether the folder was created.
 * @throws If an error occurs while creating the folder and it still doesn't exist.
 */
export async function createFolderSafe(app: App, path: string): Promise<boolean> {
  if (await app.vault.adapter.exists(path)) {
    return false;
  }

  try {
    await app.vault.createFolder(path);
    return true;
  } catch (e) {
    if (!await app.vault.exists(path)) {
      throw e;
    }

    return true;
  }
}

/**
 * Safely lists the files and folders at the specified path in the vault.
 *
 * @param app - The Obsidian application instance.
 * @param path - The path to list files and folders from.
 * @returns A promise that resolves to a `ListedFiles` object containing the listed files and folders.
 */
export async function safeList(app: App, path: string): Promise<ListedFiles> {
  const EMPTY = { files: [], folders: [] };
  if (!(await app.vault.exists(path))) {
    return EMPTY;
  }

  try {
    return await app.vault.adapter.list(path);
  } catch (e) {
    if (await app.vault.exists(path)) {
      throw e;
    }
    return EMPTY;
  }
}

/**
 * Removes empty folder hierarchy starting from the given folder.
 *
 * @param app - The application instance.
 * @param pathOrFolder - The folder to start removing empty hierarchy from.
 * @returns A promise that resolves when the empty hierarchy is deleted.
 */
export async function deleteEmptyFolderHierarchy(app: App, pathOrFolder: PathOrFolder | null): Promise<void> {
  let folder = getFolderOrNull(app, pathOrFolder);

  while (folder) {
    if (!await isEmptyFolder(app, folder)) {
      return;
    }
    const parent = folder.parent;
    await deleteSafe(app, folder.path);
    folder = parent;
  }
}

/**
 * Creates a temporary file in the vault with parent folders if needed.
 * @param app - The application instance.
 * @param path - The path of the file to create.
 * @returns A promise that resolves to a function that can be called to delete the temporary file and all its created parents.
 */
export async function createTempFile(app: App, path: string): Promise<() => Promise<void>> {
  let file = app.vault.getFileByPath(path);
  if (file) {
    return async () => {
      // Do nothing
    };
  }

  const folderCleanup = await createTempFolder(app, dirname(path));

  try {
    await app.vault.create(path, '');
  } catch (e) {
    if (!await app.vault.exists(path)) {
      throw e;
    }
  }

  file = app.vault.getFileByPath(path) ?? throwExpression(new Error('File not found'));

  return async () => {
    if (!file.deleted) {
      await app.fileManager.trashFile(file);
    }
    await folderCleanup();
  };
}

/**
 * Creates a temporary folder in the vault with parent folders if needed.
 * @param app - The application instance.
 * @param path - The path of the folder to create.
 * @returns A promise that resolves to a function that can be called to delete the temporary folder and all its created parents.
 */
export async function createTempFolder(app: App, path: string): Promise<() => Promise<void>> {
  let folder = app.vault.getFolderByPath(path);
  if (folder) {
    return async () => {
      // Do nothing
    };
  }

  const dirPath = dirname(path);
  await createTempFolder(app, dirPath);

  const folderCleanup = await createTempFolder(app, dirname(path));

  await createFolderSafe(app, path);

  folder = app.vault.getFolderByPath(path) ?? throwExpression(new Error('Folder not found'));

  return async () => {
    if (!folder.deleted) {
      await app.fileManager.trashFile(folder);
    }
    await folderCleanup();
  };
}

/**
 * Checks if a folder is empty.
 * @param app - The application instance.
 * @param pathOrFolder - The path or folder to check.
 * @returns A promise that resolves to a boolean indicating whether the folder is empty.
 */
export async function isEmptyFolder(app: App, pathOrFolder: PathOrFolder): Promise<boolean> {
  const listedFiles = await safeList(app, getPath(pathOrFolder));
  return listedFiles.files.length === 0 && listedFiles.folders.length === 0;
}
