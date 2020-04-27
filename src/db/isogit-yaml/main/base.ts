import * as log from 'electron-log';
import * as fs from 'fs-extra';
import * as path from 'path';

import { listen } from '../../../ipc/main';
import { Setting, SettingManager } from '../../../settings/main';

import { Index } from '../../query';
import { UniqueConstraintError } from '../../errors';

import { FilesystemWrapper } from '../../main/fs-wrapper';

import {
  BackendClass as BaseBackendClass,
  BackendStatusReporter as BaseBackendStatusReporter,
  VersionedFilesystemBackend,
  ModelManager,
  FilesystemManager,
} from '../../main/base';

import { BackendDescription, BackendStatus } from '../base';

import { IsoGitWrapper } from './isogit';


interface FixedBackendOptions {
  /* Settings supplied by the developer */

  workDir: string
  corsProxyURL: string
  upstreamRepoURL?: string
  fsWrapperClass: () => Promise<{ default: new (baseDir: string) => FilesystemWrapper<any> }>
}
interface ConfigurableBackendOptions {
  /* Settings that user can or must specify */
  repoURL: string
  username: string
  authorName: string
  authorEmail: string
}
type BackendOptions = FixedBackendOptions & ConfigurableBackendOptions & {
  fsWrapper: FilesystemWrapper<any>
}
type InitialBackendOptions = FixedBackendOptions & Partial<ConfigurableBackendOptions>


type BackendStatusReporter = BaseBackendStatusReporter<BackendStatus>


class Backend extends VersionedFilesystemBackend {
  /* Combines a filesystem storage with Git. */

  private git: IsoGitWrapper;
  private fs: FilesystemWrapper<any>;
  private managers: (FilesystemManager & ModelManager<any, any, any>)[];

  constructor(
      private opts: BackendOptions,
      private reportBackendStatus: BackendStatusReporter) {

    super();

    this.fs = opts.fsWrapper;

    this.git = new IsoGitWrapper(
      fs,
      this.opts.repoURL,
      this.opts.upstreamRepoURL,
      this.opts.username,
      { name: this.opts.authorName, email: this.opts.authorEmail },
      this.opts.workDir,
      this.opts.corsProxyURL,

      // The status of this backend is reduced to Git repo status now.
      // Potentially it should include filesystem-related status as well,
      // reporting issues with e.g. insufficient disk space.
      this.reportBackendStatus,
    );

    this.managers = [];

    this.synchronize = this.synchronize.bind(this);
  }

  public async describe(): Promise<BackendDescription> {
    return {
      verboseName: "Git+YAML",
      verboseNameLong: "Git-versioned YAML file tree",
      gitRepo: this.opts.repoURL,
      gitUsername: this.opts.username,
      localClonePath: this.opts.workDir,
      status: this.git.getStatus(),
    }
  }

  public static registerSettingsForConfigurableOptions(
      settings: SettingManager,
      initialOptions: InitialBackendOptions,
      dbID: string) {

    const paneLabelPostfix = dbID !== 'default' ? ` for “${dbID}”` : '';
    const settingIDPrefix = `db_${dbID}_`;
    const paneID = `db_${dbID}`;

    settings.configurePane({
      id: paneID,
      label: `Database settings${paneLabelPostfix}`,
      icon: 'git-merge',
    });

    settings.register(new Setting<string>(
      paneID,
      `${settingIDPrefix}gitRepoUrl`,
      'text',
      initialOptions.repoURL === undefined,
      "Git repository URL",
      "E.g., https://github.com/<username>/<repository name>",
    ));

    settings.register(new Setting<string>(
      paneID,
      `${settingIDPrefix}gitUsername`,
      'text',
      initialOptions.username === undefined,
      "Git username",
    ));

    settings.register(new Setting<string>(
      paneID,
      `${settingIDPrefix}gitAuthorName`,
      'text',
      initialOptions.authorName === undefined,
      "Git author name",
    ));

    settings.register(new Setting<string>(
      paneID,
      `${settingIDPrefix}gitAuthorEmail`,
      'text',
      initialOptions.authorEmail === undefined,
      "Git author email",
    ));
  }

  public static async completeOptionsFromSettings(
      settings: SettingManager,
      availableOptions: InitialBackendOptions,
      dbID: string) {

    const settingIDPrefix = `db_${dbID}_`;

    async function getSetting<T>(settingID: string): Promise<T> {
      return await settings.getValue(`${settingIDPrefix}${settingID}`) as T;
    }

    const fsWrapperClass = (await availableOptions.fsWrapperClass()).default;

    return {
      workDir: availableOptions.workDir,
      corsProxyURL: availableOptions.corsProxyURL,
      upstreamRepoURL: availableOptions.upstreamRepoURL,
      fsWrapperClass: availableOptions.fsWrapperClass,
      fsWrapper: new fsWrapperClass(availableOptions.workDir),

      repoURL: (
        (await getSetting<string>('gitRepoUrl'))
        || availableOptions.repoURL) as string,
      username: (
        (await getSetting<string>('gitUsername'))
        || availableOptions.username) as string,
      authorName: (
        (await getSetting<string>('gitAuthorName'))
        || availableOptions.authorName) as string,
      authorEmail: (
        (await getSetting<string>('gitAuthorEmail'))
        || availableOptions.authorEmail) as string,
    }
  }

  public async registerManager(manager: FilesystemManager & ModelManager<any, any, any>) {
    this.managers.push(manager);
  }

  public async init(forceReset = false) {
    let doInitialize: boolean;

    try {
      if (forceReset === true) {
        log.warn("C/db/isogit-yaml: Git is being force reinitialized");
        doInitialize = true;
      } else if (!(await this.git.isUsingRemoteURLs({
          origin: this.opts.repoURL,
          upstream: this.opts.upstreamRepoURL}))) {
        log.warn("C/db/isogit-yaml: Git has mismatching remote URLs, reinitializing");
        doInitialize = true;
      } else {
        log.info("C/db/isogit-yaml: Git is already initialized");
        doInitialize = false;
      }
    } catch (e) {
      doInitialize = true;
    }

    if (doInitialize) {
      await this.git.destroy();
    }
  }

  public async read(objID: string, metaFields?: string[]) {
    return await this.fs.read(this.getRef(objID), metaFields) as object;
  }

  public async readVersion(objID: string, version: string) {
    // NOTE: This will fail with YAMLDirectoryWrapper.
    // objID must refer to a single file.

    // TODO: Support compound objects (directories)
    // by moving the file data parsing logic into manager
    // and adding Backend.readTree().

    const blob = await this.git.readFileBlobAtCommit(this.getRef(objID), version);
    return this.fs.parseData(blob);
  }

  public async create<O extends Record<string, any>>(obj: O, objPath: string, metaFields?: (keyof O)[]) {
    if (await this.fs.exists(objPath)) {
      throw new UniqueConstraintError("filesystem path", objPath);
    }

    await this.fs.write(objPath, obj, metaFields);
  }

  public async commit(objIDs: string[], message: string) {
    await this.resetOrphanedFileChanges();

    const uncommitted = await this.readUncommittedFileInfo();

    const paths: string[] = uncommitted.
      filter(fileinfo => gitPathMatches(objIDs, fileinfo.path)).
      map(fileinfo => fileinfo.path);

    log.debug("C/db: Committing objects", objIDs, uncommitted, paths, message);

    if (paths.length > 0) {
      // TODO: Make Git track which files got committed (had changes),
      // and return paths
      await this.git.stageAndCommit(paths, message);
    }
  }

  public async discard(objIDs: string[]) {
    const paths: string[] = (await this.readUncommittedFileInfo()).
      filter(fileinfo => gitPathMatches(objIDs, fileinfo.path)).
      map(fileinfo => fileinfo.path);

    if (paths.length > 0) {
      await this.git.resetFiles(paths);
    }
  }

  public async listUncommitted() {
    const files = await this.readUncommittedFileInfo();

    const objIDs: string[] = files.
      map(fileinfo => fileinfo.path);

    // Discard duplicates from the list
    return objIDs.filter(function (objID, idx, self) {
      return idx === self.indexOf(objID);
    });
  }

  public async listIDs(query: { subdir: string }) {
    return await this.fs.listIDs({ subdir: query.subdir });
  }

  public async getIndex(subdir: string, idField: string, onlyIDs?: string[], metaFields?: string[]) {
    const idsToSelect = onlyIDs !== undefined
      ? onlyIDs.map(id => this.getRef(id))
      : undefined;

    const objs = await this.fs.readAll({ subdir, onlyIDs: idsToSelect }, metaFields);

    var idx: Index<any> = {};
    for (const obj of objs) {
      idx[`${obj[idField]}`] = obj;
    }

    return idx;
  }

  public async update(objID: string, newData: Record<string, any>, idField: string, metaFields?: string[]) {
    await this.fs.write(this.getRef(objID), newData, metaFields);
  }

  public async delete(objID: string) {
    await this.fs.write(this.getRef(objID), undefined);
  }

  public async resetOrphanedFileChanges(): Promise<void> {
    /* Remove from filesystem any files under our FS backend path
       that the backend cannot account for,
       but which may appear as unstaged changes to Git. */

    const orphanFilePaths = (await this.readUncommittedFileInfo()).
    map(fileinfo => fileinfo.path).
    filter(filepath => this.managers.map(mgr => mgr.managesFileAtPath(filepath)).indexOf(true) < 0);

    if (orphanFilePaths.length > 0) {
      log.warn("C/db/isogit-yaml: Resetting orphaned files", orphanFilePaths);
      await this.git.resetFiles(orphanFilePaths);
    }
  }

  private async readUncommittedFileInfo(): Promise<{ path: string }[]> {
    /* Returns a list of objects that map Git-relative paths to actual object IDs.
       Where object ID is undefined, that implies file is “orphaned”
       (not recognized as belonging to any object managed by this store). */

    const changedFiles: string[] = await this.git.listChangedFiles(['.']);
    return await Promise.all(changedFiles.map(fp => {
      return { path: fp };
    }));
  }

  private getRef(objID: string | number): string {
    /* Returns FS backend reference from DB backend object ID. */
    return `${objID}`;
  }

  private async synchronize() {
    await this.git.synchronize();

    for (const mgr of this.managers) {
      mgr.reportUpdatedData();
    }
  }

  private async checkUncommitted() {
    return await this.git.checkUncommitted();
  }

  public setUpIPC(dbID: string) {
    super.setUpIPC(dbID);

    log.verbose("C/db/isogit-yaml: Setting up IPC");

    const prefix = `db-${dbID}`;

    listen<{}, { numUncommitted: number }>
    (`${prefix}-count-uncommitted`, async () => {
      return { numUncommitted: (await this.git.listChangedFiles()).length };
    });

    listen<{}, { started: true }>
    (`${prefix}-git-trigger-sync`, async () => {
      this.synchronize();
      return { started: true };
    });

    listen<{}, { success: true }>
    (`${prefix}-git-discard-unstaged`, async () => {
      await this.git.resetFiles();
      return { success: true };
    });

    listen<{}, { hasUncommittedChanges: boolean }>
    (`${prefix}-git-update-status`, async () => {
      return { hasUncommittedChanges: await this.checkUncommitted() };
    });

    listen<{ password: string }, { success: true }>
    (`${prefix}-git-set-password`, async ({ password }) => {
      // WARNING: Don’t log password
      log.verbose("C/db/isogit-yaml: received git-set-password request");

      this.git.setPassword(password);
      this.synchronize();

      return { success: true };
    });

    listen<{}, { originURL: string | null, name: string | null, email: string | null, username: string | null }>
    (`${prefix}-git-config-get`, async () => {
      log.verbose("C/db/isogit-yaml: received git-config request");
      return {
        originURL: await this.git.getOriginUrl(),
        name: await this.git.configGet('user.name'),
        email: await this.git.configGet('user.email'),
        username: await this.git.configGet('credentials.username'),
        // Password must not be returned, of course
      };
    });
  }
}

export const BackendClass: BaseBackendClass<InitialBackendOptions, BackendOptions, BackendStatus> = Backend

export default Backend;


function gitPathMatches(objIDs: string[], gitPath: string) {
  if (objIDs.indexOf(gitPath) >= 0) {
    return true;
  }
  const parsed = path.parse(gitPath);

  // Backend operates file references as paths without extensions.
  // FS wrapper expands paths, adding extension if necessary.
  // Git, however, doesn’t know about the extensions.
  // For YAML files with extensions (not directories),
  // try comparing with extensions removed.

  // Attempt to compare with directory of the file, for YAML directory
  // backend.
  return objIDs.find(id =>
    id === parsed.dir || id === path.join(parsed.dir, parsed.name)
  ) !== undefined;
}