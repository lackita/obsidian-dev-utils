import {
  App,
  Notice,
  TFile,
  TFolder,
  type ListedFiles
} from "obsidian";
import {
  deepEqual,
  toJson
} from "../Object.ts";
import {
  retryWithTimeout,
  type MaybePromise,
  type RetryOptions
} from "../Async.ts";
import { getBacklinksForFileSafe } from "./MetadataCache.ts";
import { printError } from "../Error.ts";

export type FileChange = {
  startIndex: number;
  endIndex: number;
  oldContent: string;
  newContent: string;
};

export function getMarkdownFilesSorted(app: App): TFile[] {
  return app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path));
}

export async function processWithRetry(app: App, file: TFile, processFn: (content: string) => MaybePromise<string | null>, retryOptions: Partial<RetryOptions> = {}): Promise<void> {
  const DEFAULT_RETRY_OPTIONS: Partial<RetryOptions> = { timeoutInMilliseconds: 60000 };
  const overriddenOptions: Partial<RetryOptions> = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };
  await retryWithTimeout(async () => {
    const oldContent = await app.vault.adapter.read(file.path);
    const newContent = await processFn(oldContent);
    if (newContent === null) {
      return false;
    }
    let success = true;
    await app.vault.process(file, (content) => {
      if (content !== oldContent) {
        console.warn(`Content of ${file.path} has changed since it was read. Retrying...`);
        success = false;
        return content;
      }

      return newContent;
    });

    return success;
  }, overriddenOptions);
}

export async function applyFileChanges(app: App, file: TFile, changesFn: () => MaybePromise<FileChange[]>, retryOptions: Partial<RetryOptions> = {}): Promise<void> {
  const DEFAULT_RETRY_OPTIONS: Partial<RetryOptions> = { timeoutInMilliseconds: 60000 };
  const overriddenOptions: Partial<RetryOptions> = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };
  await processWithRetry(app, file, async (content) => {
    let changes = await changesFn();

    for (const change of changes) {
      const actualContent = content.slice(change.startIndex, change.endIndex);
      if (actualContent !== change.oldContent) {
        console.warn(`Content mismatch at ${change.startIndex}-${change.endIndex} in ${file.path}:\nExpected: ${change.oldContent}\nActual: ${actualContent}`);
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
      const change = changes[i]!;
      const previousChange = changes[i - 1]!;
      if (previousChange.endIndex > change.startIndex) {
        console.warn(`Overlapping changes:\n${toJson(previousChange)}\n${toJson(change)}`);
        return null;
      }
    }

    let newContent = "";
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

export async function removeFolderSafe(app: App, folderPath: string, removedNotePath?: string): Promise<boolean> {
  const folder = app.vault.getFolderByPath(folderPath);

  if (!folder) {
    return false;
  }

  let canRemove = true;

  for (const child of folder.children) {
    if (child instanceof TFile) {
      const backlinks = await getBacklinksForFileSafe(app, child);
      if (removedNotePath) {
        backlinks.removeKey(removedNotePath);
      }
      if (backlinks.count() !== 0) {
        new Notice(`Attachment ${child.path} is still used by other notes. It will not be deleted.`);
        canRemove = false;
      } else {
        try {
          await app.vault.delete(child);
        } catch (e) {
          if (await app.vault.adapter.exists(child.path)) {
            printError(new Error(`Failed to delete ${child.path}`, { cause: e }));
            canRemove = false;
          }
        }
      }
    } else if (child instanceof TFolder) {
      canRemove &&= await removeFolderSafe(app, child.path, removedNotePath);
    }
  }

  if (canRemove) {
    try {
      await app.vault.delete(folder, true);
    } catch (e) {
      if (await app.vault.adapter.exists(folder.path)) {
        printError(new Error(`Failed to delete ${folder.path}`, { cause: e }));
        canRemove = false;
      }
    }
  }

  return canRemove;
}

export async function createFolderSafe(app: App, path: string): Promise<void> {
  if (await app.vault.adapter.exists(path)) {
    return;
  }

  try {
    await app.vault.adapter.mkdir(path);
  } catch (e) {
    if (!await app.vault.adapter.exists(path)) {
      throw e;
    }
  }
}

export async function safeList(app: App, path: string): Promise<ListedFiles> {
  const EMPTY = { files: [], folders: [] };
  if (!(await app.vault.exists(path))) {
    return EMPTY;
  }

  try {
    return await app.vault.adapter.list(path);
  } catch (e) {
    if (await app.vault.adapter.exists(path)) {
      throw e;
    }
    return EMPTY;
  }
}

export async function removeEmptyFolderHierarchy(app: App, folder: TFolder | null): Promise<void> {
  while (folder) {
    if (folder.children.length > 0) {
      return;
    }
    await removeFolderSafe(app, folder.path);
    folder = folder.parent;
  }
}
