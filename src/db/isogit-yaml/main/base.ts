import * as log from 'electron-log';
import * as fs from 'fs-extra';

import { ipcMain } from 'electron';

import { listen } from '../../../ipc/main';
import { Setting, SettingManager } from '../../../settings/main';

import { Index } from '../../query';
import { UniqueConstraintError } from '../../errors';

import {
  BackendClass,
  BackendStatus as BaseBackendStatus,
  BackendStatusReporter as BaseBackendStatusReporter,
  VersionedFilesystemBackend,
  VersionedFilesystemManager,
} from '../../main/base';

import { YAMLDirectoryWrapper } from './yaml';
import { IsoGitWrapper } from './isogit';


export interface FixedBackendOptions {
  /* Settings supplied by the developer */
  workDir: string
  corsProxyURL: string
  upstreamRepoURL: string
}

export interface ConfigurableBackendOptions {
  /* Settings that user can or must specify */
  repoURL: string
  username: string
  authorName: string
  authorEmail: string
}

export type BackendOptions = FixedBackendOptions & ConfigurableBackendOptions

export type InitialBackendOptions = FixedBackendOptions & Partial<ConfigurableBackendOptions>


export interface BackendStatus extends BaseBackendStatus {
  isOffline: boolean
  hasLocalChanges: boolean
  needsPassword: boolean
  statusRelativeToLocal: 'ahead' | 'behind' | 'diverged' | 'updated' | undefined
  isPushing: boolean
  isPulling: boolean
}
export type BackendStatusReporter = BaseBackendStatusReporter<BackendStatus>


export const Backend: BackendClass<InitialBackendOptions, BackendOptions, BackendStatus> = class Backend
implements VersionedFilesystemBackend {
  /* Combines a filesystem storage with Git. */

  private git: IsoGitWrapper;
  private fs: YAMLDirectoryWrapper;
  private managers: VersionedFilesystemManager[];

  constructor(private opts: BackendOptions, private reportBackendStatus: BackendStatusReporter) {
    this.fs = new YAMLDirectoryWrapper(this.opts.workDir);
    // TODO: Supply specific FS wrapper implementation via options

    this.git = new IsoGitWrapper(
      fs,
      this.opts.repoURL,
      this.opts.upstreamRepoURL,
      this.opts.workDir,
      this.opts.corsProxyURL,
    );

    this.managers = [];

    this.synchronize = this.synchronize.bind(this);

    // this.collections = Object.entries(this.opts.collections).map(([collectionID, collectionOptions]) => {
    //   return { [collectionID]: { index: {}, opts: collectionOptions } } as Partial<Collections>;
    // }).reduce((val, acc) => ({ ...acc, ...val }), {} as Partial<Collections>) as Collections;
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

    return {
      workDir: availableOptions.workDir,
      corsProxyURL: availableOptions.corsProxyURL,
      upstreamRepoURL: availableOptions.upstreamRepoURL,

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

  public async registerManager(manager: VersionedFilesystemManager) {
    this.managers.push(manager);
  }

  public async init(forceReset = false) {
    let doInitialize: boolean;

    if (forceReset === true) {
      log.warn("C/db/isogit-yaml: Git is being force reinitialized");
      doInitialize = true;
    } else if (!(await this.git.isInitialized())) {
      log.warn("C/db/isogit-yaml: Git is not initialized yet");
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

    if (doInitialize) {
      await this.git.forceInitialize();
    }

    await this.git.loadAuth();
  }

  public async read(objID: string, metaFields: string[]) {
    return await this.fs.read(this.getRef(objID), metaFields) as object;
  }

  public async create<O extends Record<string, any>>(obj: O, objPath: string, metaFields: (keyof O)[]) {
    if (await this.fs.exists(objPath)) {
      throw new UniqueConstraintError("filesystem path", objPath);
    }

    await this.fs.write(objPath, obj, metaFields);
  }

  public async commit(objIDs: string[], message: string) {
    await this.resetOrphanedFileChanges();

    const paths: string[] = (await this.readUncommittedFileInfo()).
      filter(fileinfo => objIDs.indexOf(fileinfo.path) >= 0).
      map(fileinfo => fileinfo.path);

    if (paths.length > 0) {
      await this.git.stageAndCommit(paths, message);
    }
  }

  public async discard(objIDs: string[]) {
    const paths: string[] = (await this.readUncommittedFileInfo()).
      filter(fileinfo => objIDs.indexOf(fileinfo.path) >= 0).
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

  public async readAll(idField: string) {
    const objs = await this.fs.readAll();
    var idx: Index<any> = {};
    for (const obj of objs) {
      idx[`${obj[idField]}`] = obj;
    }
    return idx;
  }

  public async update(objID: string, newData: Record<string, any>, idField: string) {
    if (objID !== newData[idField]) {
      throw new Error("Updating object IDs is not supported at the moment.");
    }

    await this.fs.write(this.getRef(objID), newData);
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
    filter(filepath => this.managers.map(mgr => mgr.managesFileAtPath(filepath)).indexOf(true) >= 0);

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
    /* Returns FS backend reference given object ID. */
    return `${objID}`;
  }

  private async synchronize() {
    return await this.git.synchronize(this.reportBackendStatus);
  }

  private async checkUncommitted() {
    return await this.git.checkUncommitted(this.reportBackendStatus);
  }

  public setUpIPC(dbID: string) {
    log.verbose("C/db/isogit-yaml: Setting up IPC");

    const prefix = `db-${dbID}`;

    ipcMain.on(`${prefix}-git-trigger-sync`, this.synchronize);
    ipcMain.on(`${prefix}-git-discard-unstaged`, () => this.git.resetFiles() );
    ipcMain.on(`${prefix}-git-update-status`, this.checkUncommitted);

    listen<{ name: string, email: string, username: string }, { success: true }>
    (`${prefix}-git-config-set`, async ({ name, email, username }) => {
      log.verbose("C/db/isogit-yaml: received git-config-set request");

      await this.git.configSet('user.name', name);
      await this.git.configSet('user.email', email);
      await this.git.configSet('credentials.username', username);

      await this.git.loadAuth();
      // ^ this.git.auth.username = username

      this.synchronize();

      return { success: true };
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

export default Backend;
