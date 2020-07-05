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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFzZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9kYi9pc29naXQteWFtbC9tYWluL2lzb2dpdC9iYXNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sS0FBSyxLQUFLLE1BQU0sT0FBTyxDQUFDO0FBQy9CLE9BQU8sS0FBSyxJQUFJLE1BQU0sTUFBTSxDQUFDO0FBQzdCLE9BQU8sU0FBUyxNQUFNLFlBQVksQ0FBQztBQUNuQyxPQUFPLEtBQUssR0FBRyxNQUFNLGdCQUFnQixDQUFDO0FBQ3RDLE9BQU8sS0FBSyxHQUFHLE1BQU0sY0FBYyxDQUFDO0FBTXBDLE1BQU0sZUFBZSxHQUFHLFVBQVUsQ0FBQztBQUNuQyxNQUFNLFdBQVcsR0FBRyxRQUFRLENBQUM7QUFHN0IsTUFBTSxjQUFjLEdBQWM7SUFDaEMsUUFBUSxFQUFFLEtBQUs7SUFDZixlQUFlLEVBQUUsS0FBSztJQUN0QixlQUFlLEVBQUUsS0FBSztJQUN0QixhQUFhLEVBQUUsS0FBSztJQUNwQixxQkFBcUIsRUFBRSxTQUFTO0lBQ2hDLGdCQUFnQixFQUFFLElBQUk7SUFDdEIsU0FBUyxFQUFFLEtBQUs7SUFDaEIsU0FBUyxFQUFFLEtBQUs7Q0FDakIsQ0FBQTtBQUdELE1BQU0sT0FBTyxhQUFhO0lBVXhCLFlBQ1ksRUFBTyxFQUNQLE9BQWUsRUFDZixlQUFtQyxFQUMzQyxRQUFnQixFQUNSLE1BQXVDLEVBQ3hDLE9BQWUsRUFDZCxTQUE2QixFQUM3QixjQUFxRDtRQVByRCxPQUFFLEdBQUYsRUFBRSxDQUFLO1FBQ1AsWUFBTyxHQUFQLE9BQU8sQ0FBUTtRQUNmLG9CQUFlLEdBQWYsZUFBZSxDQUFvQjtRQUVuQyxXQUFNLEdBQU4sTUFBTSxDQUFpQztRQUN4QyxZQUFPLEdBQVAsT0FBTyxDQUFRO1FBQ2QsY0FBUyxHQUFULFNBQVMsQ0FBb0I7UUFDN0IsbUJBQWMsR0FBZCxjQUFjLENBQXVDO1FBaEJ6RCxTQUFJLEdBQXNCLEVBQUUs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IHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgQXN5bmNMb2NrIGZyb20gJ2FzeW5jLWxvY2snO1xuaW1wb3J0ICogYXMgZ2l0IGZyb20gJ2lzb21vcnBoaWMtZ2l0JztcbmltcG9ydCAqIGFzIGxvZyBmcm9tICdlbGVjdHJvbi1sb2cnO1xuXG5pbXBvcnQgeyBHaXRTdGF0dXMgfSBmcm9tICcuLi8uLi9iYXNlJztcbmltcG9ydCB7IEdpdEF1dGhlbnRpY2F0aW9uIH0gZnJvbSAnLi90eXBlcyc7XG5cblxuY29uc3QgVVBTVFJFQU1fUkVNT1RFID0gJ3Vwc3RyZWFtJztcbmNvbnN0IE1BSU5fUkVNT1RFID0gJ29yaWdpbic7XG5cblxuY29uc3QgSU5JVElBTF9TVEFUVVM6IEdpdFN0YXR1cyA9IHtcbiAgaXNPbmxpbmU6IGZhbHNlLFxuICBpc01pc2NvbmZpZ3VyZWQ6IGZhbHNlLFxuICBoYXNMb2NhbENoYW5nZXM6IGZhbHNlLFxuICBuZWVkc1Bhc3N3b3JkOiBmYWxzZSxcbiAgc3RhdHVzUmVsYXRpdmVUb0xvY2FsOiB1bmRlZmluZWQsXG4gIGxhc3RTeW5jaHJvbml6ZWQ6IG51bGwsXG4gIGlzUHVzaGluZzogZmFsc2UsXG4gIGlzUHVsbGluZzogZmFsc2UsXG59XG5cblxuZXhwb3J0IGNsYXNzIElzb0dpdFdyYXBwZXIge1xuXG4gIHByaXZhdGUgYXV0aDogR2l0QXV0aGVudGljYXRpb24gPSB7fTtcblxuICBwcml2YXRlIHB1c2hQZW5kaW5nID0gZmFsc2U7XG5cbiAgcHJpdmF0ZSBzdGFnaW5nTG9jazogQXN5bmNMb2NrO1xuXG4gIHByaXZhdGUgc3RhdHVzOiBHaXRTdGF0dXM7XG5cbiAgY29uc3RydWN0b3IoXG4gICAgICBwcml2YXRlIGZzOiBhbnksXG4gICAgICBwcml2YXRlIHJlcG9Vcmw6IHN0cmluZyxcbiAgICAgIHByaXZhdGUgdXBzdHJlYW1SZXBvVXJsOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICAgICB1c2VybmFtZTogc3RyaW5nLFxuICAgICAgcHJpdmF0ZSBhdXRob3I6IHsgbmFtZTogc3RyaW5nLCBlbWFpbDogc3RyaW5nIH0sXG4gICAgICBwdWJsaWMgd29ya0Rpcjogc3RyaW5nLFxuICAgICAgcHJpdmF0ZSBjb3JzUHJveHk6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgIHByaXZhdGUgc3RhdHVzUmVwb3J0ZXI6IChwYXlsb2FkOiBHaXRTdGF0dXMpID0+IFByb21pc2U8dm9pZD4pIHtcblxuICAgIGdpdC5wbHVnaW5zLnNldCgnZnMnLCBmcyk7XG5cbiAgICB0aGlzLnN0YWdpbmdMb2NrID0gbmV3IEFzeW5jTG9jayh7IHRpbWVvdXQ6IDIwMDAwLCBtYXhQZW5kaW5nOiAyIH0pO1xuXG4gICAgLy8gTWFrZXMgaXQgZWFzaWVyIHRvIGJpbmQgdGhlc2UgdG8gSVBDIGV2ZW50c1xuICAgIHRoaXMuc3luY2hyb25pemUgPSB0aGlzLnN5bmNocm9uaXplLmJpbmQodGhpcyk7XG4gICAgdGhpcy5yZXNldEZpbGVzID0gdGhpcy5yZXNldEZpbGVzLmJpbmQodGhpcyk7XG4gICAgdGhpcy5jaGVja1VuY29tbWl0dGVkID0gdGhpcy5jaGVja1VuY29tbWl0dGVkLmJpbmQodGhpcyk7XG5cbiAgICB0aGlzLmF1dGgudXNlcm5hbWUgPSB1c2VybmFtZTtcblxuICAgIHRoaXMuc3RhdHVzID0gSU5JVElBTF9TVEFUVVM7XG4gIH1cblxuXG4gIC8vIFJlcG9ydGluZyBHaXQgc3RhdHVzIHRvIERCIGJhY2tlbmQsXG4gIC8vIHNvIHRoYXQgaXQgY2FuIGJlIHJlZmxlY3RlZCBpbiB0aGUgR1VJXG5cbiAgcHJpdmF0ZSBhc3luYyByZXBvcnRTdGF0dXMoKSB7XG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuc3RhdHVzUmVwb3J0ZXIodGhpcy5zdGF0dXMpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBzZXRTdGF0dXMoc3RhdHVzOiBQYXJ0aWFsPEdpdFN0YXR1cz4pIHtcbiAgICBPYmplY3QuYXNzaWduKHRoaXMuc3RhdHVzLCBzdGF0dXMpO1xuICAgIGF3YWl0IHRoaXMucmVwb3J0U3RhdHVzKCk7XG4gIH1cblxuICBwdWJsaWMgZ2V0U3RhdHVzKCk6IEdpdFN0YXR1cyB7XG4gICAgcmV0dXJuIHRoaXMuc3RhdHVzO1xuICB9XG5cblxuICAvLyBJbml0aWxhaXphdGlvblxuXG4gIHB1YmxpYyBhc3luYyBpc0luaXRpYWxpemVkKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIGxldCBoYXNHaXREaXJlY3Rvcnk6IGJvb2xlYW47XG4gICAgdHJ5IHtcbiAgICAgIGhhc0dpdERpcmVjdG9yeSA9IChhd2FpdCB0aGlzLmZzLnN0YXQocGF0aC5qb2luKHRoaXMud29ya0RpciwgJy5naXQnKSkpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaGFzR2l0RGlyZWN0b3J5ID0gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiBoYXNHaXREaXJlY3Rvcnk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgaXNVc2luZ1JlbW90ZVVSTHMocmVtb3RlVXJsczogeyBvcmlnaW46IHN0cmluZywgdXBzdHJlYW0/OiBzdHJpbmcgfSk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIGNvbnN0IG9yaWdpbiA9IChhd2FpdCB0aGlzLmdldE9yaWdpblVybCgpIHx8ICcnKS50cmltKCk7XG4gICAgY29uc3QgdXBzdHJlYW0gPSAoYXdhaXQgdGhpcy5nZXRVcHN0cmVhbVVybCgpIHx8ICcnKS50cmltKCk7XG4gICAgcmV0dXJuIG9yaWdpbiA9PT0gcmVtb3RlVXJscy5vcmlnaW4gJiYgKHJlbW90ZVVybHMudXBzdHJlYW0gPT09IHVuZGVmaW5lZCB8fCB1cHN0cmVhbSA9PT0gcmVtb3RlVXJscy51cHN0cmVhbSk7XG4gIH1cblxuICBwdWJsaWMgbmVlZHNQYXNzd29yZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gKHRoaXMuYXV0aC5wYXNzd29yZCB8fCAnJykudHJpbSgpID09PSAnJztcbiAgfVxuXG4gIHB1YmxpYyBnZXRVc2VybmFtZSgpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0aGlzLmF1dGgudXNlcm5hbWU7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgZGVzdHJveSgpIHtcbiAgICAvKiBSZW1vdmVzIHdvcmtpbmcgZGlyZWN0b3J5LlxuICAgICAgIE9uIG5leHQgc3luYyBHaXQgcmVwbyB3aWxsIGhhdmUgdG8gYmUgcmVpbml0aWFsaXplZCwgY2xvbmVkIGV0Yy4gKi9cblxuICAgIGxvZy53YXJuKFwiQy9kYi9pc29naXQ6IEluaXRpYWxpemU6IFJlbW92aW5nIGRhdGEgZGlyZWN0b3J5XCIpO1xuICAgIGF3YWl0IHRoaXMuZnMucmVtb3ZlKHRoaXMud29ya0Rpcik7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGZvcmNlSW5pdGlhbGl6ZSgpIHtcbiAgICAvKiBJbml0aWFsaXplcyBmcm9tIHNjcmF0Y2g6IHdpcGVzIHdvcmsgZGlyZWN0b3J5LCBjbG9uZXMgcmVwb3NpdG9yeSwgYWRkcyByZW1vdGVzLiAqL1xuXG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuc3RhZ2luZ0xvY2suYWNxdWlyZSgnMScsIGFzeW5jICgpID0+IHtcbiAgICAgIGxvZy53YXJuKFwiQy9kYi9pc29naXQ6IEluaXRpYWxpemluZ1wiKTtcblxuICAgICAgbG9nLnNpbGx5KFwiQy9kYi9pc29naXQ6IEluaXRpYWxpemU6IEVuc3VyaW5nIGRhdGEgZGlyZWN0b3J5IGV4aXN0c1wiKTtcbiAgICAgIGF3YWl0IHRoaXMuZnMuZW5zdXJlRGlyKHRoaXMud29ya0Rpcik7XG5cbiAgICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IEluaXRpYWxpemU6IENsb25pbmdcIiwgdGhpcy5yZXBvVXJsKTtcblxuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgZ2l0LmNsb25lKHtcbiAgICAgICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgICB1cmw6IHRoaXMucmVwb1VybCxcbiAgICAgICAgICByZWY6ICdtYXN0ZXInLFxuICAgICAgICAgIHNpbmdsZUJyYW5jaDogdHJ1ZSxcbiAgICAgICAgICBkZXB0aDogNSxcbiAgICAgICAgICBjb3JzUHJveHk6IHRoaXMuY29yc1Byb3h5LFxuICAgICAgICAgIC4uLnRoaXMuYXV0aCxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKHRoaXMudXBzdHJlYW1SZXBvVXJsICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICBsb2cuZGVidWcoXCJDL2RiL2lzb2dpdDogSW5pdGlhbGl6ZTogQWRkaW5nIHVwc3RyZWFtIHJlbW90ZVwiLCB0aGlzLnVwc3RyZWFtUmVwb1VybCk7XG4gICAgICAgICAgYXdhaXQgZ2l0LmFkZFJlbW90ZSh7XG4gICAgICAgICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgICAgIHJlbW90ZTogVVBTVFJFQU1fUkVNT1RFLFxuICAgICAgICAgICAgdXJsOiB0aGlzLnVwc3RyZWFtUmVwb1VybCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBsb2cud2FybihcIkMvZGIvaXNvZ2l0OiBJbml0aWFsaXplOiBObyB1cHN0cmVhbSByZW1vdGUgc3BlY2lmaWVkXCIpO1xuICAgICAgICB9XG5cbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgbG9nLmVycm9yKFwiQy9kYi9pc29naXQ6IEVycm9yIGR1cmluZyBpbml0aWFsaXphdGlvblwiKVxuICAgICAgICBhd2FpdCB0aGlzLmZzLnJlbW92ZSh0aGlzLndvcmtEaXIpO1xuICAgICAgICBhd2FpdCB0aGlzLl9oYW5kbGVHaXRFcnJvcihlKTtcbiAgICAgICAgdGhyb3cgZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG5cbiAgLy8gQXV0aGVudGljYXRpb25cblxuICBwdWJsaWMgc2V0UGFzc3dvcmQodmFsdWU6IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICAgIHRoaXMuYXV0aC5wYXNzd29yZCA9IHZhbHVlO1xuICAgIHRoaXMuc2V0U3RhdHVzKHsgbmVlZHNQYXNzd29yZDogZmFsc2UgfSk7XG4gIH1cblxuXG4gIC8vIEdpdCBvcGVyYXRpb25zXG5cbiAgYXN5bmMgY29uZmlnU2V0KHByb3A6IHN0cmluZywgdmFsOiBzdHJpbmcpIHtcbiAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBTZXQgY29uZmlnXCIpO1xuICAgIGF3YWl0IGdpdC5jb25maWcoeyBkaXI6IHRoaXMud29ya0RpciwgcGF0aDogcHJvcCwgdmFsdWU6IHZhbCB9KTtcbiAgfVxuXG4gIGFzeW5jIGNvbmZpZ0dldChwcm9wOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IEdldCBjb25maWdcIiwgcHJvcCk7XG4gICAgcmV0dXJuIGF3YWl0IGdpdC5jb25maWcoeyBkaXI6IHRoaXMud29ya0RpciwgcGF0aDogcHJvcCB9KTtcbiAgfVxuXG4gIGFzeW5jIHJlYWRGaWxlQmxvYkF0Q29tbWl0KHJlbGF0aXZlRmlsZVBhdGg6IHN0cmluZywgY29tbWl0SGFzaDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICAvKiBSZWFkcyBmaWxlIGNvbnRlbnRzIGF0IGdpdmVuIHBhdGggYXMgb2YgZ2l2ZW4gY29tbWl0LiBGaWxlIGNvbnRlbnRzIG11c3QgdXNlIFVURi04IGVuY29kaW5nLiAqL1xuXG4gICAgcmV0dXJuIChhd2FpdCBnaXQucmVhZEJsb2Ioe1xuICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICBvaWQ6IGNvbW1pdEhhc2gsXG4gICAgICBmaWxlcGF0aDogcmVsYXRpdmVGaWxlUGF0aCxcbiAgICB9KSkuYmxvYi50b1N0cmluZygpO1xuICB9XG5cbiAgYXN5bmMgcHVsbCgpIHtcbiAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBQdWxsaW5nIG1hc3RlciB3aXRoIGZhc3QtZm9yd2FyZCBtZXJnZVwiKTtcblxuICAgIHJldHVybiBhd2FpdCBnaXQucHVsbCh7XG4gICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgIHNpbmdsZUJyYW5jaDogdHJ1ZSxcbiAgICAgIGZhc3RGb3J3YXJkT25seTogdHJ1ZSxcblxuICAgICAgZmFzdDogdHJ1ZSxcbiAgICAgIC8vIE5PVEU6IFR5cGVTY3JpcHQgaXMga25vd24gdG8gY29tcGxhaW4gYWJvdXQgdGhlIGBgZmFzdGBgIG9wdGlvbi5cbiAgICAgIC8vIFNlZW1zIGxpa2UgYSBwcm9ibGVtIHdpdGggdHlwaW5ncy5cblxuICAgICAgLi4udGhpcy5hdXRoLFxuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgc3RhZ2UocGF0aFNwZWNzOiBzdHJpbmdbXSwgcmVtb3ZpbmcgPSBmYWxzZSkge1xuICAgIGxvZy52ZXJib3NlKGBDL2RiL2lzb2dpdDogU3RhZ2luZyBjaGFuZ2VzOiAke3BhdGhTcGVjcy5qb2luKCcsICcpfSB1c2luZyAke3JlbW92aW5nID8gXCJyZW1vdmUoKVwiIDogXCJhZGQoKVwifWApO1xuXG4gICAgZm9yIChjb25zdCBwYXRoU3BlYyBvZiBwYXRoU3BlY3MpIHtcbiAgICAgIGlmIChyZW1vdmluZyAhPT0gdHJ1ZSkge1xuICAgICAgICBhd2FpdCBnaXQuYWRkKHtcbiAgICAgICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgICBmaWxlcGF0aDogcGF0aFNwZWMsXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYXdhaXQgZ2l0LnJlbW92ZSh7XG4gICAgICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICAgICAgZmlsZXBhdGg6IHBhdGhTcGVjLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBhc3luYyBjb21taXQobXNnOiBzdHJpbmcpIHtcbiAgICBsb2cudmVyYm9zZShgQy9kYi9pc29naXQ6IENvbW1pdHRpbmcgd2l0aCBtZXNzYWdlICR7bXNnfWApO1xuXG4gICAgcmV0dXJuIGF3YWl0IGdpdC5jb21taXQoe1xuICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICBtZXNzYWdlOiBtc2csXG4gICAgICBhdXRob3I6IHRoaXMuYXV0aG9yLFxuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgZmV0Y2hSZW1vdGUoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgZ2l0LmZldGNoKHsgZGlyOiB0aGlzLndvcmtEaXIsIHJlbW90ZTogTUFJTl9SRU1PVEUsIC4uLnRoaXMuYXV0aCB9KTtcbiAgfVxuXG4gIGFzeW5jIGZldGNoVXBzdHJlYW0oKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgZ2l0LmZldGNoKHsgZGlyOiB0aGlzLndvcmtEaXIsIHJlbW90ZTogVVBTVFJFQU1fUkVNT1RFLCAuLi50aGlzLmF1dGggfSk7XG4gIH1cblxuICBhc3luYyBwdXNoKGZvcmNlID0gZmFsc2UpIHtcbiAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBQdXNoaW5nXCIpO1xuXG4gICAgcmV0dXJuIGF3YWl0IGdpdC5wdXNoKHtcbiAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgcmVtb3RlOiBNQUlOX1JFTU9URSxcbiAgICAgIGZvcmNlOiBmb3JjZSxcbiAgICAgIC4uLnRoaXMuYXV0aCxcbiAgICB9KTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyByZXNldEZpbGVzKHBhdGhzPzogc3RyaW5nW10pIHtcbiAgICByZXR1cm4gYXdhaXQgdGhpcy5zdGFnaW5nTG9jay5hY3F1aXJlKCcxJywgYXN5bmMgKCkgPT4ge1xuICAgICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogRm9yY2UgcmVzZXR0aW5nIGZpbGVzXCIpO1xuXG4gICAgICByZXR1cm4gYXdhaXQgZ2l0LmZhc3RDaGVja291dCh7XG4gICAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgICBmb3JjZTogdHJ1ZSxcbiAgICAgICAgZmlsZXBhdGhzOiBwYXRocyB8fCAoYXdhaXQgdGhpcy5saXN0Q2hhbmdlZEZpbGVzKCkpLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBnZXRPcmlnaW5VcmwoKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gICAgcmV0dXJuICgoYXdhaXQgZ2l0Lmxpc3RSZW1vdGVzKHtcbiAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgIH0pKS5maW5kKHIgPT4gci5yZW1vdGUgPT09IE1BSU5fUkVNT1RFKSB8fCB7IHVybDogbnVsbCB9KS51cmw7XG4gIH1cblxuICBhc3luYyBnZXRVcHN0cmVhbVVybCgpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgICByZXR1cm4gKChhd2FpdCBnaXQubGlzdFJlbW90ZXMoe1xuICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgfSkpLmZpbmQociA9PiByLnJlbW90ZSA9PT0gVVBTVFJFQU1fUkVNT1RFKSB8fCB7IHVybDogbnVsbCB9KS51cmw7XG4gIH1cblxuICBhc3luYyBsaXN0TG9jYWxDb21taXRzKCk6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgICAvKiBSZXR1cm5zIGEgbGlzdCBvZiBjb21taXQgbWVzc2FnZXMgZm9yIGNvbW1pdHMgdGhhdCB3ZXJlIG5vdCBwdXNoZWQgeWV0LlxuXG4gICAgICAgVXNlZnVsIHRvIGNoZWNrIHdoaWNoIGNvbW1pdHMgd2lsbCBiZSB0aHJvd24gb3V0XG4gICAgICAgaWYgd2UgZm9yY2UgdXBkYXRlIHRvIHJlbW90ZSBtYXN0ZXIuXG5cbiAgICAgICBEb2VzIHNvIGJ5IHdhbGtpbmcgdGhyb3VnaCBsYXN0IDEwMCBjb21taXRzIHN0YXJ0aW5nIGZyb20gY3VycmVudCBIRUFELlxuICAgICAgIFdoZW4gaXQgZW5jb3VudGVycyB0aGUgZmlyc3QgbG9jYWwgY29tbWl0IHRoYXQgZG9lc27igJl0IGRlc2NlbmRzIGZyb20gcmVtb3RlIG1hc3RlciBIRUFELFxuICAgICAgIGl0IGNvbnNpZGVycyBhbGwgcHJlY2VkaW5nIGNvbW1pdHMgdG8gYmUgYWhlYWQvbG9jYWwgYW5kIHJldHVybnMgdGhlbS5cblxuICAgICAgIElmIGl0IGZpbmlzaGVzIHRoZSB3YWxrIHdpdGhvdXQgZmluZGluZyBhbiBhbmNlc3RvciwgdGhyb3dzIGFuIGVycm9yLlxuICAgICAgIEl0IGlzIGFzc3VtZWQgdGhhdCB0aGUgYXBwIGRvZXMgbm90IGFsbG93IHRvIGFjY3VtdWxhdGVcbiAgICAgICBtb3JlIHRoYW4gMTAwIGNvbW1pdHMgd2l0aG91dCBwdXNoaW5nIChldmVuIDEwMCBpcyB0b28gbWFueSEpLFxuICAgICAgIHNvIHRoZXJl4oCZcyBwcm9iYWJseSBzb21ldGhpbmcgc3RyYW5nZSBnb2luZyBvbi5cblxuICAgICAgIE90aGVyIGFzc3VtcHRpb25zOlxuXG4gICAgICAgKiBnaXQubG9nIHJldHVybnMgY29tbWl0cyBmcm9tIG5ld2VzdCB0byBvbGRlc3QuXG4gICAgICAgKiBUaGUgcmVtb3RlIHdhcyBhbHJlYWR5IGZldGNoZWQuXG5cbiAgICAqL1xuXG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuc3RhZ2luZ0xvY2suYWNxdWlyZSgnMScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGxhdGVzdFJlbW90ZUNvbW1pdCA9IGF3YWl0IGdpdC5yZXNvbHZlUmVmKHtcbiAgICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICAgIHJlZjogYCR7TUFJTl9SRU1PVEV9L21hc3RlcmAsXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgbG9jYWxDb21taXRzID0gYXdhaXQgZ2l0LmxvZyh7XG4gICAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgICBkZXB0aDogMTAwLFxuICAgICAgfSk7XG5cbiAgICAgIHZhciBjb21taXRzID0gW10gYXMgc3RyaW5nW107XG4gICAgICBmb3IgKGNvbnN0IGNvbW1pdCBvZiBsb2NhbENvbW1pdHMpIHtcbiAgICAgICAgaWYgKGF3YWl0IGdpdC5pc0Rlc2NlbmRlbnQoeyBkaXI6IHRoaXMud29ya0Rpciwgb2lkOiBjb21taXQub2lkLCBhbmNlc3RvcjogbGF0ZXN0UmVtb3RlQ29tbWl0IH0pKSB7XG4gICAgICAgICAgY29tbWl0cy5wdXNoKGNvbW1pdC5tZXNzYWdlKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXR1cm4gY29tbWl0cztcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJEaWQgbm90IGZpbmQgYSBsb2NhbCBjb21taXQgdGhhdCBpcyBhbiBhbmNlc3RvciBvZiByZW1vdGUgbWFzdGVyXCIpO1xuICAgIH0pO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGxpc3RDaGFuZ2VkRmlsZXMocGF0aFNwZWNzID0gWycuJ10pOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gICAgLyogTGlzdHMgcmVsYXRpdmUgcGF0aHMgdG8gYWxsIGZpbGVzIHRoYXQgd2VyZSBjaGFuZ2VkIGFuZCBoYXZlIG5vdCBiZWVuIGNvbW1pdHRlZC4gKi9cblxuICAgIGNvbnN0IEZJTEUgPSAwLCBIRUFEID0gMSwgV09SS0RJUiA9IDI7XG5cbiAgICByZXR1cm4gKGF3YWl0IGdpdC5zdGF0dXNNYXRyaXgoeyBkaXI6IHRoaXMud29ya0RpciwgZmlsZXBhdGhzOiBwYXRoU3BlY3MgfSkpXG4gICAgICAuZmlsdGVyKHJvdyA9PiByb3dbSEVBRF0gIT09IHJvd1tXT1JLRElSXSlcbiAgICAgIC5tYXAocm93ID0+IHJvd1tGSUxFXSlcbiAgICAgIC5maWx0ZXIoZmlsZXBhdGggPT4gIWZpbGVwYXRoLnN0YXJ0c1dpdGgoJy4uJykgJiYgZmlsZXBhdGggIT09IFwiLkRTX1N0b3JlXCIpO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIHN0YWdlQW5kQ29tbWl0KHBhdGhTcGVjczogc3RyaW5nW10sIG1zZzogc3RyaW5nLCByZW1vdmluZyA9IGZhbHNlKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgICAvKiBTdGFnZXMgYW5kIGNvbW1pdHMgZmlsZXMgbWF0Y2hpbmcgZ2l2ZW4gcGF0aCBzcGVjIHdpdGggZ2l2ZW4gbWVzc2FnZS5cblxuICAgICAgIEFueSBvdGhlciBmaWxlcyBzdGFnZWQgYXQgdGhlIHRpbWUgb2YgdGhlIGNhbGwgd2lsbCBiZSB1bnN0YWdlZC5cblxuICAgICAgIFJldHVybnMgdGhlIG51bWJlciBvZiBtYXRjaGluZyBmaWxlcyB3aXRoIHVuc3RhZ2VkIGNoYW5nZXMgcHJpb3IgdG8gc3RhZ2luZy5cbiAgICAgICBJZiBubyBtYXRjaGluZyBmaWxlcyB3ZXJlIGZvdW5kIGhhdmluZyB1bnN0YWdlZCBjaGFuZ2VzLFxuICAgICAgIHNraXBzIHRoZSByZXN0IGFuZCByZXR1cm5zIHplcm8uXG5cbiAgICAgICBJZiBmYWlsSWZEaXZlcmdlZCBpcyBnaXZlbiwgYXR0ZW1wdHMgYSBmYXN0LWZvcndhcmQgcHVsbCBhZnRlciB0aGUgY29tbWl0LlxuICAgICAgIEl0IHdpbGwgZmFpbCBpbW1lZGlhdGVseSBpZiBtYWluIHJlbW90ZSBoYWQgb3RoZXIgY29tbWl0cyBhcHBlYXIgaW4gbWVhbnRpbWUuXG5cbiAgICAgICBMb2NrcyBzbyB0aGF0IHRoaXMgbWV0aG9kIGNhbm5vdCBiZSBydW4gY29uY3VycmVudGx5IChieSBzYW1lIGluc3RhbmNlKS5cbiAgICAqL1xuXG4gICAgaWYgKHBhdGhTcGVjcy5sZW5ndGggPCAxKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJXYXNu4oCZdCBnaXZlbiBhbnkgcGF0aHMgdG8gY29tbWl0IVwiKTtcbiAgICB9XG5cbiAgICByZXR1cm4gYXdhaXQgdGhpcy5zdGFnaW5nTG9jay5hY3F1aXJlKCcxJywgYXN5bmMgKCkgPT4ge1xuICAgICAgbG9nLnZlcmJvc2UoYEMvZGIvaXNvZ2l0OiBTdGFnaW5nIGFuZCBjb21taXR0aW5nOiAke3BhdGhTcGVjcy5qb2luKCcsICcpfWApO1xuXG4gICAgICBjb25zdCBmaWxlc0NoYW5nZWQgPSAoYXdhaXQgdGhpcy5saXN0Q2hhbmdlZEZpbGVzKHBhdGhTcGVjcykpLmxlbmd0aDtcbiAgICAgIGlmIChmaWxlc0NoYW5nZWQgPCAxKSB7XG4gICAgICAgIHJldHVybiAwO1xuICAgICAgfVxuXG4gICAgICBhd2FpdCB0aGlzLnVuc3RhZ2VBbGwoKTtcbiAgICAgIGF3YWl0IHRoaXMuc3RhZ2UocGF0aFNwZWNzLCByZW1vdmluZyk7XG4gICAgICBhd2FpdCB0aGlzLmNvbW1pdChtc2cpO1xuXG4gICAgICByZXR1cm4gZmlsZXNDaGFuZ2VkO1xuICAgIH0pO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGNoZWNrVW5jb21taXR0ZWQoKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgLyogQ2hlY2tzIGZvciBhbnkgdW5jb21taXR0ZWQgY2hhbmdlcyBsb2NhbGx5IHByZXNlbnQuXG4gICAgICAgTm90aWZpZXMgYWxsIHdpbmRvd3MgYWJvdXQgdGhlIHN0YXR1cy4gKi9cblxuICAgIGxvZy5kZWJ1ZyhcIkMvZGIvaXNvZ2l0OiBDaGVja2luZyBmb3IgdW5jb21taXR0ZWQgY2hhbmdlc1wiKTtcbiAgICBjb25zdCBjaGFuZ2VkRmlsZXMgPSBhd2FpdCB0aGlzLmxpc3RDaGFuZ2VkRmlsZXMoKTtcbiAgICBsb2cuZGVidWcoXCJDL2RiL2lzb2dpdDogQ2hhbmdlZCBmaWxlczpcIiwgY2hhbmdlZEZpbGVzKTtcbiAgICBjb25zdCBoYXNMb2NhbENoYW5nZXMgPSBjaGFuZ2VkRmlsZXMubGVuZ3RoID4gMDtcbiAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGhhc0xvY2FsQ2hhbmdlcyB9KTtcbiAgICByZXR1cm4gaGFzTG9jYWxDaGFuZ2VzO1xuICB9XG5cbiAgcHVibGljIHJlcXVlc3RQdXNoKCkge1xuICAgIHRoaXMucHVzaFBlbmRpbmcgPSB0cnVlO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIHN5bmNocm9uaXplKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIC8qIENoZWNrcyBmb3IgY29ubmVjdGlvbiwgbG9jYWwgY2hhbmdlcyBhbmQgdW5wdXNoZWQgY29tbWl0cyxcbiAgICAgICB0cmllcyB0byBwdXNoIGFuZCBwdWxsIHdoZW4gdGhlcmXigJlzIG9wcG9ydHVuaXR5LlxuXG4gICAgICAgTm90aWZpZXMgYWxsIHdpbmRvd3MgYWJvdXQgdGhlIHN0YXR1cyBpbiBwcm9jZXNzLiAqL1xuXG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogQ2hlY2tpbmcgaWYgY2xvbmUgZXhpc3RzXCIpO1xuXG4gICAgaWYgKCEoYXdhaXQgdGhpcy5pc0luaXRpYWxpemVkKCkpKSB7XG4gICAgICBhd2FpdCB0aGlzLmZvcmNlSW5pdGlhbGl6ZSgpO1xuXG4gICAgfSBlbHNlIHtcbiAgICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IENoZWNraW5nIGZvciB1bmNvbW1pdHRlZCBjaGFuZ2VzXCIpO1xuXG4gICAgICBjb25zdCBoYXNVbmNvbW1pdHRlZENoYW5nZXMgPSBhd2FpdCB0aGlzLmNoZWNrVW5jb21taXR0ZWQoKTtcblxuICAgICAgaWYgKGhhc1VuY29tbWl0dGVkQ2hhbmdlcykge1xuICAgICAgICAvLyBEbyBub3QgcnVuIHB1bGwgaWYgdGhlcmUgYXJlIHVuc3RhZ2VkL3VuY29tbWl0dGVkIGNoYW5nZXNcbiAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBoYXNMb2NhbENoYW5nZXM6IHRydWUgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIElmIHVuY29tbWl0dGVkIGNoYW5nZXMgd2VyZW7igJl0IGRldGVjdGVkLCB0aGVyZSBtYXkgc3RpbGwgYmUgY2hhbmdlZCBmaWxlc1xuICAgICAgICAvLyB0aGF0IGFyZSBub3QgbWFuYWdlZCBieSB0aGUgYmFja2VuZCAoZS5nLiwgLkRTX1N0b3JlKS4gRGlzY2FyZCBhbnkgc3R1ZmYgbGlrZSB0aGF0LlxuICAgICAgICBhd2FpdCB0aGlzLnJlc2V0RmlsZXMoWycuJ10pO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmICh0aGlzLnN0YWdpbmdMb2NrLmlzQnVzeSgpKSB7XG4gICAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBMb2NrIGlzIGJ1c3ksIHNraXBwaW5nIHN5bmNcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogUXVldWVpbmcgc3luYyBub3csIGxvY2sgaXMgbm90IGJ1c3lcIik7XG5cbiAgICByZXR1cm4gYXdhaXQgdGhpcy5zdGFnaW5nTG9jay5hY3F1aXJlKCcxJywgYXN5bmMgKCkgPT4ge1xuICAgICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogU3RhcnRpbmcgc3luY1wiKTtcblxuICAgICAgY29uc3QgaXNPbmxpbmUgPSAoYXdhaXQgY2hlY2tPbmxpbmVTdGF0dXMoKSkgPT09IHRydWU7XG5cbiAgICAgIGlmIChpc09ubGluZSkge1xuICAgICAgICBjb25zdCBuZWVkc1Bhc3N3b3JkID0gdGhpcy5uZWVkc1Bhc3N3b3JkKCk7XG4gICAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgbmVlZHNQYXNzd29yZCB9KTtcbiAgICAgICAgaWYgKG5lZWRzUGFzc3dvcmQpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzT25saW5lOiB0cnVlIH0pO1xuXG4gICAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaXNQdWxsaW5nOiB0cnVlIH0pO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGF3YWl0IHRoaXMucHVsbCgpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgbG9nLmVycm9yKGUpO1xuICAgICAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHtcbiAgICAgICAgICAgIGxhc3RTeW5jaHJvbml6ZWQ6IG5ldyBEYXRlKCksXG4gICAgICAgICAgICBpc1B1bGxpbmc6IGZhbHNlLFxuICAgICAgICAgICAgaXNQdXNoaW5nOiBmYWxzZSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBhd2FpdCB0aGlzLl9oYW5kbGVHaXRFcnJvcihlKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgLy9hd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzUHVsbGluZzogZmFsc2UgfSk7XG5cbiAgICAgICAgaWYgKHRoaXMucHVzaFBlbmRpbmcpIHtcbiAgICAgICAgICAvLyBSdW4gcHVzaCBBRlRFUiBwdWxsLiBNYXkgcmVzdWx0IGluIGZhbHNlLXBvc2l0aXZlIG5vbi1mYXN0LWZvcndhcmQgcmVqZWN0aW9uXG4gICAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBpc1B1c2hpbmc6IHRydWUgfSk7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucHVzaCgpO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIGxvZy5lcnJvcihlKTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHtcbiAgICAgICAgICAgICAgbGFzdFN5bmNocm9uaXplZDogbmV3IERhdGUoKSxcbiAgICAgICAgICAgICAgaXNQdWxsaW5nOiBmYWxzZSxcbiAgICAgICAgICAgICAgaXNQdXNoaW5nOiBmYWxzZSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5faGFuZGxlR2l0RXJyb3IoZSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIHRoaXMucHVzaFBlbmRpbmcgPSBmYWxzZTtcbiAgICAgICAgICAvL2F3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaXNQdXNoaW5nOiBmYWxzZSB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHtcbiAgICAgICAgICBzdGF0dXNSZWxhdGl2ZVRvTG9jYWw6ICd1cGRhdGVkJyxcbiAgICAgICAgICBpc01pc2NvbmZpZ3VyZWQ6IGZhbHNlLFxuICAgICAgICAgIGxhc3RTeW5jaHJvbml6ZWQ6IG5ldyBEYXRlKCksXG4gICAgICAgICAgbmVlZHNQYXNzd29yZDogZmFsc2UsXG4gICAgICAgICAgaXNQdXNoaW5nOiBmYWxzZSxcbiAgICAgICAgICBpc1B1bGxpbmc6IGZhbHNlLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgdW5zdGFnZUFsbCgpIHtcbiAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBVbnN0YWdpbmcgYWxsIGNoYW5nZXNcIik7XG4gICAgYXdhaXQgZ2l0LnJlbW92ZSh7IGRpcjogdGhpcy53b3JrRGlyLCBmaWxlcGF0aDogJy4nIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBfaGFuZGxlR2l0RXJyb3IoZTogRXJyb3IgJiB7IGNvZGU6IHN0cmluZyB9KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgbG9nLmRlYnVnKFwiSGFuZGxpbmcgR2l0IGVycm9yXCIsIGUpO1xuXG4gICAgaWYgKGUuY29kZSA9PT0gJ0Zhc3RGb3J3YXJkRmFpbCcgfHwgZS5jb2RlID09PSAnTWVyZ2VOb3RTdXBwb3J0ZWRGYWlsJykge1xuICAgICAgLy8gTk9URTogVGhlcmXigJlzIGFsc28gUHVzaFJlamVjdGVkTm9uRmFzdEZvcndhcmQsIGJ1dCBpdCBzZWVtcyB0byBiZSB0aHJvd25cbiAgICAgIC8vIGZvciB1bnJlbGF0ZWQgY2FzZXMgZHVyaW5nIHB1c2ggKGZhbHNlIHBvc2l0aXZlKS5cbiAgICAgIC8vIEJlY2F1c2Ugb2YgdGhhdCBmYWxzZSBwb3NpdGl2ZSwgd2UgaWdub3JlIHRoYXQgZXJyb3IgYW5kIGluc3RlYWQgZG8gcHVsbCBmaXJzdCxcbiAgICAgIC8vIGNhdGNoaW5nIGFjdHVhbCBmYXN0LWZvcndhcmQgZmFpbHMgb24gdGhhdCBzdGVwIGJlZm9yZSBwdXNoLlxuICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBzdGF0dXNSZWxhdGl2ZVRvTG9jYWw6ICdkaXZlcmdlZCcgfSk7XG4gICAgfSBlbHNlIGlmIChbJ01pc3NpbmdVc2VybmFtZUVycm9yJywgJ01pc3NpbmdBdXRob3JFcnJvcicsICdNaXNzaW5nQ29tbWl0dGVyRXJyb3InXS5pbmRleE9mKGUuY29kZSkgPj0gMCkge1xuICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBpc01pc2NvbmZpZ3VyZWQ6IHRydWUgfSk7XG4gICAgfSBlbHNlIGlmIChcbiAgICAgICAgZS5jb2RlID09PSAnTWlzc2luZ1Bhc3N3b3JkVG9rZW5FcnJvcidcbiAgICAgICAgfHwgKGUuY29kZSA9PT0gJ0hUVFBFcnJvcicgJiYgZS5tZXNzYWdlLmluZGV4T2YoJ1VuYXV0aG9yaXplZCcpID49IDApKSB7XG4gICAgICBsb2cud2FybihcIlBhc3N3b3JkIGlucHV0IHJlcXVpcmVkXCIpO1xuICAgICAgdGhpcy5zZXRQYXNzd29yZCh1bmRlZmluZWQpO1xuICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBuZWVkc1Bhc3N3b3JkOiB0cnVlIH0pO1xuICAgIH1cbiAgfVxufVxuXG5cbmFzeW5jIGZ1bmN0aW9uIGNoZWNrT25saW5lU3RhdHVzKHRpbWVvdXQgPSA0NTAwKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIC8vIFRPRE86IE1vdmUgdG8gZ2VuZXJhbCB1dGlsaXR5IGZ1bmN0aW9uc1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICBsb2cuZGVidWcoXCJDL2RiL2lzb2dpdDogQ29ubmVjdGlvbiB0ZXN0OiBTdGFydGluZ1wiKTtcblxuICAgIGNvbnN0IHJlcSA9IGh0dHBzLmdldCgnaHR0cHM6Ly9naXRodWIuY29tLycsIHsgdGltZW91dCB9LCByZXBvcnRPbmxpbmUpO1xuXG4gICAgcmVxLm9uKCdlcnJvcicsICgpID0+IHJlcS5hYm9ydCgpKTtcbiAgICByZXEub24oJ3Jlc3BvbnNlJywgcmVwb3J0T25saW5lKTtcbiAgICByZXEub24oJ2Nvbm5lY3QnLCByZXBvcnRPbmxpbmUpO1xuICAgIHJlcS5vbignY29udGludWUnLCByZXBvcnRPbmxpbmUpO1xuICAgIHJlcS5vbigndXBncmFkZScsIHJlcG9ydE9ubGluZSk7XG4gICAgcmVxLm9uKCd0aW1lb3V0JywgcmVwb3J0T2ZmbGluZSk7XG5cbiAgICByZXEuZW5kKCk7XG5cbiAgICBjb25zdCBjaGVja1RpbWVvdXQgPSBzZXRUaW1lb3V0KHJlcG9ydE9mZmxpbmUsIHRpbWVvdXQpO1xuXG4gICAgZnVuY3Rpb24gcmVwb3J0T2ZmbGluZSgpIHtcbiAgICAgIGxvZy53YXJuKFwiQy9kYi9pc29naXQ6IENvbm5lY3Rpb24gdGVzdDogUmVwb3J0IG9mZmxpbmVcIik7XG4gICAgICB0cnkgeyByZXEuYWJvcnQoKTsgfSBjYXRjaCAoZSkge31cbiAgICAgIGNsZWFyVGltZW91dChjaGVja1RpbWVvdXQpO1xuICAgICAgcmVzb2x2ZShmYWxzZSk7XG4gICAgfVxuICAgIGZ1bmN0aW9uIHJlcG9ydE9ubGluZSgpIHtcbiAgICAgIGxvZy5pbmZvKFwiQy9kYi9pc29naXQ6IENvbm5lY3Rpb24gdGVzdDogUmVwb3J0IG9ubGluZVwiKTtcbiAgICAgIHRyeSB7IHJlcS5hYm9ydCgpOyB9IGNhdGNoIChlKSB7fVxuICAgICAgY2xlYXJUaW1lb3V0KGNoZWNrVGltZW91dCk7XG4gICAgICByZXNvbHZlKHRydWUpO1xuICAgIH1cbiAgfSk7XG59XG5cblxuLy8gVE9ETzogVGVtcG9yYXJ5IHdvcmthcm91bmQgc2luY2UgaXNvbW9ycGhpYy1naXQgZG9lc27igJl0IHNlZW0gdG8gZXhwb3J0IGl0cyBHaXRFcnJvciBjbGFzc1xuLy8gaW4gYW55IHdheSBhdmFpbGFibGUgdG8gVFMsIHNvIHdlIGNhbuKAmXQgdXNlIGluc3RhbmNlb2YgOihcblxuZXhwb3J0IGZ1bmN0aW9uIGlzR2l0RXJyb3IoZTogRXJyb3IgJiB7IGNvZGU6IHN0cmluZyB9KSB7XG4gIGlmICghZS5jb2RlKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiBPYmplY3Qua2V5cyhJc29tb3JwaGljR2l0RXJyb3JDb2RlcykuaW5kZXhPZihlLmNvZGUpID49IDA7XG59XG5cbmNvbnN0IElzb21vcnBoaWNHaXRFcnJvckNvZGVzID0ge1xuICBGaWxlUmVhZEVycm9yOiBgRmlsZVJlYWRFcnJvcmAsXG4gIE1pc3NpbmdSZXF1aXJlZFBhcmFtZXRlckVycm9yOiBgTWlzc2luZ1JlcXVpcmVkUGFyYW1ldGVyRXJyb3JgLFxuICBJbnZhbGlkUmVmTmFtZUVycm9yOiBgSW52YWxpZFJlZk5hbWVFcnJvcmAsXG4gIEludmFsaWRQYXJhbWV0ZXJDb21iaW5hdGlvbkVycm9yOiBgSW52YWxpZFBhcmFtZXRlckNvbWJpbmF0aW9uRXJyb3JgLFxuICBSZWZFeGlzdHNFcnJvcjogYFJlZkV4aXN0c0Vycm9yYCxcbiAgUmVmTm90RXhpc3RzRXJyb3I6IGBSZWZOb3RFeGlzdHNFcnJvcmAsXG4gIEJyYW5jaERlbGV0ZUVycm9yOiBgQnJhbmNoRGVsZXRlRXJyb3JgLFxuICBOb0hlYWRDb21taXRFcnJvcjogYE5vSGVhZENvbW1pdEVycm9yYCxcbiAgQ29tbWl0Tm90RmV0Y2hlZEVycm9yOiBgQ29tbWl0Tm90RmV0Y2hlZEVycm9yYCxcbiAgT2JqZWN0VHlwZVVua25vd25GYWlsOiBgT2JqZWN0VHlwZVVua25vd25GYWlsYCxcbiAgT2JqZWN0VHlwZUFzc2VydGlvbkZhaWw6IGBPYmplY3RUeXBlQXNzZXJ0aW9uRmFpbGAsXG4gIE9iamVjdFR5cGVBc3NlcnRpb25JblRyZWVGYWlsOiBgT2JqZWN0VHlwZUFzc2VydGlvbkluVHJlZUZhaWxgLFxuICBPYmplY3RUeXBlQXNzZXJ0aW9uSW5SZWZGYWlsOiBgT2JqZWN0VHlwZUFzc2VydGlvbkluUmVmRmFpbGAsXG4gIE9iamVjdFR5cGVBc3NlcnRpb25JblBhdGhGYWlsOiBgT2JqZWN0VHlwZUFzc2VydGlvbkluUGF0aEZhaWxgLFxuICBNaXNzaW5nQXV0aG9yRXJyb3I6IGBNaXNzaW5nQXV0aG9yRXJyb3JgLFxuICBNaXNzaW5nQ29tbWl0dGVyRXJyb3I6IGBNaXNzaW5nQ29tbWl0dGVyRXJyb3JgLFxuICBNaXNzaW5nVGFnZ2VyRXJyb3I6IGBNaXNzaW5nVGFnZ2VyRXJyb3JgLFxuICBHaXRSb290Tm90Rm91bmRFcnJvcjogYEdpdFJvb3ROb3RGb3VuZEVycm9yYCxcbiAgVW5wYXJzZWFibGVTZXJ2ZXJSZXNwb25zZUZhaWw6IGBVbnBhcnNlYWJsZVNlcnZlclJlc3BvbnNlRmFpbGAsXG4gIEludmFsaWREZXB0aFBhcmFtZXRlckVycm9yOiBgSW52YWxpZERlcHRoUGFyYW1ldGVyRXJyb3JgLFxuICBSZW1vdGVEb2VzTm90U3VwcG9ydFNoYWxsb3dGYWlsOiBgUmVtb3RlRG9lc05vdFN1cHBvcnRTaGFsbG93RmFpbGAsXG4gIFJlbW90ZURvZXNOb3RTdXBwb3J0RGVlcGVuU2luY2VGYWlsOiBgUmVtb3RlRG9lc05vdFN1cHBvcnREZWVwZW5TaW5jZUZhaWxgLFxuICBSZW1vdGVEb2VzTm90U3VwcG9ydERlZXBlbk5vdEZhaWw6IGBSZW1vdGVEb2VzTm90U3VwcG9ydERlZXBlbk5vdEZhaWxgLFxuICBSZW1vdGVEb2VzTm90U3VwcG9ydERlZXBlblJlbGF0aXZlRmFpbDogYFJlbW90ZURvZXNOb3RTdXBwb3J0RGVlcGVuUmVsYXRpdmVGYWlsYCxcbiAgUmVtb3RlRG9lc05vdFN1cHBvcnRTbWFydEhUVFA6IGBSZW1vdGVEb2VzTm90U3VwcG9ydFNtYXJ0SFRUUGAsXG4gIENvcnJ1cHRTaGFsbG93T2lkRmFpbDogYENvcnJ1cHRTaGFsbG93T2lkRmFpbGAsXG4gIEZhc3RGb3J3YXJkRmFpbDogYEZhc3RGb3J3YXJkRmFpbGAsXG4gIE1lcmdlTm90U3VwcG9ydGVkRmFpbDogYE1lcmdlTm90U3VwcG9ydGVkRmFpbGAsXG4gIERpcmVjdG9yeVNlcGFyYXRvcnNFcnJvcjogYERpcmVjdG9yeVNlcGFyYXRvcnNFcnJvcmAsXG4gIFJlc29sdmVUcmVlRXJyb3I6IGBSZXNvbHZlVHJlZUVycm9yYCxcbiAgUmVzb2x2ZUNvbW1pdEVycm9yOiBgUmVzb2x2ZUNvbW1pdEVycm9yYCxcbiAgRGlyZWN0b3J5SXNBRmlsZUVycm9yOiBgRGlyZWN0b3J5SXNBRmlsZUVycm9yYCxcbiAgVHJlZU9yQmxvYk5vdEZvdW5kRXJyb3I6IGBUcmVlT3JCbG9iTm90Rm91bmRFcnJvcmAsXG4gIE5vdEltcGxlbWVudGVkRmFpbDogYE5vdEltcGxlbWVudGVkRmFpbGAsXG4gIFJlYWRPYmplY3RGYWlsOiBgUmVhZE9iamVjdEZhaWxgLFxuICBOb3RBbk9pZEZhaWw6IGBOb3RBbk9pZEZhaWxgLFxuICBOb1JlZnNwZWNDb25maWd1cmVkRXJyb3I6IGBOb1JlZnNwZWNDb25maWd1cmVkRXJyb3JgLFxuICBNaXNtYXRjaFJlZlZhbHVlRXJyb3I6IGBNaXNtYXRjaFJlZlZhbHVlRXJyb3JgLFxuICBSZXNvbHZlUmVmRXJyb3I6IGBSZXNvbHZlUmVmRXJyb3JgLFxuICBFeHBhbmRSZWZFcnJvcjogYEV4cGFuZFJlZkVycm9yYCxcbiAgRW1wdHlTZXJ2ZXJSZXNwb25zZUZhaWw6IGBFbXB0eVNlcnZlclJlc3BvbnNlRmFpbGAsXG4gIEFzc2VydFNlcnZlclJlc3BvbnNlRmFpbDogYEFzc2VydFNlcnZlclJlc3BvbnNlRmFpbGAsXG4gIEhUVFBFcnJvcjogYEhUVFBFcnJvcmAsXG4gIFJlbW90ZVVybFBhcnNlRXJyb3I6IGBSZW1vdGVVcmxQYXJzZUVycm9yYCxcbiAgVW5rbm93blRyYW5zcG9ydEVycm9yOiBgVW5rbm93blRyYW5zcG9ydEVycm9yYCxcbiAgQWNxdWlyZUxvY2tGaWxlRmFpbDogYEFjcXVpcmVMb2NrRmlsZUZhaWxgLFxuICBEb3VibGVSZWxlYXNlTG9ja0ZpbGVGYWlsOiBgRG91YmxlUmVsZWFzZUxvY2tGaWxlRmFpbGAsXG4gIEludGVybmFsRmFpbDogYEludGVybmFsRmFpbGAsXG4gIFVua25vd25PYXV0aDJGb3JtYXQ6IGBVbmtub3duT2F1dGgyRm9ybWF0YCxcbiAgTWlzc2luZ1Bhc3N3b3JkVG9rZW5FcnJvcjogYE1pc3NpbmdQYXNzd29yZFRva2VuRXJyb3JgLFxuICBNaXNzaW5nVXNlcm5hbWVFcnJvcjogYE1pc3NpbmdVc2VybmFtZUVycm9yYCxcbiAgTWl4UGFzc3dvcmRUb2tlbkVycm9yOiBgTWl4UGFzc3dvcmRUb2tlbkVycm9yYCxcbiAgTWl4VXNlcm5hbWVQYXNzd29yZFRva2VuRXJyb3I6IGBNaXhVc2VybmFtZVBhc3N3b3JkVG9rZW5FcnJvcmAsXG4gIE1pc3NpbmdUb2tlbkVycm9yOiBgTWlzc2luZ1Rva2VuRXJyb3JgLFxuICBNaXhVc2VybmFtZU9hdXRoMmZvcm1hdE1pc3NpbmdUb2tlbkVycm9yOiBgTWl4VXNlcm5hbWVPYXV0aDJmb3JtYXRNaXNzaW5nVG9rZW5FcnJvcmAsXG4gIE1peFBhc3N3b3JkT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3I6IGBNaXhQYXNzd29yZE9hdXRoMmZvcm1hdE1pc3NpbmdUb2tlbkVycm9yYCxcbiAgTWl4VXNlcm5hbWVQYXNzd29yZE9hdXRoMmZvcm1hdE1pc3NpbmdUb2tlbkVycm9yOiBgTWl4VXNlcm5hbWVQYXNzd29yZE9hdXRoMmZvcm1hdE1pc3NpbmdUb2tlbkVycm9yYCxcbiAgTWl4VXNlcm5hbWVPYXV0aDJmb3JtYXRUb2tlbkVycm9yOiBgTWl4VXNlcm5hbWVPYXV0aDJmb3JtYXRUb2tlbkVycm9yYCxcbiAgTWl4UGFzc3dvcmRPYXV0aDJmb3JtYXRUb2tlbkVycm9yOiBgTWl4UGFzc3dvcmRPYXV0aDJmb3JtYXRUb2tlbkVycm9yYCxcbiAgTWl4VXNlcm5hbWVQYXNzd29yZE9hdXRoMmZvcm1hdFRva2VuRXJyb3I6IGBNaXhVc2VybmFtZVBhc3N3b3JkT2F1dGgyZm9ybWF0VG9rZW5FcnJvcmAsXG4gIE1heFNlYXJjaERlcHRoRXhjZWVkZWQ6IGBNYXhTZWFyY2hEZXB0aEV4Y2VlZGVkYCxcbiAgUHVzaFJlamVjdGVkTm9uRmFzdEZvcndhcmQ6IGBQdXNoUmVqZWN0ZWROb25GYXN0Rm9yd2FyZGAsXG4gIFB1c2hSZWplY3RlZFRhZ0V4aXN0czogYFB1c2hSZWplY3RlZFRhZ0V4aXN0c2AsXG4gIEFkZGluZ1JlbW90ZVdvdWxkT3ZlcndyaXRlOiBgQWRkaW5nUmVtb3RlV291bGRPdmVyd3JpdGVgLFxuICBQbHVnaW5VbmRlZmluZWQ6IGBQbHVnaW5VbmRlZmluZWRgLFxuICBDb3JlTm90Rm91bmQ6IGBDb3JlTm90Rm91bmRgLFxuICBQbHVnaW5TY2hlbWFWaW9sYXRpb246IGBQbHVnaW5TY2hlbWFWaW9sYXRpb25gLFxuICBQbHVnaW5VbnJlY29nbml6ZWQ6IGBQbHVnaW5VbnJlY29nbml6ZWRgLFxuICBBbWJpZ3VvdXNTaG9ydE9pZDogYEFtYmlndW91c1Nob3J0T2lkYCxcbiAgU2hvcnRPaWROb3RGb3VuZDogYFNob3J0T2lkTm90Rm91bmRgLFxuICBDaGVja291dENvbmZsaWN0RXJyb3I6IGBDaGVja291dENvbmZsaWN0RXJyb3JgXG59XG5cbiJdfQ==