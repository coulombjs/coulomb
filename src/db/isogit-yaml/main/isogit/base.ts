import * as https from 'https';
import * as path from 'path';
import AsyncLock from 'async-lock';
import * as git from 'isomorphic-git';
import * as log from 'electron-log';

import { GitStatus } from '../../base';
import { GitAuthentication } from './types';


const UPSTREAM_REMOTE = 'upstream';
const MAIN_REMOTE = 'origin';


const INITIAL_STATUS: GitStatus = {
  isOnline: false,
  isMisconfigured: false,
  hasLocalChanges: false,
  needsPassword: false,
  statusRelativeToLocal: undefined,
  lastSynchronized: null,
  isPushing: false,
  isPulling: false,
}


export class IsoGitWrapper {

  private auth: GitAuthentication = {};

  private stagingLock: AsyncLock;

  private status: GitStatus;

  constructor(
      private fs: any,
      private repoUrl: string,
      private upstreamRepoUrl: string | undefined,
      username: string,
      private author: { name: string, email: string },
      public workDir: string,
      private corsProxy: string,
      private statusReporter: (payload: GitStatus) => Promise<void>) {

    git.plugins.set('fs', fs);

    this.stagingLock = new AsyncLock({ timeout: 20000, maxPending: 2 });

    // Makes it easier to bind these to IPC events
    this.synchronize = this.synchronize.bind(this);
    this.resetFiles = this.resetFiles.bind(this);
    this.checkUncommitted = this.checkUncommitted.bind(this);

    this.auth.username = username;

    this.status = INITIAL_STATUS;
  }


  // Reporting Git status to DB backend,
  // so that it can be reflected in the GUI

  private async reportStatus() {
    return await this.statusReporter(this.status);
  }

  private async setStatus(status: Partial<GitStatus>) {
    Object.assign(this.status, status);
    await this.reportStatus();
  }

  public getStatus(): GitStatus {
    return this.status;
  }


  // Initilaization

  public async isInitialized(): Promise<boolean> {
    let hasGitDirectory: boolean;
    try {
      hasGitDirectory = (await this.fs.stat(path.join(this.workDir, '.git'))).isDirectory();
    } catch (e) {
      hasGitDirectory = false;
    }
    return hasGitDirectory;
  }

  public async isUsingRemoteURLs(remoteUrls: { origin: string, upstream?: string }): Promise<boolean> {
    const origin = (await this.getOriginUrl() || '').trim();
    const upstream = (await this.getUpstreamUrl() || '').trim();
    return origin === remoteUrls.origin && (upstream === undefined || upstream === remoteUrls.upstream);
  }

  public needsPassword(): boolean {
    return (this.auth.password || '').trim() === '';
  }

  public getUsername(): string | undefined {
    return this.auth.username;
  }

  public async destroy() {
    /* Removes working directory.
       On next sync Git repo will have to be reinitialized, cloned etc. */

    log.warn("C/db/isogit: Initialize: Removing data directory");
    await this.fs.remove(this.workDir);
  }

  private async forceInitialize() {
    /* Initializes from scratch: wipes work directory, clones repository, adds remotes. */

    log.warn("C/db/isogit: Initializing");

    log.silly("C/db/isogit: Initialize: Ensuring data directory exists");
    await this.fs.ensureDir(this.workDir);

    log.verbose("C/db/isogit: Initialize: Cloning", this.repoUrl);

    try {
      await git.clone({
        dir: this.workDir,
        url: this.repoUrl,
        ref: 'master',
        singleBranch: true,
        depth: 5,
        corsProxy: this.corsProxy,
        ...this.auth,
      });

      if (this.upstreamRepoUrl !== undefined) {
        log.debug("C/db/isogit: Initialize: Adding upstream remote", this.upstreamRepoUrl);
        await git.addRemote({
          dir: this.workDir,
          remote: UPSTREAM_REMOTE,
          url: this.upstreamRepoUrl,
        });
      } else {
        log.warn("C/db/isogit: Initialize: No upstream remote specified");
      }

    } catch (e) {
      log.error("C/db/isogit: Error during initialization")
      await this.fs.remove(this.workDir);
      await this._handleGitError(e);
      throw e;
    }
  }


  // Authentication

  public setPassword(value: string | undefined) {
    this.auth.password = value;
  }


  // Git operations

  async configSet(prop: string, val: string) {
    log.verbose("C/db/isogit: Set config");
    await git.config({ dir: this.workDir, path: prop, value: val });
  }

  async configGet(prop: string): Promise<string> {
    log.verbose("C/db/isogit: Get config", prop);
    return await git.config({ dir: this.workDir, path: prop });
  }

  async readFileBlobAtCommit(relativeFilePath: string, commitHash: string): Promise<string> {
    /* Reads file contents at given path as of given commit. File contents must use UTF-8 encoding. */

    return (await git.readBlob({
      dir: this.workDir,
      oid: commitHash,
      filepath: relativeFilePath,
    })).blob.toString();
  }

  async pull() {
    log.verbose("C/db/isogit: Pulling master with fast-forward merge");

    return await git.pull({
      dir: this.workDir,
      singleBranch: true,
      fastForwardOnly: true,

      fast: true,
      // NOTE: TypeScript is known to complain about the ``fast`` option.
      // Seems like a problem with typings.

      ...this.auth,
    });
  }

  async stage(pathSpecs: string[]) {
    log.verbose(`C/db/isogit: Adding changes: ${pathSpecs.join(', ')}`);

    for (const pathSpec of pathSpecs) {
      await git.add({
        dir: this.workDir,
        filepath: pathSpec,
      });
    }
  }

  async commit(msg: string) {
    log.verbose(`C/db/isogit: Committing with message ${msg}`);

    return await git.commit({
      dir: this.workDir,
      message: msg,
      author: this.author,
    });
  }

  async fetchRemote(): Promise<void> {
    await git.fetch({ dir: this.workDir, remote: MAIN_REMOTE, ...this.auth });
  }

  async fetchUpstream(): Promise<void> {
    await git.fetch({ dir: this.workDir, remote: UPSTREAM_REMOTE, ...this.auth });
  }

  async push(force = false) {
    log.verbose("C/db/isogit: Pushing");

    return await git.push({
      dir: this.workDir,
      remote: MAIN_REMOTE,
      force: force,
      ...this.auth,
    });
  }

  public async resetFiles(paths?: string[]) {
    return await this.stagingLock.acquire('1', async () => {
      log.verbose("C/db/isogit: Force resetting files");

      return await git.fastCheckout({
        dir: this.workDir,
        force: true,
        filepaths: paths || (await this.listChangedFiles()),
      });
    });
  }

  async getOriginUrl(): Promise<string | null> {
    return ((await git.listRemotes({
      dir: this.workDir,
    })).find(r => r.remote === MAIN_REMOTE) || { url: null }).url;
  }

  async getUpstreamUrl(): Promise<string | null> {
    return ((await git.listRemotes({
      dir: this.workDir,
    })).find(r => r.remote === UPSTREAM_REMOTE) || { url: null }).url;
  }

  async listLocalCommits(): Promise<string[]> {
    /* Returns a list of commit messages for commits that were not pushed yet.

       Useful to check which commits will be thrown out
       if we force update to remote master.

       Does so by walking through last 100 commits starting from current HEAD.
       When it encounters the first local commit that doesn’t descends from remote master HEAD,
       it considers all preceding commits to be ahead/local and returns them.

       If it finishes the walk without finding an ancestor, throws an error.
       It is assumed that the app does not allow to accumulate
       more than 100 commits without pushing (even 100 is too many!),
       so there’s probably something strange going on.

       Other assumptions:

       * git.log returns commits from newest to oldest.
       * The remote was already fetched.

    */

    return await this.stagingLock.acquire('1', async () => {
      const latestRemoteCommit = await git.resolveRef({
        dir: this.workDir,
        ref: `${MAIN_REMOTE}/master`,
      });

      const localCommits = await git.log({
        dir: this.workDir,
        depth: 100,
      });

      var commits = [] as string[];
      for (const commit of localCommits) {
        if (await git.isDescendent({ dir: this.workDir, oid: commit.oid, ancestor: latestRemoteCommit })) {
          commits.push(commit.message);
        } else {
          return commits;
        }
      }

      throw new Error("Did not find a local commit that is an ancestor of remote master");
    });
  }

  public async listChangedFiles(pathSpecs = ['.']): Promise<string[]> {
    /* Lists relative paths to all files that were changed and have not been committed. */

    const FILE = 0, HEAD = 1, WORKDIR = 2;

    return (await git.statusMatrix({ dir: this.workDir, filepaths: pathSpecs }))
      .filter(row => row[HEAD] !== row[WORKDIR])
      .map(row => row[FILE])
      .filter(filepath => !filepath.startsWith('..'));
  }

  public async stageAndCommit(pathSpecs: string[], msg: string): Promise<number> {
    /* Stages and commits files matching given path spec with given message.

       Any other files staged at the time of the call will be unstaged.

       Returns the number of matching files with unstaged changes prior to staging.
       If no matching files were found having unstaged changes,
       skips the rest and returns zero.

       If failIfDiverged is given, attempts a fast-forward pull after the commit.
       It will fail immediately if main remote had other commits appear in meantime.

       Locks so that this method cannot be run concurrently (by same instance).
    */

    if (pathSpecs.length < 1) {
      throw new Error("Wasn’t given any paths to commit!");
    }

    return await this.stagingLock.acquire('1', async () => {
      log.verbose(`C/db/isogit: Staging and committing: ${pathSpecs.join(', ')}`);

      const filesChanged = (await this.listChangedFiles(pathSpecs)).length;
      if (filesChanged < 1) {
        return 0;
      }

      await this.unstageAll();
      await this.stage(pathSpecs);
      await this.commit(msg);

      return filesChanged;
    });
  }

  public async checkUncommitted(): Promise<boolean> {
    /* Checks for any uncommitted changes locally present.
       Notifies all windows about the status. */

    log.debug("C/db/isogit: Checking for uncommitted changes");
    const hasUncommittedChanges = (await this.listChangedFiles()).length > 0;
    await this.setStatus({ hasLocalChanges: hasUncommittedChanges });
    return hasUncommittedChanges;
  }

  public async synchronize(): Promise<void> {
    /* Checks for connection, local changes and unpushed commits,
       tries to push and pull when there’s opportunity.

       Notifies all windows about the status in process. */

    if (this.stagingLock.isBusy()) {
      log.verbose("C/db/isogit: Lock is busy, skipping sync");
      return;
    }

    log.verbose("C/db/isogit: Queueing sync");

    return await this.stagingLock.acquire('1', async () => {
      log.verbose("C/db/isogit: Starting sync");

      const isOnline = (await checkOnlineStatus()) === true;

      if (isOnline) {
        const needsPassword = this.needsPassword();
        await this.setStatus({ needsPassword });
        if (needsPassword) {
          return;
        }

        if (!(await this.isInitialized())) {
          await this.forceInitialize();
        }

        await this.setStatus({ isOnline: true });

        const hasUncommittedChanges = await this.checkUncommitted();

        // Do not run pull if there are unstaged/uncommitted changes
        if (!hasUncommittedChanges) {
          await this.setStatus({ isPulling: true });
          try {
            await this.pull();
          } catch (e) {
            log.error(e);
            await this.setStatus({ isPushing: false, isPulling: false });
            await this._handleGitError(e);
            return;
          }
          //await this.setStatus({ isPulling: false });

          // Run push AFTER pull. May result in false-positive non-fast-forward rejection
          //await this.setStatus({ isPushing: true });
          try {
            await this.push();
          } catch (e) {
            log.error(e);
            await this.setStatus({ isPulling: false, isPushing: false });
            await this._handleGitError(e);
            return;
          }
          //await this.setStatus({ isPushing: false });

          await this.setStatus({
            statusRelativeToLocal: 'updated',
            isMisconfigured: false,
            needsPassword: false,
            isPushing: false,
            isPulling: false,
          });
        }
      }
    });
  }

  private async unstageAll() {
    log.verbose("C/db/isogit: Unstaging all changes");
    await git.remove({ dir: this.workDir, filepath: '.' });
  }

  private async _handleGitError(e: Error & { code: string }): Promise<void> {
    log.debug("Handling Git error", e);

    if (e.code === 'FastForwardFail' || e.code === 'MergeNotSupportedFail') {
      // NOTE: There’s also PushRejectedNonFastForward, but it seems to be thrown
      // for unrelated cases during push (false positive).
      // Because of that false positive, we ignore that error and instead do pull first,
      // catching actual fast-forward fails on that step before push.
      await this.setStatus({ statusRelativeToLocal: 'diverged' });
    } else if (['MissingUsernameError', 'MissingAuthorError', 'MissingCommitterError'].indexOf(e.code) >= 0) {
      await this.setStatus({ isMisconfigured: true });
    } else if (
        e.code === 'MissingPasswordTokenError'
        || (e.code === 'HTTPError' && e.message.indexOf('Unauthorized') >= 0)) {
      log.warn("Password input required");
      this.setPassword(undefined);
      await this.setStatus({ needsPassword: true });
    }
  }
}


async function checkOnlineStatus(timeout = 4500): Promise<boolean> {
  // TODO: Move to general utility functions
  return new Promise((resolve) => {
    log.debug("C/db/isogit: Connection test: Starting");

    const req = https.get('https://github.com/', { timeout }, reportOnline);

    req.on('error', () => req.abort());
    req.on('response', reportOnline);
    req.on('connect', reportOnline);
    req.on('continue', reportOnline);
    req.on('upgrade', reportOnline);
    req.on('timeout', reportOffline);

    req.end();

    const checkTimeout = setTimeout(reportOffline, timeout);

    function reportOffline() {
      log.warn("C/db/isogit: Connection test: Report offline");
      try { req.abort(); } catch (e) {}
      clearTimeout(checkTimeout);
      resolve(false);
    }
    function reportOnline() {
      log.info("C/db/isogit: Connection test: Report online");
      try { req.abort(); } catch (e) {}
      clearTimeout(checkTimeout);
      resolve(true);
    }
  });
}


// TODO: Temporary workaround since isomorphic-git doesn’t seem to export its GitError class
// in any way available to TS, so we can’t use instanceof :(

export function isGitError(e: Error & { code: string }) {
  if (!e.code) {
    return false;
  }
  return Object.keys(IsomorphicGitErrorCodes).indexOf(e.code) >= 0;
}

const IsomorphicGitErrorCodes = {
  FileReadError: `FileReadError`,
  MissingRequiredParameterError: `MissingRequiredParameterError`,
  InvalidRefNameError: `InvalidRefNameError`,
  InvalidParameterCombinationError: `InvalidParameterCombinationError`,
  RefExistsError: `RefExistsError`,
  RefNotExistsError: `RefNotExistsError`,
  BranchDeleteError: `BranchDeleteError`,
  NoHeadCommitError: `NoHeadCommitError`,
  CommitNotFetchedError: `CommitNotFetchedError`,
  ObjectTypeUnknownFail: `ObjectTypeUnknownFail`,
  ObjectTypeAssertionFail: `ObjectTypeAssertionFail`,
  ObjectTypeAssertionInTreeFail: `ObjectTypeAssertionInTreeFail`,
  ObjectTypeAssertionInRefFail: `ObjectTypeAssertionInRefFail`,
  ObjectTypeAssertionInPathFail: `ObjectTypeAssertionInPathFail`,
  MissingAuthorError: `MissingAuthorError`,
  MissingCommitterError: `MissingCommitterError`,
  MissingTaggerError: `MissingTaggerError`,
  GitRootNotFoundError: `GitRootNotFoundError`,
  UnparseableServerResponseFail: `UnparseableServerResponseFail`,
  InvalidDepthParameterError: `InvalidDepthParameterError`,
  RemoteDoesNotSupportShallowFail: `RemoteDoesNotSupportShallowFail`,
  RemoteDoesNotSupportDeepenSinceFail: `RemoteDoesNotSupportDeepenSinceFail`,
  RemoteDoesNotSupportDeepenNotFail: `RemoteDoesNotSupportDeepenNotFail`,
  RemoteDoesNotSupportDeepenRelativeFail: `RemoteDoesNotSupportDeepenRelativeFail`,
  RemoteDoesNotSupportSmartHTTP: `RemoteDoesNotSupportSmartHTTP`,
  CorruptShallowOidFail: `CorruptShallowOidFail`,
  FastForwardFail: `FastForwardFail`,
  MergeNotSupportedFail: `MergeNotSupportedFail`,
  DirectorySeparatorsError: `DirectorySeparatorsError`,
  ResolveTreeError: `ResolveTreeError`,
  ResolveCommitError: `ResolveCommitError`,
  DirectoryIsAFileError: `DirectoryIsAFileError`,
  TreeOrBlobNotFoundError: `TreeOrBlobNotFoundError`,
  NotImplementedFail: `NotImplementedFail`,
  ReadObjectFail: `ReadObjectFail`,
  NotAnOidFail: `NotAnOidFail`,
  NoRefspecConfiguredError: `NoRefspecConfiguredError`,
  MismatchRefValueError: `MismatchRefValueError`,
  ResolveRefError: `ResolveRefError`,
  ExpandRefError: `ExpandRefError`,
  EmptyServerResponseFail: `EmptyServerResponseFail`,
  AssertServerResponseFail: `AssertServerResponseFail`,
  HTTPError: `HTTPError`,
  RemoteUrlParseError: `RemoteUrlParseError`,
  UnknownTransportError: `UnknownTransportError`,
  AcquireLockFileFail: `AcquireLockFileFail`,
  DoubleReleaseLockFileFail: `DoubleReleaseLockFileFail`,
  InternalFail: `InternalFail`,
  UnknownOauth2Format: `UnknownOauth2Format`,
  MissingPasswordTokenError: `MissingPasswordTokenError`,
  MissingUsernameError: `MissingUsernameError`,
  MixPasswordTokenError: `MixPasswordTokenError`,
  MixUsernamePasswordTokenError: `MixUsernamePasswordTokenError`,
  MissingTokenError: `MissingTokenError`,
  MixUsernameOauth2formatMissingTokenError: `MixUsernameOauth2formatMissingTokenError`,
  MixPasswordOauth2formatMissingTokenError: `MixPasswordOauth2formatMissingTokenError`,
  MixUsernamePasswordOauth2formatMissingTokenError: `MixUsernamePasswordOauth2formatMissingTokenError`,
  MixUsernameOauth2formatTokenError: `MixUsernameOauth2formatTokenError`,
  MixPasswordOauth2formatTokenError: `MixPasswordOauth2formatTokenError`,
  MixUsernamePasswordOauth2formatTokenError: `MixUsernamePasswordOauth2formatTokenError`,
  MaxSearchDepthExceeded: `MaxSearchDepthExceeded`,
  PushRejectedNonFastForward: `PushRejectedNonFastForward`,
  PushRejectedTagExists: `PushRejectedTagExists`,
  AddingRemoteWouldOverwrite: `AddingRemoteWouldOverwrite`,
  PluginUndefined: `PluginUndefined`,
  CoreNotFound: `CoreNotFound`,
  PluginSchemaViolation: `PluginSchemaViolation`,
  PluginUnrecognized: `PluginUnrecognized`,
  AmbiguousShortOid: `AmbiguousShortOid`,
  ShortOidNotFound: `ShortOidNotFound`,
  CheckoutConflictError: `CheckoutConflictError`
}

