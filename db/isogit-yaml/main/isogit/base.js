import * as https from 'https';
import * as path from 'path';
import AsyncLock from 'async-lock';
import * as git from 'isomorphic-git';
import * as log from 'electron-log';
const UPSTREAM_REMOTE = 'upstream';
const MAIN_REMOTE = 'origin';
const INITIAL_STATUS = {
    isOnline: false,
    isMisconfigured: false,
    hasLocalChanges: false,
    needsPassword: false,
    statusRelativeToLocal: undefined,
    lastSynchronized: null,
    isPushing: false,
    isPulling: false,
};
export class IsoGitWrapper {
    constructor(fs, repoUrl, upstreamRepoUrl, username, author, workDir, corsProxy, statusReporter) {
        this.fs = fs;
        this.repoUrl = repoUrl;
        this.upstreamRepoUrl = upstreamRepoUrl;
        this.author = author;
        this.workDir = workDir;
        this.corsProxy = corsProxy;
        this.statusReporter = statusReporter;
        this.auth = {};
        this.pushPending = false;
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
    async reportStatus() {
        return await this.statusReporter(this.status);
    }
    async setStatus(status) {
        Object.assign(this.status, status);
        await this.reportStatus();
    }
    getStatus() {
        return this.status;
    }
    // Initilaization
    async isInitialized() {
        let hasGitDirectory;
        try {
            hasGitDirectory = (await this.fs.stat(path.join(this.workDir, '.git'))).isDirectory();
        }
        catch (e) {
            hasGitDirectory = false;
        }
        return hasGitDirectory;
    }
    async isUsingRemoteURLs(remoteUrls) {
        const origin = (await this.getOriginUrl() || '').trim();
        const upstream = (await this.getUpstreamUrl() || '').trim();
        return origin === remoteUrls.origin && (remoteUrls.upstream === undefined || upstream === remoteUrls.upstream);
    }
    needsPassword() {
        return (this.auth.password || '').trim() === '';
    }
    getUsername() {
        return this.auth.username;
    }
    async destroy() {
        /* Removes working directory.
           On next sync Git repo will have to be reinitialized, cloned etc. */
        log.warn("C/db/isogit: Initialize: Removing data directory");
        await this.fs.remove(this.workDir);
    }
    async forceInitialize() {
        /* Initializes from scratch: wipes work directory, clones repository, adds remotes. */
        return await this.stagingLock.acquire('1', async () => {
            log.warn("C/db/isogit: Initializing");
            log.silly("C/db/isogit: Initialize: Ensuring data directory exists");
            await this.fs.ensureDir(this.workDir);
            log.verbose("C/db/isogit: Initialize: Cloning", this.repoUrl);
            try {
                await git.clone(Object.assign({ dir: this.workDir, url: this.repoUrl, ref: 'master', singleBranch: true, depth: 5, corsProxy: this.corsProxy }, this.auth));
                if (this.upstreamRepoUrl !== undefined) {
                    log.debug("C/db/isogit: Initialize: Adding upstream remote", this.upstreamRepoUrl);
                    await git.addRemote({
                        dir: this.workDir,
                        remote: UPSTREAM_REMOTE,
                        url: this.upstreamRepoUrl,
                    });
                }
                else {
                    log.warn("C/db/isogit: Initialize: No upstream remote specified");
                }
            }
            catch (e) {
                log.error("C/db/isogit: Error during initialization");
                await this.fs.remove(this.workDir);
                await this._handleGitError(e);
                throw e;
            }
        });
    }
    // Authentication
    setPassword(value) {
        this.auth.password = value;
        this.setStatus({ needsPassword: false });
    }
    // Git operations
    async configSet(prop, val) {
        log.verbose("C/db/isogit: Set config");
        await git.config({ dir: this.workDir, path: prop, value: val });
    }
    async configGet(prop) {
        log.verbose("C/db/isogit: Get config", prop);
        return await git.config({ dir: this.workDir, path: prop });
    }
    async readFileBlobAtCommit(relativeFilePath, commitHash) {
        /* Reads file contents at given path as of given commit. File contents must use UTF-8 encoding. */
        return (await git.readBlob({
            dir: this.workDir,
            oid: commitHash,
            filepath: relativeFilePath,
        })).blob.toString();
    }
    async pull() {
        log.verbose("C/db/isogit: Pulling master with fast-forward merge");
        return await git.pull(Object.assign({ dir: this.workDir, singleBranch: true, fastForwardOnly: true, fast: true }, this.auth));
    }
    async stage(pathSpecs, removing = false) {
        log.verbose(`C/db/isogit: Staging changes: ${pathSpecs.join(', ')} using ${removing ? "remove()" : "add()"}`);
        for (const pathSpec of pathSpecs) {
            if (removing !== true) {
                await git.add({
                    dir: this.workDir,
                    filepath: pathSpec,
                });
            }
            else {
                await git.remove({
                    dir: this.workDir,
                    filepath: pathSpec,
                });
            }
        }
    }
    async commit(msg) {
        log.verbose(`C/db/isogit: Committing with message ${msg}`);
        return await git.commit({
            dir: this.workDir,
            message: msg,
            author: this.author,
        });
    }
    async fetchRemote() {
        await git.fetch(Object.assign({ dir: this.workDir, remote: MAIN_REMOTE }, this.auth));
    }
    async fetchUpstream() {
        await git.fetch(Object.assign({ dir: this.workDir, remote: UPSTREAM_REMOTE }, this.auth));
    }
    async push(force = false) {
        log.verbose("C/db/isogit: Pushing");
        return await git.push(Object.assign({ dir: this.workDir, remote: MAIN_REMOTE, force: force }, this.auth));
    }
    async resetFiles(paths) {
        return await this.stagingLock.acquire('1', async () => {
            log.verbose("C/db/isogit: Force resetting files");
            return await git.fastCheckout({
                dir: this.workDir,
                force: true,
                filepaths: paths || (await this.listChangedFiles()),
            });
        });
    }
    async getOriginUrl() {
        return ((await git.listRemotes({
            dir: this.workDir,
        })).find(r => r.remote === MAIN_REMOTE) || { url: null }).url;
    }
    async getUpstreamUrl() {
        return ((await git.listRemotes({
            dir: this.workDir,
        })).find(r => r.remote === UPSTREAM_REMOTE) || { url: null }).url;
    }
    async listLocalCommits() {
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
            var commits = [];
            for (const commit of localCommits) {
                if (await git.isDescendent({ dir: this.workDir, oid: commit.oid, ancestor: latestRemoteCommit })) {
                    commits.push(commit.message);
                }
                else {
                    return commits;
                }
            }
            throw new Error("Did not find a local commit that is an ancestor of remote master");
        });
    }
    async listChangedFiles(pathSpecs = ['.']) {
        /* Lists relative paths to all files that were changed and have not been committed. */
        const FILE = 0, HEAD = 1, WORKDIR = 2;
        return (await git.statusMatrix({ dir: this.workDir, filepaths: pathSpecs }))
            .filter(row => row[HEAD] !== row[WORKDIR])
            .map(row => row[FILE])
            .filter(filepath => !filepath.startsWith('..') && filepath !== ".DS_Store");
    }
    async stageAndCommit(pathSpecs, msg, removing = false) {
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
            await this.stage(pathSpecs, removing);
            await this.commit(msg);
            return filesChanged;
        });
    }
    async checkUncommitted() {
        /* Checks for any uncommitted changes locally present.
           Notifies all windows about the status. */
        log.debug("C/db/isogit: Checking for uncommitted changes");
        const changedFiles = await this.listChangedFiles();
        log.debug("C/db/isogit: Changed files:", changedFiles);
        const hasLocalChanges = changedFiles.length > 0;
        await this.setStatus({ hasLocalChanges });
        return hasLocalChanges;
    }
    requestPush() {
        this.pushPending = true;
    }
    async synchronize() {
        /* Checks for connection, local changes and unpushed commits,
           tries to push and pull when there’s opportunity.
    
           Notifies all windows about the status in process. */
        log.verbose("C/db/isogit: Checking if clone exists");
        if (!(await this.isInitialized())) {
            await this.forceInitialize();
        }
        else {
            log.verbose("C/db/isogit: Checking for uncommitted changes");
            const hasUncommittedChanges = await this.checkUncommitted();
            if (hasUncommittedChanges) {
                // Do not run pull if there are unstaged/uncommitted changes
                await this.setStatus({ hasLocalChanges: true });
                return;
            }
            else {
                // If uncommitted changes weren’t detected, there may still be changed files
                // that are not managed by the backend (e.g., .DS_Store). Discard any stuff like that.
                await this.resetFiles(['.']);
            }
        }
        if (this.stagingLock.isBusy()) {
            log.verbose("C/db/isogit: Lock is busy, skipping sync");
            return;
        }
        log.verbose("C/db/isogit: Queueing sync now, lock is not busy");
        return await this.stagingLock.acquire('1', async () => {
            log.verbose("C/db/isogit: Starting sync");
            const isOnline = (await checkOnlineStatus()) === true;
            if (isOnline) {
                const needsPassword = this.needsPassword();
                await this.setStatus({ needsPassword });
                if (needsPassword) {
                    return;
                }
                await this.setStatus({ isOnline: true });
                await this.setStatus({ isPulling: true });
                try {
                    await this.pull();
                }
                catch (e) {
                    log.error(e);
                    await this.setStatus({
                        lastSynchronized: new Date(),
                        isPulling: false,
                        isPushing: false,
                    });
                    await this._handleGitError(e);
                    return;
                }
                //await this.setStatus({ isPulling: false });
                if (this.pushPending) {
                    // Run push AFTER pull. May result in false-positive non-fast-forward rejection
                    await this.setStatus({ isPushing: true });
                    try {
                        await this.push();
                    }
                    catch (e) {
                        log.error(e);
                        await this.setStatus({
                            lastSynchronized: new Date(),
                            isPulling: false,
                            isPushing: false,
                        });
                        await this._handleGitError(e);
                        return;
                    }
                    this.pushPending = false;
                    //await this.setStatus({ isPushing: false });
                }
                await this.setStatus({
                    statusRelativeToLocal: 'updated',
                    isMisconfigured: false,
                    lastSynchronized: new Date(),
                    needsPassword: false,
                    isPushing: false,
                    isPulling: false,
                });
            }
        });
    }
    async unstageAll() {
        log.verbose("C/db/isogit: Unstaging all changes");
        await git.remove({ dir: this.workDir, filepath: '.' });
    }
    async _handleGitError(e) {
        log.debug("Handling Git error", e);
        if (e.code === 'FastForwardFail' || e.code === 'MergeNotSupportedFail') {
            // NOTE: There’s also PushRejectedNonFastForward, but it seems to be thrown
            // for unrelated cases during push (false positive).
            // Because of that false positive, we ignore that error and instead do pull first,
            // catching actual fast-forward fails on that step before push.
            await this.setStatus({ statusRelativeToLocal: 'diverged' });
        }
        else if (['MissingUsernameError', 'MissingAuthorError', 'MissingCommitterError'].indexOf(e.code) >= 0) {
            await this.setStatus({ isMisconfigured: true });
        }
        else if (e.code === 'MissingPasswordTokenError'
            || (e.code === 'HTTPError' && e.message.indexOf('Unauthorized') >= 0)) {
            log.warn("Password input required");
            this.setPassword(undefined);
            await this.setStatus({ needsPassword: true });
        }
    }
}
async function checkOnlineStatus(timeout = 4500) {
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
            try {
                req.abort();
            }
            catch (e) { }
            clearTimeout(checkTimeout);
            resolve(false);
        }
        function reportOnline() {
            log.info("C/db/isogit: Connection test: Report online");
            try {
                req.abort();
            }
            catch (e) { }
            clearTimeout(checkTimeout);
            resolve(true);
        }
    });
}
// TODO: Temporary workaround since isomorphic-git doesn’t seem to export its GitError class
// in any way available to TS, so we can’t use instanceof :(
export function isGitError(e) {
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
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFzZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9kYi9pc29naXQteWFtbC9tYWluL2lzb2dpdC9iYXNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sS0FBSyxLQUFLLE1BQU0sT0FBTyxDQUFDO0FBQy9CLE9BQU8sS0FBSyxJQUFJLE1BQU0sTUFBTSxDQUFDO0FBQzdCLE9BQU8sU0FBUyxNQUFNLFlBQVksQ0FBQztBQUNuQyxPQUFPLEtBQUssR0FBRyxNQUFNLGdCQUFnQixDQUFDO0FBQ3RDLE9BQU8sS0FBSyxHQUFHLE1BQU0sY0FBYyxDQUFDO0FBTXBDLE1BQU0sZUFBZSxHQUFHLFVBQVUsQ0FBQztBQUNuQyxNQUFNLFdBQVcsR0FBRyxRQUFRLENBQUM7QUFHN0IsTUFBTSxjQUFjLEdBQWM7SUFDaEMsUUFBUSxFQUFFLEtBQUs7SUFDZixlQUFlLEVBQUUsS0FBSztJQUN0QixlQUFlLEVBQUUsS0FBSztJQUN0QixhQUFhLEVBQUUsS0FBSztJQUNwQixxQkFBcUIsRUFBRSxTQUFTO0lBQ2hDLGdCQUFnQixFQUFFLElBQUk7SUFDdEIsU0FBUyxFQUFFLEtBQUs7SUFDaEIsU0FBUyxFQUFFLEtBQUs7Q0FDakIsQ0FBQTtBQUdELE1BQU0sT0FBTyxhQUFhO0lBVXhCLFlBQ1ksRUFBTyxFQUNQLE9BQWUsRUFDZixlQUFtQyxFQUMzQyxRQUFnQixFQUNSLE1BQXVDLEVBQ3hDLE9BQWUsRUFDZCxTQUFpQixFQUNqQixjQUFxRDtRQVByRCxPQUFFLEdBQUYsRUFBRSxDQUFLO1FBQ1AsWUFBTyxHQUFQLE9BQU8sQ0FBUTtRQUNmLG9CQUFlLEdBQWYsZUFBZSxDQUFvQjtRQUVuQyxXQUFNLEdBQU4sTUFBTSxDQUFpQztRQUN4QyxZQUFPLEdBQVAsT0FBTyxDQUFRO1FBQ2QsY0FBUyxHQUFULFNBQVMsQ0FBUTtRQUNqQixtQkFBYyxHQUFkLGNBQWMsQ0FBdUM7UUFoQnpELFNBQUksR0FBc0IsRUFBRSxDQUFDO1FBRTdCLGdCQUFXLEdBQUcsS0FBSyxDQUFDO1FBZ0IxQixHQUFHLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFMUIsSUFBSSxDQUFDLFdBQVcsR0FBRyxJQUFJLFNBQVMsQ0FBQyxFQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsVUFBVSxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUM7UUFFcEUsOENBQThDO1FBQzlDLElBQUksQ0FBQyxXQUFXLEdBQUcsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDL0MsSUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUM3QyxJQUFJLENBQUMsZ0JBQWdCLEdBQUcsSUFBSSxDQUFDLGdCQUFnQixDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUV6RCxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsR0FBRyxRQUFRLENBQUM7UUFFOUIsSUFBSSxDQUFDLE1BQU0sR0FBRyxjQUFjLENBQUM7SUFDL0IsQ0FBQztJQUdELHNDQUFzQztJQUN0Qyx5Q0FBeUM7SUFFakMsS0FBSyxDQUFDLFlBQVk7UUFDeEIsT0FBTyxNQUFNLElBQUksQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ2hELENBQUM7SUFFTyxLQUFLLENBQUMsU0FBUyxDQUFDLE1BQTBCO1FBQ2hELE1BQU0sQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxNQUFNLENBQUMsQ0FBQztRQUNuQyxNQUFNLElBQUksQ0FBQyxZQUFZLEVBQUUsQ0FBQztJQUM1QixDQUFDO0lBRU0sU0FBUztRQUNkLE9BQU8sSUFBSSxDQUFDLE1BQU0sQ0FBQztJQUNyQixDQUFDO0lBR0QsaUJBQWlCO0lBRVYsS0FBSyxDQUFDLGFBQWE7UUFDeEIsSUFBSSxlQUF3QixDQUFDO1FBQzdCLElBQUk7WUFDRixlQUFlLEdBQUcsQ0FBQyxNQUFNLElBQUksQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLE9BQU8sRUFBRSxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsV0FBVyxFQUFFLENBQUM7U0FDdkY7UUFBQyxPQUFPLENBQUMsRUFBRTtZQUNWLGVBQWUsR0FBRyxLQUFLLENBQUM7U0FDekI7UUFDRCxPQUFPLGVBQWUsQ0FBQztJQUN6QixDQUFDO0lBRU0sS0FBSyxDQUFDLGlCQUFpQixDQUFDLFVBQWlEO1FBQzlFLE1BQU0sTUFBTSxHQUFHLENBQUMsTUFBTSxJQUFJLENBQUMsWUFBWSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDeEQsTUFBTSxRQUFRLEdBQUcsQ0FBQyxNQUFNLElBQUksQ0FBQyxjQUFjLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUM1RCxPQUFPLE1BQU0sS0FBSyxVQUFVLENBQUMsTUFBTSxJQUFJLENBQUMsVUFBVSxDQUFDLFFBQVEsS0FBSyxTQUFTLElBQUksUUFBUSxLQUFLLFVBQVUsQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUNqSCxDQUFDO0lBRU0sYUFBYTtRQUNsQixPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRSxDQUFDO0lBQ2xELENBQUM7SUFFTSxXQUFXO1FBQ2hCLE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUM7SUFDNUIsQ0FBQztJQUVNLEtBQUssQ0FBQyxPQUFPO1FBQ2xCOzhFQUNzRTtRQUV0RSxHQUFHLENBQUMsSUFBSSxDQUFDLGtEQUFrRCxDQUFDLENBQUM7UUFDN0QsTUFBTSxJQUFJLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDckMsQ0FBQztJQUVPLEtBQUssQ0FBQyxlQUFlO1FBQzNCLHNGQUFzRjtRQUV0RixPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxPQUFPLENBQUMsR0FBRyxFQUFFLEtBQUssSUFBSSxFQUFFO1lBQ3BELEdBQUcsQ0FBQyxJQUFJLENBQUMsMkJBQTJCLENBQUMsQ0FBQztZQUV0QyxHQUFHLENBQUMsS0FBSyxDQUFDLHlEQUF5RCxDQUFDLENBQUM7WUFDckUsTUFBTSxJQUFJLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7WUFFdEMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxrQ0FBa0MsRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7WUFFOUQsSUFBSTtnQkFDRixNQUFNLEdBQUcsQ0FBQyxLQUFLLGlCQUNiLEdBQUcsRUFBRSxJQUFJLENBQUMsT0FBTyxFQUNqQixHQUFHLEVBQUUsSUFBSSxDQUFDLE9BQU8sRUFDakIsR0FBRyxFQUFFLFFBQVEsRUFDYixZQUFZLEVBQUUsSUFBSSxFQUNsQixLQUFLLEVBQUUsQ0FBQyxFQUNSLFNBQVMsRUFBRSxJQUFJLENBQUMsU0FBUyxJQUN0QixJQUFJLENBQUMsSUFBSSxFQUNaLENBQUM7Z0JBRUgsSUFBSSxJQUFJLENBQUMsZUFBZSxLQUFLLFNBQVMsRUFBRTtvQkFDdEMsR0FBRyxDQUFDLEtBQUssQ0FBQyxpREFBaUQsRUFBRSxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUM7b0JBQ25GLE1BQU0sR0FBRyxDQUFDLFNBQVMsQ0FBQzt3QkFDbEIsR0FBRyxFQUFFLElBQUksQ0FBQyxPQUFPO3dCQUNqQixNQUFNLEVBQUUsZUFBZTt3QkFDdkIsR0FBRyxFQUFFLElBQUksQ0FBQyxlQUFlO3FCQUMxQixDQUFDLENBQUM7aUJBQ0o7cUJBQU07b0JBQ0wsR0FBRyxDQUFDLElBQUksQ0FBQyx1REFBdUQsQ0FBQyxDQUFDO2lCQUNuRTthQUVGO1lBQUMsT0FBTyxDQUFDLEVBQUU7Z0JBQ1YsR0FBRyxDQUFDLEtBQUssQ0FBQywwQ0FBMEMsQ0FBQyxDQUFBO2dCQUNyRCxNQUFNLElBQUksQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztnQkFDbkMsTUFBTSxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQyxDQUFDO2dCQUM5QixNQUFNLENBQUMsQ0FBQzthQUNUO1FBQ0gsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDO0lBR0QsaUJBQWlCO0lBRVYsV0FBVyxDQUFDLEtBQXlCO1FBQzFDLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxHQUFHLEtBQUssQ0FBQztRQUMzQixJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsYUFBYSxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUM7SUFDM0MsQ0FBQztJQUdELGlCQUFpQjtJQUVqQixLQUFLLENBQUMsU0FBUyxDQUFDLElBQVksRUFBRSxHQUFXO1FBQ3ZDLEdBQUcsQ0FBQyxPQUFPLENBQUMseUJBQXlCLENBQUMsQ0FBQztRQUN2QyxNQUFNLEdBQUcsQ0FBQyxNQUFNLENBQUMsRUFBRSxHQUFHLEVBQUUsSUFBSSxDQUFDLE9BQU8sRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxHQUFHLEVBQUUsQ0FBQyxDQUFDO0lBQ2xFLENBQUM7SUFFRCxLQUFLLENBQUMsU0FBUyxDQUFDLElBQVk7UUFDMUIsR0FBRyxDQUFDLE9BQU8sQ0FBQyx5QkFBeUIsRUFBRSxJQUFJLENBQUMsQ0FBQztRQUM3QyxPQUFPLE1BQU0sR0FBRyxDQUFDLE1BQU0sQ0FBQyxFQUFFLEdBQUcsRUFBRSxJQUFJLENBQUMsT0FBTyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQzdELENBQUM7SUFFRCxLQUFLLENBQUMsb0JBQW9CLENBQUMsZ0JBQXdCLEVBQUUsVUFBa0I7UUFDckUsa0dBQWtHO1FBRWxHLE9BQU8sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxRQUFRLENBQUM7WUFDekIsR0FBRyxFQUFFLElBQUksQ0FBQyxPQUFPO1lBQ2pCLEdBQUcsRUFBRSxVQUFVO1lBQ2YsUUFBUSxFQUFFLGdCQUFnQjtTQUMzQixDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7SUFDdEIsQ0FBQztJQUVELEtBQUssQ0FBQyxJQUFJO1FBQ1IsR0FBRyxDQUFDLE9BQU8sQ0FBQyxxREFBcUQsQ0FBQyxDQUFDO1FBRW5FLE9BQU8sTUFBTSxHQUFHLENBQUMsSUFBSSxpQkFDbkIsR0FBRyxFQUFFLElBQUksQ0FBQyxPQUFPLEVBQ2pCLFlBQVksRUFBRSxJQUFJLEVBQ2xCLGVBQWUsRUFBRSxJQUFJLEVBRXJCLElBQUksRUFBRSxJQUFJLElBSVAsSUFBSSxDQUFDLElBQUksRUFDWixDQUFDO0lBQ0wsQ0FBQztJQUVELEtBQUssQ0FBQyxLQUFLLENBQUMsU0FBbUIsRUFBRSxRQUFRLEdBQUcsS0FBSztRQUMvQyxHQUFHLENBQUMsT0FBTyxDQUFDLGlDQUFpQyxTQUFTLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxVQUFVLFFBQVEsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDO1FBRTlHLEtBQUssTUFBTSxRQUFRLElBQUksU0FBUyxFQUFFO1lBQ2hDLElBQUksUUFBUSxLQUFLLElBQUksRUFBRTtnQkFDckIsTUFBTSxHQUFHLENBQUMsR0FBRyxDQUFDO29CQUNaLEdBQUcsRUFBRSxJQUFJLENBQUMsT0FBTztvQkFDakIsUUFBUSxFQUFFLFFBQVE7aUJBQ25CLENBQUMsQ0FBQzthQUNKO2lCQUFNO2dCQUNMLE1BQU0sR0FBRyxDQUFDLE1BQU0sQ0FBQztvQkFDZixHQUFHLEVBQUUsSUFBSSxDQUFDLE9BQU87b0JBQ2pCLFFBQVEsRUFBRSxRQUFRO2lCQUNuQixDQUFDLENBQUM7YUFDSjtTQUNGO0lBQ0gsQ0FBQztJQUVELEtBQUssQ0FBQyxNQUFNLENBQUMsR0FBVztRQUN0QixHQUFHLENBQUMsT0FBTyxDQUFDLHdDQUF3QyxHQUFHLEVBQUUsQ0FBQyxDQUFDO1FBRTNELE9BQU8sTUFBTSxHQUFHLENBQUMsTUFBTSxDQUFDO1lBQ3RCLEdBQUcsRUFBRSxJQUFJLENBQUMsT0FBTztZQUNqQixPQUFPLEVBQUUsR0FBRztZQUNaLE1BQU0sRUFBRSxJQUFJLENBQUMsTUFBTTtTQUNwQixDQUFDLENBQUM7SUFDTCxDQUFDO0lBRUQsS0FBSyxDQUFDLFdBQVc7UUFDZixNQUFNLEdBQUcsQ0FBQyxLQUFLLGlCQUFHLEdBQUcsRUFBRSxJQUFJLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxXQUFXLElBQUssSUFBSSxDQUFDLElBQUksRUFBRyxDQUFDO0lBQzVFLENBQUM7SUFFRCxLQUFLLENBQUMsYUFBYTtRQUNqQixNQUFNLEdBQUcsQ0FBQyxLQUFLLGlCQUFHLEdBQUcsRUFBRSxJQUFJLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxlQUFlLElBQUssSUFBSSxDQUFDLElBQUksRUFBRyxDQUFDO0lBQ2hGLENBQUM7SUFFRCxLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUssR0FBRyxLQUFLO1FBQ3RCLEdBQUcsQ0FBQyxPQUFPLENBQUMsc0JBQXNCLENBQUMsQ0FBQztRQUVwQyxPQUFPLE1BQU0sR0FBRyxDQUFDLElBQUksaUJBQ25CLEdBQUcsRUFBRSxJQUFJLENBQUMsT0FBTyxFQUNqQixNQUFNLEVBQUUsV0FBVyxFQUNuQixLQUFLLEVBQUUsS0FBSyxJQUNULElBQUksQ0FBQyxJQUFJLEVBQ1osQ0FBQztJQUNMLENBQUM7SUFFTSxLQUFLLENBQUMsVUFBVSxDQUFDLEtBQWdCO1FBQ3RDLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLE9BQU8sQ0FBQyxHQUFHLEVBQUUsS0FBSyxJQUFJLEVBQUU7WUFDcEQsR0FBRyxDQUFDLE9BQU8sQ0FBQyxvQ0FBb0MsQ0FBQyxDQUFDO1lBRWxELE9BQU8sTUFBTSxHQUFHLENBQUMsWUFBWSxDQUFDO2dCQUM1QixHQUFHLEVBQUUsSUFBSSxDQUFDLE9BQU87Z0JBQ2pCLEtBQUssRUFBRSxJQUFJO2dCQUNYLFNBQVMsRUFBRSxLQUFLLElBQUksQ0FBQyxNQUFNLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO2FBQ3BELENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVELEtBQUssQ0FBQyxZQUFZO1FBQ2hCLE9BQU8sQ0FBQyxDQUFDLE1BQU0sR0FBRyxDQUFDLFdBQVcsQ0FBQztZQUM3QixHQUFHLEVBQUUsSUFBSSxDQUFDLE9BQU87U0FDbEIsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLE1BQU0sS0FBSyxXQUFXLENBQUMsSUFBSSxFQUFFLEdBQUcsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLEdBQUcsQ0FBQztJQUNoRSxDQUFDO0lBRUQsS0FBSyxDQUFDLGNBQWM7UUFDbEIsT0FBTyxDQUFDLENBQUMsTUFBTSxHQUFHLENBQUMsV0FBVyxDQUFDO1lBQzdCLEdBQUcsRUFBRSxJQUFJLENBQUMsT0FBTztTQUNsQixDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxLQUFLLGVBQWUsQ0FBQyxJQUFJLEVBQUUsR0FBRyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsR0FBRyxDQUFDO0lBQ3BFLENBQUM7SUFFRCxLQUFLLENBQUMsZ0JBQWdCO1FBQ3BCOzs7Ozs7Ozs7Ozs7Ozs7Ozs7O1VBbUJFO1FBRUYsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLEdBQUcsRUFBRSxLQUFLLElBQUksRUFBRTtZQUNwRCxNQUFNLGtCQUFrQixHQUFHLE1BQU0sR0FBRyxDQUFDLFVBQVUsQ0FBQztnQkFDOUMsR0FBRyxFQUFFLElBQUksQ0FBQyxPQUFPO2dCQUNqQixHQUFHLEVBQUUsR0FBRyxXQUFXLFNBQVM7YUFDN0IsQ0FBQyxDQUFDO1lBRUgsTUFBTSxZQUFZLEdBQUcsTUFBTSxHQUFHLENBQUMsR0FBRyxDQUFDO2dCQUNqQyxHQUFHLEVBQUUsSUFBSSxDQUFDLE9BQU87Z0JBQ2pCLEtBQUssRUFBRSxHQUFHO2FBQ1gsQ0FBQyxDQUFDO1lBRUgsSUFBSSxPQUFPLEdBQUcsRUFBYyxDQUFDO1lBQzdCLEtBQUssTUFBTSxNQUFNLElBQUksWUFBWSxFQUFFO2dCQUNqQyxJQUFJLE1BQU0sR0FBRyxDQUFDLFlBQVksQ0FBQyxFQUFFLEdBQUcsRUFBRSxJQUFJLENBQUMsT0FBTyxFQUFFLEdBQUcsRUFBRSxNQUFNLENBQUMsR0FBRyxFQUFFLFFBQVEsRUFBRSxrQkFBa0IsRUFBRSxDQUFDLEVBQUU7b0JBQ2hHLE9BQU8sQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDO2lCQUM5QjtxQkFBTTtvQkFDTCxPQUFPLE9BQU8sQ0FBQztpQkFDaEI7YUFDRjtZQUVELE1BQU0sSUFBSSxLQUFLLENBQUMsa0VBQWtFLENBQUMsQ0FBQztRQUN0RixDQUFDLENBQUMsQ0FBQztJQUNMLENBQUM7SUFFTSxLQUFLLENBQUMsZ0JBQWdCLENBQUMsU0FBUyxHQUFHLENBQUMsR0FBRyxDQUFDO1FBQzdDLHNGQUFzRjtRQUV0RixNQUFNLElBQUksR0FBRyxDQUFDLEVBQUUsSUFBSSxHQUFHLENBQUMsRUFBRSxPQUFPLEdBQUcsQ0FBQyxDQUFDO1FBRXRDLE9BQU8sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxZQUFZLENBQUMsRUFBRSxHQUFHLEVBQUUsSUFBSSxDQUFDLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxFQUFFLENBQUMsQ0FBQzthQUN6RSxNQUFNLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEtBQUssR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDO2FBQ3pDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQzthQUNyQixNQUFNLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLElBQUksUUFBUSxLQUFLLFdBQVcsQ0FBQyxDQUFDO0lBQ2hGLENBQUM7SUFFTSxLQUFLLENBQUMsY0FBYyxDQUFDLFNBQW1CLEVBQUUsR0FBVyxFQUFFLFFBQVEsR0FBRyxLQUFLO1FBQzVFOzs7Ozs7Ozs7Ozs7VUFZRTtRQUVGLElBQUksU0FBUyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUU7WUFDeEIsTUFBTSxJQUFJLEtBQUssQ0FBQyxtQ0FBbUMsQ0FBQyxDQUFDO1NBQ3REO1FBRUQsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLEdBQUcsRUFBRSxLQUFLLElBQUksRUFBRTtZQUNwRCxHQUFHLENBQUMsT0FBTyxDQUFDLHdDQUF3QyxTQUFTLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztZQUU1RSxNQUFNLFlBQVksR0FBRyxDQUFDLE1BQU0sSUFBSSxDQUFDLGdCQUFnQixDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDO1lBQ3JFLElBQUksWUFBWSxHQUFHLENBQUMsRUFBRTtnQkFDcEIsT0FBTyxDQUFDLENBQUM7YUFDVjtZQUVELE1BQU0sSUFBSSxDQUFDLFVBQVUsRUFBRSxDQUFDO1lBQ3hCLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxTQUFTLEVBQUUsUUFBUSxDQUFDLENBQUM7WUFDdEMsTUFBTSxJQUFJLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1lBRXZCLE9BQU8sWUFBWSxDQUFDO1FBQ3RCLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVNLEtBQUssQ0FBQyxnQkFBZ0I7UUFDM0I7b0RBQzRDO1FBRTVDLEdBQUcsQ0FBQyxLQUFLLENBQUMsK0NBQStDLENBQUMsQ0FBQztRQUMzRCxNQUFNLFlBQVksR0FBRyxNQUFNLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO1FBQ25ELEdBQUcsQ0FBQyxLQUFLLENBQUMsNkJBQTZCLEVBQUUsWUFBWSxDQUFDLENBQUM7UUFDdkQsTUFBTSxlQUFlLEdBQUcsWUFBWSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUM7UUFDaEQsTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsZUFBZSxFQUFFLENBQUMsQ0FBQztRQUMxQyxPQUFPLGVBQWUsQ0FBQztJQUN6QixDQUFDO0lBRU0sV0FBVztRQUNoQixJQUFJLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQztJQUMxQixDQUFDO0lBRU0sS0FBSyxDQUFDLFdBQVc7UUFDdEI7OzsrREFHdUQ7UUFFdkQsR0FBRyxDQUFDLE9BQU8sQ0FBQyx1Q0FBdUMsQ0FBQyxDQUFDO1FBRXJELElBQUksQ0FBQyxDQUFDLE1BQU0sSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDLEVBQUU7WUFDakMsTUFBTSxJQUFJLENBQUMsZUFBZSxFQUFFLENBQUM7U0FFOUI7YUFBTTtZQUNMLEdBQUcsQ0FBQyxPQUFPLENBQUMsK0NBQStDLENBQUMsQ0FBQztZQUU3RCxNQUFNLHFCQUFxQixHQUFHLE1BQU0sSUFBSSxDQUFDLGdCQUFnQixFQUFFLENBQUM7WUFFNUQsSUFBSSxxQkFBcUIsRUFBRTtnQkFDekIsNERBQTREO2dCQUM1RCxNQUFNLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxlQUFlLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztnQkFDaEQsT0FBTzthQUNSO2lCQUFNO2dCQUNMLDRFQUE0RTtnQkFDNUUsc0ZBQXNGO2dCQUN0RixNQUFNLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO2FBQzlCO1NBQ0Y7UUFFRCxJQUFJLElBQUksQ0FBQyxXQUFXLENBQUMsTUFBTSxFQUFFLEVBQUU7WUFDN0IsR0FBRyxDQUFDLE9BQU8sQ0FBQywwQ0FBMEMsQ0FBQyxDQUFDO1lBQ3hELE9BQU87U0FDUjtRQUVELEdBQUcsQ0FBQyxPQUFPLENBQUMsa0RBQWtELENBQUMsQ0FBQztRQUVoRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxPQUFPLENBQUMsR0FBRyxFQUFFLEtBQUssSUFBSSxFQUFFO1lBQ3BELEdBQUcsQ0FBQyxPQUFPLENBQUMsNEJBQTRCLENBQUMsQ0FBQztZQUUxQyxNQUFNLFFBQVEsR0FBRyxDQUFDLE1BQU0saUJBQWlCLEVBQUUsQ0FBQyxLQUFLLElBQUksQ0FBQztZQUV0RCxJQUFJLFFBQVEsRUFBRTtnQkFDWixNQUFNLGFBQWEsR0FBRyxJQUFJLENBQUMsYUFBYSxFQUFFLENBQUM7Z0JBQzNDLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLGFBQWEsRUFBRSxDQUFDLENBQUM7Z0JBQ3hDLElBQUksYUFBYSxFQUFFO29CQUNqQixPQUFPO2lCQUNSO2dCQUVELE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO2dCQUV6QyxNQUFNLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztnQkFDMUMsSUFBSTtvQkFDRixNQUFNLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztpQkFDbkI7Z0JBQUMsT0FBTyxDQUFDLEVBQUU7b0JBQ1YsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztvQkFDYixNQUFNLElBQUksQ0FBQyxTQUFTLENBQUM7d0JBQ25CLGdCQUFnQixFQUFFLElBQUksSUFBSSxFQUFFO3dCQUM1QixTQUFTLEVBQUUsS0FBSzt3QkFDaEIsU0FBUyxFQUFFLEtBQUs7cUJBQ2pCLENBQUMsQ0FBQztvQkFDSCxNQUFNLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLENBQUM7b0JBQzlCLE9BQU87aUJBQ1I7Z0JBQ0QsNkNBQTZDO2dCQUU3QyxJQUFJLElBQUksQ0FBQyxXQUFXLEVBQUU7b0JBQ3BCLCtFQUErRTtvQkFDL0UsTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7b0JBQzFDLElBQUk7d0JBQ0YsTUFBTSxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7cUJBQ25CO29CQUFDLE9BQU8sQ0FBQyxFQUFFO3dCQUNWLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7d0JBQ2IsTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDOzRCQUNuQixnQkFBZ0IsRUFBRSxJQUFJLElBQUksRUFBRTs0QkFDNUIsU0FBUyxFQUFFLEtBQUs7NEJBQ2hCLFNBQVMsRUFBRSxLQUFLO3lCQUNqQixDQUFDLENBQUM7d0JBQ0gsTUFBTSxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQyxDQUFDO3dCQUM5QixPQUFPO3FCQUNSO29CQUNELElBQUksQ0FBQyxXQUFXLEdBQUcsS0FBSyxDQUFDO29CQUN6Qiw2Q0FBNkM7aUJBQzlDO2dCQUVELE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQztvQkFDbkIscUJBQXFCLEVBQUUsU0FBUztvQkFDaEMsZUFBZSxFQUFFLEtBQUs7b0JBQ3RCLGdCQUFnQixFQUFFLElBQUksSUFBSSxFQUFFO29CQUM1QixhQUFhLEVBQUUsS0FBSztvQkFDcEIsU0FBUyxFQUFFLEtBQUs7b0JBQ2hCLFNBQVMsRUFBRSxLQUFLO2lCQUNqQixDQUFDLENBQUM7YUFDSjtRQUNILENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVPLEtBQUssQ0FBQyxVQUFVO1FBQ3RCLEdBQUcsQ0FBQyxPQUFPLENBQUMsb0NBQW9DLENBQUMsQ0FBQztRQUNsRCxNQUFNLEdBQUcsQ0FBQyxNQUFNLENBQUMsRUFBRSxHQUFHLEVBQUUsSUFBSSxDQUFDLE9BQU8sRUFBRSxRQUFRLEVBQUUsR0FBRyxFQUFFLENBQUMsQ0FBQztJQUN6RCxDQUFDO0lBRU8sS0FBSyxDQUFDLGVBQWUsQ0FBQyxDQUEyQjtRQUN2RCxHQUFHLENBQUMsS0FBSyxDQUFDLG9CQUFvQixFQUFFLENBQUMsQ0FBQyxDQUFDO1FBRW5DLElBQUksQ0FBQyxDQUFDLElBQUksS0FBSyxpQkFBaUIsSUFBSSxDQUFDLENBQUMsSUFBSSxLQUFLLHVCQUF1QixFQUFFO1lBQ3RFLDJFQUEyRTtZQUMzRSxvREFBb0Q7WUFDcEQsa0ZBQWtGO1lBQ2xGLCtEQUErRDtZQUMvRCxNQUFNLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxxQkFBcUIsRUFBRSxVQUFVLEVBQUUsQ0FBQyxDQUFDO1NBQzdEO2FBQU0sSUFBSSxDQUFDLHNCQUFzQixFQUFFLG9CQUFvQixFQUFFLHVCQUF1QixDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUU7WUFDdkcsTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsZUFBZSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7U0FDakQ7YUFBTSxJQUNILENBQUMsQ0FBQyxJQUFJLEtBQUssMkJBQTJCO2VBQ25DLENBQUMsQ0FBQyxDQUFDLElBQUksS0FBSyxXQUFXLElBQUksQ0FBQyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsY0FBYyxDQUFDLElBQUksQ0FBQyxDQUFDLEVBQUU7WUFDekUsR0FBRyxDQUFDLElBQUksQ0FBQyx5QkFBeUIsQ0FBQyxDQUFDO1lBQ3BDLElBQUksQ0FBQyxXQUFXLENBQUMsU0FBUyxDQUFDLENBQUM7WUFDNUIsTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsYUFBYSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7U0FDL0M7SUFDSCxDQUFDO0NBQ0Y7QUFHRCxLQUFLLFVBQVUsaUJBQWlCLENBQUMsT0FBTyxHQUFHLElBQUk7SUFDN0MsMENBQTBDO0lBQzFDLE9BQU8sSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRTtRQUM3QixHQUFHLENBQUMsS0FBSyxDQUFDLHdDQUF3QyxDQUFDLENBQUM7UUFFcEQsTUFBTSxHQUFHLEdBQUcsS0FBSyxDQUFDLEdBQUcsQ0FBQyxxQkFBcUIsRUFBRSxFQUFFLE9BQU8sRUFBRSxFQUFFLFlBQVksQ0FBQyxDQUFDO1FBRXhFLEdBQUcsQ0FBQyxFQUFFLENBQUMsT0FBTyxFQUFFLEdBQUcsRUFBRSxDQUFDLEdBQUcsQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDO1FBQ25DLEdBQUcsQ0FBQyxFQUFFLENBQUMsVUFBVSxFQUFFLFlBQVksQ0FBQyxDQUFDO1FBQ2pDLEdBQUcsQ0FBQyxFQUFFLENBQUMsU0FBUyxFQUFFLFlBQVksQ0FBQyxDQUFDO1FBQ2hDLEdBQUcsQ0FBQyxFQUFFLENBQUMsVUFBVSxFQUFFLFlBQVksQ0FBQyxDQUFDO1FBQ2pDLEdBQUcsQ0FBQyxFQUFFLENBQUMsU0FBUyxFQUFFLFlBQVksQ0FBQyxDQUFDO1FBQ2hDLEdBQUcsQ0FBQyxFQUFFLENBQUMsU0FBUyxFQUFFLGFBQWEsQ0FBQyxDQUFDO1FBRWpDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztRQUVWLE1BQU0sWUFBWSxHQUFHLFVBQVUsQ0FBQyxhQUFhLEVBQUUsT0FBTyxDQUFDLENBQUM7UUFFeEQsU0FBUyxhQUFhO1lBQ3BCLEdBQUcsQ0FBQyxJQUFJLENBQUMsOENBQThDLENBQUMsQ0FBQztZQUN6RCxJQUFJO2dCQUFFLEdBQUcsQ0FBQyxLQUFLLEVBQUUsQ0FBQzthQUFFO1lBQUMsT0FBTyxDQUFDLEVBQUUsR0FBRTtZQUNqQyxZQUFZLENBQUMsWUFBWSxDQUFDLENBQUM7WUFDM0IsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ2pCLENBQUM7UUFDRCxTQUFTLFlBQVk7WUFDbkIsR0FBRyxDQUFDLElBQUksQ0FBQyw2Q0FBNkMsQ0FBQyxDQUFDO1lBQ3hELElBQUk7Z0JBQUUsR0FBRyxDQUFDLEtBQUssRUFBRSxDQUFDO2FBQUU7WUFBQyxPQUFPLENBQUMsRUFBRSxHQUFFO1lBQ2pDLFlBQVksQ0FBQyxZQUFZLENBQUMsQ0FBQztZQUMzQixPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDaEIsQ0FBQztJQUNILENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQztBQUdELDRGQUE0RjtBQUM1Riw0REFBNEQ7QUFFNUQsTUFBTSxVQUFVLFVBQVUsQ0FBQyxDQUEyQjtJQUNwRCxJQUFJLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRTtRQUNYLE9BQU8sS0FBSyxDQUFDO0tBQ2Q7SUFDRCxPQUFPLE1BQU0sQ0FBQyxJQUFJLENBQUMsdUJBQXVCLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUNuRSxDQUFDO0FBRUQsTUFBTSx1QkFBdUIsR0FBRztJQUM5QixhQUFhLEVBQUUsZUFBZTtJQUM5Qiw2QkFBNkIsRUFBRSwrQkFBK0I7SUFDOUQsbUJBQW1CLEVBQUUscUJBQXFCO0lBQzFDLGdDQUFnQyxFQUFFLGtDQUFrQztJQUNwRSxjQUFjLEVBQUUsZ0JBQWdCO0lBQ2hDLGlCQUFpQixFQUFFLG1CQUFtQjtJQUN0QyxpQkFBaUIsRUFBRSxtQkFBbUI7SUFDdEMsaUJBQWlCLEVBQUUsbUJBQW1CO0lBQ3RDLHFCQUFxQixFQUFFLHVCQUF1QjtJQUM5QyxxQkFBcUIsRUFBRSx1QkFBdUI7SUFDOUMsdUJBQXVCLEVBQUUseUJBQXlCO0lBQ2xELDZCQUE2QixFQUFFLCtCQUErQjtJQUM5RCw0QkFBNEIsRUFBRSw4QkFBOEI7SUFDNUQsNkJBQTZCLEVBQUUsK0JBQStCO0lBQzlELGtCQUFrQixFQUFFLG9CQUFvQjtJQUN4QyxxQkFBcUIsRUFBRSx1QkFBdUI7SUFDOUMsa0JBQWtCLEVBQUUsb0JBQW9CO0lBQ3hDLG9CQUFvQixFQUFFLHNCQUFzQjtJQUM1Qyw2QkFBNkIsRUFBRSwrQkFBK0I7SUFDOUQsMEJBQTBCLEVBQUUsNEJBQTRCO0lBQ3hELCtCQUErQixFQUFFLGlDQUFpQztJQUNsRSxtQ0FBbUMsRUFBRSxxQ0FBcUM7SUFDMUUsaUNBQWlDLEVBQUUsbUNBQW1DO0lBQ3RFLHNDQUFzQyxFQUFFLHdDQUF3QztJQUNoRiw2QkFBNkIsRUFBRSwrQkFBK0I7SUFDOUQscUJBQXFCLEVBQUUsdUJBQXVCO0lBQzlDLGVBQWUsRUFBRSxpQkFBaUI7SUFDbEMscUJBQXFCLEVBQUUsdUJBQXVCO0lBQzlDLHdCQUF3QixFQUFFLDBCQUEwQjtJQUNwRCxnQkFBZ0IsRUFBRSxrQkFBa0I7SUFDcEMsa0JBQWtCLEVBQUUsb0JBQW9CO0lBQ3hDLHFCQUFxQixFQUFFLHVCQUF1QjtJQUM5Qyx1QkFBdUIsRUFBRSx5QkFBeUI7SUFDbEQsa0JBQWtCLEVBQUUsb0JBQW9CO0lBQ3hDLGNBQWMsRUFBRSxnQkFBZ0I7SUFDaEMsWUFBWSxFQUFFLGNBQWM7SUFDNUIsd0JBQXdCLEVBQUUsMEJBQTBCO0lBQ3BELHFCQUFxQixFQUFFLHVCQUF1QjtJQUM5QyxlQUFlLEVBQUUsaUJBQWlCO0lBQ2xDLGNBQWMsRUFBRSxnQkFBZ0I7SUFDaEMsdUJBQXVCLEVBQUUseUJBQXlCO0lBQ2xELHdCQUF3QixFQUFFLDBCQUEwQjtJQUNwRCxTQUFTLEVBQUUsV0FBVztJQUN0QixtQkFBbUIsRUFBRSxxQkFBcUI7SUFDMUMscUJBQXFCLEVBQUUsdUJBQXVCO0lBQzlDLG1CQUFtQixFQUFFLHFCQUFxQjtJQUMxQyx5QkFBeUIsRUFBRSwyQkFBMkI7SUFDdEQsWUFBWSxFQUFFLGNBQWM7SUFDNUIsbUJBQW1CLEVBQUUscUJBQXFCO0lBQzFDLHlCQUF5QixFQUFFLDJCQUEyQjtJQUN0RCxvQkFBb0IsRUFBRSxzQkFBc0I7SUFDNUMscUJBQXFCLEVBQUUsdUJBQXVCO0lBQzlDLDZCQUE2QixFQUFFLCtCQUErQjtJQUM5RCxpQkFBaUIsRUFBRSxtQkFBbUI7SUFDdEMsd0NBQXdDLEVBQUUsMENBQTBDO0lBQ3BGLHdDQUF3QyxFQUFFLDBDQUEwQztJQUNwRixnREFBZ0QsRUFBRSxrREFBa0Q7SUFDcEcsaUNBQWlDLEVBQUUsbUNBQW1DO0lBQ3RFLGlDQUFpQyxFQUFFLG1DQUFtQztJQUN0RSx5Q0FBeUMsRUFBRSwyQ0FBMkM7SUFDdEYsc0JBQXNCLEVBQUUsd0JBQXdCO0lBQ2hELDBCQUEwQixFQUFFLDRCQUE0QjtJQUN4RCxxQkFBcUIsRUFBRSx1QkFBdUI7SUFDOUMsMEJBQTBCLEVBQUUsNEJBQTRCO0lBQ3hELGVBQWUsRUFBRSxpQkFBaUI7SUFDbEMsWUFBWSxFQUFFLGNBQWM7SUFDNUIscUJBQXFCLEVBQUUsdUJBQXVCO0lBQzlDLGtCQUFrQixFQUFFLG9CQUFvQjtJQUN4QyxpQkFBaUIsRUFBRSxtQkFBbUI7SUFDdEMsZ0JBQWdCLEVBQUUsa0JBQWtCO0lBQ3BDLHFCQUFxQixFQUFFLHVCQUF1QjtDQUMvQyxDQUFBIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgaHR0cHMgZnJvbSAnaHR0cHMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCBBc3luY0xvY2sgZnJvbSAnYXN5bmMtbG9jayc7XG5pbXBvcnQgKiBhcyBnaXQgZnJvbSAnaXNvbW9ycGhpYy1naXQnO1xuaW1wb3J0ICogYXMgbG9nIGZyb20gJ2VsZWN0cm9uLWxvZyc7XG5cbmltcG9ydCB7IEdpdFN0YXR1cyB9IGZyb20gJy4uLy4uL2Jhc2UnO1xuaW1wb3J0IHsgR2l0QXV0aGVudGljYXRpb24gfSBmcm9tICcuL3R5cGVzJztcblxuXG5jb25zdCBVUFNUUkVBTV9SRU1PVEUgPSAndXBzdHJlYW0nO1xuY29uc3QgTUFJTl9SRU1PVEUgPSAnb3JpZ2luJztcblxuXG5jb25zdCBJTklUSUFMX1NUQVRVUzogR2l0U3RhdHVzID0ge1xuICBpc09ubGluZTogZmFsc2UsXG4gIGlzTWlzY29uZmlndXJlZDogZmFsc2UsXG4gIGhhc0xvY2FsQ2hhbmdlczogZmFsc2UsXG4gIG5lZWRzUGFzc3dvcmQ6IGZhbHNlLFxuICBzdGF0dXNSZWxhdGl2ZVRvTG9jYWw6IHVuZGVmaW5lZCxcbiAgbGFzdFN5bmNocm9uaXplZDogbnVsbCxcbiAgaXNQdXNoaW5nOiBmYWxzZSxcbiAgaXNQdWxsaW5nOiBmYWxzZSxcbn1cblxuXG5leHBvcnQgY2xhc3MgSXNvR2l0V3JhcHBlciB7XG5cbiAgcHJpdmF0ZSBhdXRoOiBHaXRBdXRoZW50aWNhdGlvbiA9IHt9O1xuXG4gIHByaXZhdGUgcHVzaFBlbmRpbmcgPSBmYWxzZTtcblxuICBwcml2YXRlIHN0YWdpbmdMb2NrOiBBc3luY0xvY2s7XG5cbiAgcHJpdmF0ZSBzdGF0dXM6IEdpdFN0YXR1cztcblxuICBjb25zdHJ1Y3RvcihcbiAgICAgIHByaXZhdGUgZnM6IGFueSxcbiAgICAgIHByaXZhdGUgcmVwb1VybDogc3RyaW5nLFxuICAgICAgcHJpdmF0ZSB1cHN0cmVhbVJlcG9Vcmw6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgIHVzZXJuYW1lOiBzdHJpbmcsXG4gICAgICBwcml2YXRlIGF1dGhvcjogeyBuYW1lOiBzdHJpbmcsIGVtYWlsOiBzdHJpbmcgfSxcbiAgICAgIHB1YmxpYyB3b3JrRGlyOiBzdHJpbmcsXG4gICAgICBwcml2YXRlIGNvcnNQcm94eTogc3RyaW5nLFxuICAgICAgcHJpdmF0ZSBzdGF0dXNSZXBvcnRlcjogKHBheWxvYWQ6IEdpdFN0YXR1cykgPT4gUHJvbWlzZTx2b2lkPikge1xuXG4gICAgZ2l0LnBsdWdpbnMuc2V0KCdmcycsIGZzKTtcblxuICAgIHRoaXMuc3RhZ2luZ0xvY2sgPSBuZXcgQXN5bmNMb2NrKHsgdGltZW91dDogMjAwMDAsIG1heFBlbmRpbmc6IDIgfSk7XG5cbiAgICAvLyBNYWtlcyBpdCBlYXNpZXIgdG8gYmluZCB0aGVzZSB0byBJUEMgZXZlbnRzXG4gICAgdGhpcy5zeW5jaHJvbml6ZSA9IHRoaXMuc3luY2hyb25pemUuYmluZCh0aGlzKTtcbiAgICB0aGlzLnJlc2V0RmlsZXMgPSB0aGlzLnJlc2V0RmlsZXMuYmluZCh0aGlzKTtcbiAgICB0aGlzLmNoZWNrVW5jb21taXR0ZWQgPSB0aGlzLmNoZWNrVW5jb21taXR0ZWQuYmluZCh0aGlzKTtcblxuICAgIHRoaXMuYXV0aC51c2VybmFtZSA9IHVzZXJuYW1lO1xuXG4gICAgdGhpcy5zdGF0dXMgPSBJTklUSUFMX1NUQVRVUztcbiAgfVxuXG5cbiAgLy8gUmVwb3J0aW5nIEdpdCBzdGF0dXMgdG8gREIgYmFja2VuZCxcbiAgLy8gc28gdGhhdCBpdCBjYW4gYmUgcmVmbGVjdGVkIGluIHRoZSBHVUlcblxuICBwcml2YXRlIGFzeW5jIHJlcG9ydFN0YXR1cygpIHtcbiAgICByZXR1cm4gYXdhaXQgdGhpcy5zdGF0dXNSZXBvcnRlcih0aGlzLnN0YXR1cyk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHNldFN0YXR1cyhzdGF0dXM6IFBhcnRpYWw8R2l0U3RhdHVzPikge1xuICAgIE9iamVjdC5hc3NpZ24odGhpcy5zdGF0dXMsIHN0YXR1cyk7XG4gICAgYXdhaXQgdGhpcy5yZXBvcnRTdGF0dXMoKTtcbiAgfVxuXG4gIHB1YmxpYyBnZXRTdGF0dXMoKTogR2l0U3RhdHVzIHtcbiAgICByZXR1cm4gdGhpcy5zdGF0dXM7XG4gIH1cblxuXG4gIC8vIEluaXRpbGFpemF0aW9uXG5cbiAgcHVibGljIGFzeW5jIGlzSW5pdGlhbGl6ZWQoKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgbGV0IGhhc0dpdERpcmVjdG9yeTogYm9vbGVhbjtcbiAgICB0cnkge1xuICAgICAgaGFzR2l0RGlyZWN0b3J5ID0gKGF3YWl0IHRoaXMuZnMuc3RhdChwYXRoLmpvaW4odGhpcy53b3JrRGlyLCAnLmdpdCcpKSkuaXNEaXJlY3RvcnkoKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBoYXNHaXREaXJlY3RvcnkgPSBmYWxzZTtcbiAgICB9XG4gICAgcmV0dXJuIGhhc0dpdERpcmVjdG9yeTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBpc1VzaW5nUmVtb3RlVVJMcyhyZW1vdGVVcmxzOiB7IG9yaWdpbjogc3RyaW5nLCB1cHN0cmVhbT86IHN0cmluZyB9KTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgY29uc3Qgb3JpZ2luID0gKGF3YWl0IHRoaXMuZ2V0T3JpZ2luVXJsKCkgfHwgJycpLnRyaW0oKTtcbiAgICBjb25zdCB1cHN0cmVhbSA9IChhd2FpdCB0aGlzLmdldFVwc3RyZWFtVXJsKCkgfHwgJycpLnRyaW0oKTtcbiAgICByZXR1cm4gb3JpZ2luID09PSByZW1vdGVVcmxzLm9yaWdpbiAmJiAocmVtb3RlVXJscy51cHN0cmVhbSA9PT0gdW5kZWZpbmVkIHx8IHVwc3RyZWFtID09PSByZW1vdGVVcmxzLnVwc3RyZWFtKTtcbiAgfVxuXG4gIHB1YmxpYyBuZWVkc1Bhc3N3b3JkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiAodGhpcy5hdXRoLnBhc3N3b3JkIHx8ICcnKS50cmltKCkgPT09ICcnO1xuICB9XG5cbiAgcHVibGljIGdldFVzZXJuYW1lKCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMuYXV0aC51c2VybmFtZTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBkZXN0cm95KCkge1xuICAgIC8qIFJlbW92ZXMgd29ya2luZyBkaXJlY3RvcnkuXG4gICAgICAgT24gbmV4dCBzeW5jIEdpdCByZXBvIHdpbGwgaGF2ZSB0byBiZSByZWluaXRpYWxpemVkLCBjbG9uZWQgZXRjLiAqL1xuXG4gICAgbG9nLndhcm4oXCJDL2RiL2lzb2dpdDogSW5pdGlhbGl6ZTogUmVtb3ZpbmcgZGF0YSBkaXJlY3RvcnlcIik7XG4gICAgYXdhaXQgdGhpcy5mcy5yZW1vdmUodGhpcy53b3JrRGlyKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgZm9yY2VJbml0aWFsaXplKCkge1xuICAgIC8qIEluaXRpYWxpemVzIGZyb20gc2NyYXRjaDogd2lwZXMgd29yayBkaXJlY3RvcnksIGNsb25lcyByZXBvc2l0b3J5LCBhZGRzIHJlbW90ZXMuICovXG5cbiAgICByZXR1cm4gYXdhaXQgdGhpcy5zdGFnaW5nTG9jay5hY3F1aXJlKCcxJywgYXN5bmMgKCkgPT4ge1xuICAgICAgbG9nLndhcm4oXCJDL2RiL2lzb2dpdDogSW5pdGlhbGl6aW5nXCIpO1xuXG4gICAgICBsb2cuc2lsbHkoXCJDL2RiL2lzb2dpdDogSW5pdGlhbGl6ZTogRW5zdXJpbmcgZGF0YSBkaXJlY3RvcnkgZXhpc3RzXCIpO1xuICAgICAgYXdhaXQgdGhpcy5mcy5lbnN1cmVEaXIodGhpcy53b3JrRGlyKTtcblxuICAgICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogSW5pdGlhbGl6ZTogQ2xvbmluZ1wiLCB0aGlzLnJlcG9VcmwpO1xuXG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBnaXQuY2xvbmUoe1xuICAgICAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgICAgIHVybDogdGhpcy5yZXBvVXJsLFxuICAgICAgICAgIHJlZjogJ21hc3RlcicsXG4gICAgICAgICAgc2luZ2xlQnJhbmNoOiB0cnVlLFxuICAgICAgICAgIGRlcHRoOiA1LFxuICAgICAgICAgIGNvcnNQcm94eTogdGhpcy5jb3JzUHJveHksXG4gICAgICAgICAgLi4udGhpcy5hdXRoLFxuICAgICAgICB9KTtcblxuICAgICAgICBpZiAodGhpcy51cHN0cmVhbVJlcG9VcmwgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGxvZy5kZWJ1ZyhcIkMvZGIvaXNvZ2l0OiBJbml0aWFsaXplOiBBZGRpbmcgdXBzdHJlYW0gcmVtb3RlXCIsIHRoaXMudXBzdHJlYW1SZXBvVXJsKTtcbiAgICAgICAgICBhd2FpdCBnaXQuYWRkUmVtb3RlKHtcbiAgICAgICAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgICAgICAgcmVtb3RlOiBVUFNUUkVBTV9SRU1PVEUsXG4gICAgICAgICAgICB1cmw6IHRoaXMudXBzdHJlYW1SZXBvVXJsLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGxvZy53YXJuKFwiQy9kYi9pc29naXQ6IEluaXRpYWxpemU6IE5vIHVwc3RyZWFtIHJlbW90ZSBzcGVjaWZpZWRcIik7XG4gICAgICAgIH1cblxuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBsb2cuZXJyb3IoXCJDL2RiL2lzb2dpdDogRXJyb3IgZHVyaW5nIGluaXRpYWxpemF0aW9uXCIpXG4gICAgICAgIGF3YWl0IHRoaXMuZnMucmVtb3ZlKHRoaXMud29ya0Rpcik7XG4gICAgICAgIGF3YWl0IHRoaXMuX2hhbmRsZUdpdEVycm9yKGUpO1xuICAgICAgICB0aHJvdyBlO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cblxuICAvLyBBdXRoZW50aWNhdGlvblxuXG4gIHB1YmxpYyBzZXRQYXNzd29yZCh2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gICAgdGhpcy5hdXRoLnBhc3N3b3JkID0gdmFsdWU7XG4gICAgdGhpcy5zZXRTdGF0dXMoeyBuZWVkc1Bhc3N3b3JkOiBmYWxzZSB9KTtcbiAgfVxuXG5cbiAgLy8gR2l0IG9wZXJhdGlvbnNcblxuICBhc3luYyBjb25maWdTZXQocHJvcDogc3RyaW5nLCB2YWw6IHN0cmluZykge1xuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IFNldCBjb25maWdcIik7XG4gICAgYXdhaXQgZ2l0LmNvbmZpZyh7IGRpcjogdGhpcy53b3JrRGlyLCBwYXRoOiBwcm9wLCB2YWx1ZTogdmFsIH0pO1xuICB9XG5cbiAgYXN5bmMgY29uZmlnR2V0KHByb3A6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogR2V0IGNvbmZpZ1wiLCBwcm9wKTtcbiAgICByZXR1cm4gYXdhaXQgZ2l0LmNvbmZpZyh7IGRpcjogdGhpcy53b3JrRGlyLCBwYXRoOiBwcm9wIH0pO1xuICB9XG5cbiAgYXN5bmMgcmVhZEZpbGVCbG9iQXRDb21taXQocmVsYXRpdmVGaWxlUGF0aDogc3RyaW5nLCBjb21taXRIYXNoOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIC8qIFJlYWRzIGZpbGUgY29udGVudHMgYXQgZ2l2ZW4gcGF0aCBhcyBvZiBnaXZlbiBjb21taXQuIEZpbGUgY29udGVudHMgbXVzdCB1c2UgVVRGLTggZW5jb2RpbmcuICovXG5cbiAgICByZXR1cm4gKGF3YWl0IGdpdC5yZWFkQmxvYih7XG4gICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgIG9pZDogY29tbWl0SGFzaCxcbiAgICAgIGZpbGVwYXRoOiByZWxhdGl2ZUZpbGVQYXRoLFxuICAgIH0pKS5ibG9iLnRvU3RyaW5nKCk7XG4gIH1cblxuICBhc3luYyBwdWxsKCkge1xuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IFB1bGxpbmcgbWFzdGVyIHdpdGggZmFzdC1mb3J3YXJkIG1lcmdlXCIpO1xuXG4gICAgcmV0dXJuIGF3YWl0IGdpdC5wdWxsKHtcbiAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgc2luZ2xlQnJhbmNoOiB0cnVlLFxuICAgICAgZmFzdEZvcndhcmRPbmx5OiB0cnVlLFxuXG4gICAgICBmYXN0OiB0cnVlLFxuICAgICAgLy8gTk9URTogVHlwZVNjcmlwdCBpcyBrbm93biB0byBjb21wbGFpbiBhYm91dCB0aGUgYGBmYXN0YGAgb3B0aW9uLlxuICAgICAgLy8gU2VlbXMgbGlrZSBhIHByb2JsZW0gd2l0aCB0eXBpbmdzLlxuXG4gICAgICAuLi50aGlzLmF1dGgsXG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBzdGFnZShwYXRoU3BlY3M6IHN0cmluZ1tdLCByZW1vdmluZyA9IGZhbHNlKSB7XG4gICAgbG9nLnZlcmJvc2UoYEMvZGIvaXNvZ2l0OiBTdGFnaW5nIGNoYW5nZXM6ICR7cGF0aFNwZWNzLmpvaW4oJywgJyl9IHVzaW5nICR7cmVtb3ZpbmcgPyBcInJlbW92ZSgpXCIgOiBcImFkZCgpXCJ9YCk7XG5cbiAgICBmb3IgKGNvbnN0IHBhdGhTcGVjIG9mIHBhdGhTcGVjcykge1xuICAgICAgaWYgKHJlbW92aW5nICE9PSB0cnVlKSB7XG4gICAgICAgIGF3YWl0IGdpdC5hZGQoe1xuICAgICAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgICAgIGZpbGVwYXRoOiBwYXRoU3BlYyxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhd2FpdCBnaXQucmVtb3ZlKHtcbiAgICAgICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgICBmaWxlcGF0aDogcGF0aFNwZWMsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGFzeW5jIGNvbW1pdChtc2c6IHN0cmluZykge1xuICAgIGxvZy52ZXJib3NlKGBDL2RiL2lzb2dpdDogQ29tbWl0dGluZyB3aXRoIG1lc3NhZ2UgJHttc2d9YCk7XG5cbiAgICByZXR1cm4gYXdhaXQgZ2l0LmNvbW1pdCh7XG4gICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgIG1lc3NhZ2U6IG1zZyxcbiAgICAgIGF1dGhvcjogdGhpcy5hdXRob3IsXG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBmZXRjaFJlbW90ZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCBnaXQuZmV0Y2goeyBkaXI6IHRoaXMud29ya0RpciwgcmVtb3RlOiBNQUlOX1JFTU9URSwgLi4udGhpcy5hdXRoIH0pO1xuICB9XG5cbiAgYXN5bmMgZmV0Y2hVcHN0cmVhbSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCBnaXQuZmV0Y2goeyBkaXI6IHRoaXMud29ya0RpciwgcmVtb3RlOiBVUFNUUkVBTV9SRU1PVEUsIC4uLnRoaXMuYXV0aCB9KTtcbiAgfVxuXG4gIGFzeW5jIHB1c2goZm9yY2UgPSBmYWxzZSkge1xuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IFB1c2hpbmdcIik7XG5cbiAgICByZXR1cm4gYXdhaXQgZ2l0LnB1c2goe1xuICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICByZW1vdGU6IE1BSU5fUkVNT1RFLFxuICAgICAgZm9yY2U6IGZvcmNlLFxuICAgICAgLi4udGhpcy5hdXRoLFxuICAgIH0pO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIHJlc2V0RmlsZXMocGF0aHM/OiBzdHJpbmdbXSkge1xuICAgIHJldHVybiBhd2FpdCB0aGlzLnN0YWdpbmdMb2NrLmFjcXVpcmUoJzEnLCBhc3luYyAoKSA9PiB7XG4gICAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBGb3JjZSByZXNldHRpbmcgZmlsZXNcIik7XG5cbiAgICAgIHJldHVybiBhd2FpdCBnaXQuZmFzdENoZWNrb3V0KHtcbiAgICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICAgIGZvcmNlOiB0cnVlLFxuICAgICAgICBmaWxlcGF0aHM6IHBhdGhzIHx8IChhd2FpdCB0aGlzLmxpc3RDaGFuZ2VkRmlsZXMoKSksXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIGdldE9yaWdpblVybCgpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgICByZXR1cm4gKChhd2FpdCBnaXQubGlzdFJlbW90ZXMoe1xuICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgfSkpLmZpbmQociA9PiByLnJlbW90ZSA9PT0gTUFJTl9SRU1PVEUpIHx8IHsgdXJsOiBudWxsIH0pLnVybDtcbiAgfVxuXG4gIGFzeW5jIGdldFVwc3RyZWFtVXJsKCk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICAgIHJldHVybiAoKGF3YWl0IGdpdC5saXN0UmVtb3Rlcyh7XG4gICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICB9KSkuZmluZChyID0+IHIucmVtb3RlID09PSBVUFNUUkVBTV9SRU1PVEUpIHx8IHsgdXJsOiBudWxsIH0pLnVybDtcbiAgfVxuXG4gIGFzeW5jIGxpc3RMb2NhbENvbW1pdHMoKTogUHJvbWlzZTxzdHJpbmdbXT4ge1xuICAgIC8qIFJldHVybnMgYSBsaXN0IG9mIGNvbW1pdCBtZXNzYWdlcyBmb3IgY29tbWl0cyB0aGF0IHdlcmUgbm90IHB1c2hlZCB5ZXQuXG5cbiAgICAgICBVc2VmdWwgdG8gY2hlY2sgd2hpY2ggY29tbWl0cyB3aWxsIGJlIHRocm93biBvdXRcbiAgICAgICBpZiB3ZSBmb3JjZSB1cGRhdGUgdG8gcmVtb3RlIG1hc3Rlci5cblxuICAgICAgIERvZXMgc28gYnkgd2Fsa2luZyB0aHJvdWdoIGxhc3QgMTAwIGNvbW1pdHMgc3RhcnRpbmcgZnJvbSBjdXJyZW50IEhFQUQuXG4gICAgICAgV2hlbiBpdCBlbmNvdW50ZXJzIHRoZSBmaXJzdCBsb2NhbCBjb21taXQgdGhhdCBkb2VzbuKAmXQgZGVzY2VuZHMgZnJvbSByZW1vdGUgbWFzdGVyIEhFQUQsXG4gICAgICAgaXQgY29uc2lkZXJzIGFsbCBwcmVjZWRpbmcgY29tbWl0cyB0byBiZSBhaGVhZC9sb2NhbCBhbmQgcmV0dXJucyB0aGVtLlxuXG4gICAgICAgSWYgaXQgZmluaXNoZXMgdGhlIHdhbGsgd2l0aG91dCBmaW5kaW5nIGFuIGFuY2VzdG9yLCB0aHJvd3MgYW4gZXJyb3IuXG4gICAgICAgSXQgaXMgYXNzdW1lZCB0aGF0IHRoZSBhcHAgZG9lcyBub3QgYWxsb3cgdG8gYWNjdW11bGF0ZVxuICAgICAgIG1vcmUgdGhhbiAxMDAgY29tbWl0cyB3aXRob3V0IHB1c2hpbmcgKGV2ZW4gMTAwIGlzIHRvbyBtYW55ISksXG4gICAgICAgc28gdGhlcmXigJlzIHByb2JhYmx5IHNvbWV0aGluZyBzdHJhbmdlIGdvaW5nIG9uLlxuXG4gICAgICAgT3RoZXIgYXNzdW1wdGlvbnM6XG5cbiAgICAgICAqIGdpdC5sb2cgcmV0dXJucyBjb21taXRzIGZyb20gbmV3ZXN0IHRvIG9sZGVzdC5cbiAgICAgICAqIFRoZSByZW1vdGUgd2FzIGFscmVhZHkgZmV0Y2hlZC5cblxuICAgICovXG5cbiAgICByZXR1cm4gYXdhaXQgdGhpcy5zdGFnaW5nTG9jay5hY3F1aXJlKCcxJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgbGF0ZXN0UmVtb3RlQ29tbWl0ID0gYXdhaXQgZ2l0LnJlc29sdmVSZWYoe1xuICAgICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgcmVmOiBgJHtNQUlOX1JFTU9URX0vbWFzdGVyYCxcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBsb2NhbENvbW1pdHMgPSBhd2FpdCBnaXQubG9nKHtcbiAgICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICAgIGRlcHRoOiAxMDAsXG4gICAgICB9KTtcblxuICAgICAgdmFyIGNvbW1pdHMgPSBbXSBhcyBzdHJpbmdbXTtcbiAgICAgIGZvciAoY29uc3QgY29tbWl0IG9mIGxvY2FsQ29tbWl0cykge1xuICAgICAgICBpZiAoYXdhaXQgZ2l0LmlzRGVzY2VuZGVudCh7IGRpcjogdGhpcy53b3JrRGlyLCBvaWQ6IGNvbW1pdC5vaWQsIGFuY2VzdG9yOiBsYXRlc3RSZW1vdGVDb21taXQgfSkpIHtcbiAgICAgICAgICBjb21taXRzLnB1c2goY29tbWl0Lm1lc3NhZ2UpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJldHVybiBjb21taXRzO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkRpZCBub3QgZmluZCBhIGxvY2FsIGNvbW1pdCB0aGF0IGlzIGFuIGFuY2VzdG9yIG9mIHJlbW90ZSBtYXN0ZXJcIik7XG4gICAgfSk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgbGlzdENoYW5nZWRGaWxlcyhwYXRoU3BlY3MgPSBbJy4nXSk6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgICAvKiBMaXN0cyByZWxhdGl2ZSBwYXRocyB0byBhbGwgZmlsZXMgdGhhdCB3ZXJlIGNoYW5nZWQgYW5kIGhhdmUgbm90IGJlZW4gY29tbWl0dGVkLiAqL1xuXG4gICAgY29uc3QgRklMRSA9IDAsIEhFQUQgPSAxLCBXT1JLRElSID0gMjtcblxuICAgIHJldHVybiAoYXdhaXQgZ2l0LnN0YXR1c01hdHJpeCh7IGRpcjogdGhpcy53b3JrRGlyLCBmaWxlcGF0aHM6IHBhdGhTcGVjcyB9KSlcbiAgICAgIC5maWx0ZXIocm93ID0+IHJvd1tIRUFEXSAhPT0gcm93W1dPUktESVJdKVxuICAgICAgLm1hcChyb3cgPT4gcm93W0ZJTEVdKVxuICAgICAgLmZpbHRlcihmaWxlcGF0aCA9PiAhZmlsZXBhdGguc3RhcnRzV2l0aCgnLi4nKSAmJiBmaWxlcGF0aCAhPT0gXCIuRFNfU3RvcmVcIik7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgc3RhZ2VBbmRDb21taXQocGF0aFNwZWNzOiBzdHJpbmdbXSwgbXNnOiBzdHJpbmcsIHJlbW92aW5nID0gZmFsc2UpOiBQcm9taXNlPG51bWJlcj4ge1xuICAgIC8qIFN0YWdlcyBhbmQgY29tbWl0cyBmaWxlcyBtYXRjaGluZyBnaXZlbiBwYXRoIHNwZWMgd2l0aCBnaXZlbiBtZXNzYWdlLlxuXG4gICAgICAgQW55IG90aGVyIGZpbGVzIHN0YWdlZCBhdCB0aGUgdGltZSBvZiB0aGUgY2FsbCB3aWxsIGJlIHVuc3RhZ2VkLlxuXG4gICAgICAgUmV0dXJucyB0aGUgbnVtYmVyIG9mIG1hdGNoaW5nIGZpbGVzIHdpdGggdW5zdGFnZWQgY2hhbmdlcyBwcmlvciB0byBzdGFnaW5nLlxuICAgICAgIElmIG5vIG1hdGNoaW5nIGZpbGVzIHdlcmUgZm91bmQgaGF2aW5nIHVuc3RhZ2VkIGNoYW5nZXMsXG4gICAgICAgc2tpcHMgdGhlIHJlc3QgYW5kIHJldHVybnMgemVyby5cblxuICAgICAgIElmIGZhaWxJZkRpdmVyZ2VkIGlzIGdpdmVuLCBhdHRlbXB0cyBhIGZhc3QtZm9yd2FyZCBwdWxsIGFmdGVyIHRoZSBjb21taXQuXG4gICAgICAgSXQgd2lsbCBmYWlsIGltbWVkaWF0ZWx5IGlmIG1haW4gcmVtb3RlIGhhZCBvdGhlciBjb21taXRzIGFwcGVhciBpbiBtZWFudGltZS5cblxuICAgICAgIExvY2tzIHNvIHRoYXQgdGhpcyBtZXRob2QgY2Fubm90IGJlIHJ1biBjb25jdXJyZW50bHkgKGJ5IHNhbWUgaW5zdGFuY2UpLlxuICAgICovXG5cbiAgICBpZiAocGF0aFNwZWNzLmxlbmd0aCA8IDEpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIldhc27igJl0IGdpdmVuIGFueSBwYXRocyB0byBjb21taXQhXCIpO1xuICAgIH1cblxuICAgIHJldHVybiBhd2FpdCB0aGlzLnN0YWdpbmdMb2NrLmFjcXVpcmUoJzEnLCBhc3luYyAoKSA9PiB7XG4gICAgICBsb2cudmVyYm9zZShgQy9kYi9pc29naXQ6IFN0YWdpbmcgYW5kIGNvbW1pdHRpbmc6ICR7cGF0aFNwZWNzLmpvaW4oJywgJyl9YCk7XG5cbiAgICAgIGNvbnN0IGZpbGVzQ2hhbmdlZCA9IChhd2FpdCB0aGlzLmxpc3RDaGFuZ2VkRmlsZXMocGF0aFNwZWNzKSkubGVuZ3RoO1xuICAgICAgaWYgKGZpbGVzQ2hhbmdlZCA8IDEpIHtcbiAgICAgICAgcmV0dXJuIDA7XG4gICAgICB9XG5cbiAgICAgIGF3YWl0IHRoaXMudW5zdGFnZUFsbCgpO1xuICAgICAgYXdhaXQgdGhpcy5zdGFnZShwYXRoU3BlY3MsIHJlbW92aW5nKTtcbiAgICAgIGF3YWl0IHRoaXMuY29tbWl0KG1zZyk7XG5cbiAgICAgIHJldHVybiBmaWxlc0NoYW5nZWQ7XG4gICAgfSk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgY2hlY2tVbmNvbW1pdHRlZCgpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICAvKiBDaGVja3MgZm9yIGFueSB1bmNvbW1pdHRlZCBjaGFuZ2VzIGxvY2FsbHkgcHJlc2VudC5cbiAgICAgICBOb3RpZmllcyBhbGwgd2luZG93cyBhYm91dCB0aGUgc3RhdHVzLiAqL1xuXG4gICAgbG9nLmRlYnVnKFwiQy9kYi9pc29naXQ6IENoZWNraW5nIGZvciB1bmNvbW1pdHRlZCBjaGFuZ2VzXCIpO1xuICAgIGNvbnN0IGNoYW5nZWRGaWxlcyA9IGF3YWl0IHRoaXMubGlzdENoYW5nZWRGaWxlcygpO1xuICAgIGxvZy5kZWJ1ZyhcIkMvZGIvaXNvZ2l0OiBDaGFuZ2VkIGZpbGVzOlwiLCBjaGFuZ2VkRmlsZXMpO1xuICAgIGNvbnN0IGhhc0xvY2FsQ2hhbmdlcyA9IGNoYW5nZWRGaWxlcy5sZW5ndGggPiAwO1xuICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaGFzTG9jYWxDaGFuZ2VzIH0pO1xuICAgIHJldHVybiBoYXNMb2NhbENoYW5nZXM7XG4gIH1cblxuICBwdWJsaWMgcmVxdWVzdFB1c2goKSB7XG4gICAgdGhpcy5wdXNoUGVuZGluZyA9IHRydWU7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgc3luY2hyb25pemUoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgLyogQ2hlY2tzIGZvciBjb25uZWN0aW9uLCBsb2NhbCBjaGFuZ2VzIGFuZCB1bnB1c2hlZCBjb21taXRzLFxuICAgICAgIHRyaWVzIHRvIHB1c2ggYW5kIHB1bGwgd2hlbiB0aGVyZeKAmXMgb3Bwb3J0dW5pdHkuXG5cbiAgICAgICBOb3RpZmllcyBhbGwgd2luZG93cyBhYm91dCB0aGUgc3RhdHVzIGluIHByb2Nlc3MuICovXG5cbiAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBDaGVja2luZyBpZiBjbG9uZSBleGlzdHNcIik7XG5cbiAgICBpZiAoIShhd2FpdCB0aGlzLmlzSW5pdGlhbGl6ZWQoKSkpIHtcbiAgICAgIGF3YWl0IHRoaXMuZm9yY2VJbml0aWFsaXplKCk7XG5cbiAgICB9IGVsc2Uge1xuICAgICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogQ2hlY2tpbmcgZm9yIHVuY29tbWl0dGVkIGNoYW5nZXNcIik7XG5cbiAgICAgIGNvbnN0IGhhc1VuY29tbWl0dGVkQ2hhbmdlcyA9IGF3YWl0IHRoaXMuY2hlY2tVbmNvbW1pdHRlZCgpO1xuXG4gICAgICBpZiAoaGFzVW5jb21taXR0ZWRDaGFuZ2VzKSB7XG4gICAgICAgIC8vIERvIG5vdCBydW4gcHVsbCBpZiB0aGVyZSBhcmUgdW5zdGFnZWQvdW5jb21taXR0ZWQgY2hhbmdlc1xuICAgICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGhhc0xvY2FsQ2hhbmdlczogdHJ1ZSB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gSWYgdW5jb21taXR0ZWQgY2hhbmdlcyB3ZXJlbuKAmXQgZGV0ZWN0ZWQsIHRoZXJlIG1heSBzdGlsbCBiZSBjaGFuZ2VkIGZpbGVzXG4gICAgICAgIC8vIHRoYXQgYXJlIG5vdCBtYW5hZ2VkIGJ5IHRoZSBiYWNrZW5kIChlLmcuLCAuRFNfU3RvcmUpLiBEaXNjYXJkIGFueSBzdHVmZiBsaWtlIHRoYXQuXG4gICAgICAgIGF3YWl0IHRoaXMucmVzZXRGaWxlcyhbJy4nXSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuc3RhZ2luZ0xvY2suaXNCdXN5KCkpIHtcbiAgICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IExvY2sgaXMgYnVzeSwgc2tpcHBpbmcgc3luY1wiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBRdWV1ZWluZyBzeW5jIG5vdywgbG9jayBpcyBub3QgYnVzeVwiKTtcblxuICAgIHJldHVybiBhd2FpdCB0aGlzLnN0YWdpbmdMb2NrLmFjcXVpcmUoJzEnLCBhc3luYyAoKSA9PiB7XG4gICAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBTdGFydGluZyBzeW5jXCIpO1xuXG4gICAgICBjb25zdCBpc09ubGluZSA9IChhd2FpdCBjaGVja09ubGluZVN0YXR1cygpKSA9PT0gdHJ1ZTtcblxuICAgICAgaWYgKGlzT25saW5lKSB7XG4gICAgICAgIGNvbnN0IG5lZWRzUGFzc3dvcmQgPSB0aGlzLm5lZWRzUGFzc3dvcmQoKTtcbiAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBuZWVkc1Bhc3N3b3JkIH0pO1xuICAgICAgICBpZiAobmVlZHNQYXNzd29yZCkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaXNPbmxpbmU6IHRydWUgfSk7XG5cbiAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBpc1B1bGxpbmc6IHRydWUgfSk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgdGhpcy5wdWxsKCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBsb2cuZXJyb3IoZSk7XG4gICAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoe1xuICAgICAgICAgICAgbGFzdFN5bmNocm9uaXplZDogbmV3IERhdGUoKSxcbiAgICAgICAgICAgIGlzUHVsbGluZzogZmFsc2UsXG4gICAgICAgICAgICBpc1B1c2hpbmc6IGZhbHNlLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGF3YWl0IHRoaXMuX2hhbmRsZUdpdEVycm9yKGUpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICAvL2F3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaXNQdWxsaW5nOiBmYWxzZSB9KTtcblxuICAgICAgICBpZiAodGhpcy5wdXNoUGVuZGluZykge1xuICAgICAgICAgIC8vIFJ1biBwdXNoIEFGVEVSIHB1bGwuIE1heSByZXN1bHQgaW4gZmFsc2UtcG9zaXRpdmUgbm9uLWZhc3QtZm9yd2FyZCByZWplY3Rpb25cbiAgICAgICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzUHVzaGluZzogdHJ1ZSB9KTtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wdXNoKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgbG9nLmVycm9yKGUpO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoe1xuICAgICAgICAgICAgICBsYXN0U3luY2hyb25pemVkOiBuZXcgRGF0ZSgpLFxuICAgICAgICAgICAgICBpc1B1bGxpbmc6IGZhbHNlLFxuICAgICAgICAgICAgICBpc1B1c2hpbmc6IGZhbHNlLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9oYW5kbGVHaXRFcnJvcihlKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhpcy5wdXNoUGVuZGluZyA9IGZhbHNlO1xuICAgICAgICAgIC8vYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBpc1B1c2hpbmc6IGZhbHNlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoe1xuICAgICAgICAgIHN0YXR1c1JlbGF0aXZlVG9Mb2NhbDogJ3VwZGF0ZWQnLFxuICAgICAgICAgIGlzTWlzY29uZmlndXJlZDogZmFsc2UsXG4gICAgICAgICAgbGFzdFN5bmNocm9uaXplZDogbmV3IERhdGUoKSxcbiAgICAgICAgICBuZWVkc1Bhc3N3b3JkOiBmYWxzZSxcbiAgICAgICAgICBpc1B1c2hpbmc6IGZhbHNlLFxuICAgICAgICAgIGlzUHVsbGluZzogZmFsc2UsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyB1bnN0YWdlQWxsKCkge1xuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IFVuc3RhZ2luZyBhbGwgY2hhbmdlc1wiKTtcbiAgICBhd2FpdCBnaXQucmVtb3ZlKHsgZGlyOiB0aGlzLndvcmtEaXIsIGZpbGVwYXRoOiAnLicgfSk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIF9oYW5kbGVHaXRFcnJvcihlOiBFcnJvciAmIHsgY29kZTogc3RyaW5nIH0pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBsb2cuZGVidWcoXCJIYW5kbGluZyBHaXQgZXJyb3JcIiwgZSk7XG5cbiAgICBpZiAoZS5jb2RlID09PSAnRmFzdEZvcndhcmRGYWlsJyB8fCBlLmNvZGUgPT09ICdNZXJnZU5vdFN1cHBvcnRlZEZhaWwnKSB7XG4gICAgICAvLyBOT1RFOiBUaGVyZeKAmXMgYWxzbyBQdXNoUmVqZWN0ZWROb25GYXN0Rm9yd2FyZCwgYnV0IGl0IHNlZW1zIHRvIGJlIHRocm93blxuICAgICAgLy8gZm9yIHVucmVsYXRlZCBjYXNlcyBkdXJpbmcgcHVzaCAoZmFsc2UgcG9zaXRpdmUpLlxuICAgICAgLy8gQmVjYXVzZSBvZiB0aGF0IGZhbHNlIHBvc2l0aXZlLCB3ZSBpZ25vcmUgdGhhdCBlcnJvciBhbmQgaW5zdGVhZCBkbyBwdWxsIGZpcnN0LFxuICAgICAgLy8gY2F0Y2hpbmcgYWN0dWFsIGZhc3QtZm9yd2FyZCBmYWlscyBvbiB0aGF0IHN0ZXAgYmVmb3JlIHB1c2guXG4gICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IHN0YXR1c1JlbGF0aXZlVG9Mb2NhbDogJ2RpdmVyZ2VkJyB9KTtcbiAgICB9IGVsc2UgaWYgKFsnTWlzc2luZ1VzZXJuYW1lRXJyb3InLCAnTWlzc2luZ0F1dGhvckVycm9yJywgJ01pc3NpbmdDb21taXR0ZXJFcnJvciddLmluZGV4T2YoZS5jb2RlKSA+PSAwKSB7XG4gICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzTWlzY29uZmlndXJlZDogdHJ1ZSB9KTtcbiAgICB9IGVsc2UgaWYgKFxuICAgICAgICBlLmNvZGUgPT09ICdNaXNzaW5nUGFzc3dvcmRUb2tlbkVycm9yJ1xuICAgICAgICB8fCAoZS5jb2RlID09PSAnSFRUUEVycm9yJyAmJiBlLm1lc3NhZ2UuaW5kZXhPZignVW5hdXRob3JpemVkJykgPj0gMCkpIHtcbiAgICAgIGxvZy53YXJuKFwiUGFzc3dvcmQgaW5wdXQgcmVxdWlyZWRcIik7XG4gICAgICB0aGlzLnNldFBhc3N3b3JkKHVuZGVmaW5lZCk7XG4gICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IG5lZWRzUGFzc3dvcmQ6IHRydWUgfSk7XG4gICAgfVxuICB9XG59XG5cblxuYXN5bmMgZnVuY3Rpb24gY2hlY2tPbmxpbmVTdGF0dXModGltZW91dCA9IDQ1MDApOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgLy8gVE9ETzogTW92ZSB0byBnZW5lcmFsIHV0aWxpdHkgZnVuY3Rpb25zXG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgIGxvZy5kZWJ1ZyhcIkMvZGIvaXNvZ2l0OiBDb25uZWN0aW9uIHRlc3Q6IFN0YXJ0aW5nXCIpO1xuXG4gICAgY29uc3QgcmVxID0gaHR0cHMuZ2V0KCdodHRwczovL2dpdGh1Yi5jb20vJywgeyB0aW1lb3V0IH0sIHJlcG9ydE9ubGluZSk7XG5cbiAgICByZXEub24oJ2Vycm9yJywgKCkgPT4gcmVxLmFib3J0KCkpO1xuICAgIHJlcS5vbigncmVzcG9uc2UnLCByZXBvcnRPbmxpbmUpO1xuICAgIHJlcS5vbignY29ubmVjdCcsIHJlcG9ydE9ubGluZSk7XG4gICAgcmVxLm9uKCdjb250aW51ZScsIHJlcG9ydE9ubGluZSk7XG4gICAgcmVxLm9uKCd1cGdyYWRlJywgcmVwb3J0T25saW5lKTtcbiAgICByZXEub24oJ3RpbWVvdXQnLCByZXBvcnRPZmZsaW5lKTtcblxuICAgIHJlcS5lbmQoKTtcblxuICAgIGNvbnN0IGNoZWNrVGltZW91dCA9IHNldFRpbWVvdXQocmVwb3J0T2ZmbGluZSwgdGltZW91dCk7XG5cbiAgICBmdW5jdGlvbiByZXBvcnRPZmZsaW5lKCkge1xuICAgICAgbG9nLndhcm4oXCJDL2RiL2lzb2dpdDogQ29ubmVjdGlvbiB0ZXN0OiBSZXBvcnQgb2ZmbGluZVwiKTtcbiAgICAgIHRyeSB7IHJlcS5hYm9ydCgpOyB9IGNhdGNoIChlKSB7fVxuICAgICAgY2xlYXJUaW1lb3V0KGNoZWNrVGltZW91dCk7XG4gICAgICByZXNvbHZlKGZhbHNlKTtcbiAgICB9XG4gICAgZnVuY3Rpb24gcmVwb3J0T25saW5lKCkge1xuICAgICAgbG9nLmluZm8oXCJDL2RiL2lzb2dpdDogQ29ubmVjdGlvbiB0ZXN0OiBSZXBvcnQgb25saW5lXCIpO1xuICAgICAgdHJ5IHsgcmVxLmFib3J0KCk7IH0gY2F0Y2ggKGUpIHt9XG4gICAgICBjbGVhclRpbWVvdXQoY2hlY2tUaW1lb3V0KTtcbiAgICAgIHJlc29sdmUodHJ1ZSk7XG4gICAgfVxuICB9KTtcbn1cblxuXG4vLyBUT0RPOiBUZW1wb3Jhcnkgd29ya2Fyb3VuZCBzaW5jZSBpc29tb3JwaGljLWdpdCBkb2VzbuKAmXQgc2VlbSB0byBleHBvcnQgaXRzIEdpdEVycm9yIGNsYXNzXG4vLyBpbiBhbnkgd2F5IGF2YWlsYWJsZSB0byBUUywgc28gd2UgY2Fu4oCZdCB1c2UgaW5zdGFuY2VvZiA6KFxuXG5leHBvcnQgZnVuY3Rpb24gaXNHaXRFcnJvcihlOiBFcnJvciAmIHsgY29kZTogc3RyaW5nIH0pIHtcbiAgaWYgKCFlLmNvZGUpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIE9iamVjdC5rZXlzKElzb21vcnBoaWNHaXRFcnJvckNvZGVzKS5pbmRleE9mKGUuY29kZSkgPj0gMDtcbn1cblxuY29uc3QgSXNvbW9ycGhpY0dpdEVycm9yQ29kZXMgPSB7XG4gIEZpbGVSZWFkRXJyb3I6IGBGaWxlUmVhZEVycm9yYCxcbiAgTWlzc2luZ1JlcXVpcmVkUGFyYW1ldGVyRXJyb3I6IGBNaXNzaW5nUmVxdWlyZWRQYXJhbWV0ZXJFcnJvcmAsXG4gIEludmFsaWRSZWZOYW1lRXJyb3I6IGBJbnZhbGlkUmVmTmFtZUVycm9yYCxcbiAgSW52YWxpZFBhcmFtZXRlckNvbWJpbmF0aW9uRXJyb3I6IGBJbnZhbGlkUGFyYW1ldGVyQ29tYmluYXRpb25FcnJvcmAsXG4gIFJlZkV4aXN0c0Vycm9yOiBgUmVmRXhpc3RzRXJyb3JgLFxuICBSZWZOb3RFeGlzdHNFcnJvcjogYFJlZk5vdEV4aXN0c0Vycm9yYCxcbiAgQnJhbmNoRGVsZXRlRXJyb3I6IGBCcmFuY2hEZWxldGVFcnJvcmAsXG4gIE5vSGVhZENvbW1pdEVycm9yOiBgTm9IZWFkQ29tbWl0RXJyb3JgLFxuICBDb21taXROb3RGZXRjaGVkRXJyb3I6IGBDb21taXROb3RGZXRjaGVkRXJyb3JgLFxuICBPYmplY3RUeXBlVW5rbm93bkZhaWw6IGBPYmplY3RUeXBlVW5rbm93bkZhaWxgLFxuICBPYmplY3RUeXBlQXNzZXJ0aW9uRmFpbDogYE9iamVjdFR5cGVBc3NlcnRpb25GYWlsYCxcbiAgT2JqZWN0VHlwZUFzc2VydGlvbkluVHJlZUZhaWw6IGBPYmplY3RUeXBlQXNzZXJ0aW9uSW5UcmVlRmFpbGAsXG4gIE9iamVjdFR5cGVBc3NlcnRpb25JblJlZkZhaWw6IGBPYmplY3RUeXBlQXNzZXJ0aW9uSW5SZWZGYWlsYCxcbiAgT2JqZWN0VHlwZUFzc2VydGlvbkluUGF0aEZhaWw6IGBPYmplY3RUeXBlQXNzZXJ0aW9uSW5QYXRoRmFpbGAsXG4gIE1pc3NpbmdBdXRob3JFcnJvcjogYE1pc3NpbmdBdXRob3JFcnJvcmAsXG4gIE1pc3NpbmdDb21taXR0ZXJFcnJvcjogYE1pc3NpbmdDb21taXR0ZXJFcnJvcmAsXG4gIE1pc3NpbmdUYWdnZXJFcnJvcjogYE1pc3NpbmdUYWdnZXJFcnJvcmAsXG4gIEdpdFJvb3ROb3RGb3VuZEVycm9yOiBgR2l0Um9vdE5vdEZvdW5kRXJyb3JgLFxuICBVbnBhcnNlYWJsZVNlcnZlclJlc3BvbnNlRmFpbDogYFVucGFyc2VhYmxlU2VydmVyUmVzcG9uc2VGYWlsYCxcbiAgSW52YWxpZERlcHRoUGFyYW1ldGVyRXJyb3I6IGBJbnZhbGlkRGVwdGhQYXJhbWV0ZXJFcnJvcmAsXG4gIFJlbW90ZURvZXNOb3RTdXBwb3J0U2hhbGxvd0ZhaWw6IGBSZW1vdGVEb2VzTm90U3VwcG9ydFNoYWxsb3dGYWlsYCxcbiAgUmVtb3RlRG9lc05vdFN1cHBvcnREZWVwZW5TaW5jZUZhaWw6IGBSZW1vdGVEb2VzTm90U3VwcG9ydERlZXBlblNpbmNlRmFpbGAsXG4gIFJlbW90ZURvZXNOb3RTdXBwb3J0RGVlcGVuTm90RmFpbDogYFJlbW90ZURvZXNOb3RTdXBwb3J0RGVlcGVuTm90RmFpbGAsXG4gIFJlbW90ZURvZXNOb3RTdXBwb3J0RGVlcGVuUmVsYXRpdmVGYWlsOiBgUmVtb3RlRG9lc05vdFN1cHBvcnREZWVwZW5SZWxhdGl2ZUZhaWxgLFxuICBSZW1vdGVEb2VzTm90U3VwcG9ydFNtYXJ0SFRUUDogYFJlbW90ZURvZXNOb3RTdXBwb3J0U21hcnRIVFRQYCxcbiAgQ29ycnVwdFNoYWxsb3dPaWRGYWlsOiBgQ29ycnVwdFNoYWxsb3dPaWRGYWlsYCxcbiAgRmFzdEZvcndhcmRGYWlsOiBgRmFzdEZvcndhcmRGYWlsYCxcbiAgTWVyZ2VOb3RTdXBwb3J0ZWRGYWlsOiBgTWVyZ2VOb3RTdXBwb3J0ZWRGYWlsYCxcbiAgRGlyZWN0b3J5U2VwYXJhdG9yc0Vycm9yOiBgRGlyZWN0b3J5U2VwYXJhdG9yc0Vycm9yYCxcbiAgUmVzb2x2ZVRyZWVFcnJvcjogYFJlc29sdmVUcmVlRXJyb3JgLFxuICBSZXNvbHZlQ29tbWl0RXJyb3I6IGBSZXNvbHZlQ29tbWl0RXJyb3JgLFxuICBEaXJlY3RvcnlJc0FGaWxlRXJyb3I6IGBEaXJlY3RvcnlJc0FGaWxlRXJyb3JgLFxuICBUcmVlT3JCbG9iTm90Rm91bmRFcnJvcjogYFRyZWVPckJsb2JOb3RGb3VuZEVycm9yYCxcbiAgTm90SW1wbGVtZW50ZWRGYWlsOiBgTm90SW1wbGVtZW50ZWRGYWlsYCxcbiAgUmVhZE9iamVjdEZhaWw6IGBSZWFkT2JqZWN0RmFpbGAsXG4gIE5vdEFuT2lkRmFpbDogYE5vdEFuT2lkRmFpbGAsXG4gIE5vUmVmc3BlY0NvbmZpZ3VyZWRFcnJvcjogYE5vUmVmc3BlY0NvbmZpZ3VyZWRFcnJvcmAsXG4gIE1pc21hdGNoUmVmVmFsdWVFcnJvcjogYE1pc21hdGNoUmVmVmFsdWVFcnJvcmAsXG4gIFJlc29sdmVSZWZFcnJvcjogYFJlc29sdmVSZWZFcnJvcmAsXG4gIEV4cGFuZFJlZkVycm9yOiBgRXhwYW5kUmVmRXJyb3JgLFxuICBFbXB0eVNlcnZlclJlc3BvbnNlRmFpbDogYEVtcHR5U2VydmVyUmVzcG9uc2VGYWlsYCxcbiAgQXNzZXJ0U2VydmVyUmVzcG9uc2VGYWlsOiBgQXNzZXJ0U2VydmVyUmVzcG9uc2VGYWlsYCxcbiAgSFRUUEVycm9yOiBgSFRUUEVycm9yYCxcbiAgUmVtb3RlVXJsUGFyc2VFcnJvcjogYFJlbW90ZVVybFBhcnNlRXJyb3JgLFxuICBVbmtub3duVHJhbnNwb3J0RXJyb3I6IGBVbmtub3duVHJhbnNwb3J0RXJyb3JgLFxuICBBY3F1aXJlTG9ja0ZpbGVGYWlsOiBgQWNxdWlyZUxvY2tGaWxlRmFpbGAsXG4gIERvdWJsZVJlbGVhc2VMb2NrRmlsZUZhaWw6IGBEb3VibGVSZWxlYXNlTG9ja0ZpbGVGYWlsYCxcbiAgSW50ZXJuYWxGYWlsOiBgSW50ZXJuYWxGYWlsYCxcbiAgVW5rbm93bk9hdXRoMkZvcm1hdDogYFVua25vd25PYXV0aDJGb3JtYXRgLFxuICBNaXNzaW5nUGFzc3dvcmRUb2tlbkVycm9yOiBgTWlzc2luZ1Bhc3N3b3JkVG9rZW5FcnJvcmAsXG4gIE1pc3NpbmdVc2VybmFtZUVycm9yOiBgTWlzc2luZ1VzZXJuYW1lRXJyb3JgLFxuICBNaXhQYXNzd29yZFRva2VuRXJyb3I6IGBNaXhQYXNzd29yZFRva2VuRXJyb3JgLFxuICBNaXhVc2VybmFtZVBhc3N3b3JkVG9rZW5FcnJvcjogYE1peFVzZXJuYW1lUGFzc3dvcmRUb2tlbkVycm9yYCxcbiAgTWlzc2luZ1Rva2VuRXJyb3I6IGBNaXNzaW5nVG9rZW5FcnJvcmAsXG4gIE1peFVzZXJuYW1lT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3I6IGBNaXhVc2VybmFtZU9hdXRoMmZvcm1hdE1pc3NpbmdUb2tlbkVycm9yYCxcbiAgTWl4UGFzc3dvcmRPYXV0aDJmb3JtYXRNaXNzaW5nVG9rZW5FcnJvcjogYE1peFBhc3N3b3JkT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3JgLFxuICBNaXhVc2VybmFtZVBhc3N3b3JkT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3I6IGBNaXhVc2VybmFtZVBhc3N3b3JkT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3JgLFxuICBNaXhVc2VybmFtZU9hdXRoMmZvcm1hdFRva2VuRXJyb3I6IGBNaXhVc2VybmFtZU9hdXRoMmZvcm1hdFRva2VuRXJyb3JgLFxuICBNaXhQYXNzd29yZE9hdXRoMmZvcm1hdFRva2VuRXJyb3I6IGBNaXhQYXNzd29yZE9hdXRoMmZvcm1hdFRva2VuRXJyb3JgLFxuICBNaXhVc2VybmFtZVBhc3N3b3JkT2F1dGgyZm9ybWF0VG9rZW5FcnJvcjogYE1peFVzZXJuYW1lUGFzc3dvcmRPYXV0aDJmb3JtYXRUb2tlbkVycm9yYCxcbiAgTWF4U2VhcmNoRGVwdGhFeGNlZWRlZDogYE1heFNlYXJjaERlcHRoRXhjZWVkZWRgLFxuICBQdXNoUmVqZWN0ZWROb25GYXN0Rm9yd2FyZDogYFB1c2hSZWplY3RlZE5vbkZhc3RGb3J3YXJkYCxcbiAgUHVzaFJlamVjdGVkVGFnRXhpc3RzOiBgUHVzaFJlamVjdGVkVGFnRXhpc3RzYCxcbiAgQWRkaW5nUmVtb3RlV291bGRPdmVyd3JpdGU6IGBBZGRpbmdSZW1vdGVXb3VsZE92ZXJ3cml0ZWAsXG4gIFBsdWdpblVuZGVmaW5lZDogYFBsdWdpblVuZGVmaW5lZGAsXG4gIENvcmVOb3RGb3VuZDogYENvcmVOb3RGb3VuZGAsXG4gIFBsdWdpblNjaGVtYVZpb2xhdGlvbjogYFBsdWdpblNjaGVtYVZpb2xhdGlvbmAsXG4gIFBsdWdpblVucmVjb2duaXplZDogYFBsdWdpblVucmVjb2duaXplZGAsXG4gIEFtYmlndW91c1Nob3J0T2lkOiBgQW1iaWd1b3VzU2hvcnRPaWRgLFxuICBTaG9ydE9pZE5vdEZvdW5kOiBgU2hvcnRPaWROb3RGb3VuZGAsXG4gIENoZWNrb3V0Q29uZmxpY3RFcnJvcjogYENoZWNrb3V0Q29uZmxpY3RFcnJvcmBcbn1cblxuIl19