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
    }
    // Authentication
    setPassword(value) {
        this.auth.password = value;
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
            .filter(filepath => !filepath.startsWith('..'));
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
        const hasUncommittedChanges = (await this.listChangedFiles()).length > 0;
        await this.setStatus({ hasLocalChanges: hasUncommittedChanges });
        return hasUncommittedChanges;
    }
    async synchronize() {
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
                    // Run push AFTER pull. May result in false-positive non-fast-forward rejection
                    //await this.setStatus({ isPushing: true });
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
                    //await this.setStatus({ isPushing: false });
                    await this.setStatus({
                        statusRelativeToLocal: 'updated',
                        isMisconfigured: false,
                        lastSynchronized: new Date(),
                        needsPassword: false,
                        isPushing: false,
                        isPulling: false,
                    });
                }
                else {
                    await this.setStatus({ hasLocalChanges: true });
                }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFzZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9kYi9pc29naXQteWFtbC9tYWluL2lzb2dpdC9iYXNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sS0FBSyxLQUFLLE1BQU0sT0FBTyxDQUFDO0FBQy9CLE9BQU8sS0FBSyxJQUFJLE1BQU0sTUFBTSxDQUFDO0FBQzdCLE9BQU8sU0FBUyxNQUFNLFlBQVksQ0FBQztBQUNuQyxPQUFPLEtBQUssR0FBRyxNQUFNLGdCQUFnQixDQUFDO0FBQ3RDLE9BQU8sS0FBSyxHQUFHLE1BQU0sY0FBYyxDQUFDO0FBTXBDLE1BQU0sZUFBZSxHQUFHLFVBQVUsQ0FBQztBQUNuQyxNQUFNLFdBQVcsR0FBRyxRQUFRLENBQUM7QUFHN0IsTUFBTSxjQUFjLEdBQWM7SUFDaEMsUUFBUSxFQUFFLEtBQUs7SUFDZixlQUFlLEVBQUUsS0FBSztJQUN0QixlQUFlLEVBQUUsS0FBSztJQUN0QixhQUFhLEVBQUUsS0FBSztJQUNwQixxQkFBcUIsRUFBRSxTQUFTO0lBQ2hDLGdCQUFnQixFQUFFLElBQUk7SUFDdEIsU0FBUyxFQUFFLEtBQUs7SUFDaEIsU0FBUyxFQUFFLEtBQUs7Q0FDakIsQ0FBQTtBQUdELE1BQU0sT0FBTyxhQUFhO0lBUXhCLFlBQ1ksRUFBTyxFQUNQLE9BQWUsRUFDZixlQUFtQyxFQUMzQyxRQUFnQixFQUNSLE1BQXVDLEVBQ3hDLE9BQWUsRUFDZCxTQUFpQixFQUNqQixjQUFxRDtRQVByRCxPQUFFLEdBQUYsRUFBRSxDQUFLO1FBQ1AsWUFBTyxHQUFQLE9BQU8sQ0FBUTtRQUNmLG9CQUFlLEdBQWYsZUFBZSxDQUFvQjtRQUVuQyxXQUFNLEdBQU4sTUFBTSxDQUFpQztRQUN4QyxZQUFPLEdBQVAsT0FBTyxDQUFRO1FBQ2QsY0FBUyxHQUFULFNBQVMsQ0FBUTtRQUNqQixtQkFBYyxHQUFkLGNBQWMsQ0FBdUM7UUFkekQsU0FBSSxHQUFzQixFQUFFLENB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QUM5QywwQkFBMEIsRUFBRSw0QkFBNEI7SUFDeEQsZUFBZSxFQUFFLGlCQUFpQjtJQUNsQyxZQUFZLEVBQUUsY0FBYztJQUM1QixxQkFBcUIsRUFBRSx1QkFBdUI7SUFDOUMsa0JBQWtCLEVBQUUsb0JBQW9CO0lBQ3hDLGlCQUFpQixFQUFFLG1CQUFtQjtJQUN0QyxnQkFBZ0IsRUFBRSxrQkFBa0I7SUFDcEMscUJBQXFCLEVBQUUsdUJBQXVCO0NBQy9DLENBQUEiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBodHRwcyBmcm9tICdodHRwcyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0IEFzeW5jTG9jayBmcm9tICdhc3luYy1sb2NrJztcbmltcG9ydCAqIGFzIGdpdCBmcm9tICdpc29tb3JwaGljLWdpdCc7XG5pbXBvcnQgKiBhcyBsb2cgZnJvbSAnZWxlY3Ryb24tbG9nJztcblxuaW1wb3J0IHsgR2l0U3RhdHVzIH0gZnJvbSAnLi4vLi4vYmFzZSc7XG5pbXBvcnQgeyBHaXRBdXRoZW50aWNhdGlvbiB9IGZyb20gJy4vdHlwZXMnO1xuXG5cbmNvbnN0IFVQU1RSRUFNX1JFTU9URSA9ICd1cHN0cmVhbSc7XG5jb25zdCBNQUlOX1JFTU9URSA9ICdvcmlnaW4nO1xuXG5cbmNvbnN0IElOSVRJQUxfU1RBVFVTOiBHaXRTdGF0dXMgPSB7XG4gIGlzT25saW5lOiBmYWxzZSxcbiAgaXNNaXNjb25maWd1cmVkOiBmYWxzZSxcbiAgaGFzTG9jYWxDaGFuZ2VzOiBmYWxzZSxcbiAgbmVlZHNQYXNzd29yZDogZmFsc2UsXG4gIHN0YXR1c1JlbGF0aXZlVG9Mb2NhbDogdW5kZWZpbmVkLFxuICBsYXN0U3luY2hyb25pemVkOiBudWxsLFxuICBpc1B1c2hpbmc6IGZhbHNlLFxuICBpc1B1bGxpbmc6IGZhbHNlLFxufVxuXG5cbmV4cG9ydCBjbGFzcyBJc29HaXRXcmFwcGVyIHtcblxuICBwcml2YXRlIGF1dGg6IEdpdEF1dGhlbnRpY2F0aW9uID0ge307XG5cbiAgcHJpdmF0ZSBzdGFnaW5nTG9jazogQXN5bmNMb2NrO1xuXG4gIHByaXZhdGUgc3RhdHVzOiBHaXRTdGF0dXM7XG5cbiAgY29uc3RydWN0b3IoXG4gICAgICBwcml2YXRlIGZzOiBhbnksXG4gICAgICBwcml2YXRlIHJlcG9Vcmw6IHN0cmluZyxcbiAgICAgIHByaXZhdGUgdXBzdHJlYW1SZXBvVXJsOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICAgICB1c2VybmFtZTogc3RyaW5nLFxuICAgICAgcHJpdmF0ZSBhdXRob3I6IHsgbmFtZTogc3RyaW5nLCBlbWFpbDogc3RyaW5nIH0sXG4gICAgICBwdWJsaWMgd29ya0Rpcjogc3RyaW5nLFxuICAgICAgcHJpdmF0ZSBjb3JzUHJveHk6IHN0cmluZyxcbiAgICAgIHByaXZhdGUgc3RhdHVzUmVwb3J0ZXI6IChwYXlsb2FkOiBHaXRTdGF0dXMpID0+IFByb21pc2U8dm9pZD4pIHtcblxuICAgIGdpdC5wbHVnaW5zLnNldCgnZnMnLCBmcyk7XG5cbiAgICB0aGlzLnN0YWdpbmdMb2NrID0gbmV3IEFzeW5jTG9jayh7IHRpbWVvdXQ6IDIwMDAwLCBtYXhQZW5kaW5nOiAyIH0pO1xuXG4gICAgLy8gTWFrZXMgaXQgZWFzaWVyIHRvIGJpbmQgdGhlc2UgdG8gSVBDIGV2ZW50c1xuICAgIHRoaXMuc3luY2hyb25pemUgPSB0aGlzLnN5bmNocm9uaXplLmJpbmQodGhpcyk7XG4gICAgdGhpcy5yZXNldEZpbGVzID0gdGhpcy5yZXNldEZpbGVzLmJpbmQodGhpcyk7XG4gICAgdGhpcy5jaGVja1VuY29tbWl0dGVkID0gdGhpcy5jaGVja1VuY29tbWl0dGVkLmJpbmQodGhpcyk7XG5cbiAgICB0aGlzLmF1dGgudXNlcm5hbWUgPSB1c2VybmFtZTtcblxuICAgIHRoaXMuc3RhdHVzID0gSU5JVElBTF9TVEFUVVM7XG4gIH1cblxuXG4gIC8vIFJlcG9ydGluZyBHaXQgc3RhdHVzIHRvIERCIGJhY2tlbmQsXG4gIC8vIHNvIHRoYXQgaXQgY2FuIGJlIHJlZmxlY3RlZCBpbiB0aGUgR1VJXG5cbiAgcHJpdmF0ZSBhc3luYyByZXBvcnRTdGF0dXMoKSB7XG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuc3RhdHVzUmVwb3J0ZXIodGhpcy5zdGF0dXMpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBzZXRTdGF0dXMoc3RhdHVzOiBQYXJ0aWFsPEdpdFN0YXR1cz4pIHtcbiAgICBPYmplY3QuYXNzaWduKHRoaXMuc3RhdHVzLCBzdGF0dXMpO1xuICAgIGF3YWl0IHRoaXMucmVwb3J0U3RhdHVzKCk7XG4gIH1cblxuICBwdWJsaWMgZ2V0U3RhdHVzKCk6IEdpdFN0YXR1cyB7XG4gICAgcmV0dXJuIHRoaXMuc3RhdHVzO1xuICB9XG5cblxuICAvLyBJbml0aWxhaXphdGlvblxuXG4gIHB1YmxpYyBhc3luYyBpc0luaXRpYWxpemVkKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIGxldCBoYXNHaXREaXJlY3Rvcnk6IGJvb2xlYW47XG4gICAgdHJ5IHtcbiAgICAgIGhhc0dpdERpcmVjdG9yeSA9IChhd2FpdCB0aGlzLmZzLnN0YXQocGF0aC5qb2luKHRoaXMud29ya0RpciwgJy5naXQnKSkpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaGFzR2l0RGlyZWN0b3J5ID0gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiBoYXNHaXREaXJlY3Rvcnk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgaXNVc2luZ1JlbW90ZVVSTHMocmVtb3RlVXJsczogeyBvcmlnaW46IHN0cmluZywgdXBzdHJlYW0/OiBzdHJpbmcgfSk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIGNvbnN0IG9yaWdpbiA9IChhd2FpdCB0aGlzLmdldE9yaWdpblVybCgpIHx8ICcnKS50cmltKCk7XG4gICAgY29uc3QgdXBzdHJlYW0gPSAoYXdhaXQgdGhpcy5nZXRVcHN0cmVhbVVybCgpIHx8ICcnKS50cmltKCk7XG4gICAgcmV0dXJuIG9yaWdpbiA9PT0gcmVtb3RlVXJscy5vcmlnaW4gJiYgKHJlbW90ZVVybHMudXBzdHJlYW0gPT09IHVuZGVmaW5lZCB8fCB1cHN0cmVhbSA9PT0gcmVtb3RlVXJscy51cHN0cmVhbSk7XG4gIH1cblxuICBwdWJsaWMgbmVlZHNQYXNzd29yZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gKHRoaXMuYXV0aC5wYXNzd29yZCB8fCAnJykudHJpbSgpID09PSAnJztcbiAgfVxuXG4gIHB1YmxpYyBnZXRVc2VybmFtZSgpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0aGlzLmF1dGgudXNlcm5hbWU7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgZGVzdHJveSgpIHtcbiAgICAvKiBSZW1vdmVzIHdvcmtpbmcgZGlyZWN0b3J5LlxuICAgICAgIE9uIG5leHQgc3luYyBHaXQgcmVwbyB3aWxsIGhhdmUgdG8gYmUgcmVpbml0aWFsaXplZCwgY2xvbmVkIGV0Yy4gKi9cblxuICAgIGxvZy53YXJuKFwiQy9kYi9pc29naXQ6IEluaXRpYWxpemU6IFJlbW92aW5nIGRhdGEgZGlyZWN0b3J5XCIpO1xuICAgIGF3YWl0IHRoaXMuZnMucmVtb3ZlKHRoaXMud29ya0Rpcik7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGZvcmNlSW5pdGlhbGl6ZSgpIHtcbiAgICAvKiBJbml0aWFsaXplcyBmcm9tIHNjcmF0Y2g6IHdpcGVzIHdvcmsgZGlyZWN0b3J5LCBjbG9uZXMgcmVwb3NpdG9yeSwgYWRkcyByZW1vdGVzLiAqL1xuXG4gICAgbG9nLndhcm4oXCJDL2RiL2lzb2dpdDogSW5pdGlhbGl6aW5nXCIpO1xuXG4gICAgbG9nLnNpbGx5KFwiQy9kYi9pc29naXQ6IEluaXRpYWxpemU6IEVuc3VyaW5nIGRhdGEgZGlyZWN0b3J5IGV4aXN0c1wiKTtcbiAgICBhd2FpdCB0aGlzLmZzLmVuc3VyZURpcih0aGlzLndvcmtEaXIpO1xuXG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogSW5pdGlhbGl6ZTogQ2xvbmluZ1wiLCB0aGlzLnJlcG9VcmwpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGdpdC5jbG9uZSh7XG4gICAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgICB1cmw6IHRoaXMucmVwb1VybCxcbiAgICAgICAgcmVmOiAnbWFzdGVyJyxcbiAgICAgICAgc2luZ2xlQnJhbmNoOiB0cnVlLFxuICAgICAgICBkZXB0aDogNSxcbiAgICAgICAgY29yc1Byb3h5OiB0aGlzLmNvcnNQcm94eSxcbiAgICAgICAgLi4udGhpcy5hdXRoLFxuICAgICAgfSk7XG5cbiAgICAgIGlmICh0aGlzLnVwc3RyZWFtUmVwb1VybCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGxvZy5kZWJ1ZyhcIkMvZGIvaXNvZ2l0OiBJbml0aWFsaXplOiBBZGRpbmcgdXBzdHJlYW0gcmVtb3RlXCIsIHRoaXMudXBzdHJlYW1SZXBvVXJsKTtcbiAgICAgICAgYXdhaXQgZ2l0LmFkZFJlbW90ZSh7XG4gICAgICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICAgICAgcmVtb3RlOiBVUFNUUkVBTV9SRU1PVEUsXG4gICAgICAgICAgdXJsOiB0aGlzLnVwc3RyZWFtUmVwb1VybCxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBsb2cud2FybihcIkMvZGIvaXNvZ2l0OiBJbml0aWFsaXplOiBObyB1cHN0cmVhbSByZW1vdGUgc3BlY2lmaWVkXCIpO1xuICAgICAgfVxuXG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgbG9nLmVycm9yKFwiQy9kYi9pc29naXQ6IEVycm9yIGR1cmluZyBpbml0aWFsaXphdGlvblwiKVxuICAgICAgYXdhaXQgdGhpcy5mcy5yZW1vdmUodGhpcy53b3JrRGlyKTtcbiAgICAgIGF3YWl0IHRoaXMuX2hhbmRsZUdpdEVycm9yKGUpO1xuICAgICAgdGhyb3cgZTtcbiAgICB9XG4gIH1cblxuXG4gIC8vIEF1dGhlbnRpY2F0aW9uXG5cbiAgcHVibGljIHNldFBhc3N3b3JkKHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgICB0aGlzLmF1dGgucGFzc3dvcmQgPSB2YWx1ZTtcbiAgfVxuXG5cbiAgLy8gR2l0IG9wZXJhdGlvbnNcblxuICBhc3luYyBjb25maWdTZXQocHJvcDogc3RyaW5nLCB2YWw6IHN0cmluZykge1xuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IFNldCBjb25maWdcIik7XG4gICAgYXdhaXQgZ2l0LmNvbmZpZyh7IGRpcjogdGhpcy53b3JrRGlyLCBwYXRoOiBwcm9wLCB2YWx1ZTogdmFsIH0pO1xuICB9XG5cbiAgYXN5bmMgY29uZmlnR2V0KHByb3A6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogR2V0IGNvbmZpZ1wiLCBwcm9wKTtcbiAgICByZXR1cm4gYXdhaXQgZ2l0LmNvbmZpZyh7IGRpcjogdGhpcy53b3JrRGlyLCBwYXRoOiBwcm9wIH0pO1xuICB9XG5cbiAgYXN5bmMgcmVhZEZpbGVCbG9iQXRDb21taXQocmVsYXRpdmVGaWxlUGF0aDogc3RyaW5nLCBjb21taXRIYXNoOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIC8qIFJlYWRzIGZpbGUgY29udGVudHMgYXQgZ2l2ZW4gcGF0aCBhcyBvZiBnaXZlbiBjb21taXQuIEZpbGUgY29udGVudHMgbXVzdCB1c2UgVVRGLTggZW5jb2RpbmcuICovXG5cbiAgICByZXR1cm4gKGF3YWl0IGdpdC5yZWFkQmxvYih7XG4gICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgIG9pZDogY29tbWl0SGFzaCxcbiAgICAgIGZpbGVwYXRoOiByZWxhdGl2ZUZpbGVQYXRoLFxuICAgIH0pKS5ibG9iLnRvU3RyaW5nKCk7XG4gIH1cblxuICBhc3luYyBwdWxsKCkge1xuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IFB1bGxpbmcgbWFzdGVyIHdpdGggZmFzdC1mb3J3YXJkIG1lcmdlXCIpO1xuXG4gICAgcmV0dXJuIGF3YWl0IGdpdC5wdWxsKHtcbiAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgc2luZ2xlQnJhbmNoOiB0cnVlLFxuICAgICAgZmFzdEZvcndhcmRPbmx5OiB0cnVlLFxuXG4gICAgICBmYXN0OiB0cnVlLFxuICAgICAgLy8gTk9URTogVHlwZVNjcmlwdCBpcyBrbm93biB0byBjb21wbGFpbiBhYm91dCB0aGUgYGBmYXN0YGAgb3B0aW9uLlxuICAgICAgLy8gU2VlbXMgbGlrZSBhIHByb2JsZW0gd2l0aCB0eXBpbmdzLlxuXG4gICAgICAuLi50aGlzLmF1dGgsXG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBzdGFnZShwYXRoU3BlY3M6IHN0cmluZ1tdLCByZW1vdmluZyA9IGZhbHNlKSB7XG4gICAgbG9nLnZlcmJvc2UoYEMvZGIvaXNvZ2l0OiBTdGFnaW5nIGNoYW5nZXM6ICR7cGF0aFNwZWNzLmpvaW4oJywgJyl9IHVzaW5nICR7cmVtb3ZpbmcgPyBcInJlbW92ZSgpXCIgOiBcImFkZCgpXCJ9YCk7XG5cbiAgICBmb3IgKGNvbnN0IHBhdGhTcGVjIG9mIHBhdGhTcGVjcykge1xuICAgICAgaWYgKHJlbW92aW5nICE9PSB0cnVlKSB7XG4gICAgICAgIGF3YWl0IGdpdC5hZGQoe1xuICAgICAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgICAgIGZpbGVwYXRoOiBwYXRoU3BlYyxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhd2FpdCBnaXQucmVtb3ZlKHtcbiAgICAgICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgICBmaWxlcGF0aDogcGF0aFNwZWMsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGFzeW5jIGNvbW1pdChtc2c6IHN0cmluZykge1xuICAgIGxvZy52ZXJib3NlKGBDL2RiL2lzb2dpdDogQ29tbWl0dGluZyB3aXRoIG1lc3NhZ2UgJHttc2d9YCk7XG5cbiAgICByZXR1cm4gYXdhaXQgZ2l0LmNvbW1pdCh7XG4gICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgIG1lc3NhZ2U6IG1zZyxcbiAgICAgIGF1dGhvcjogdGhpcy5hdXRob3IsXG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBmZXRjaFJlbW90ZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCBnaXQuZmV0Y2goeyBkaXI6IHRoaXMud29ya0RpciwgcmVtb3RlOiBNQUlOX1JFTU9URSwgLi4udGhpcy5hdXRoIH0pO1xuICB9XG5cbiAgYXN5bmMgZmV0Y2hVcHN0cmVhbSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCBnaXQuZmV0Y2goeyBkaXI6IHRoaXMud29ya0RpciwgcmVtb3RlOiBVUFNUUkVBTV9SRU1PVEUsIC4uLnRoaXMuYXV0aCB9KTtcbiAgfVxuXG4gIGFzeW5jIHB1c2goZm9yY2UgPSBmYWxzZSkge1xuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IFB1c2hpbmdcIik7XG5cbiAgICByZXR1cm4gYXdhaXQgZ2l0LnB1c2goe1xuICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICByZW1vdGU6IE1BSU5fUkVNT1RFLFxuICAgICAgZm9yY2U6IGZvcmNlLFxuICAgICAgLi4udGhpcy5hdXRoLFxuICAgIH0pO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIHJlc2V0RmlsZXMocGF0aHM/OiBzdHJpbmdbXSkge1xuICAgIHJldHVybiBhd2FpdCB0aGlzLnN0YWdpbmdMb2NrLmFjcXVpcmUoJzEnLCBhc3luYyAoKSA9PiB7XG4gICAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBGb3JjZSByZXNldHRpbmcgZmlsZXNcIik7XG5cbiAgICAgIHJldHVybiBhd2FpdCBnaXQuZmFzdENoZWNrb3V0KHtcbiAgICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICAgIGZvcmNlOiB0cnVlLFxuICAgICAgICBmaWxlcGF0aHM6IHBhdGhzIHx8IChhd2FpdCB0aGlzLmxpc3RDaGFuZ2VkRmlsZXMoKSksXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIGdldE9yaWdpblVybCgpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgICByZXR1cm4gKChhd2FpdCBnaXQubGlzdFJlbW90ZXMoe1xuICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgfSkpLmZpbmQociA9PiByLnJlbW90ZSA9PT0gTUFJTl9SRU1PVEUpIHx8IHsgdXJsOiBudWxsIH0pLnVybDtcbiAgfVxuXG4gIGFzeW5jIGdldFVwc3RyZWFtVXJsKCk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICAgIHJldHVybiAoKGF3YWl0IGdpdC5saXN0UmVtb3Rlcyh7XG4gICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICB9KSkuZmluZChyID0+IHIucmVtb3RlID09PSBVUFNUUkVBTV9SRU1PVEUpIHx8IHsgdXJsOiBudWxsIH0pLnVybDtcbiAgfVxuXG4gIGFzeW5jIGxpc3RMb2NhbENvbW1pdHMoKTogUHJvbWlzZTxzdHJpbmdbXT4ge1xuICAgIC8qIFJldHVybnMgYSBsaXN0IG9mIGNvbW1pdCBtZXNzYWdlcyBmb3IgY29tbWl0cyB0aGF0IHdlcmUgbm90IHB1c2hlZCB5ZXQuXG5cbiAgICAgICBVc2VmdWwgdG8gY2hlY2sgd2hpY2ggY29tbWl0cyB3aWxsIGJlIHRocm93biBvdXRcbiAgICAgICBpZiB3ZSBmb3JjZSB1cGRhdGUgdG8gcmVtb3RlIG1hc3Rlci5cblxuICAgICAgIERvZXMgc28gYnkgd2Fsa2luZyB0aHJvdWdoIGxhc3QgMTAwIGNvbW1pdHMgc3RhcnRpbmcgZnJvbSBjdXJyZW50IEhFQUQuXG4gICAgICAgV2hlbiBpdCBlbmNvdW50ZXJzIHRoZSBmaXJzdCBsb2NhbCBjb21taXQgdGhhdCBkb2VzbuKAmXQgZGVzY2VuZHMgZnJvbSByZW1vdGUgbWFzdGVyIEhFQUQsXG4gICAgICAgaXQgY29uc2lkZXJzIGFsbCBwcmVjZWRpbmcgY29tbWl0cyB0byBiZSBhaGVhZC9sb2NhbCBhbmQgcmV0dXJucyB0aGVtLlxuXG4gICAgICAgSWYgaXQgZmluaXNoZXMgdGhlIHdhbGsgd2l0aG91dCBmaW5kaW5nIGFuIGFuY2VzdG9yLCB0aHJvd3MgYW4gZXJyb3IuXG4gICAgICAgSXQgaXMgYXNzdW1lZCB0aGF0IHRoZSBhcHAgZG9lcyBub3QgYWxsb3cgdG8gYWNjdW11bGF0ZVxuICAgICAgIG1vcmUgdGhhbiAxMDAgY29tbWl0cyB3aXRob3V0IHB1c2hpbmcgKGV2ZW4gMTAwIGlzIHRvbyBtYW55ISksXG4gICAgICAgc28gdGhlcmXigJlzIHByb2JhYmx5IHNvbWV0aGluZyBzdHJhbmdlIGdvaW5nIG9uLlxuXG4gICAgICAgT3RoZXIgYXNzdW1wdGlvbnM6XG5cbiAgICAgICAqIGdpdC5sb2cgcmV0dXJucyBjb21taXRzIGZyb20gbmV3ZXN0IHRvIG9sZGVzdC5cbiAgICAgICAqIFRoZSByZW1vdGUgd2FzIGFscmVhZHkgZmV0Y2hlZC5cblxuICAgICovXG5cbiAgICByZXR1cm4gYXdhaXQgdGhpcy5zdGFnaW5nTG9jay5hY3F1aXJlKCcxJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgbGF0ZXN0UmVtb3RlQ29tbWl0ID0gYXdhaXQgZ2l0LnJlc29sdmVSZWYoe1xuICAgICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgcmVmOiBgJHtNQUlOX1JFTU9URX0vbWFzdGVyYCxcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBsb2NhbENvbW1pdHMgPSBhd2FpdCBnaXQubG9nKHtcbiAgICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICAgIGRlcHRoOiAxMDAsXG4gICAgICB9KTtcblxuICAgICAgdmFyIGNvbW1pdHMgPSBbXSBhcyBzdHJpbmdbXTtcbiAgICAgIGZvciAoY29uc3QgY29tbWl0IG9mIGxvY2FsQ29tbWl0cykge1xuICAgICAgICBpZiAoYXdhaXQgZ2l0LmlzRGVzY2VuZGVudCh7IGRpcjogdGhpcy53b3JrRGlyLCBvaWQ6IGNvbW1pdC5vaWQsIGFuY2VzdG9yOiBsYXRlc3RSZW1vdGVDb21taXQgfSkpIHtcbiAgICAgICAgICBjb21taXRzLnB1c2goY29tbWl0Lm1lc3NhZ2UpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJldHVybiBjb21taXRzO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkRpZCBub3QgZmluZCBhIGxvY2FsIGNvbW1pdCB0aGF0IGlzIGFuIGFuY2VzdG9yIG9mIHJlbW90ZSBtYXN0ZXJcIik7XG4gICAgfSk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgbGlzdENoYW5nZWRGaWxlcyhwYXRoU3BlY3MgPSBbJy4nXSk6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgICAvKiBMaXN0cyByZWxhdGl2ZSBwYXRocyB0byBhbGwgZmlsZXMgdGhhdCB3ZXJlIGNoYW5nZWQgYW5kIGhhdmUgbm90IGJlZW4gY29tbWl0dGVkLiAqL1xuXG4gICAgY29uc3QgRklMRSA9IDAsIEhFQUQgPSAxLCBXT1JLRElSID0gMjtcblxuICAgIHJldHVybiAoYXdhaXQgZ2l0LnN0YXR1c01hdHJpeCh7IGRpcjogdGhpcy53b3JrRGlyLCBmaWxlcGF0aHM6IHBhdGhTcGVjcyB9KSlcbiAgICAgIC5maWx0ZXIocm93ID0+IHJvd1tIRUFEXSAhPT0gcm93W1dPUktESVJdKVxuICAgICAgLm1hcChyb3cgPT4gcm93W0ZJTEVdKVxuICAgICAgLmZpbHRlcihmaWxlcGF0aCA9PiAhZmlsZXBhdGguc3RhcnRzV2l0aCgnLi4nKSk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgc3RhZ2VBbmRDb21taXQocGF0aFNwZWNzOiBzdHJpbmdbXSwgbXNnOiBzdHJpbmcsIHJlbW92aW5nID0gZmFsc2UpOiBQcm9taXNlPG51bWJlcj4ge1xuICAgIC8qIFN0YWdlcyBhbmQgY29tbWl0cyBmaWxlcyBtYXRjaGluZyBnaXZlbiBwYXRoIHNwZWMgd2l0aCBnaXZlbiBtZXNzYWdlLlxuXG4gICAgICAgQW55IG90aGVyIGZpbGVzIHN0YWdlZCBhdCB0aGUgdGltZSBvZiB0aGUgY2FsbCB3aWxsIGJlIHVuc3RhZ2VkLlxuXG4gICAgICAgUmV0dXJucyB0aGUgbnVtYmVyIG9mIG1hdGNoaW5nIGZpbGVzIHdpdGggdW5zdGFnZWQgY2hhbmdlcyBwcmlvciB0byBzdGFnaW5nLlxuICAgICAgIElmIG5vIG1hdGNoaW5nIGZpbGVzIHdlcmUgZm91bmQgaGF2aW5nIHVuc3RhZ2VkIGNoYW5nZXMsXG4gICAgICAgc2tpcHMgdGhlIHJlc3QgYW5kIHJldHVybnMgemVyby5cblxuICAgICAgIElmIGZhaWxJZkRpdmVyZ2VkIGlzIGdpdmVuLCBhdHRlbXB0cyBhIGZhc3QtZm9yd2FyZCBwdWxsIGFmdGVyIHRoZSBjb21taXQuXG4gICAgICAgSXQgd2lsbCBmYWlsIGltbWVkaWF0ZWx5IGlmIG1haW4gcmVtb3RlIGhhZCBvdGhlciBjb21taXRzIGFwcGVhciBpbiBtZWFudGltZS5cblxuICAgICAgIExvY2tzIHNvIHRoYXQgdGhpcyBtZXRob2QgY2Fubm90IGJlIHJ1biBjb25jdXJyZW50bHkgKGJ5IHNhbWUgaW5zdGFuY2UpLlxuICAgICovXG5cbiAgICBpZiAocGF0aFNwZWNzLmxlbmd0aCA8IDEpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIldhc27igJl0IGdpdmVuIGFueSBwYXRocyB0byBjb21taXQhXCIpO1xuICAgIH1cblxuICAgIHJldHVybiBhd2FpdCB0aGlzLnN0YWdpbmdMb2NrLmFjcXVpcmUoJzEnLCBhc3luYyAoKSA9PiB7XG4gICAgICBsb2cudmVyYm9zZShgQy9kYi9pc29naXQ6IFN0YWdpbmcgYW5kIGNvbW1pdHRpbmc6ICR7cGF0aFNwZWNzLmpvaW4oJywgJyl9YCk7XG5cbiAgICAgIGNvbnN0IGZpbGVzQ2hhbmdlZCA9IChhd2FpdCB0aGlzLmxpc3RDaGFuZ2VkRmlsZXMocGF0aFNwZWNzKSkubGVuZ3RoO1xuICAgICAgaWYgKGZpbGVzQ2hhbmdlZCA8IDEpIHtcbiAgICAgICAgcmV0dXJuIDA7XG4gICAgICB9XG5cbiAgICAgIGF3YWl0IHRoaXMudW5zdGFnZUFsbCgpO1xuICAgICAgYXdhaXQgdGhpcy5zdGFnZShwYXRoU3BlY3MsIHJlbW92aW5nKTtcbiAgICAgIGF3YWl0IHRoaXMuY29tbWl0KG1zZyk7XG5cbiAgICAgIHJldHVybiBmaWxlc0NoYW5nZWQ7XG4gICAgfSk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgY2hlY2tVbmNvbW1pdHRlZCgpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICAvKiBDaGVja3MgZm9yIGFueSB1bmNvbW1pdHRlZCBjaGFuZ2VzIGxvY2FsbHkgcHJlc2VudC5cbiAgICAgICBOb3RpZmllcyBhbGwgd2luZG93cyBhYm91dCB0aGUgc3RhdHVzLiAqL1xuXG4gICAgbG9nLmRlYnVnKFwiQy9kYi9pc29naXQ6IENoZWNraW5nIGZvciB1bmNvbW1pdHRlZCBjaGFuZ2VzXCIpO1xuICAgIGNvbnN0IGhhc1VuY29tbWl0dGVkQ2hhbmdlcyA9IChhd2FpdCB0aGlzLmxpc3RDaGFuZ2VkRmlsZXMoKSkubGVuZ3RoID4gMDtcbiAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGhhc0xvY2FsQ2hhbmdlczogaGFzVW5jb21taXR0ZWRDaGFuZ2VzIH0pO1xuICAgIHJldHVybiBoYXNVbmNvbW1pdHRlZENoYW5nZXM7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgc3luY2hyb25pemUoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgLyogQ2hlY2tzIGZvciBjb25uZWN0aW9uLCBsb2NhbCBjaGFuZ2VzIGFuZCB1bnB1c2hlZCBjb21taXRzLFxuICAgICAgIHRyaWVzIHRvIHB1c2ggYW5kIHB1bGwgd2hlbiB0aGVyZeKAmXMgb3Bwb3J0dW5pdHkuXG5cbiAgICAgICBOb3RpZmllcyBhbGwgd2luZG93cyBhYm91dCB0aGUgc3RhdHVzIGluIHByb2Nlc3MuICovXG5cbiAgICBpZiAodGhpcy5zdGFnaW5nTG9jay5pc0J1c3koKSkge1xuICAgICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogTG9jayBpcyBidXN5LCBza2lwcGluZyBzeW5jXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IFF1ZXVlaW5nIHN5bmNcIik7XG5cbiAgICByZXR1cm4gYXdhaXQgdGhpcy5zdGFnaW5nTG9jay5hY3F1aXJlKCcxJywgYXN5bmMgKCkgPT4ge1xuICAgICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogU3RhcnRpbmcgc3luY1wiKTtcblxuICAgICAgY29uc3QgaXNPbmxpbmUgPSAoYXdhaXQgY2hlY2tPbmxpbmVTdGF0dXMoKSkgPT09IHRydWU7XG5cbiAgICAgIGlmIChpc09ubGluZSkge1xuICAgICAgICBjb25zdCBuZWVkc1Bhc3N3b3JkID0gdGhpcy5uZWVkc1Bhc3N3b3JkKCk7XG4gICAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgbmVlZHNQYXNzd29yZCB9KTtcbiAgICAgICAgaWYgKG5lZWRzUGFzc3dvcmQpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIShhd2FpdCB0aGlzLmlzSW5pdGlhbGl6ZWQoKSkpIHtcbiAgICAgICAgICBhd2FpdCB0aGlzLmZvcmNlSW5pdGlhbGl6ZSgpO1xuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBpc09ubGluZTogdHJ1ZSB9KTtcblxuICAgICAgICBjb25zdCBoYXNVbmNvbW1pdHRlZENoYW5nZXMgPSBhd2FpdCB0aGlzLmNoZWNrVW5jb21taXR0ZWQoKTtcblxuICAgICAgICAvLyBEbyBub3QgcnVuIHB1bGwgaWYgdGhlcmUgYXJlIHVuc3RhZ2VkL3VuY29tbWl0dGVkIGNoYW5nZXNcbiAgICAgICAgaWYgKCFoYXNVbmNvbW1pdHRlZENoYW5nZXMpIHtcbiAgICAgICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzUHVsbGluZzogdHJ1ZSB9KTtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wdWxsKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgbG9nLmVycm9yKGUpO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoe1xuICAgICAgICAgICAgICBsYXN0U3luY2hyb25pemVkOiBuZXcgRGF0ZSgpLFxuICAgICAgICAgICAgICBpc1B1bGxpbmc6IGZhbHNlLFxuICAgICAgICAgICAgICBpc1B1c2hpbmc6IGZhbHNlLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9oYW5kbGVHaXRFcnJvcihlKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy9hd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzUHVsbGluZzogZmFsc2UgfSk7XG5cbiAgICAgICAgICAvLyBSdW4gcHVzaCBBRlRFUiBwdWxsLiBNYXkgcmVzdWx0IGluIGZhbHNlLXBvc2l0aXZlIG5vbi1mYXN0LWZvcndhcmQgcmVqZWN0aW9uXG4gICAgICAgICAgLy9hd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzUHVzaGluZzogdHJ1ZSB9KTtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wdXNoKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgbG9nLmVycm9yKGUpO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoe1xuICAgICAgICAgICAgICBsYXN0U3luY2hyb25pemVkOiBuZXcgRGF0ZSgpLFxuICAgICAgICAgICAgICBpc1B1bGxpbmc6IGZhbHNlLFxuICAgICAgICAgICAgICBpc1B1c2hpbmc6IGZhbHNlLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9oYW5kbGVHaXRFcnJvcihlKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy9hd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzUHVzaGluZzogZmFsc2UgfSk7XG5cbiAgICAgICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7XG4gICAgICAgICAgICBzdGF0dXNSZWxhdGl2ZVRvTG9jYWw6ICd1cGRhdGVkJyxcbiAgICAgICAgICAgIGlzTWlzY29uZmlndXJlZDogZmFsc2UsXG4gICAgICAgICAgICBsYXN0U3luY2hyb25pemVkOiBuZXcgRGF0ZSgpLFxuICAgICAgICAgICAgbmVlZHNQYXNzd29yZDogZmFsc2UsXG4gICAgICAgICAgICBpc1B1c2hpbmc6IGZhbHNlLFxuICAgICAgICAgICAgaXNQdWxsaW5nOiBmYWxzZSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGhhc0xvY2FsQ2hhbmdlczogdHJ1ZSB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyB1bnN0YWdlQWxsKCkge1xuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IFVuc3RhZ2luZyBhbGwgY2hhbmdlc1wiKTtcbiAgICBhd2FpdCBnaXQucmVtb3ZlKHsgZGlyOiB0aGlzLndvcmtEaXIsIGZpbGVwYXRoOiAnLicgfSk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIF9oYW5kbGVHaXRFcnJvcihlOiBFcnJvciAmIHsgY29kZTogc3RyaW5nIH0pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBsb2cuZGVidWcoXCJIYW5kbGluZyBHaXQgZXJyb3JcIiwgZSk7XG5cbiAgICBpZiAoZS5jb2RlID09PSAnRmFzdEZvcndhcmRGYWlsJyB8fCBlLmNvZGUgPT09ICdNZXJnZU5vdFN1cHBvcnRlZEZhaWwnKSB7XG4gICAgICAvLyBOT1RFOiBUaGVyZeKAmXMgYWxzbyBQdXNoUmVqZWN0ZWROb25GYXN0Rm9yd2FyZCwgYnV0IGl0IHNlZW1zIHRvIGJlIHRocm93blxuICAgICAgLy8gZm9yIHVucmVsYXRlZCBjYXNlcyBkdXJpbmcgcHVzaCAoZmFsc2UgcG9zaXRpdmUpLlxuICAgICAgLy8gQmVjYXVzZSBvZiB0aGF0IGZhbHNlIHBvc2l0aXZlLCB3ZSBpZ25vcmUgdGhhdCBlcnJvciBhbmQgaW5zdGVhZCBkbyBwdWxsIGZpcnN0LFxuICAgICAgLy8gY2F0Y2hpbmcgYWN0dWFsIGZhc3QtZm9yd2FyZCBmYWlscyBvbiB0aGF0IHN0ZXAgYmVmb3JlIHB1c2guXG4gICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IHN0YXR1c1JlbGF0aXZlVG9Mb2NhbDogJ2RpdmVyZ2VkJyB9KTtcbiAgICB9IGVsc2UgaWYgKFsnTWlzc2luZ1VzZXJuYW1lRXJyb3InLCAnTWlzc2luZ0F1dGhvckVycm9yJywgJ01pc3NpbmdDb21taXR0ZXJFcnJvciddLmluZGV4T2YoZS5jb2RlKSA+PSAwKSB7XG4gICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzTWlzY29uZmlndXJlZDogdHJ1ZSB9KTtcbiAgICB9IGVsc2UgaWYgKFxuICAgICAgICBlLmNvZGUgPT09ICdNaXNzaW5nUGFzc3dvcmRUb2tlbkVycm9yJ1xuICAgICAgICB8fCAoZS5jb2RlID09PSAnSFRUUEVycm9yJyAmJiBlLm1lc3NhZ2UuaW5kZXhPZignVW5hdXRob3JpemVkJykgPj0gMCkpIHtcbiAgICAgIGxvZy53YXJuKFwiUGFzc3dvcmQgaW5wdXQgcmVxdWlyZWRcIik7XG4gICAgICB0aGlzLnNldFBhc3N3b3JkKHVuZGVmaW5lZCk7XG4gICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IG5lZWRzUGFzc3dvcmQ6IHRydWUgfSk7XG4gICAgfVxuICB9XG59XG5cblxuYXN5bmMgZnVuY3Rpb24gY2hlY2tPbmxpbmVTdGF0dXModGltZW91dCA9IDQ1MDApOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgLy8gVE9ETzogTW92ZSB0byBnZW5lcmFsIHV0aWxpdHkgZnVuY3Rpb25zXG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgIGxvZy5kZWJ1ZyhcIkMvZGIvaXNvZ2l0OiBDb25uZWN0aW9uIHRlc3Q6IFN0YXJ0aW5nXCIpO1xuXG4gICAgY29uc3QgcmVxID0gaHR0cHMuZ2V0KCdodHRwczovL2dpdGh1Yi5jb20vJywgeyB0aW1lb3V0IH0sIHJlcG9ydE9ubGluZSk7XG5cbiAgICByZXEub24oJ2Vycm9yJywgKCkgPT4gcmVxLmFib3J0KCkpO1xuICAgIHJlcS5vbigncmVzcG9uc2UnLCByZXBvcnRPbmxpbmUpO1xuICAgIHJlcS5vbignY29ubmVjdCcsIHJlcG9ydE9ubGluZSk7XG4gICAgcmVxLm9uKCdjb250aW51ZScsIHJlcG9ydE9ubGluZSk7XG4gICAgcmVxLm9uKCd1cGdyYWRlJywgcmVwb3J0T25saW5lKTtcbiAgICByZXEub24oJ3RpbWVvdXQnLCByZXBvcnRPZmZsaW5lKTtcblxuICAgIHJlcS5lbmQoKTtcblxuICAgIGNvbnN0IGNoZWNrVGltZW91dCA9IHNldFRpbWVvdXQocmVwb3J0T2ZmbGluZSwgdGltZW91dCk7XG5cbiAgICBmdW5jdGlvbiByZXBvcnRPZmZsaW5lKCkge1xuICAgICAgbG9nLndhcm4oXCJDL2RiL2lzb2dpdDogQ29ubmVjdGlvbiB0ZXN0OiBSZXBvcnQgb2ZmbGluZVwiKTtcbiAgICAgIHRyeSB7IHJlcS5hYm9ydCgpOyB9IGNhdGNoIChlKSB7fVxuICAgICAgY2xlYXJUaW1lb3V0KGNoZWNrVGltZW91dCk7XG4gICAgICByZXNvbHZlKGZhbHNlKTtcbiAgICB9XG4gICAgZnVuY3Rpb24gcmVwb3J0T25saW5lKCkge1xuICAgICAgbG9nLmluZm8oXCJDL2RiL2lzb2dpdDogQ29ubmVjdGlvbiB0ZXN0OiBSZXBvcnQgb25saW5lXCIpO1xuICAgICAgdHJ5IHsgcmVxLmFib3J0KCk7IH0gY2F0Y2ggKGUpIHt9XG4gICAgICBjbGVhclRpbWVvdXQoY2hlY2tUaW1lb3V0KTtcbiAgICAgIHJlc29sdmUodHJ1ZSk7XG4gICAgfVxuICB9KTtcbn1cblxuXG4vLyBUT0RPOiBUZW1wb3Jhcnkgd29ya2Fyb3VuZCBzaW5jZSBpc29tb3JwaGljLWdpdCBkb2VzbuKAmXQgc2VlbSB0byBleHBvcnQgaXRzIEdpdEVycm9yIGNsYXNzXG4vLyBpbiBhbnkgd2F5IGF2YWlsYWJsZSB0byBUUywgc28gd2UgY2Fu4oCZdCB1c2UgaW5zdGFuY2VvZiA6KFxuXG5leHBvcnQgZnVuY3Rpb24gaXNHaXRFcnJvcihlOiBFcnJvciAmIHsgY29kZTogc3RyaW5nIH0pIHtcbiAgaWYgKCFlLmNvZGUpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIE9iamVjdC5rZXlzKElzb21vcnBoaWNHaXRFcnJvckNvZGVzKS5pbmRleE9mKGUuY29kZSkgPj0gMDtcbn1cblxuY29uc3QgSXNvbW9ycGhpY0dpdEVycm9yQ29kZXMgPSB7XG4gIEZpbGVSZWFkRXJyb3I6IGBGaWxlUmVhZEVycm9yYCxcbiAgTWlzc2luZ1JlcXVpcmVkUGFyYW1ldGVyRXJyb3I6IGBNaXNzaW5nUmVxdWlyZWRQYXJhbWV0ZXJFcnJvcmAsXG4gIEludmFsaWRSZWZOYW1lRXJyb3I6IGBJbnZhbGlkUmVmTmFtZUVycm9yYCxcbiAgSW52YWxpZFBhcmFtZXRlckNvbWJpbmF0aW9uRXJyb3I6IGBJbnZhbGlkUGFyYW1ldGVyQ29tYmluYXRpb25FcnJvcmAsXG4gIFJlZkV4aXN0c0Vycm9yOiBgUmVmRXhpc3RzRXJyb3JgLFxuICBSZWZOb3RFeGlzdHNFcnJvcjogYFJlZk5vdEV4aXN0c0Vycm9yYCxcbiAgQnJhbmNoRGVsZXRlRXJyb3I6IGBCcmFuY2hEZWxldGVFcnJvcmAsXG4gIE5vSGVhZENvbW1pdEVycm9yOiBgTm9IZWFkQ29tbWl0RXJyb3JgLFxuICBDb21taXROb3RGZXRjaGVkRXJyb3I6IGBDb21taXROb3RGZXRjaGVkRXJyb3JgLFxuICBPYmplY3RUeXBlVW5rbm93bkZhaWw6IGBPYmplY3RUeXBlVW5rbm93bkZhaWxgLFxuICBPYmplY3RUeXBlQXNzZXJ0aW9uRmFpbDogYE9iamVjdFR5cGVBc3NlcnRpb25GYWlsYCxcbiAgT2JqZWN0VHlwZUFzc2VydGlvbkluVHJlZUZhaWw6IGBPYmplY3RUeXBlQXNzZXJ0aW9uSW5UcmVlRmFpbGAsXG4gIE9iamVjdFR5cGVBc3NlcnRpb25JblJlZkZhaWw6IGBPYmplY3RUeXBlQXNzZXJ0aW9uSW5SZWZGYWlsYCxcbiAgT2JqZWN0VHlwZUFzc2VydGlvbkluUGF0aEZhaWw6IGBPYmplY3RUeXBlQXNzZXJ0aW9uSW5QYXRoRmFpbGAsXG4gIE1pc3NpbmdBdXRob3JFcnJvcjogYE1pc3NpbmdBdXRob3JFcnJvcmAsXG4gIE1pc3NpbmdDb21taXR0ZXJFcnJvcjogYE1pc3NpbmdDb21taXR0ZXJFcnJvcmAsXG4gIE1pc3NpbmdUYWdnZXJFcnJvcjogYE1pc3NpbmdUYWdnZXJFcnJvcmAsXG4gIEdpdFJvb3ROb3RGb3VuZEVycm9yOiBgR2l0Um9vdE5vdEZvdW5kRXJyb3JgLFxuICBVbnBhcnNlYWJsZVNlcnZlclJlc3BvbnNlRmFpbDogYFVucGFyc2VhYmxlU2VydmVyUmVzcG9uc2VGYWlsYCxcbiAgSW52YWxpZERlcHRoUGFyYW1ldGVyRXJyb3I6IGBJbnZhbGlkRGVwdGhQYXJhbWV0ZXJFcnJvcmAsXG4gIFJlbW90ZURvZXNOb3RTdXBwb3J0U2hhbGxvd0ZhaWw6IGBSZW1vdGVEb2VzTm90U3VwcG9ydFNoYWxsb3dGYWlsYCxcbiAgUmVtb3RlRG9lc05vdFN1cHBvcnREZWVwZW5TaW5jZUZhaWw6IGBSZW1vdGVEb2VzTm90U3VwcG9ydERlZXBlblNpbmNlRmFpbGAsXG4gIFJlbW90ZURvZXNOb3RTdXBwb3J0RGVlcGVuTm90RmFpbDogYFJlbW90ZURvZXNOb3RTdXBwb3J0RGVlcGVuTm90RmFpbGAsXG4gIFJlbW90ZURvZXNOb3RTdXBwb3J0RGVlcGVuUmVsYXRpdmVGYWlsOiBgUmVtb3RlRG9lc05vdFN1cHBvcnREZWVwZW5SZWxhdGl2ZUZhaWxgLFxuICBSZW1vdGVEb2VzTm90U3VwcG9ydFNtYXJ0SFRUUDogYFJlbW90ZURvZXNOb3RTdXBwb3J0U21hcnRIVFRQYCxcbiAgQ29ycnVwdFNoYWxsb3dPaWRGYWlsOiBgQ29ycnVwdFNoYWxsb3dPaWRGYWlsYCxcbiAgRmFzdEZvcndhcmRGYWlsOiBgRmFzdEZvcndhcmRGYWlsYCxcbiAgTWVyZ2VOb3RTdXBwb3J0ZWRGYWlsOiBgTWVyZ2VOb3RTdXBwb3J0ZWRGYWlsYCxcbiAgRGlyZWN0b3J5U2VwYXJhdG9yc0Vycm9yOiBgRGlyZWN0b3J5U2VwYXJhdG9yc0Vycm9yYCxcbiAgUmVzb2x2ZVRyZWVFcnJvcjogYFJlc29sdmVUcmVlRXJyb3JgLFxuICBSZXNvbHZlQ29tbWl0RXJyb3I6IGBSZXNvbHZlQ29tbWl0RXJyb3JgLFxuICBEaXJlY3RvcnlJc0FGaWxlRXJyb3I6IGBEaXJlY3RvcnlJc0FGaWxlRXJyb3JgLFxuICBUcmVlT3JCbG9iTm90Rm91bmRFcnJvcjogYFRyZWVPckJsb2JOb3RGb3VuZEVycm9yYCxcbiAgTm90SW1wbGVtZW50ZWRGYWlsOiBgTm90SW1wbGVtZW50ZWRGYWlsYCxcbiAgUmVhZE9iamVjdEZhaWw6IGBSZWFkT2JqZWN0RmFpbGAsXG4gIE5vdEFuT2lkRmFpbDogYE5vdEFuT2lkRmFpbGAsXG4gIE5vUmVmc3BlY0NvbmZpZ3VyZWRFcnJvcjogYE5vUmVmc3BlY0NvbmZpZ3VyZWRFcnJvcmAsXG4gIE1pc21hdGNoUmVmVmFsdWVFcnJvcjogYE1pc21hdGNoUmVmVmFsdWVFcnJvcmAsXG4gIFJlc29sdmVSZWZFcnJvcjogYFJlc29sdmVSZWZFcnJvcmAsXG4gIEV4cGFuZFJlZkVycm9yOiBgRXhwYW5kUmVmRXJyb3JgLFxuICBFbXB0eVNlcnZlclJlc3BvbnNlRmFpbDogYEVtcHR5U2VydmVyUmVzcG9uc2VGYWlsYCxcbiAgQXNzZXJ0U2VydmVyUmVzcG9uc2VGYWlsOiBgQXNzZXJ0U2VydmVyUmVzcG9uc2VGYWlsYCxcbiAgSFRUUEVycm9yOiBgSFRUUEVycm9yYCxcbiAgUmVtb3RlVXJsUGFyc2VFcnJvcjogYFJlbW90ZVVybFBhcnNlRXJyb3JgLFxuICBVbmtub3duVHJhbnNwb3J0RXJyb3I6IGBVbmtub3duVHJhbnNwb3J0RXJyb3JgLFxuICBBY3F1aXJlTG9ja0ZpbGVGYWlsOiBgQWNxdWlyZUxvY2tGaWxlRmFpbGAsXG4gIERvdWJsZVJlbGVhc2VMb2NrRmlsZUZhaWw6IGBEb3VibGVSZWxlYXNlTG9ja0ZpbGVGYWlsYCxcbiAgSW50ZXJuYWxGYWlsOiBgSW50ZXJuYWxGYWlsYCxcbiAgVW5rbm93bk9hdXRoMkZvcm1hdDogYFVua25vd25PYXV0aDJGb3JtYXRgLFxuICBNaXNzaW5nUGFzc3dvcmRUb2tlbkVycm9yOiBgTWlzc2luZ1Bhc3N3b3JkVG9rZW5FcnJvcmAsXG4gIE1pc3NpbmdVc2VybmFtZUVycm9yOiBgTWlzc2luZ1VzZXJuYW1lRXJyb3JgLFxuICBNaXhQYXNzd29yZFRva2VuRXJyb3I6IGBNaXhQYXNzd29yZFRva2VuRXJyb3JgLFxuICBNaXhVc2VybmFtZVBhc3N3b3JkVG9rZW5FcnJvcjogYE1peFVzZXJuYW1lUGFzc3dvcmRUb2tlbkVycm9yYCxcbiAgTWlzc2luZ1Rva2VuRXJyb3I6IGBNaXNzaW5nVG9rZW5FcnJvcmAsXG4gIE1peFVzZXJuYW1lT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3I6IGBNaXhVc2VybmFtZU9hdXRoMmZvcm1hdE1pc3NpbmdUb2tlbkVycm9yYCxcbiAgTWl4UGFzc3dvcmRPYXV0aDJmb3JtYXRNaXNzaW5nVG9rZW5FcnJvcjogYE1peFBhc3N3b3JkT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3JgLFxuICBNaXhVc2VybmFtZVBhc3N3b3JkT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3I6IGBNaXhVc2VybmFtZVBhc3N3b3JkT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3JgLFxuICBNaXhVc2VybmFtZU9hdXRoMmZvcm1hdFRva2VuRXJyb3I6IGBNaXhVc2VybmFtZU9hdXRoMmZvcm1hdFRva2VuRXJyb3JgLFxuICBNaXhQYXNzd29yZE9hdXRoMmZvcm1hdFRva2VuRXJyb3I6IGBNaXhQYXNzd29yZE9hdXRoMmZvcm1hdFRva2VuRXJyb3JgLFxuICBNaXhVc2VybmFtZVBhc3N3b3JkT2F1dGgyZm9ybWF0VG9rZW5FcnJvcjogYE1peFVzZXJuYW1lUGFzc3dvcmRPYXV0aDJmb3JtYXRUb2tlbkVycm9yYCxcbiAgTWF4U2VhcmNoRGVwdGhFeGNlZWRlZDogYE1heFNlYXJjaERlcHRoRXhjZWVkZWRgLFxuICBQdXNoUmVqZWN0ZWROb25GYXN0Rm9yd2FyZDogYFB1c2hSZWplY3RlZE5vbkZhc3RGb3J3YXJkYCxcbiAgUHVzaFJlamVjdGVkVGFnRXhpc3RzOiBgUHVzaFJlamVjdGVkVGFnRXhpc3RzYCxcbiAgQWRkaW5nUmVtb3RlV291bGRPdmVyd3JpdGU6IGBBZGRpbmdSZW1vdGVXb3VsZE92ZXJ3cml0ZWAsXG4gIFBsdWdpblVuZGVmaW5lZDogYFBsdWdpblVuZGVmaW5lZGAsXG4gIENvcmVOb3RGb3VuZDogYENvcmVOb3RGb3VuZGAsXG4gIFBsdWdpblNjaGVtYVZpb2xhdGlvbjogYFBsdWdpblNjaGVtYVZpb2xhdGlvbmAsXG4gIFBsdWdpblVucmVjb2duaXplZDogYFBsdWdpblVucmVjb2duaXplZGAsXG4gIEFtYmlndW91c1Nob3J0T2lkOiBgQW1iaWd1b3VzU2hvcnRPaWRgLFxuICBTaG9ydE9pZE5vdEZvdW5kOiBgU2hvcnRPaWROb3RGb3VuZGAsXG4gIENoZWNrb3V0Q29uZmxpY3RFcnJvcjogYENoZWNrb3V0Q29uZmxpY3RFcnJvcmBcbn1cblxuIl19