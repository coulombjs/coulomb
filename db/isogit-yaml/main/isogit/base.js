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
            await this.setStatus(Object.assign(Object.assign({}, INITIAL_STATUS), { hasLocalChanges: false, lastSynchronized: this.status.lastSynchronized }));
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
        log.debug("Handling Git error", e.code, e);
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
        else if (e.code === 'EHOSTDOWN') {
            await this.setStatus({ isOnline: false });
            log.warn("Possible connection issues");
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFzZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9kYi9pc29naXQteWFtbC9tYWluL2lzb2dpdC9iYXNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sS0FBSyxLQUFLLE1BQU0sT0FBTyxDQUFDO0FBQy9CLE9BQU8sS0FBSyxJQUFJLE1BQU0sTUFBTSxDQUFDO0FBQzdCLE9BQU8sU0FBUyxNQUFNLFlBQVksQ0FBQztBQUNuQyxPQUFPLEtBQUssR0FBRyxNQUFNLGdCQUFnQixDQUFDO0FBQ3RDLE9BQU8sS0FBSyxHQUFHLE1BQU0sY0FBYyxDQUFDO0FBTXBDLE1BQU0sZUFBZSxHQUFHLFVBQVUsQ0FBQztBQUNuQyxNQUFNLFdBQVcsR0FBRyxRQUFRLENBQUM7QUFHN0IsTUFBTSxjQUFjLEdBQWM7SUFDaEMsUUFBUSxFQUFFLEtBQUs7SUFDZixlQUFlLEVBQUUsS0FBSztJQUN0QixlQUFlLEVBQUUsS0FBSztJQUN0QixhQUFhLEVBQUUsS0FBSztJQUNwQixxQkFBcUIsRUFBRSxTQUFTO0lBQ2hDLGdCQUFnQixFQUFFLElBQUk7SUFDdEIsU0FBUyxFQUFFLEtBQUs7SUFDaEIsU0FBUyxFQUFFLEtBQUs7Q0FDUixDQUFDO0FBR1gsTUFBTSxPQUFPLGFBQWE7SUFVeEIsWUFDWSxFQUFPLEVBQ1AsT0FBZSxFQUNmLGVBQW1DLEVBQzNDLFFBQWdCLEVBQ1IsTUFBdUMsRUFDeEMsT0FBZSxFQUNkLFNBQTZCLEVBQzdCLGNBQXFEO1FBUHJELE9BQUUsR0FBRixFQUFFLENBQUs7UUFDUCxZQUFPLEdBQVAsT0FBTyxDQUFRO1FBQ2Ysb0JBQWUsR0FBZixlQUFlLENBQW9CO1FBRW5DLFdBQU0sR0FBTixNQUFNLENBQWlDO1FBQ3hDLFlBQU8sR0FBUCxPQUFPLENBQVE7UUFDZCxjQUFTLEdBQVQsU0FBUyxDQUFvQjtRQUM3QixtQkFBYyxHQUFkLGNBQWMsQ0FBdUM7UUFoQnpELFNBQUksR0FBc0IsRUFBRSxD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QkFBcUIsRUFBRSx1QkFBdUI7SUFDOUMsMEJBQTBCLEVBQUUsNEJBQTRCO0lBQ3hELGVBQWUsRUFBRSxpQkFBaUI7SUFDbEMsWUFBWSxFQUFFLGNBQWM7SUFDNUIscUJBQXFCLEVBQUUsdUJBQXVCO0lBQzlDLGtCQUFrQixFQUFFLG9CQUFvQjtJQUN4QyxpQkFBaUIsRUFBRSxtQkFBbUI7SUFDdEMsZ0JBQWdCLEVBQUUsa0JBQWtCO0lBQ3BDLHFCQUFxQixFQUFFLHVCQUF1QjtDQUMvQyxDQUFBIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgaHR0cHMgZnJvbSAnaHR0cHMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCBBc3luY0xvY2sgZnJvbSAnYXN5bmMtbG9jayc7XG5pbXBvcnQgKiBhcyBnaXQgZnJvbSAnaXNvbW9ycGhpYy1naXQnO1xuaW1wb3J0ICogYXMgbG9nIGZyb20gJ2VsZWN0cm9uLWxvZyc7XG5cbmltcG9ydCB7IEdpdFN0YXR1cyB9IGZyb20gJy4uLy4uL2Jhc2UnO1xuaW1wb3J0IHsgR2l0QXV0aGVudGljYXRpb24gfSBmcm9tICcuL3R5cGVzJztcblxuXG5jb25zdCBVUFNUUkVBTV9SRU1PVEUgPSAndXBzdHJlYW0nO1xuY29uc3QgTUFJTl9SRU1PVEUgPSAnb3JpZ2luJztcblxuXG5jb25zdCBJTklUSUFMX1NUQVRVUzogR2l0U3RhdHVzID0ge1xuICBpc09ubGluZTogZmFsc2UsXG4gIGlzTWlzY29uZmlndXJlZDogZmFsc2UsXG4gIGhhc0xvY2FsQ2hhbmdlczogZmFsc2UsXG4gIG5lZWRzUGFzc3dvcmQ6IGZhbHNlLFxuICBzdGF0dXNSZWxhdGl2ZVRvTG9jYWw6IHVuZGVmaW5lZCxcbiAgbGFzdFN5bmNocm9uaXplZDogbnVsbCxcbiAgaXNQdXNoaW5nOiBmYWxzZSxcbiAgaXNQdWxsaW5nOiBmYWxzZSxcbn0gYXMgY29uc3Q7XG5cblxuZXhwb3J0IGNsYXNzIElzb0dpdFdyYXBwZXIge1xuXG4gIHByaXZhdGUgYXV0aDogR2l0QXV0aGVudGljYXRpb24gPSB7fTtcblxuICBwcml2YXRlIHB1c2hQZW5kaW5nID0gZmFsc2U7XG5cbiAgcHJpdmF0ZSBzdGFnaW5nTG9jazogQXN5bmNMb2NrO1xuXG4gIHByaXZhdGUgc3RhdHVzOiBHaXRTdGF0dXM7XG5cbiAgY29uc3RydWN0b3IoXG4gICAgICBwcml2YXRlIGZzOiBhbnksXG4gICAgICBwcml2YXRlIHJlcG9Vcmw6IHN0cmluZyxcbiAgICAgIHByaXZhdGUgdXBzdHJlYW1SZXBvVXJsOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICAgICB1c2VybmFtZTogc3RyaW5nLFxuICAgICAgcHJpdmF0ZSBhdXRob3I6IHsgbmFtZTogc3RyaW5nLCBlbWFpbDogc3RyaW5nIH0sXG4gICAgICBwdWJsaWMgd29ya0Rpcjogc3RyaW5nLFxuICAgICAgcHJpdmF0ZSBjb3JzUHJveHk6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgIHByaXZhdGUgc3RhdHVzUmVwb3J0ZXI6IChwYXlsb2FkOiBHaXRTdGF0dXMpID0+IFByb21pc2U8dm9pZD4pIHtcblxuICAgIGdpdC5wbHVnaW5zLnNldCgnZnMnLCBmcyk7XG5cbiAgICB0aGlzLnN0YWdpbmdMb2NrID0gbmV3IEFzeW5jTG9jayh7IHRpbWVvdXQ6IDIwMDAwLCBtYXhQZW5kaW5nOiAyIH0pO1xuXG4gICAgLy8gTWFrZXMgaXQgZWFzaWVyIHRvIGJpbmQgdGhlc2UgdG8gSVBDIGV2ZW50c1xuICAgIHRoaXMuc3luY2hyb25pemUgPSB0aGlzLnN5bmNocm9uaXplLmJpbmQodGhpcyk7XG4gICAgdGhpcy5yZXNldEZpbGVzID0gdGhpcy5yZXNldEZpbGVzLmJpbmQodGhpcyk7XG4gICAgdGhpcy5jaGVja1VuY29tbWl0dGVkID0gdGhpcy5jaGVja1VuY29tbWl0dGVkLmJpbmQodGhpcyk7XG5cbiAgICB0aGlzLmF1dGgudXNlcm5hbWUgPSB1c2VybmFtZTtcblxuICAgIHRoaXMuc3RhdHVzID0gSU5JVElBTF9TVEFUVVM7XG4gIH1cblxuXG4gIC8vIFJlcG9ydGluZyBHaXQgc3RhdHVzIHRvIERCIGJhY2tlbmQsXG4gIC8vIHNvIHRoYXQgaXQgY2FuIGJlIHJlZmxlY3RlZCBpbiB0aGUgR1VJXG5cbiAgcHJpdmF0ZSBhc3luYyByZXBvcnRTdGF0dXMoKSB7XG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuc3RhdHVzUmVwb3J0ZXIodGhpcy5zdGF0dXMpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBzZXRTdGF0dXMoc3RhdHVzOiBQYXJ0aWFsPEdpdFN0YXR1cz4pIHtcbiAgICBPYmplY3QuYXNzaWduKHRoaXMuc3RhdHVzLCBzdGF0dXMpO1xuICAgIGF3YWl0IHRoaXMucmVwb3J0U3RhdHVzKCk7XG4gIH1cblxuICBwdWJsaWMgZ2V0U3RhdHVzKCk6IEdpdFN0YXR1cyB7XG4gICAgcmV0dXJuIHRoaXMuc3RhdHVzO1xuICB9XG5cblxuICAvLyBJbml0aWxhaXphdGlvblxuXG4gIHB1YmxpYyBhc3luYyBpc0luaXRpYWxpemVkKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIGxldCBoYXNHaXREaXJlY3Rvcnk6IGJvb2xlYW47XG4gICAgdHJ5IHtcbiAgICAgIGhhc0dpdERpcmVjdG9yeSA9IChhd2FpdCB0aGlzLmZzLnN0YXQocGF0aC5qb2luKHRoaXMud29ya0RpciwgJy5naXQnKSkpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaGFzR2l0RGlyZWN0b3J5ID0gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiBoYXNHaXREaXJlY3Rvcnk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgaXNVc2luZ1JlbW90ZVVSTHMocmVtb3RlVXJsczogeyBvcmlnaW46IHN0cmluZywgdXBzdHJlYW0/OiBzdHJpbmcgfSk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIGNvbnN0IG9yaWdpbiA9IChhd2FpdCB0aGlzLmdldE9yaWdpblVybCgpIHx8ICcnKS50cmltKCk7XG4gICAgY29uc3QgdXBzdHJlYW0gPSAoYXdhaXQgdGhpcy5nZXRVcHN0cmVhbVVybCgpIHx8ICcnKS50cmltKCk7XG4gICAgcmV0dXJuIG9yaWdpbiA9PT0gcmVtb3RlVXJscy5vcmlnaW4gJiYgKHJlbW90ZVVybHMudXBzdHJlYW0gPT09IHVuZGVmaW5lZCB8fCB1cHN0cmVhbSA9PT0gcmVtb3RlVXJscy51cHN0cmVhbSk7XG4gIH1cblxuICBwdWJsaWMgbmVlZHNQYXNzd29yZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gKHRoaXMuYXV0aC5wYXNzd29yZCB8fCAnJykudHJpbSgpID09PSAnJztcbiAgfVxuXG4gIHB1YmxpYyBnZXRVc2VybmFtZSgpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0aGlzLmF1dGgudXNlcm5hbWU7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgZGVzdHJveSgpIHtcbiAgICAvKiBSZW1vdmVzIHdvcmtpbmcgZGlyZWN0b3J5LlxuICAgICAgIE9uIG5leHQgc3luYyBHaXQgcmVwbyB3aWxsIGhhdmUgdG8gYmUgcmVpbml0aWFsaXplZCwgY2xvbmVkIGV0Yy4gKi9cblxuICAgIGxvZy53YXJuKFwiQy9kYi9pc29naXQ6IEluaXRpYWxpemU6IFJlbW92aW5nIGRhdGEgZGlyZWN0b3J5XCIpO1xuICAgIGF3YWl0IHRoaXMuZnMucmVtb3ZlKHRoaXMud29ya0Rpcik7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGZvcmNlSW5pdGlhbGl6ZSgpIHtcbiAgICAvKiBJbml0aWFsaXplcyBmcm9tIHNjcmF0Y2g6IHdpcGVzIHdvcmsgZGlyZWN0b3J5LCBjbG9uZXMgcmVwb3NpdG9yeSwgYWRkcyByZW1vdGVzLiAqL1xuXG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuc3RhZ2luZ0xvY2suYWNxdWlyZSgnMScsIGFzeW5jICgpID0+IHtcbiAgICAgIGxvZy53YXJuKFwiQy9kYi9pc29naXQ6IEluaXRpYWxpemluZ1wiKTtcblxuICAgICAgbG9nLnNpbGx5KFwiQy9kYi9pc29naXQ6IEluaXRpYWxpemU6IEVuc3VyaW5nIGRhdGEgZGlyZWN0b3J5IGV4aXN0c1wiKTtcbiAgICAgIGF3YWl0IHRoaXMuZnMuZW5zdXJlRGlyKHRoaXMud29ya0Rpcik7XG5cbiAgICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IEluaXRpYWxpemU6IENsb25pbmdcIiwgdGhpcy5yZXBvVXJsKTtcblxuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgZ2l0LmNsb25lKHtcbiAgICAgICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgICB1cmw6IHRoaXMucmVwb1VybCxcbiAgICAgICAgICByZWY6ICdtYXN0ZXInLFxuICAgICAgICAgIHNpbmdsZUJyYW5jaDogdHJ1ZSxcbiAgICAgICAgICBkZXB0aDogNSxcbiAgICAgICAgICBjb3JzUHJveHk6IHRoaXMuY29yc1Byb3h5LFxuICAgICAgICAgIC4uLnRoaXMuYXV0aCxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKHRoaXMudXBzdHJlYW1SZXBvVXJsICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICBsb2cuZGVidWcoXCJDL2RiL2lzb2dpdDogSW5pdGlhbGl6ZTogQWRkaW5nIHVwc3RyZWFtIHJlbW90ZVwiLCB0aGlzLnVwc3RyZWFtUmVwb1VybCk7XG4gICAgICAgICAgYXdhaXQgZ2l0LmFkZFJlbW90ZSh7XG4gICAgICAgICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgICAgIHJlbW90ZTogVVBTVFJFQU1fUkVNT1RFLFxuICAgICAgICAgICAgdXJsOiB0aGlzLnVwc3RyZWFtUmVwb1VybCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBsb2cud2FybihcIkMvZGIvaXNvZ2l0OiBJbml0aWFsaXplOiBObyB1cHN0cmVhbSByZW1vdGUgc3BlY2lmaWVkXCIpO1xuICAgICAgICB9XG5cbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgbG9nLmVycm9yKFwiQy9kYi9pc29naXQ6IEVycm9yIGR1cmluZyBpbml0aWFsaXphdGlvblwiKVxuICAgICAgICBhd2FpdCB0aGlzLmZzLnJlbW92ZSh0aGlzLndvcmtEaXIpO1xuICAgICAgICBhd2FpdCB0aGlzLl9oYW5kbGVHaXRFcnJvcihlKTtcbiAgICAgICAgdGhyb3cgZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG5cbiAgLy8gQXV0aGVudGljYXRpb25cblxuICBwdWJsaWMgc2V0UGFzc3dvcmQodmFsdWU6IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICAgIHRoaXMuYXV0aC5wYXNzd29yZCA9IHZhbHVlO1xuICAgIHRoaXMuc2V0U3RhdHVzKHsgbmVlZHNQYXNzd29yZDogZmFsc2UgfSk7XG4gIH1cblxuXG4gIC8vIEdpdCBvcGVyYXRpb25zXG5cbiAgYXN5bmMgY29uZmlnU2V0KHByb3A6IHN0cmluZywgdmFsOiBzdHJpbmcpIHtcbiAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBTZXQgY29uZmlnXCIpO1xuICAgIGF3YWl0IGdpdC5jb25maWcoeyBkaXI6IHRoaXMud29ya0RpciwgcGF0aDogcHJvcCwgdmFsdWU6IHZhbCB9KTtcbiAgfVxuXG4gIGFzeW5jIGNvbmZpZ0dldChwcm9wOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IEdldCBjb25maWdcIiwgcHJvcCk7XG4gICAgcmV0dXJuIGF3YWl0IGdpdC5jb25maWcoeyBkaXI6IHRoaXMud29ya0RpciwgcGF0aDogcHJvcCB9KTtcbiAgfVxuXG4gIGFzeW5jIHJlYWRGaWxlQmxvYkF0Q29tbWl0KHJlbGF0aXZlRmlsZVBhdGg6IHN0cmluZywgY29tbWl0SGFzaDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICAvKiBSZWFkcyBmaWxlIGNvbnRlbnRzIGF0IGdpdmVuIHBhdGggYXMgb2YgZ2l2ZW4gY29tbWl0LiBGaWxlIGNvbnRlbnRzIG11c3QgdXNlIFVURi04IGVuY29kaW5nLiAqL1xuXG4gICAgcmV0dXJuIChhd2FpdCBnaXQucmVhZEJsb2Ioe1xuICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICBvaWQ6IGNvbW1pdEhhc2gsXG4gICAgICBmaWxlcGF0aDogcmVsYXRpdmVGaWxlUGF0aCxcbiAgICB9KSkuYmxvYi50b1N0cmluZygpO1xuICB9XG5cbiAgYXN5bmMgcHVsbCgpIHtcbiAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBQdWxsaW5nIG1hc3RlciB3aXRoIGZhc3QtZm9yd2FyZCBtZXJnZVwiKTtcblxuICAgIHJldHVybiBhd2FpdCBnaXQucHVsbCh7XG4gICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgIHNpbmdsZUJyYW5jaDogdHJ1ZSxcbiAgICAgIGZhc3RGb3J3YXJkT25seTogdHJ1ZSxcblxuICAgICAgZmFzdDogdHJ1ZSxcbiAgICAgIC8vIE5PVEU6IFR5cGVTY3JpcHQgaXMga25vd24gdG8gY29tcGxhaW4gYWJvdXQgdGhlIGBgZmFzdGBgIG9wdGlvbi5cbiAgICAgIC8vIFNlZW1zIGxpa2UgYSBwcm9ibGVtIHdpdGggdHlwaW5ncy5cblxuICAgICAgLi4udGhpcy5hdXRoLFxuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgc3RhZ2UocGF0aFNwZWNzOiBzdHJpbmdbXSwgcmVtb3ZpbmcgPSBmYWxzZSkge1xuICAgIGxvZy52ZXJib3NlKGBDL2RiL2lzb2dpdDogU3RhZ2luZyBjaGFuZ2VzOiAke3BhdGhTcGVjcy5qb2luKCcsICcpfSB1c2luZyAke3JlbW92aW5nID8gXCJyZW1vdmUoKVwiIDogXCJhZGQoKVwifWApO1xuXG4gICAgZm9yIChjb25zdCBwYXRoU3BlYyBvZiBwYXRoU3BlY3MpIHtcbiAgICAgIGlmIChyZW1vdmluZyAhPT0gdHJ1ZSkge1xuICAgICAgICBhd2FpdCBnaXQuYWRkKHtcbiAgICAgICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgICBmaWxlcGF0aDogcGF0aFNwZWMsXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYXdhaXQgZ2l0LnJlbW92ZSh7XG4gICAgICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICAgICAgZmlsZXBhdGg6IHBhdGhTcGVjLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBhc3luYyBjb21taXQobXNnOiBzdHJpbmcpIHtcbiAgICBsb2cudmVyYm9zZShgQy9kYi9pc29naXQ6IENvbW1pdHRpbmcgd2l0aCBtZXNzYWdlICR7bXNnfWApO1xuXG4gICAgcmV0dXJuIGF3YWl0IGdpdC5jb21taXQoe1xuICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICBtZXNzYWdlOiBtc2csXG4gICAgICBhdXRob3I6IHRoaXMuYXV0aG9yLFxuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgZmV0Y2hSZW1vdGUoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgZ2l0LmZldGNoKHsgZGlyOiB0aGlzLndvcmtEaXIsIHJlbW90ZTogTUFJTl9SRU1PVEUsIC4uLnRoaXMuYXV0aCB9KTtcbiAgfVxuXG4gIGFzeW5jIGZldGNoVXBzdHJlYW0oKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgZ2l0LmZldGNoKHsgZGlyOiB0aGlzLndvcmtEaXIsIHJlbW90ZTogVVBTVFJFQU1fUkVNT1RFLCAuLi50aGlzLmF1dGggfSk7XG4gIH1cblxuICBhc3luYyBwdXNoKGZvcmNlID0gZmFsc2UpIHtcbiAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBQdXNoaW5nXCIpO1xuXG4gICAgcmV0dXJuIGF3YWl0IGdpdC5wdXNoKHtcbiAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgcmVtb3RlOiBNQUlOX1JFTU9URSxcbiAgICAgIGZvcmNlOiBmb3JjZSxcbiAgICAgIC4uLnRoaXMuYXV0aCxcbiAgICB9KTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyByZXNldEZpbGVzKHBhdGhzPzogc3RyaW5nW10pIHtcbiAgICByZXR1cm4gYXdhaXQgdGhpcy5zdGFnaW5nTG9jay5hY3F1aXJlKCcxJywgYXN5bmMgKCkgPT4ge1xuICAgICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogRm9yY2UgcmVzZXR0aW5nIGZpbGVzXCIpO1xuXG4gICAgICByZXR1cm4gYXdhaXQgZ2l0LmZhc3RDaGVja291dCh7XG4gICAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgICBmb3JjZTogdHJ1ZSxcbiAgICAgICAgZmlsZXBhdGhzOiBwYXRocyB8fCAoYXdhaXQgdGhpcy5saXN0Q2hhbmdlZEZpbGVzKCkpLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBnZXRPcmlnaW5VcmwoKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gICAgcmV0dXJuICgoYXdhaXQgZ2l0Lmxpc3RSZW1vdGVzKHtcbiAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgIH0pKS5maW5kKHIgPT4gci5yZW1vdGUgPT09IE1BSU5fUkVNT1RFKSB8fCB7IHVybDogbnVsbCB9KS51cmw7XG4gIH1cblxuICBhc3luYyBnZXRVcHN0cmVhbVVybCgpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgICByZXR1cm4gKChhd2FpdCBnaXQubGlzdFJlbW90ZXMoe1xuICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgfSkpLmZpbmQociA9PiByLnJlbW90ZSA9PT0gVVBTVFJFQU1fUkVNT1RFKSB8fCB7IHVybDogbnVsbCB9KS51cmw7XG4gIH1cblxuICBhc3luYyBsaXN0TG9jYWxDb21taXRzKCk6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgICAvKiBSZXR1cm5zIGEgbGlzdCBvZiBjb21taXQgbWVzc2FnZXMgZm9yIGNvbW1pdHMgdGhhdCB3ZXJlIG5vdCBwdXNoZWQgeWV0LlxuXG4gICAgICAgVXNlZnVsIHRvIGNoZWNrIHdoaWNoIGNvbW1pdHMgd2lsbCBiZSB0aHJvd24gb3V0XG4gICAgICAgaWYgd2UgZm9yY2UgdXBkYXRlIHRvIHJlbW90ZSBtYXN0ZXIuXG5cbiAgICAgICBEb2VzIHNvIGJ5IHdhbGtpbmcgdGhyb3VnaCBsYXN0IDEwMCBjb21taXRzIHN0YXJ0aW5nIGZyb20gY3VycmVudCBIRUFELlxuICAgICAgIFdoZW4gaXQgZW5jb3VudGVycyB0aGUgZmlyc3QgbG9jYWwgY29tbWl0IHRoYXQgZG9lc27igJl0IGRlc2NlbmRzIGZyb20gcmVtb3RlIG1hc3RlciBIRUFELFxuICAgICAgIGl0IGNvbnNpZGVycyBhbGwgcHJlY2VkaW5nIGNvbW1pdHMgdG8gYmUgYWhlYWQvbG9jYWwgYW5kIHJldHVybnMgdGhlbS5cblxuICAgICAgIElmIGl0IGZpbmlzaGVzIHRoZSB3YWxrIHdpdGhvdXQgZmluZGluZyBhbiBhbmNlc3RvciwgdGhyb3dzIGFuIGVycm9yLlxuICAgICAgIEl0IGlzIGFzc3VtZWQgdGhhdCB0aGUgYXBwIGRvZXMgbm90IGFsbG93IHRvIGFjY3VtdWxhdGVcbiAgICAgICBtb3JlIHRoYW4gMTAwIGNvbW1pdHMgd2l0aG91dCBwdXNoaW5nIChldmVuIDEwMCBpcyB0b28gbWFueSEpLFxuICAgICAgIHNvIHRoZXJl4oCZcyBwcm9iYWJseSBzb21ldGhpbmcgc3RyYW5nZSBnb2luZyBvbi5cblxuICAgICAgIE90aGVyIGFzc3VtcHRpb25zOlxuXG4gICAgICAgKiBnaXQubG9nIHJldHVybnMgY29tbWl0cyBmcm9tIG5ld2VzdCB0byBvbGRlc3QuXG4gICAgICAgKiBUaGUgcmVtb3RlIHdhcyBhbHJlYWR5IGZldGNoZWQuXG5cbiAgICAqL1xuXG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuc3RhZ2luZ0xvY2suYWNxdWlyZSgnMScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGxhdGVzdFJlbW90ZUNvbW1pdCA9IGF3YWl0IGdpdC5yZXNvbHZlUmVmKHtcbiAgICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICAgIHJlZjogYCR7TUFJTl9SRU1PVEV9L21hc3RlcmAsXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgbG9jYWxDb21taXRzID0gYXdhaXQgZ2l0LmxvZyh7XG4gICAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgICBkZXB0aDogMTAwLFxuICAgICAgfSk7XG5cbiAgICAgIHZhciBjb21taXRzID0gW10gYXMgc3RyaW5nW107XG4gICAgICBmb3IgKGNvbnN0IGNvbW1pdCBvZiBsb2NhbENvbW1pdHMpIHtcbiAgICAgICAgaWYgKGF3YWl0IGdpdC5pc0Rlc2NlbmRlbnQoeyBkaXI6IHRoaXMud29ya0Rpciwgb2lkOiBjb21taXQub2lkLCBhbmNlc3RvcjogbGF0ZXN0UmVtb3RlQ29tbWl0IH0pKSB7XG4gICAgICAgICAgY29tbWl0cy5wdXNoKGNvbW1pdC5tZXNzYWdlKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXR1cm4gY29tbWl0cztcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJEaWQgbm90IGZpbmQgYSBsb2NhbCBjb21taXQgdGhhdCBpcyBhbiBhbmNlc3RvciBvZiByZW1vdGUgbWFzdGVyXCIpO1xuICAgIH0pO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGxpc3RDaGFuZ2VkRmlsZXMocGF0aFNwZWNzID0gWycuJ10pOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gICAgLyogTGlzdHMgcmVsYXRpdmUgcGF0aHMgdG8gYWxsIGZpbGVzIHRoYXQgd2VyZSBjaGFuZ2VkIGFuZCBoYXZlIG5vdCBiZWVuIGNvbW1pdHRlZC4gKi9cblxuICAgIGNvbnN0IEZJTEUgPSAwLCBIRUFEID0gMSwgV09SS0RJUiA9IDI7XG5cbiAgICByZXR1cm4gKGF3YWl0IGdpdC5zdGF0dXNNYXRyaXgoeyBkaXI6IHRoaXMud29ya0RpciwgZmlsZXBhdGhzOiBwYXRoU3BlY3MgfSkpXG4gICAgICAuZmlsdGVyKHJvdyA9PiByb3dbSEVBRF0gIT09IHJvd1tXT1JLRElSXSlcbiAgICAgIC5tYXAocm93ID0+IHJvd1tGSUxFXSlcbiAgICAgIC5maWx0ZXIoZmlsZXBhdGggPT4gIWZpbGVwYXRoLnN0YXJ0c1dpdGgoJy4uJykgJiYgZmlsZXBhdGggIT09IFwiLkRTX1N0b3JlXCIpO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIHN0YWdlQW5kQ29tbWl0KHBhdGhTcGVjczogc3RyaW5nW10sIG1zZzogc3RyaW5nLCByZW1vdmluZyA9IGZhbHNlKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgICAvKiBTdGFnZXMgYW5kIGNvbW1pdHMgZmlsZXMgbWF0Y2hpbmcgZ2l2ZW4gcGF0aCBzcGVjIHdpdGggZ2l2ZW4gbWVzc2FnZS5cblxuICAgICAgIEFueSBvdGhlciBmaWxlcyBzdGFnZWQgYXQgdGhlIHRpbWUgb2YgdGhlIGNhbGwgd2lsbCBiZSB1bnN0YWdlZC5cblxuICAgICAgIFJldHVybnMgdGhlIG51bWJlciBvZiBtYXRjaGluZyBmaWxlcyB3aXRoIHVuc3RhZ2VkIGNoYW5nZXMgcHJpb3IgdG8gc3RhZ2luZy5cbiAgICAgICBJZiBubyBtYXRjaGluZyBmaWxlcyB3ZXJlIGZvdW5kIGhhdmluZyB1bnN0YWdlZCBjaGFuZ2VzLFxuICAgICAgIHNraXBzIHRoZSByZXN0IGFuZCByZXR1cm5zIHplcm8uXG5cbiAgICAgICBJZiBmYWlsSWZEaXZlcmdlZCBpcyBnaXZlbiwgYXR0ZW1wdHMgYSBmYXN0LWZvcndhcmQgcHVsbCBhZnRlciB0aGUgY29tbWl0LlxuICAgICAgIEl0IHdpbGwgZmFpbCBpbW1lZGlhdGVseSBpZiBtYWluIHJlbW90ZSBoYWQgb3RoZXIgY29tbWl0cyBhcHBlYXIgaW4gbWVhbnRpbWUuXG5cbiAgICAgICBMb2NrcyBzbyB0aGF0IHRoaXMgbWV0aG9kIGNhbm5vdCBiZSBydW4gY29uY3VycmVudGx5IChieSBzYW1lIGluc3RhbmNlKS5cbiAgICAqL1xuXG4gICAgaWYgKHBhdGhTcGVjcy5sZW5ndGggPCAxKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJXYXNu4oCZdCBnaXZlbiBhbnkgcGF0aHMgdG8gY29tbWl0IVwiKTtcbiAgICB9XG5cbiAgICByZXR1cm4gYXdhaXQgdGhpcy5zdGFnaW5nTG9jay5hY3F1aXJlKCcxJywgYXN5bmMgKCkgPT4ge1xuICAgICAgbG9nLnZlcmJvc2UoYEMvZGIvaXNvZ2l0OiBTdGFnaW5nIGFuZCBjb21taXR0aW5nOiAke3BhdGhTcGVjcy5qb2luKCcsICcpfWApO1xuXG4gICAgICBjb25zdCBmaWxlc0NoYW5nZWQgPSAoYXdhaXQgdGhpcy5saXN0Q2hhbmdlZEZpbGVzKHBhdGhTcGVjcykpLmxlbmd0aDtcbiAgICAgIGlmIChmaWxlc0NoYW5nZWQgPCAxKSB7XG4gICAgICAgIHJldHVybiAwO1xuICAgICAgfVxuXG4gICAgICBhd2FpdCB0aGlzLnVuc3RhZ2VBbGwoKTtcbiAgICAgIGF3YWl0IHRoaXMuc3RhZ2UocGF0aFNwZWNzLCByZW1vdmluZyk7XG4gICAgICBhd2FpdCB0aGlzLmNvbW1pdChtc2cpO1xuXG4gICAgICByZXR1cm4gZmlsZXNDaGFuZ2VkO1xuICAgIH0pO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGNoZWNrVW5jb21taXR0ZWQoKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgLyogQ2hlY2tzIGZvciBhbnkgdW5jb21taXR0ZWQgY2hhbmdlcyBsb2NhbGx5IHByZXNlbnQuXG4gICAgICAgTm90aWZpZXMgYWxsIHdpbmRvd3MgYWJvdXQgdGhlIHN0YXR1cy4gKi9cblxuICAgIGxvZy5kZWJ1ZyhcIkMvZGIvaXNvZ2l0OiBDaGVja2luZyBmb3IgdW5jb21taXR0ZWQgY2hhbmdlc1wiKTtcbiAgICBjb25zdCBjaGFuZ2VkRmlsZXMgPSBhd2FpdCB0aGlzLmxpc3RDaGFuZ2VkRmlsZXMoKTtcbiAgICBsb2cuZGVidWcoXCJDL2RiL2lzb2dpdDogQ2hhbmdlZCBmaWxlczpcIiwgY2hhbmdlZEZpbGVzKTtcbiAgICBjb25zdCBoYXNMb2NhbENoYW5nZXMgPSBjaGFuZ2VkRmlsZXMubGVuZ3RoID4gMDtcbiAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGhhc0xvY2FsQ2hhbmdlcyB9KTtcbiAgICByZXR1cm4gaGFzTG9jYWxDaGFuZ2VzO1xuICB9XG5cbiAgcHVibGljIHJlcXVlc3RQdXNoKCkge1xuICAgIHRoaXMucHVzaFBlbmRpbmcgPSB0cnVlO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIHN5bmNocm9uaXplKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIC8qIENoZWNrcyBmb3IgY29ubmVjdGlvbiwgbG9jYWwgY2hhbmdlcyBhbmQgdW5wdXNoZWQgY29tbWl0cyxcbiAgICAgICB0cmllcyB0byBwdXNoIGFuZCBwdWxsIHdoZW4gdGhlcmXigJlzIG9wcG9ydHVuaXR5LlxuXG4gICAgICAgTm90aWZpZXMgYWxsIHdpbmRvd3MgYWJvdXQgdGhlIHN0YXR1cyBpbiBwcm9jZXNzLiAqL1xuXG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogQ2hlY2tpbmcgaWYgY2xvbmUgZXhpc3RzXCIpO1xuXG4gICAgaWYgKCEoYXdhaXQgdGhpcy5pc0luaXRpYWxpemVkKCkpKSB7XG4gICAgICBhd2FpdCB0aGlzLmZvcmNlSW5pdGlhbGl6ZSgpO1xuXG4gICAgfSBlbHNlIHtcbiAgICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IENoZWNraW5nIGZvciB1bmNvbW1pdHRlZCBjaGFuZ2VzXCIpO1xuXG4gICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7XG4gICAgICAgIC4uLklOSVRJQUxfU1RBVFVTLFxuICAgICAgICBoYXNMb2NhbENoYW5nZXM6IGZhbHNlLFxuICAgICAgICBsYXN0U3luY2hyb25pemVkOiB0aGlzLnN0YXR1cy5sYXN0U3luY2hyb25pemVkLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IGhhc1VuY29tbWl0dGVkQ2hhbmdlcyA9IGF3YWl0IHRoaXMuY2hlY2tVbmNvbW1pdHRlZCgpO1xuXG4gICAgICBpZiAoaGFzVW5jb21taXR0ZWRDaGFuZ2VzKSB7XG4gICAgICAgIC8vIERvIG5vdCBydW4gcHVsbCBpZiB0aGVyZSBhcmUgdW5zdGFnZWQvdW5jb21taXR0ZWQgY2hhbmdlc1xuICAgICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGhhc0xvY2FsQ2hhbmdlczogdHJ1ZSB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gSWYgdW5jb21taXR0ZWQgY2hhbmdlcyB3ZXJlbuKAmXQgZGV0ZWN0ZWQsIHRoZXJlIG1heSBzdGlsbCBiZSBjaGFuZ2VkIGZpbGVzXG4gICAgICAgIC8vIHRoYXQgYXJlIG5vdCBtYW5hZ2VkIGJ5IHRoZSBiYWNrZW5kIChlLmcuLCAuRFNfU3RvcmUpLiBEaXNjYXJkIGFueSBzdHVmZiBsaWtlIHRoYXQuXG4gICAgICAgIGF3YWl0IHRoaXMucmVzZXRGaWxlcyhbJy4nXSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuc3RhZ2luZ0xvY2suaXNCdXN5KCkpIHtcbiAgICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IExvY2sgaXMgYnVzeSwgc2tpcHBpbmcgc3luY1wiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBRdWV1ZWluZyBzeW5jIG5vdywgbG9jayBpcyBub3QgYnVzeVwiKTtcblxuICAgIHJldHVybiBhd2FpdCB0aGlzLnN0YWdpbmdMb2NrLmFjcXVpcmUoJzEnLCBhc3luYyAoKSA9PiB7XG4gICAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBTdGFydGluZyBzeW5jXCIpO1xuXG4gICAgICBjb25zdCBpc09ubGluZSA9IChhd2FpdCBjaGVja09ubGluZVN0YXR1cygpKSA9PT0gdHJ1ZTtcblxuICAgICAgaWYgKGlzT25saW5lKSB7XG4gICAgICAgIGNvbnN0IG5lZWRzUGFzc3dvcmQgPSB0aGlzLm5lZWRzUGFzc3dvcmQoKTtcbiAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBuZWVkc1Bhc3N3b3JkIH0pO1xuICAgICAgICBpZiAobmVlZHNQYXNzd29yZCkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaXNPbmxpbmU6IHRydWUgfSk7XG5cbiAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBpc1B1bGxpbmc6IHRydWUgfSk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgdGhpcy5wdWxsKCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBsb2cuZXJyb3IoZSk7XG4gICAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoe1xuICAgICAgICAgICAgbGFzdFN5bmNocm9uaXplZDogbmV3IERhdGUoKSxcbiAgICAgICAgICAgIGlzUHVsbGluZzogZmFsc2UsXG4gICAgICAgICAgICBpc1B1c2hpbmc6IGZhbHNlLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGF3YWl0IHRoaXMuX2hhbmRsZUdpdEVycm9yKGUpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICAvL2F3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaXNQdWxsaW5nOiBmYWxzZSB9KTtcblxuICAgICAgICBpZiAodGhpcy5wdXNoUGVuZGluZykge1xuICAgICAgICAgIC8vIFJ1biBwdXNoIEFGVEVSIHB1bGwuIE1heSByZXN1bHQgaW4gZmFsc2UtcG9zaXRpdmUgbm9uLWZhc3QtZm9yd2FyZCByZWplY3Rpb25cbiAgICAgICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzUHVzaGluZzogdHJ1ZSB9KTtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wdXNoKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgbG9nLmVycm9yKGUpO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoe1xuICAgICAgICAgICAgICBsYXN0U3luY2hyb25pemVkOiBuZXcgRGF0ZSgpLFxuICAgICAgICAgICAgICBpc1B1bGxpbmc6IGZhbHNlLFxuICAgICAgICAgICAgICBpc1B1c2hpbmc6IGZhbHNlLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9oYW5kbGVHaXRFcnJvcihlKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhpcy5wdXNoUGVuZGluZyA9IGZhbHNlO1xuICAgICAgICAgIC8vYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBpc1B1c2hpbmc6IGZhbHNlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoe1xuICAgICAgICAgIHN0YXR1c1JlbGF0aXZlVG9Mb2NhbDogJ3VwZGF0ZWQnLFxuICAgICAgICAgIGlzTWlzY29uZmlndXJlZDogZmFsc2UsXG4gICAgICAgICAgbGFzdFN5bmNocm9uaXplZDogbmV3IERhdGUoKSxcbiAgICAgICAgICBuZWVkc1Bhc3N3b3JkOiBmYWxzZSxcbiAgICAgICAgICBpc1B1c2hpbmc6IGZhbHNlLFxuICAgICAgICAgIGlzUHVsbGluZzogZmFsc2UsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyB1bnN0YWdlQWxsKCkge1xuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IFVuc3RhZ2luZyBhbGwgY2hhbmdlc1wiKTtcbiAgICBhd2FpdCBnaXQucmVtb3ZlKHsgZGlyOiB0aGlzLndvcmtEaXIsIGZpbGVwYXRoOiAnLicgfSk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIF9oYW5kbGVHaXRFcnJvcihlOiBFcnJvciAmIHsgY29kZTogc3RyaW5nIH0pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBsb2cuZGVidWcoXCJIYW5kbGluZyBHaXQgZXJyb3JcIiwgZS5jb2RlLCBlKTtcblxuICAgIGlmIChlLmNvZGUgPT09ICdGYXN0Rm9yd2FyZEZhaWwnIHx8IGUuY29kZSA9PT0gJ01lcmdlTm90U3VwcG9ydGVkRmFpbCcpIHtcbiAgICAgIC8vIE5PVEU6IFRoZXJl4oCZcyBhbHNvIFB1c2hSZWplY3RlZE5vbkZhc3RGb3J3YXJkLCBidXQgaXQgc2VlbXMgdG8gYmUgdGhyb3duXG4gICAgICAvLyBmb3IgdW5yZWxhdGVkIGNhc2VzIGR1cmluZyBwdXNoIChmYWxzZSBwb3NpdGl2ZSkuXG4gICAgICAvLyBCZWNhdXNlIG9mIHRoYXQgZmFsc2UgcG9zaXRpdmUsIHdlIGlnbm9yZSB0aGF0IGVycm9yIGFuZCBpbnN0ZWFkIGRvIHB1bGwgZmlyc3QsXG4gICAgICAvLyBjYXRjaGluZyBhY3R1YWwgZmFzdC1mb3J3YXJkIGZhaWxzIG9uIHRoYXQgc3RlcCBiZWZvcmUgcHVzaC5cbiAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgc3RhdHVzUmVsYXRpdmVUb0xvY2FsOiAnZGl2ZXJnZWQnIH0pO1xuICAgIH0gZWxzZSBpZiAoWydNaXNzaW5nVXNlcm5hbWVFcnJvcicsICdNaXNzaW5nQXV0aG9yRXJyb3InLCAnTWlzc2luZ0NvbW1pdHRlckVycm9yJ10uaW5kZXhPZihlLmNvZGUpID49IDApIHtcbiAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaXNNaXNjb25maWd1cmVkOiB0cnVlIH0pO1xuICAgIH0gZWxzZSBpZiAoZS5jb2RlID09PSAnRUhPU1RET1dOJykge1xuICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBpc09ubGluZTogZmFsc2UgfSk7XG4gICAgICBsb2cud2FybihcIlBvc3NpYmxlIGNvbm5lY3Rpb24gaXNzdWVzXCIpO1xuICAgIH0gZWxzZSBpZiAoXG4gICAgICAgIGUuY29kZSA9PT0gJ01pc3NpbmdQYXNzd29yZFRva2VuRXJyb3InXG4gICAgICAgIHx8IChlLmNvZGUgPT09ICdIVFRQRXJyb3InICYmIGUubWVzc2FnZS5pbmRleE9mKCdVbmF1dGhvcml6ZWQnKSA+PSAwKSkge1xuICAgICAgbG9nLndhcm4oXCJQYXNzd29yZCBpbnB1dCByZXF1aXJlZFwiKTtcbiAgICAgIHRoaXMuc2V0UGFzc3dvcmQodW5kZWZpbmVkKTtcbiAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgbmVlZHNQYXNzd29yZDogdHJ1ZSB9KTtcbiAgICB9XG4gIH1cbn1cblxuXG5hc3luYyBmdW5jdGlvbiBjaGVja09ubGluZVN0YXR1cyh0aW1lb3V0ID0gNDUwMCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAvLyBUT0RPOiBNb3ZlIHRvIGdlbmVyYWwgdXRpbGl0eSBmdW5jdGlvbnNcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgbG9nLmRlYnVnKFwiQy9kYi9pc29naXQ6IENvbm5lY3Rpb24gdGVzdDogU3RhcnRpbmdcIik7XG5cbiAgICBjb25zdCByZXEgPSBodHRwcy5nZXQoJ2h0dHBzOi8vZ2l0aHViLmNvbS8nLCB7IHRpbWVvdXQgfSwgcmVwb3J0T25saW5lKTtcblxuICAgIHJlcS5vbignZXJyb3InLCAoKSA9PiByZXEuYWJvcnQoKSk7XG4gICAgcmVxLm9uKCdyZXNwb25zZScsIHJlcG9ydE9ubGluZSk7XG4gICAgcmVxLm9uKCdjb25uZWN0JywgcmVwb3J0T25saW5lKTtcbiAgICByZXEub24oJ2NvbnRpbnVlJywgcmVwb3J0T25saW5lKTtcbiAgICByZXEub24oJ3VwZ3JhZGUnLCByZXBvcnRPbmxpbmUpO1xuICAgIHJlcS5vbigndGltZW91dCcsIHJlcG9ydE9mZmxpbmUpO1xuXG4gICAgcmVxLmVuZCgpO1xuXG4gICAgY29uc3QgY2hlY2tUaW1lb3V0ID0gc2V0VGltZW91dChyZXBvcnRPZmZsaW5lLCB0aW1lb3V0KTtcblxuICAgIGZ1bmN0aW9uIHJlcG9ydE9mZmxpbmUoKSB7XG4gICAgICBsb2cud2FybihcIkMvZGIvaXNvZ2l0OiBDb25uZWN0aW9uIHRlc3Q6IFJlcG9ydCBvZmZsaW5lXCIpO1xuICAgICAgdHJ5IHsgcmVxLmFib3J0KCk7IH0gY2F0Y2ggKGUpIHt9XG4gICAgICBjbGVhclRpbWVvdXQoY2hlY2tUaW1lb3V0KTtcbiAgICAgIHJlc29sdmUoZmFsc2UpO1xuICAgIH1cbiAgICBmdW5jdGlvbiByZXBvcnRPbmxpbmUoKSB7XG4gICAgICBsb2cuaW5mbyhcIkMvZGIvaXNvZ2l0OiBDb25uZWN0aW9uIHRlc3Q6IFJlcG9ydCBvbmxpbmVcIik7XG4gICAgICB0cnkgeyByZXEuYWJvcnQoKTsgfSBjYXRjaCAoZSkge31cbiAgICAgIGNsZWFyVGltZW91dChjaGVja1RpbWVvdXQpO1xuICAgICAgcmVzb2x2ZSh0cnVlKTtcbiAgICB9XG4gIH0pO1xufVxuXG5cbi8vIFRPRE86IFRlbXBvcmFyeSB3b3JrYXJvdW5kIHNpbmNlIGlzb21vcnBoaWMtZ2l0IGRvZXNu4oCZdCBzZWVtIHRvIGV4cG9ydCBpdHMgR2l0RXJyb3IgY2xhc3Ncbi8vIGluIGFueSB3YXkgYXZhaWxhYmxlIHRvIFRTLCBzbyB3ZSBjYW7igJl0IHVzZSBpbnN0YW5jZW9mIDooXG5cbmV4cG9ydCBmdW5jdGlvbiBpc0dpdEVycm9yKGU6IEVycm9yICYgeyBjb2RlOiBzdHJpbmcgfSkge1xuICBpZiAoIWUuY29kZSkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gT2JqZWN0LmtleXMoSXNvbW9ycGhpY0dpdEVycm9yQ29kZXMpLmluZGV4T2YoZS5jb2RlKSA+PSAwO1xufVxuXG5jb25zdCBJc29tb3JwaGljR2l0RXJyb3JDb2RlcyA9IHtcbiAgRmlsZVJlYWRFcnJvcjogYEZpbGVSZWFkRXJyb3JgLFxuICBNaXNzaW5nUmVxdWlyZWRQYXJhbWV0ZXJFcnJvcjogYE1pc3NpbmdSZXF1aXJlZFBhcmFtZXRlckVycm9yYCxcbiAgSW52YWxpZFJlZk5hbWVFcnJvcjogYEludmFsaWRSZWZOYW1lRXJyb3JgLFxuICBJbnZhbGlkUGFyYW1ldGVyQ29tYmluYXRpb25FcnJvcjogYEludmFsaWRQYXJhbWV0ZXJDb21iaW5hdGlvbkVycm9yYCxcbiAgUmVmRXhpc3RzRXJyb3I6IGBSZWZFeGlzdHNFcnJvcmAsXG4gIFJlZk5vdEV4aXN0c0Vycm9yOiBgUmVmTm90RXhpc3RzRXJyb3JgLFxuICBCcmFuY2hEZWxldGVFcnJvcjogYEJyYW5jaERlbGV0ZUVycm9yYCxcbiAgTm9IZWFkQ29tbWl0RXJyb3I6IGBOb0hlYWRDb21taXRFcnJvcmAsXG4gIENvbW1pdE5vdEZldGNoZWRFcnJvcjogYENvbW1pdE5vdEZldGNoZWRFcnJvcmAsXG4gIE9iamVjdFR5cGVVbmtub3duRmFpbDogYE9iamVjdFR5cGVVbmtub3duRmFpbGAsXG4gIE9iamVjdFR5cGVBc3NlcnRpb25GYWlsOiBgT2JqZWN0VHlwZUFzc2VydGlvbkZhaWxgLFxuICBPYmplY3RUeXBlQXNzZXJ0aW9uSW5UcmVlRmFpbDogYE9iamVjdFR5cGVBc3NlcnRpb25JblRyZWVGYWlsYCxcbiAgT2JqZWN0VHlwZUFzc2VydGlvbkluUmVmRmFpbDogYE9iamVjdFR5cGVBc3NlcnRpb25JblJlZkZhaWxgLFxuICBPYmplY3RUeXBlQXNzZXJ0aW9uSW5QYXRoRmFpbDogYE9iamVjdFR5cGVBc3NlcnRpb25JblBhdGhGYWlsYCxcbiAgTWlzc2luZ0F1dGhvckVycm9yOiBgTWlzc2luZ0F1dGhvckVycm9yYCxcbiAgTWlzc2luZ0NvbW1pdHRlckVycm9yOiBgTWlzc2luZ0NvbW1pdHRlckVycm9yYCxcbiAgTWlzc2luZ1RhZ2dlckVycm9yOiBgTWlzc2luZ1RhZ2dlckVycm9yYCxcbiAgR2l0Um9vdE5vdEZvdW5kRXJyb3I6IGBHaXRSb290Tm90Rm91bmRFcnJvcmAsXG4gIFVucGFyc2VhYmxlU2VydmVyUmVzcG9uc2VGYWlsOiBgVW5wYXJzZWFibGVTZXJ2ZXJSZXNwb25zZUZhaWxgLFxuICBJbnZhbGlkRGVwdGhQYXJhbWV0ZXJFcnJvcjogYEludmFsaWREZXB0aFBhcmFtZXRlckVycm9yYCxcbiAgUmVtb3RlRG9lc05vdFN1cHBvcnRTaGFsbG93RmFpbDogYFJlbW90ZURvZXNOb3RTdXBwb3J0U2hhbGxvd0ZhaWxgLFxuICBSZW1vdGVEb2VzTm90U3VwcG9ydERlZXBlblNpbmNlRmFpbDogYFJlbW90ZURvZXNOb3RTdXBwb3J0RGVlcGVuU2luY2VGYWlsYCxcbiAgUmVtb3RlRG9lc05vdFN1cHBvcnREZWVwZW5Ob3RGYWlsOiBgUmVtb3RlRG9lc05vdFN1cHBvcnREZWVwZW5Ob3RGYWlsYCxcbiAgUmVtb3RlRG9lc05vdFN1cHBvcnREZWVwZW5SZWxhdGl2ZUZhaWw6IGBSZW1vdGVEb2VzTm90U3VwcG9ydERlZXBlblJlbGF0aXZlRmFpbGAsXG4gIFJlbW90ZURvZXNOb3RTdXBwb3J0U21hcnRIVFRQOiBgUmVtb3RlRG9lc05vdFN1cHBvcnRTbWFydEhUVFBgLFxuICBDb3JydXB0U2hhbGxvd09pZEZhaWw6IGBDb3JydXB0U2hhbGxvd09pZEZhaWxgLFxuICBGYXN0Rm9yd2FyZEZhaWw6IGBGYXN0Rm9yd2FyZEZhaWxgLFxuICBNZXJnZU5vdFN1cHBvcnRlZEZhaWw6IGBNZXJnZU5vdFN1cHBvcnRlZEZhaWxgLFxuICBEaXJlY3RvcnlTZXBhcmF0b3JzRXJyb3I6IGBEaXJlY3RvcnlTZXBhcmF0b3JzRXJyb3JgLFxuICBSZXNvbHZlVHJlZUVycm9yOiBgUmVzb2x2ZVRyZWVFcnJvcmAsXG4gIFJlc29sdmVDb21taXRFcnJvcjogYFJlc29sdmVDb21taXRFcnJvcmAsXG4gIERpcmVjdG9yeUlzQUZpbGVFcnJvcjogYERpcmVjdG9yeUlzQUZpbGVFcnJvcmAsXG4gIFRyZWVPckJsb2JOb3RGb3VuZEVycm9yOiBgVHJlZU9yQmxvYk5vdEZvdW5kRXJyb3JgLFxuICBOb3RJbXBsZW1lbnRlZEZhaWw6IGBOb3RJbXBsZW1lbnRlZEZhaWxgLFxuICBSZWFkT2JqZWN0RmFpbDogYFJlYWRPYmplY3RGYWlsYCxcbiAgTm90QW5PaWRGYWlsOiBgTm90QW5PaWRGYWlsYCxcbiAgTm9SZWZzcGVjQ29uZmlndXJlZEVycm9yOiBgTm9SZWZzcGVjQ29uZmlndXJlZEVycm9yYCxcbiAgTWlzbWF0Y2hSZWZWYWx1ZUVycm9yOiBgTWlzbWF0Y2hSZWZWYWx1ZUVycm9yYCxcbiAgUmVzb2x2ZVJlZkVycm9yOiBgUmVzb2x2ZVJlZkVycm9yYCxcbiAgRXhwYW5kUmVmRXJyb3I6IGBFeHBhbmRSZWZFcnJvcmAsXG4gIEVtcHR5U2VydmVyUmVzcG9uc2VGYWlsOiBgRW1wdHlTZXJ2ZXJSZXNwb25zZUZhaWxgLFxuICBBc3NlcnRTZXJ2ZXJSZXNwb25zZUZhaWw6IGBBc3NlcnRTZXJ2ZXJSZXNwb25zZUZhaWxgLFxuICBIVFRQRXJyb3I6IGBIVFRQRXJyb3JgLFxuICBSZW1vdGVVcmxQYXJzZUVycm9yOiBgUmVtb3RlVXJsUGFyc2VFcnJvcmAsXG4gIFVua25vd25UcmFuc3BvcnRFcnJvcjogYFVua25vd25UcmFuc3BvcnRFcnJvcmAsXG4gIEFjcXVpcmVMb2NrRmlsZUZhaWw6IGBBY3F1aXJlTG9ja0ZpbGVGYWlsYCxcbiAgRG91YmxlUmVsZWFzZUxvY2tGaWxlRmFpbDogYERvdWJsZVJlbGVhc2VMb2NrRmlsZUZhaWxgLFxuICBJbnRlcm5hbEZhaWw6IGBJbnRlcm5hbEZhaWxgLFxuICBVbmtub3duT2F1dGgyRm9ybWF0OiBgVW5rbm93bk9hdXRoMkZvcm1hdGAsXG4gIE1pc3NpbmdQYXNzd29yZFRva2VuRXJyb3I6IGBNaXNzaW5nUGFzc3dvcmRUb2tlbkVycm9yYCxcbiAgTWlzc2luZ1VzZXJuYW1lRXJyb3I6IGBNaXNzaW5nVXNlcm5hbWVFcnJvcmAsXG4gIE1peFBhc3N3b3JkVG9rZW5FcnJvcjogYE1peFBhc3N3b3JkVG9rZW5FcnJvcmAsXG4gIE1peFVzZXJuYW1lUGFzc3dvcmRUb2tlbkVycm9yOiBgTWl4VXNlcm5hbWVQYXNzd29yZFRva2VuRXJyb3JgLFxuICBNaXNzaW5nVG9rZW5FcnJvcjogYE1pc3NpbmdUb2tlbkVycm9yYCxcbiAgTWl4VXNlcm5hbWVPYXV0aDJmb3JtYXRNaXNzaW5nVG9rZW5FcnJvcjogYE1peFVzZXJuYW1lT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3JgLFxuICBNaXhQYXNzd29yZE9hdXRoMmZvcm1hdE1pc3NpbmdUb2tlbkVycm9yOiBgTWl4UGFzc3dvcmRPYXV0aDJmb3JtYXRNaXNzaW5nVG9rZW5FcnJvcmAsXG4gIE1peFVzZXJuYW1lUGFzc3dvcmRPYXV0aDJmb3JtYXRNaXNzaW5nVG9rZW5FcnJvcjogYE1peFVzZXJuYW1lUGFzc3dvcmRPYXV0aDJmb3JtYXRNaXNzaW5nVG9rZW5FcnJvcmAsXG4gIE1peFVzZXJuYW1lT2F1dGgyZm9ybWF0VG9rZW5FcnJvcjogYE1peFVzZXJuYW1lT2F1dGgyZm9ybWF0VG9rZW5FcnJvcmAsXG4gIE1peFBhc3N3b3JkT2F1dGgyZm9ybWF0VG9rZW5FcnJvcjogYE1peFBhc3N3b3JkT2F1dGgyZm9ybWF0VG9rZW5FcnJvcmAsXG4gIE1peFVzZXJuYW1lUGFzc3dvcmRPYXV0aDJmb3JtYXRUb2tlbkVycm9yOiBgTWl4VXNlcm5hbWVQYXNzd29yZE9hdXRoMmZvcm1hdFRva2VuRXJyb3JgLFxuICBNYXhTZWFyY2hEZXB0aEV4Y2VlZGVkOiBgTWF4U2VhcmNoRGVwdGhFeGNlZWRlZGAsXG4gIFB1c2hSZWplY3RlZE5vbkZhc3RGb3J3YXJkOiBgUHVzaFJlamVjdGVkTm9uRmFzdEZvcndhcmRgLFxuICBQdXNoUmVqZWN0ZWRUYWdFeGlzdHM6IGBQdXNoUmVqZWN0ZWRUYWdFeGlzdHNgLFxuICBBZGRpbmdSZW1vdGVXb3VsZE92ZXJ3cml0ZTogYEFkZGluZ1JlbW90ZVdvdWxkT3ZlcndyaXRlYCxcbiAgUGx1Z2luVW5kZWZpbmVkOiBgUGx1Z2luVW5kZWZpbmVkYCxcbiAgQ29yZU5vdEZvdW5kOiBgQ29yZU5vdEZvdW5kYCxcbiAgUGx1Z2luU2NoZW1hVmlvbGF0aW9uOiBgUGx1Z2luU2NoZW1hVmlvbGF0aW9uYCxcbiAgUGx1Z2luVW5yZWNvZ25pemVkOiBgUGx1Z2luVW5yZWNvZ25pemVkYCxcbiAgQW1iaWd1b3VzU2hvcnRPaWQ6IGBBbWJpZ3VvdXNTaG9ydE9pZGAsXG4gIFNob3J0T2lkTm90Rm91bmQ6IGBTaG9ydE9pZE5vdEZvdW5kYCxcbiAgQ2hlY2tvdXRDb25mbGljdEVycm9yOiBgQ2hlY2tvdXRDb25mbGljdEVycm9yYFxufVxuXG4iXX0=