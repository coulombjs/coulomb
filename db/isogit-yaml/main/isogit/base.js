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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFzZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9kYi9pc29naXQteWFtbC9tYWluL2lzb2dpdC9iYXNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sS0FBSyxLQUFLLE1BQU0sT0FBTyxDQUFDO0FBQy9CLE9BQU8sS0FBSyxJQUFJLE1BQU0sTUFBTSxDQUFDO0FBQzdCLE9BQU8sU0FBUyxNQUFNLFlBQVksQ0FBQztBQUNuQyxPQUFPLEtBQUssR0FBRyxNQUFNLGdCQUFnQixDQUFDO0FBQ3RDLE9BQU8sS0FBSyxHQUFHLE1BQU0sY0FBYyxDQUFDO0FBTXBDLE1BQU0sZUFBZSxHQUFHLFVBQVUsQ0FBQztBQUNuQyxNQUFNLFdBQVcsR0FBRyxRQUFRLENBQUM7QUFHN0IsTUFBTSxjQUFjLEdBQWM7SUFDaEMsUUFBUSxFQUFFLEtBQUs7SUFDZixlQUFlLEVBQUUsS0FBSztJQUN0QixlQUFlLEVBQUUsS0FBSztJQUN0QixhQUFhLEVBQUUsS0FBSztJQUNwQixxQkFBcUIsRUFBRSxTQUFTO0lBQ2hDLGdCQUFnQixFQUFFLElBQUk7SUFDdEIsU0FBUyxFQUFFLEtBQUs7SUFDaEIsU0FBUyxFQUFFLEtBQUs7Q0FDakIsQ0FBQTtBQUdELE1BQU0sT0FBTyxhQUFhO0lBUXhCLFlBQ1ksRUFBTyxFQUNQLE9BQWUsRUFDZixlQUFtQyxFQUMzQyxRQUFnQixFQUNSLE1BQXVDLEVBQ3hDLE9BQWUsRUFDZCxTQUFpQixFQUNqQixjQUFxRDtRQVByRCxPQUFFLEdBQUYsRUFBRSxDQUFLO1FBQ1AsWUFBTyxHQUFQLE9BQU8sQ0FBUTtRQUNmLG9CQUFlLEdBQWYsZUFBZSxDQUFvQjtRQUVuQyxXQUFNLEdBQU4sTUFBTSxDQUFpQztRQUN4QyxZQUFPLEdBQVAsT0FBTyxDQUFRO1FBQ2QsY0FBUyxHQUFULFNBQVMsQ0FBUTtRQUNqQixtQkFBYyxHQUFkLGNBQWMsQ0FBdUM7UUFkekQsU0FBSSxHQUFzQixFQUFFLENB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QixFQUFFLHVCQUF1QjtJQUM5QyxrQkFBa0IsRUFBRSxvQkFBb0I7SUFDeEMsaUJBQWlCLEVBQUUsbUJBQW1CO0lBQ3RDLGdCQUFnQixFQUFFLGtCQUFrQjtJQUNwQyxxQkFBcUIsRUFBRSx1QkFBdUI7Q0FDL0MsQ0FBQSIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGh0dHBzIGZyb20gJ2h0dHBzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgQXN5bmNMb2NrIGZyb20gJ2FzeW5jLWxvY2snO1xuaW1wb3J0ICogYXMgZ2l0IGZyb20gJ2lzb21vcnBoaWMtZ2l0JztcbmltcG9ydCAqIGFzIGxvZyBmcm9tICdlbGVjdHJvbi1sb2cnO1xuXG5pbXBvcnQgeyBHaXRTdGF0dXMgfSBmcm9tICcuLi8uLi9iYXNlJztcbmltcG9ydCB7IEdpdEF1dGhlbnRpY2F0aW9uIH0gZnJvbSAnLi90eXBlcyc7XG5cblxuY29uc3QgVVBTVFJFQU1fUkVNT1RFID0gJ3Vwc3RyZWFtJztcbmNvbnN0IE1BSU5fUkVNT1RFID0gJ29yaWdpbic7XG5cblxuY29uc3QgSU5JVElBTF9TVEFUVVM6IEdpdFN0YXR1cyA9IHtcbiAgaXNPbmxpbmU6IGZhbHNlLFxuICBpc01pc2NvbmZpZ3VyZWQ6IGZhbHNlLFxuICBoYXNMb2NhbENoYW5nZXM6IGZhbHNlLFxuICBuZWVkc1Bhc3N3b3JkOiBmYWxzZSxcbiAgc3RhdHVzUmVsYXRpdmVUb0xvY2FsOiB1bmRlZmluZWQsXG4gIGxhc3RTeW5jaHJvbml6ZWQ6IG51bGwsXG4gIGlzUHVzaGluZzogZmFsc2UsXG4gIGlzUHVsbGluZzogZmFsc2UsXG59XG5cblxuZXhwb3J0IGNsYXNzIElzb0dpdFdyYXBwZXIge1xuXG4gIHByaXZhdGUgYXV0aDogR2l0QXV0aGVudGljYXRpb24gPSB7fTtcblxuICBwcml2YXRlIHN0YWdpbmdMb2NrOiBBc3luY0xvY2s7XG5cbiAgcHJpdmF0ZSBzdGF0dXM6IEdpdFN0YXR1cztcblxuICBjb25zdHJ1Y3RvcihcbiAgICAgIHByaXZhdGUgZnM6IGFueSxcbiAgICAgIHByaXZhdGUgcmVwb1VybDogc3RyaW5nLFxuICAgICAgcHJpdmF0ZSB1cHN0cmVhbVJlcG9Vcmw6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgIHVzZXJuYW1lOiBzdHJpbmcsXG4gICAgICBwcml2YXRlIGF1dGhvcjogeyBuYW1lOiBzdHJpbmcsIGVtYWlsOiBzdHJpbmcgfSxcbiAgICAgIHB1YmxpYyB3b3JrRGlyOiBzdHJpbmcsXG4gICAgICBwcml2YXRlIGNvcnNQcm94eTogc3RyaW5nLFxuICAgICAgcHJpdmF0ZSBzdGF0dXNSZXBvcnRlcjogKHBheWxvYWQ6IEdpdFN0YXR1cykgPT4gUHJvbWlzZTx2b2lkPikge1xuXG4gICAgZ2l0LnBsdWdpbnMuc2V0KCdmcycsIGZzKTtcblxuICAgIHRoaXMuc3RhZ2luZ0xvY2sgPSBuZXcgQXN5bmNMb2NrKHsgdGltZW91dDogMjAwMDAsIG1heFBlbmRpbmc6IDIgfSk7XG5cbiAgICAvLyBNYWtlcyBpdCBlYXNpZXIgdG8gYmluZCB0aGVzZSB0byBJUEMgZXZlbnRzXG4gICAgdGhpcy5zeW5jaHJvbml6ZSA9IHRoaXMuc3luY2hyb25pemUuYmluZCh0aGlzKTtcbiAgICB0aGlzLnJlc2V0RmlsZXMgPSB0aGlzLnJlc2V0RmlsZXMuYmluZCh0aGlzKTtcbiAgICB0aGlzLmNoZWNrVW5jb21taXR0ZWQgPSB0aGlzLmNoZWNrVW5jb21taXR0ZWQuYmluZCh0aGlzKTtcblxuICAgIHRoaXMuYXV0aC51c2VybmFtZSA9IHVzZXJuYW1lO1xuXG4gICAgdGhpcy5zdGF0dXMgPSBJTklUSUFMX1NUQVRVUztcbiAgfVxuXG5cbiAgLy8gUmVwb3J0aW5nIEdpdCBzdGF0dXMgdG8gREIgYmFja2VuZCxcbiAgLy8gc28gdGhhdCBpdCBjYW4gYmUgcmVmbGVjdGVkIGluIHRoZSBHVUlcblxuICBwcml2YXRlIGFzeW5jIHJlcG9ydFN0YXR1cygpIHtcbiAgICByZXR1cm4gYXdhaXQgdGhpcy5zdGF0dXNSZXBvcnRlcih0aGlzLnN0YXR1cyk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHNldFN0YXR1cyhzdGF0dXM6IFBhcnRpYWw8R2l0U3RhdHVzPikge1xuICAgIE9iamVjdC5hc3NpZ24odGhpcy5zdGF0dXMsIHN0YXR1cyk7XG4gICAgYXdhaXQgdGhpcy5yZXBvcnRTdGF0dXMoKTtcbiAgfVxuXG4gIHB1YmxpYyBnZXRTdGF0dXMoKTogR2l0U3RhdHVzIHtcbiAgICByZXR1cm4gdGhpcy5zdGF0dXM7XG4gIH1cblxuXG4gIC8vIEluaXRpbGFpemF0aW9uXG5cbiAgcHVibGljIGFzeW5jIGlzSW5pdGlhbGl6ZWQoKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgbGV0IGhhc0dpdERpcmVjdG9yeTogYm9vbGVhbjtcbiAgICB0cnkge1xuICAgICAgaGFzR2l0RGlyZWN0b3J5ID0gKGF3YWl0IHRoaXMuZnMuc3RhdChwYXRoLmpvaW4odGhpcy53b3JrRGlyLCAnLmdpdCcpKSkuaXNEaXJlY3RvcnkoKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBoYXNHaXREaXJlY3RvcnkgPSBmYWxzZTtcbiAgICB9XG4gICAgcmV0dXJuIGhhc0dpdERpcmVjdG9yeTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBpc1VzaW5nUmVtb3RlVVJMcyhyZW1vdGVVcmxzOiB7IG9yaWdpbjogc3RyaW5nLCB1cHN0cmVhbT86IHN0cmluZyB9KTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgY29uc3Qgb3JpZ2luID0gKGF3YWl0IHRoaXMuZ2V0T3JpZ2luVXJsKCkgfHwgJycpLnRyaW0oKTtcbiAgICBjb25zdCB1cHN0cmVhbSA9IChhd2FpdCB0aGlzLmdldFVwc3RyZWFtVXJsKCkgfHwgJycpLnRyaW0oKTtcbiAgICByZXR1cm4gb3JpZ2luID09PSByZW1vdGVVcmxzLm9yaWdpbiAmJiAocmVtb3RlVXJscy51cHN0cmVhbSA9PT0gdW5kZWZpbmVkIHx8IHVwc3RyZWFtID09PSByZW1vdGVVcmxzLnVwc3RyZWFtKTtcbiAgfVxuXG4gIHB1YmxpYyBuZWVkc1Bhc3N3b3JkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiAodGhpcy5hdXRoLnBhc3N3b3JkIHx8ICcnKS50cmltKCkgPT09ICcnO1xuICB9XG5cbiAgcHVibGljIGdldFVzZXJuYW1lKCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMuYXV0aC51c2VybmFtZTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBkZXN0cm95KCkge1xuICAgIC8qIFJlbW92ZXMgd29ya2luZyBkaXJlY3RvcnkuXG4gICAgICAgT24gbmV4dCBzeW5jIEdpdCByZXBvIHdpbGwgaGF2ZSB0byBiZSByZWluaXRpYWxpemVkLCBjbG9uZWQgZXRjLiAqL1xuXG4gICAgbG9nLndhcm4oXCJDL2RiL2lzb2dpdDogSW5pdGlhbGl6ZTogUmVtb3ZpbmcgZGF0YSBkaXJlY3RvcnlcIik7XG4gICAgYXdhaXQgdGhpcy5mcy5yZW1vdmUodGhpcy53b3JrRGlyKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgZm9yY2VJbml0aWFsaXplKCkge1xuICAgIC8qIEluaXRpYWxpemVzIGZyb20gc2NyYXRjaDogd2lwZXMgd29yayBkaXJlY3RvcnksIGNsb25lcyByZXBvc2l0b3J5LCBhZGRzIHJlbW90ZXMuICovXG5cbiAgICBsb2cud2FybihcIkMvZGIvaXNvZ2l0OiBJbml0aWFsaXppbmdcIik7XG5cbiAgICBsb2cuc2lsbHkoXCJDL2RiL2lzb2dpdDogSW5pdGlhbGl6ZTogRW5zdXJpbmcgZGF0YSBkaXJlY3RvcnkgZXhpc3RzXCIpO1xuICAgIGF3YWl0IHRoaXMuZnMuZW5zdXJlRGlyKHRoaXMud29ya0Rpcik7XG5cbiAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBJbml0aWFsaXplOiBDbG9uaW5nXCIsIHRoaXMucmVwb1VybCk7XG5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgZ2l0LmNsb25lKHtcbiAgICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICAgIHVybDogdGhpcy5yZXBvVXJsLFxuICAgICAgICByZWY6ICdtYXN0ZXInLFxuICAgICAgICBzaW5nbGVCcmFuY2g6IHRydWUsXG4gICAgICAgIGRlcHRoOiA1LFxuICAgICAgICBjb3JzUHJveHk6IHRoaXMuY29yc1Byb3h5LFxuICAgICAgICAuLi50aGlzLmF1dGgsXG4gICAgICB9KTtcblxuICAgICAgaWYgKHRoaXMudXBzdHJlYW1SZXBvVXJsICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgbG9nLmRlYnVnKFwiQy9kYi9pc29naXQ6IEluaXRpYWxpemU6IEFkZGluZyB1cHN0cmVhbSByZW1vdGVcIiwgdGhpcy51cHN0cmVhbVJlcG9VcmwpO1xuICAgICAgICBhd2FpdCBnaXQuYWRkUmVtb3RlKHtcbiAgICAgICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgICByZW1vdGU6IFVQU1RSRUFNX1JFTU9URSxcbiAgICAgICAgICB1cmw6IHRoaXMudXBzdHJlYW1SZXBvVXJsLFxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGxvZy53YXJuKFwiQy9kYi9pc29naXQ6IEluaXRpYWxpemU6IE5vIHVwc3RyZWFtIHJlbW90ZSBzcGVjaWZpZWRcIik7XG4gICAgICB9XG5cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBsb2cuZXJyb3IoXCJDL2RiL2lzb2dpdDogRXJyb3IgZHVyaW5nIGluaXRpYWxpemF0aW9uXCIpXG4gICAgICBhd2FpdCB0aGlzLmZzLnJlbW92ZSh0aGlzLndvcmtEaXIpO1xuICAgICAgYXdhaXQgdGhpcy5faGFuZGxlR2l0RXJyb3IoZSk7XG4gICAgICB0aHJvdyBlO1xuICAgIH1cbiAgfVxuXG5cbiAgLy8gQXV0aGVudGljYXRpb25cblxuICBwdWJsaWMgc2V0UGFzc3dvcmQodmFsdWU6IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICAgIHRoaXMuYXV0aC5wYXNzd29yZCA9IHZhbHVlO1xuICB9XG5cblxuICAvLyBHaXQgb3BlcmF0aW9uc1xuXG4gIGFzeW5jIGNvbmZpZ1NldChwcm9wOiBzdHJpbmcsIHZhbDogc3RyaW5nKSB7XG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogU2V0IGNvbmZpZ1wiKTtcbiAgICBhd2FpdCBnaXQuY29uZmlnKHsgZGlyOiB0aGlzLndvcmtEaXIsIHBhdGg6IHByb3AsIHZhbHVlOiB2YWwgfSk7XG4gIH1cblxuICBhc3luYyBjb25maWdHZXQocHJvcDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBHZXQgY29uZmlnXCIsIHByb3ApO1xuICAgIHJldHVybiBhd2FpdCBnaXQuY29uZmlnKHsgZGlyOiB0aGlzLndvcmtEaXIsIHBhdGg6IHByb3AgfSk7XG4gIH1cblxuICBhc3luYyByZWFkRmlsZUJsb2JBdENvbW1pdChyZWxhdGl2ZUZpbGVQYXRoOiBzdHJpbmcsIGNvbW1pdEhhc2g6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgLyogUmVhZHMgZmlsZSBjb250ZW50cyBhdCBnaXZlbiBwYXRoIGFzIG9mIGdpdmVuIGNvbW1pdC4gRmlsZSBjb250ZW50cyBtdXN0IHVzZSBVVEYtOCBlbmNvZGluZy4gKi9cblxuICAgIHJldHVybiAoYXdhaXQgZ2l0LnJlYWRCbG9iKHtcbiAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgb2lkOiBjb21taXRIYXNoLFxuICAgICAgZmlsZXBhdGg6IHJlbGF0aXZlRmlsZVBhdGgsXG4gICAgfSkpLmJsb2IudG9TdHJpbmcoKTtcbiAgfVxuXG4gIGFzeW5jIHB1bGwoKSB7XG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogUHVsbGluZyBtYXN0ZXIgd2l0aCBmYXN0LWZvcndhcmQgbWVyZ2VcIik7XG5cbiAgICByZXR1cm4gYXdhaXQgZ2l0LnB1bGwoe1xuICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICBzaW5nbGVCcmFuY2g6IHRydWUsXG4gICAgICBmYXN0Rm9yd2FyZE9ubHk6IHRydWUsXG5cbiAgICAgIGZhc3Q6IHRydWUsXG4gICAgICAvLyBOT1RFOiBUeXBlU2NyaXB0IGlzIGtub3duIHRvIGNvbXBsYWluIGFib3V0IHRoZSBgYGZhc3RgYCBvcHRpb24uXG4gICAgICAvLyBTZWVtcyBsaWtlIGEgcHJvYmxlbSB3aXRoIHR5cGluZ3MuXG5cbiAgICAgIC4uLnRoaXMuYXV0aCxcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIHN0YWdlKHBhdGhTcGVjczogc3RyaW5nW10sIHJlbW92aW5nID0gZmFsc2UpIHtcbiAgICBsb2cudmVyYm9zZShgQy9kYi9pc29naXQ6IFN0YWdpbmcgY2hhbmdlczogJHtwYXRoU3BlY3Muam9pbignLCAnKX0gdXNpbmcgJHtyZW1vdmluZyA/IFwicmVtb3ZlKClcIiA6IFwiYWRkKClcIn1gKTtcblxuICAgIGZvciAoY29uc3QgcGF0aFNwZWMgb2YgcGF0aFNwZWNzKSB7XG4gICAgICBpZiAocmVtb3ZpbmcgIT09IHRydWUpIHtcbiAgICAgICAgYXdhaXQgZ2l0LmFkZCh7XG4gICAgICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICAgICAgZmlsZXBhdGg6IHBhdGhTcGVjLFxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGF3YWl0IGdpdC5yZW1vdmUoe1xuICAgICAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgICAgIGZpbGVwYXRoOiBwYXRoU3BlYyxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgY29tbWl0KG1zZzogc3RyaW5nKSB7XG4gICAgbG9nLnZlcmJvc2UoYEMvZGIvaXNvZ2l0OiBDb21taXR0aW5nIHdpdGggbWVzc2FnZSAke21zZ31gKTtcblxuICAgIHJldHVybiBhd2FpdCBnaXQuY29tbWl0KHtcbiAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgbWVzc2FnZTogbXNnLFxuICAgICAgYXV0aG9yOiB0aGlzLmF1dGhvcixcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIGZldGNoUmVtb3RlKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IGdpdC5mZXRjaCh7IGRpcjogdGhpcy53b3JrRGlyLCByZW1vdGU6IE1BSU5fUkVNT1RFLCAuLi50aGlzLmF1dGggfSk7XG4gIH1cblxuICBhc3luYyBmZXRjaFVwc3RyZWFtKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IGdpdC5mZXRjaCh7IGRpcjogdGhpcy53b3JrRGlyLCByZW1vdGU6IFVQU1RSRUFNX1JFTU9URSwgLi4udGhpcy5hdXRoIH0pO1xuICB9XG5cbiAgYXN5bmMgcHVzaChmb3JjZSA9IGZhbHNlKSB7XG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogUHVzaGluZ1wiKTtcblxuICAgIHJldHVybiBhd2FpdCBnaXQucHVzaCh7XG4gICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgIHJlbW90ZTogTUFJTl9SRU1PVEUsXG4gICAgICBmb3JjZTogZm9yY2UsXG4gICAgICAuLi50aGlzLmF1dGgsXG4gICAgfSk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgcmVzZXRGaWxlcyhwYXRocz86IHN0cmluZ1tdKSB7XG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuc3RhZ2luZ0xvY2suYWNxdWlyZSgnMScsIGFzeW5jICgpID0+IHtcbiAgICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IEZvcmNlIHJlc2V0dGluZyBmaWxlc1wiKTtcblxuICAgICAgcmV0dXJuIGF3YWl0IGdpdC5mYXN0Q2hlY2tvdXQoe1xuICAgICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgZm9yY2U6IHRydWUsXG4gICAgICAgIGZpbGVwYXRoczogcGF0aHMgfHwgKGF3YWl0IHRoaXMubGlzdENoYW5nZWRGaWxlcygpKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgZ2V0T3JpZ2luVXJsKCk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICAgIHJldHVybiAoKGF3YWl0IGdpdC5saXN0UmVtb3Rlcyh7XG4gICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICB9KSkuZmluZChyID0+IHIucmVtb3RlID09PSBNQUlOX1JFTU9URSkgfHwgeyB1cmw6IG51bGwgfSkudXJsO1xuICB9XG5cbiAgYXN5bmMgZ2V0VXBzdHJlYW1VcmwoKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gICAgcmV0dXJuICgoYXdhaXQgZ2l0Lmxpc3RSZW1vdGVzKHtcbiAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgIH0pKS5maW5kKHIgPT4gci5yZW1vdGUgPT09IFVQU1RSRUFNX1JFTU9URSkgfHwgeyB1cmw6IG51bGwgfSkudXJsO1xuICB9XG5cbiAgYXN5bmMgbGlzdExvY2FsQ29tbWl0cygpOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gICAgLyogUmV0dXJucyBhIGxpc3Qgb2YgY29tbWl0IG1lc3NhZ2VzIGZvciBjb21taXRzIHRoYXQgd2VyZSBub3QgcHVzaGVkIHlldC5cblxuICAgICAgIFVzZWZ1bCB0byBjaGVjayB3aGljaCBjb21taXRzIHdpbGwgYmUgdGhyb3duIG91dFxuICAgICAgIGlmIHdlIGZvcmNlIHVwZGF0ZSB0byByZW1vdGUgbWFzdGVyLlxuXG4gICAgICAgRG9lcyBzbyBieSB3YWxraW5nIHRocm91Z2ggbGFzdCAxMDAgY29tbWl0cyBzdGFydGluZyBmcm9tIGN1cnJlbnQgSEVBRC5cbiAgICAgICBXaGVuIGl0IGVuY291bnRlcnMgdGhlIGZpcnN0IGxvY2FsIGNvbW1pdCB0aGF0IGRvZXNu4oCZdCBkZXNjZW5kcyBmcm9tIHJlbW90ZSBtYXN0ZXIgSEVBRCxcbiAgICAgICBpdCBjb25zaWRlcnMgYWxsIHByZWNlZGluZyBjb21taXRzIHRvIGJlIGFoZWFkL2xvY2FsIGFuZCByZXR1cm5zIHRoZW0uXG5cbiAgICAgICBJZiBpdCBmaW5pc2hlcyB0aGUgd2FsayB3aXRob3V0IGZpbmRpbmcgYW4gYW5jZXN0b3IsIHRocm93cyBhbiBlcnJvci5cbiAgICAgICBJdCBpcyBhc3N1bWVkIHRoYXQgdGhlIGFwcCBkb2VzIG5vdCBhbGxvdyB0byBhY2N1bXVsYXRlXG4gICAgICAgbW9yZSB0aGFuIDEwMCBjb21taXRzIHdpdGhvdXQgcHVzaGluZyAoZXZlbiAxMDAgaXMgdG9vIG1hbnkhKSxcbiAgICAgICBzbyB0aGVyZeKAmXMgcHJvYmFibHkgc29tZXRoaW5nIHN0cmFuZ2UgZ29pbmcgb24uXG5cbiAgICAgICBPdGhlciBhc3N1bXB0aW9uczpcblxuICAgICAgICogZ2l0LmxvZyByZXR1cm5zIGNvbW1pdHMgZnJvbSBuZXdlc3QgdG8gb2xkZXN0LlxuICAgICAgICogVGhlIHJlbW90ZSB3YXMgYWxyZWFkeSBmZXRjaGVkLlxuXG4gICAgKi9cblxuICAgIHJldHVybiBhd2FpdCB0aGlzLnN0YWdpbmdMb2NrLmFjcXVpcmUoJzEnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBsYXRlc3RSZW1vdGVDb21taXQgPSBhd2FpdCBnaXQucmVzb2x2ZVJlZih7XG4gICAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgICByZWY6IGAke01BSU5fUkVNT1RFfS9tYXN0ZXJgLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IGxvY2FsQ29tbWl0cyA9IGF3YWl0IGdpdC5sb2coe1xuICAgICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgZGVwdGg6IDEwMCxcbiAgICAgIH0pO1xuXG4gICAgICB2YXIgY29tbWl0cyA9IFtdIGFzIHN0cmluZ1tdO1xuICAgICAgZm9yIChjb25zdCBjb21taXQgb2YgbG9jYWxDb21taXRzKSB7XG4gICAgICAgIGlmIChhd2FpdCBnaXQuaXNEZXNjZW5kZW50KHsgZGlyOiB0aGlzLndvcmtEaXIsIG9pZDogY29tbWl0Lm9pZCwgYW5jZXN0b3I6IGxhdGVzdFJlbW90ZUNvbW1pdCB9KSkge1xuICAgICAgICAgIGNvbW1pdHMucHVzaChjb21taXQubWVzc2FnZSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmV0dXJuIGNvbW1pdHM7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiRGlkIG5vdCBmaW5kIGEgbG9jYWwgY29tbWl0IHRoYXQgaXMgYW4gYW5jZXN0b3Igb2YgcmVtb3RlIG1hc3RlclwiKTtcbiAgICB9KTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBsaXN0Q2hhbmdlZEZpbGVzKHBhdGhTcGVjcyA9IFsnLiddKTogUHJvbWlzZTxzdHJpbmdbXT4ge1xuICAgIC8qIExpc3RzIHJlbGF0aXZlIHBhdGhzIHRvIGFsbCBmaWxlcyB0aGF0IHdlcmUgY2hhbmdlZCBhbmQgaGF2ZSBub3QgYmVlbiBjb21taXR0ZWQuICovXG5cbiAgICBjb25zdCBGSUxFID0gMCwgSEVBRCA9IDEsIFdPUktESVIgPSAyO1xuXG4gICAgcmV0dXJuIChhd2FpdCBnaXQuc3RhdHVzTWF0cml4KHsgZGlyOiB0aGlzLndvcmtEaXIsIGZpbGVwYXRoczogcGF0aFNwZWNzIH0pKVxuICAgICAgLmZpbHRlcihyb3cgPT4gcm93W0hFQURdICE9PSByb3dbV09SS0RJUl0pXG4gICAgICAubWFwKHJvdyA9PiByb3dbRklMRV0pXG4gICAgICAuZmlsdGVyKGZpbGVwYXRoID0+ICFmaWxlcGF0aC5zdGFydHNXaXRoKCcuLicpKTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBzdGFnZUFuZENvbW1pdChwYXRoU3BlY3M6IHN0cmluZ1tdLCBtc2c6IHN0cmluZywgcmVtb3ZpbmcgPSBmYWxzZSk6IFByb21pc2U8bnVtYmVyPiB7XG4gICAgLyogU3RhZ2VzIGFuZCBjb21taXRzIGZpbGVzIG1hdGNoaW5nIGdpdmVuIHBhdGggc3BlYyB3aXRoIGdpdmVuIG1lc3NhZ2UuXG5cbiAgICAgICBBbnkgb3RoZXIgZmlsZXMgc3RhZ2VkIGF0IHRoZSB0aW1lIG9mIHRoZSBjYWxsIHdpbGwgYmUgdW5zdGFnZWQuXG5cbiAgICAgICBSZXR1cm5zIHRoZSBudW1iZXIgb2YgbWF0Y2hpbmcgZmlsZXMgd2l0aCB1bnN0YWdlZCBjaGFuZ2VzIHByaW9yIHRvIHN0YWdpbmcuXG4gICAgICAgSWYgbm8gbWF0Y2hpbmcgZmlsZXMgd2VyZSBmb3VuZCBoYXZpbmcgdW5zdGFnZWQgY2hhbmdlcyxcbiAgICAgICBza2lwcyB0aGUgcmVzdCBhbmQgcmV0dXJucyB6ZXJvLlxuXG4gICAgICAgSWYgZmFpbElmRGl2ZXJnZWQgaXMgZ2l2ZW4sIGF0dGVtcHRzIGEgZmFzdC1mb3J3YXJkIHB1bGwgYWZ0ZXIgdGhlIGNvbW1pdC5cbiAgICAgICBJdCB3aWxsIGZhaWwgaW1tZWRpYXRlbHkgaWYgbWFpbiByZW1vdGUgaGFkIG90aGVyIGNvbW1pdHMgYXBwZWFyIGluIG1lYW50aW1lLlxuXG4gICAgICAgTG9ja3Mgc28gdGhhdCB0aGlzIG1ldGhvZCBjYW5ub3QgYmUgcnVuIGNvbmN1cnJlbnRseSAoYnkgc2FtZSBpbnN0YW5jZSkuXG4gICAgKi9cblxuICAgIGlmIChwYXRoU3BlY3MubGVuZ3RoIDwgMSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiV2FzbuKAmXQgZ2l2ZW4gYW55IHBhdGhzIHRvIGNvbW1pdCFcIik7XG4gICAgfVxuXG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuc3RhZ2luZ0xvY2suYWNxdWlyZSgnMScsIGFzeW5jICgpID0+IHtcbiAgICAgIGxvZy52ZXJib3NlKGBDL2RiL2lzb2dpdDogU3RhZ2luZyBhbmQgY29tbWl0dGluZzogJHtwYXRoU3BlY3Muam9pbignLCAnKX1gKTtcblxuICAgICAgY29uc3QgZmlsZXNDaGFuZ2VkID0gKGF3YWl0IHRoaXMubGlzdENoYW5nZWRGaWxlcyhwYXRoU3BlY3MpKS5sZW5ndGg7XG4gICAgICBpZiAoZmlsZXNDaGFuZ2VkIDwgMSkge1xuICAgICAgICByZXR1cm4gMDtcbiAgICAgIH1cblxuICAgICAgYXdhaXQgdGhpcy51bnN0YWdlQWxsKCk7XG4gICAgICBhd2FpdCB0aGlzLnN0YWdlKHBhdGhTcGVjcywgcmVtb3ZpbmcpO1xuICAgICAgYXdhaXQgdGhpcy5jb21taXQobXNnKTtcblxuICAgICAgcmV0dXJuIGZpbGVzQ2hhbmdlZDtcbiAgICB9KTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBjaGVja1VuY29tbWl0dGVkKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIC8qIENoZWNrcyBmb3IgYW55IHVuY29tbWl0dGVkIGNoYW5nZXMgbG9jYWxseSBwcmVzZW50LlxuICAgICAgIE5vdGlmaWVzIGFsbCB3aW5kb3dzIGFib3V0IHRoZSBzdGF0dXMuICovXG5cbiAgICBsb2cuZGVidWcoXCJDL2RiL2lzb2dpdDogQ2hlY2tpbmcgZm9yIHVuY29tbWl0dGVkIGNoYW5nZXNcIik7XG4gICAgY29uc3QgaGFzVW5jb21taXR0ZWRDaGFuZ2VzID0gKGF3YWl0IHRoaXMubGlzdENoYW5nZWRGaWxlcygpKS5sZW5ndGggPiAwO1xuICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaGFzTG9jYWxDaGFuZ2VzOiBoYXNVbmNvbW1pdHRlZENoYW5nZXMgfSk7XG4gICAgcmV0dXJuIGhhc1VuY29tbWl0dGVkQ2hhbmdlcztcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBzeW5jaHJvbml6ZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAvKiBDaGVja3MgZm9yIGNvbm5lY3Rpb24sIGxvY2FsIGNoYW5nZXMgYW5kIHVucHVzaGVkIGNvbW1pdHMsXG4gICAgICAgdHJpZXMgdG8gcHVzaCBhbmQgcHVsbCB3aGVuIHRoZXJl4oCZcyBvcHBvcnR1bml0eS5cblxuICAgICAgIE5vdGlmaWVzIGFsbCB3aW5kb3dzIGFib3V0IHRoZSBzdGF0dXMgaW4gcHJvY2Vzcy4gKi9cblxuICAgIGlmICh0aGlzLnN0YWdpbmdMb2NrLmlzQnVzeSgpKSB7XG4gICAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBMb2NrIGlzIGJ1c3ksIHNraXBwaW5nIHN5bmNcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogUXVldWVpbmcgc3luY1wiKTtcblxuICAgIHJldHVybiBhd2FpdCB0aGlzLnN0YWdpbmdMb2NrLmFjcXVpcmUoJzEnLCBhc3luYyAoKSA9PiB7XG4gICAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBTdGFydGluZyBzeW5jXCIpO1xuXG4gICAgICBjb25zdCBpc09ubGluZSA9IChhd2FpdCBjaGVja09ubGluZVN0YXR1cygpKSA9PT0gdHJ1ZTtcblxuICAgICAgaWYgKGlzT25saW5lKSB7XG4gICAgICAgIGNvbnN0IG5lZWRzUGFzc3dvcmQgPSB0aGlzLm5lZWRzUGFzc3dvcmQoKTtcbiAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBuZWVkc1Bhc3N3b3JkIH0pO1xuICAgICAgICBpZiAobmVlZHNQYXNzd29yZCkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghKGF3YWl0IHRoaXMuaXNJbml0aWFsaXplZCgpKSkge1xuICAgICAgICAgIGF3YWl0IHRoaXMuZm9yY2VJbml0aWFsaXplKCk7XG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzT25saW5lOiB0cnVlIH0pO1xuXG4gICAgICAgIGNvbnN0IGhhc1VuY29tbWl0dGVkQ2hhbmdlcyA9IGF3YWl0IHRoaXMuY2hlY2tVbmNvbW1pdHRlZCgpO1xuXG4gICAgICAgIC8vIERvIG5vdCBydW4gcHVsbCBpZiB0aGVyZSBhcmUgdW5zdGFnZWQvdW5jb21taXR0ZWQgY2hhbmdlc1xuICAgICAgICBpZiAoIWhhc1VuY29tbWl0dGVkQ2hhbmdlcykge1xuICAgICAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaXNQdWxsaW5nOiB0cnVlIH0pO1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnB1bGwoKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICBsb2cuZXJyb3IoZSk7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7XG4gICAgICAgICAgICAgIGxhc3RTeW5jaHJvbml6ZWQ6IG5ldyBEYXRlKCksXG4gICAgICAgICAgICAgIGlzUHVsbGluZzogZmFsc2UsXG4gICAgICAgICAgICAgIGlzUHVzaGluZzogZmFsc2UsXG4sICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX2hhbmRsZUdpdEVycm9yKGUpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvL2F3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaXNQdWxsaW5nOiBmYWxzZSB9KTtcblxuICAgICAgICAgIC8vIFJ1biBwdXNoIEFGVEVSIHB1bGwuIE1heSByZXN1bHQgaW4gZmFsc2UtcG9zaXRpdmUgbm9uLWZhc3QtZm9yd2FyZCByZWplY3Rpb25cbiAgICAgICAgICAvL2F3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaXNQdXNoaW5nOiB0cnVlIH0pO1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnB1c2goKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICBsb2cuZXJyb3IoZSk7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7XG4gICAgICAgICAgICAgIGxhc3RTeW5jaHJvbml6ZWQ6IG5ldyBEYXRlKCksXG4gICAgICAgICAgICAgIGlzUHVsbGluZzogZmFsc2UsXG4gICAgICAgICAgICAgIGlzUHVzaGluZzogZmFsc2UsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX2hhbmRsZUdpdEVycm9yKGUpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvL2F3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaXNQdXNoaW5nOiBmYWxzZSB9KTtcblxuICAgICAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHtcbiAgICAgICAgICAgIHN0YXR1c1JlbGF0aXZlVG9Mb2NhbDogJ3VwZGF0ZWQnLFxuICAgICAgICAgICAgaXNNaXNjb25maWd1cmVkOiBmYWxzZSxcbiAgICAgICAgICAgIGxhc3RTeW5jaHJvbml6ZWQ6IG5ldyBEYXRlKCksXG4gICAgICAgICAgICBuZWVkc1Bhc3N3b3JkOiBmYWxzZSxcbiAgICAgICAgICAgIGlzUHVzaGluZzogZmFsc2UsXG4gICAgICAgICAgICBpc1B1bGxpbmc6IGZhbHNlLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHVuc3RhZ2VBbGwoKSB7XG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogVW5zdGFnaW5nIGFsbCBjaGFuZ2VzXCIpO1xuICAgIGF3YWl0IGdpdC5yZW1vdmUoeyBkaXI6IHRoaXMud29ya0RpciwgZmlsZXBhdGg6ICcuJyB9KTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgX2hhbmRsZUdpdEVycm9yKGU6IEVycm9yICYgeyBjb2RlOiBzdHJpbmcgfSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGxvZy5kZWJ1ZyhcIkhhbmRsaW5nIEdpdCBlcnJvclwiLCBlKTtcblxuICAgIGlmIChlLmNvZGUgPT09ICdGYXN0Rm9yd2FyZEZhaWwnIHx8IGUuY29kZSA9PT0gJ01lcmdlTm90U3VwcG9ydGVkRmFpbCcpIHtcbiAgICAgIC8vIE5PVEU6IFRoZXJl4oCZcyBhbHNvIFB1c2hSZWplY3RlZE5vbkZhc3RGb3J3YXJkLCBidXQgaXQgc2VlbXMgdG8gYmUgdGhyb3duXG4gICAgICAvLyBmb3IgdW5yZWxhdGVkIGNhc2VzIGR1cmluZyBwdXNoIChmYWxzZSBwb3NpdGl2ZSkuXG4gICAgICAvLyBCZWNhdXNlIG9mIHRoYXQgZmFsc2UgcG9zaXRpdmUsIHdlIGlnbm9yZSB0aGF0IGVycm9yIGFuZCBpbnN0ZWFkIGRvIHB1bGwgZmlyc3QsXG4gICAgICAvLyBjYXRjaGluZyBhY3R1YWwgZmFzdC1mb3J3YXJkIGZhaWxzIG9uIHRoYXQgc3RlcCBiZWZvcmUgcHVzaC5cbiAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgc3RhdHVzUmVsYXRpdmVUb0xvY2FsOiAnZGl2ZXJnZWQnIH0pO1xuICAgIH0gZWxzZSBpZiAoWydNaXNzaW5nVXNlcm5hbWVFcnJvcicsICdNaXNzaW5nQXV0aG9yRXJyb3InLCAnTWlzc2luZ0NvbW1pdHRlckVycm9yJ10uaW5kZXhPZihlLmNvZGUpID49IDApIHtcbiAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaXNNaXNjb25maWd1cmVkOiB0cnVlIH0pO1xuICAgIH0gZWxzZSBpZiAoXG4gICAgICAgIGUuY29kZSA9PT0gJ01pc3NpbmdQYXNzd29yZFRva2VuRXJyb3InXG4gICAgICAgIHx8IChlLmNvZGUgPT09ICdIVFRQRXJyb3InICYmIGUubWVzc2FnZS5pbmRleE9mKCdVbmF1dGhvcml6ZWQnKSA+PSAwKSkge1xuICAgICAgbG9nLndhcm4oXCJQYXNzd29yZCBpbnB1dCByZXF1aXJlZFwiKTtcbiAgICAgIHRoaXMuc2V0UGFzc3dvcmQodW5kZWZpbmVkKTtcbiAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgbmVlZHNQYXNzd29yZDogdHJ1ZSB9KTtcbiAgICB9XG4gIH1cbn1cblxuXG5hc3luYyBmdW5jdGlvbiBjaGVja09ubGluZVN0YXR1cyh0aW1lb3V0ID0gNDUwMCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAvLyBUT0RPOiBNb3ZlIHRvIGdlbmVyYWwgdXRpbGl0eSBmdW5jdGlvbnNcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgbG9nLmRlYnVnKFwiQy9kYi9pc29naXQ6IENvbm5lY3Rpb24gdGVzdDogU3RhcnRpbmdcIik7XG5cbiAgICBjb25zdCByZXEgPSBodHRwcy5nZXQoJ2h0dHBzOi8vZ2l0aHViLmNvbS8nLCB7IHRpbWVvdXQgfSwgcmVwb3J0T25saW5lKTtcblxuICAgIHJlcS5vbignZXJyb3InLCAoKSA9PiByZXEuYWJvcnQoKSk7XG4gICAgcmVxLm9uKCdyZXNwb25zZScsIHJlcG9ydE9ubGluZSk7XG4gICAgcmVxLm9uKCdjb25uZWN0JywgcmVwb3J0T25saW5lKTtcbiAgICByZXEub24oJ2NvbnRpbnVlJywgcmVwb3J0T25saW5lKTtcbiAgICByZXEub24oJ3VwZ3JhZGUnLCByZXBvcnRPbmxpbmUpO1xuICAgIHJlcS5vbigndGltZW91dCcsIHJlcG9ydE9mZmxpbmUpO1xuXG4gICAgcmVxLmVuZCgpO1xuXG4gICAgY29uc3QgY2hlY2tUaW1lb3V0ID0gc2V0VGltZW91dChyZXBvcnRPZmZsaW5lLCB0aW1lb3V0KTtcblxuICAgIGZ1bmN0aW9uIHJlcG9ydE9mZmxpbmUoKSB7XG4gICAgICBsb2cud2FybihcIkMvZGIvaXNvZ2l0OiBDb25uZWN0aW9uIHRlc3Q6IFJlcG9ydCBvZmZsaW5lXCIpO1xuICAgICAgdHJ5IHsgcmVxLmFib3J0KCk7IH0gY2F0Y2ggKGUpIHt9XG4gICAgICBjbGVhclRpbWVvdXQoY2hlY2tUaW1lb3V0KTtcbiAgICAgIHJlc29sdmUoZmFsc2UpO1xuICAgIH1cbiAgICBmdW5jdGlvbiByZXBvcnRPbmxpbmUoKSB7XG4gICAgICBsb2cuaW5mbyhcIkMvZGIvaXNvZ2l0OiBDb25uZWN0aW9uIHRlc3Q6IFJlcG9ydCBvbmxpbmVcIik7XG4gICAgICB0cnkgeyByZXEuYWJvcnQoKTsgfSBjYXRjaCAoZSkge31cbiAgICAgIGNsZWFyVGltZW91dChjaGVja1RpbWVvdXQpO1xuICAgICAgcmVzb2x2ZSh0cnVlKTtcbiAgICB9XG4gIH0pO1xufVxuXG5cbi8vIFRPRE86IFRlbXBvcmFyeSB3b3JrYXJvdW5kIHNpbmNlIGlzb21vcnBoaWMtZ2l0IGRvZXNu4oCZdCBzZWVtIHRvIGV4cG9ydCBpdHMgR2l0RXJyb3IgY2xhc3Ncbi8vIGluIGFueSB3YXkgYXZhaWxhYmxlIHRvIFRTLCBzbyB3ZSBjYW7igJl0IHVzZSBpbnN0YW5jZW9mIDooXG5cbmV4cG9ydCBmdW5jdGlvbiBpc0dpdEVycm9yKGU6IEVycm9yICYgeyBjb2RlOiBzdHJpbmcgfSkge1xuICBpZiAoIWUuY29kZSkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gT2JqZWN0LmtleXMoSXNvbW9ycGhpY0dpdEVycm9yQ29kZXMpLmluZGV4T2YoZS5jb2RlKSA+PSAwO1xufVxuXG5jb25zdCBJc29tb3JwaGljR2l0RXJyb3JDb2RlcyA9IHtcbiAgRmlsZVJlYWRFcnJvcjogYEZpbGVSZWFkRXJyb3JgLFxuICBNaXNzaW5nUmVxdWlyZWRQYXJhbWV0ZXJFcnJvcjogYE1pc3NpbmdSZXF1aXJlZFBhcmFtZXRlckVycm9yYCxcbiAgSW52YWxpZFJlZk5hbWVFcnJvcjogYEludmFsaWRSZWZOYW1lRXJyb3JgLFxuICBJbnZhbGlkUGFyYW1ldGVyQ29tYmluYXRpb25FcnJvcjogYEludmFsaWRQYXJhbWV0ZXJDb21iaW5hdGlvbkVycm9yYCxcbiAgUmVmRXhpc3RzRXJyb3I6IGBSZWZFeGlzdHNFcnJvcmAsXG4gIFJlZk5vdEV4aXN0c0Vycm9yOiBgUmVmTm90RXhpc3RzRXJyb3JgLFxuICBCcmFuY2hEZWxldGVFcnJvcjogYEJyYW5jaERlbGV0ZUVycm9yYCxcbiAgTm9IZWFkQ29tbWl0RXJyb3I6IGBOb0hlYWRDb21taXRFcnJvcmAsXG4gIENvbW1pdE5vdEZldGNoZWRFcnJvcjogYENvbW1pdE5vdEZldGNoZWRFcnJvcmAsXG4gIE9iamVjdFR5cGVVbmtub3duRmFpbDogYE9iamVjdFR5cGVVbmtub3duRmFpbGAsXG4gIE9iamVjdFR5cGVBc3NlcnRpb25GYWlsOiBgT2JqZWN0VHlwZUFzc2VydGlvbkZhaWxgLFxuICBPYmplY3RUeXBlQXNzZXJ0aW9uSW5UcmVlRmFpbDogYE9iamVjdFR5cGVBc3NlcnRpb25JblRyZWVGYWlsYCxcbiAgT2JqZWN0VHlwZUFzc2VydGlvbkluUmVmRmFpbDogYE9iamVjdFR5cGVBc3NlcnRpb25JblJlZkZhaWxgLFxuICBPYmplY3RUeXBlQXNzZXJ0aW9uSW5QYXRoRmFpbDogYE9iamVjdFR5cGVBc3NlcnRpb25JblBhdGhGYWlsYCxcbiAgTWlzc2luZ0F1dGhvckVycm9yOiBgTWlzc2luZ0F1dGhvckVycm9yYCxcbiAgTWlzc2luZ0NvbW1pdHRlckVycm9yOiBgTWlzc2luZ0NvbW1pdHRlckVycm9yYCxcbiAgTWlzc2luZ1RhZ2dlckVycm9yOiBgTWlzc2luZ1RhZ2dlckVycm9yYCxcbiAgR2l0Um9vdE5vdEZvdW5kRXJyb3I6IGBHaXRSb290Tm90Rm91bmRFcnJvcmAsXG4gIFVucGFyc2VhYmxlU2VydmVyUmVzcG9uc2VGYWlsOiBgVW5wYXJzZWFibGVTZXJ2ZXJSZXNwb25zZUZhaWxgLFxuICBJbnZhbGlkRGVwdGhQYXJhbWV0ZXJFcnJvcjogYEludmFsaWREZXB0aFBhcmFtZXRlckVycm9yYCxcbiAgUmVtb3RlRG9lc05vdFN1cHBvcnRTaGFsbG93RmFpbDogYFJlbW90ZURvZXNOb3RTdXBwb3J0U2hhbGxvd0ZhaWxgLFxuICBSZW1vdGVEb2VzTm90U3VwcG9ydERlZXBlblNpbmNlRmFpbDogYFJlbW90ZURvZXNOb3RTdXBwb3J0RGVlcGVuU2luY2VGYWlsYCxcbiAgUmVtb3RlRG9lc05vdFN1cHBvcnREZWVwZW5Ob3RGYWlsOiBgUmVtb3RlRG9lc05vdFN1cHBvcnREZWVwZW5Ob3RGYWlsYCxcbiAgUmVtb3RlRG9lc05vdFN1cHBvcnREZWVwZW5SZWxhdGl2ZUZhaWw6IGBSZW1vdGVEb2VzTm90U3VwcG9ydERlZXBlblJlbGF0aXZlRmFpbGAsXG4gIFJlbW90ZURvZXNOb3RTdXBwb3J0U21hcnRIVFRQOiBgUmVtb3RlRG9lc05vdFN1cHBvcnRTbWFydEhUVFBgLFxuICBDb3JydXB0U2hhbGxvd09pZEZhaWw6IGBDb3JydXB0U2hhbGxvd09pZEZhaWxgLFxuICBGYXN0Rm9yd2FyZEZhaWw6IGBGYXN0Rm9yd2FyZEZhaWxgLFxuICBNZXJnZU5vdFN1cHBvcnRlZEZhaWw6IGBNZXJnZU5vdFN1cHBvcnRlZEZhaWxgLFxuICBEaXJlY3RvcnlTZXBhcmF0b3JzRXJyb3I6IGBEaXJlY3RvcnlTZXBhcmF0b3JzRXJyb3JgLFxuICBSZXNvbHZlVHJlZUVycm9yOiBgUmVzb2x2ZVRyZWVFcnJvcmAsXG4gIFJlc29sdmVDb21taXRFcnJvcjogYFJlc29sdmVDb21taXRFcnJvcmAsXG4gIERpcmVjdG9yeUlzQUZpbGVFcnJvcjogYERpcmVjdG9yeUlzQUZpbGVFcnJvcmAsXG4gIFRyZWVPckJsb2JOb3RGb3VuZEVycm9yOiBgVHJlZU9yQmxvYk5vdEZvdW5kRXJyb3JgLFxuICBOb3RJbXBsZW1lbnRlZEZhaWw6IGBOb3RJbXBsZW1lbnRlZEZhaWxgLFxuICBSZWFkT2JqZWN0RmFpbDogYFJlYWRPYmplY3RGYWlsYCxcbiAgTm90QW5PaWRGYWlsOiBgTm90QW5PaWRGYWlsYCxcbiAgTm9SZWZzcGVjQ29uZmlndXJlZEVycm9yOiBgTm9SZWZzcGVjQ29uZmlndXJlZEVycm9yYCxcbiAgTWlzbWF0Y2hSZWZWYWx1ZUVycm9yOiBgTWlzbWF0Y2hSZWZWYWx1ZUVycm9yYCxcbiAgUmVzb2x2ZVJlZkVycm9yOiBgUmVzb2x2ZVJlZkVycm9yYCxcbiAgRXhwYW5kUmVmRXJyb3I6IGBFeHBhbmRSZWZFcnJvcmAsXG4gIEVtcHR5U2VydmVyUmVzcG9uc2VGYWlsOiBgRW1wdHlTZXJ2ZXJSZXNwb25zZUZhaWxgLFxuICBBc3NlcnRTZXJ2ZXJSZXNwb25zZUZhaWw6IGBBc3NlcnRTZXJ2ZXJSZXNwb25zZUZhaWxgLFxuICBIVFRQRXJyb3I6IGBIVFRQRXJyb3JgLFxuICBSZW1vdGVVcmxQYXJzZUVycm9yOiBgUmVtb3RlVXJsUGFyc2VFcnJvcmAsXG4gIFVua25vd25UcmFuc3BvcnRFcnJvcjogYFVua25vd25UcmFuc3BvcnRFcnJvcmAsXG4gIEFjcXVpcmVMb2NrRmlsZUZhaWw6IGBBY3F1aXJlTG9ja0ZpbGVGYWlsYCxcbiAgRG91YmxlUmVsZWFzZUxvY2tGaWxlRmFpbDogYERvdWJsZVJlbGVhc2VMb2NrRmlsZUZhaWxgLFxuICBJbnRlcm5hbEZhaWw6IGBJbnRlcm5hbEZhaWxgLFxuICBVbmtub3duT2F1dGgyRm9ybWF0OiBgVW5rbm93bk9hdXRoMkZvcm1hdGAsXG4gIE1pc3NpbmdQYXNzd29yZFRva2VuRXJyb3I6IGBNaXNzaW5nUGFzc3dvcmRUb2tlbkVycm9yYCxcbiAgTWlzc2luZ1VzZXJuYW1lRXJyb3I6IGBNaXNzaW5nVXNlcm5hbWVFcnJvcmAsXG4gIE1peFBhc3N3b3JkVG9rZW5FcnJvcjogYE1peFBhc3N3b3JkVG9rZW5FcnJvcmAsXG4gIE1peFVzZXJuYW1lUGFzc3dvcmRUb2tlbkVycm9yOiBgTWl4VXNlcm5hbWVQYXNzd29yZFRva2VuRXJyb3JgLFxuICBNaXNzaW5nVG9rZW5FcnJvcjogYE1pc3NpbmdUb2tlbkVycm9yYCxcbiAgTWl4VXNlcm5hbWVPYXV0aDJmb3JtYXRNaXNzaW5nVG9rZW5FcnJvcjogYE1peFVzZXJuYW1lT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3JgLFxuICBNaXhQYXNzd29yZE9hdXRoMmZvcm1hdE1pc3NpbmdUb2tlbkVycm9yOiBgTWl4UGFzc3dvcmRPYXV0aDJmb3JtYXRNaXNzaW5nVG9rZW5FcnJvcmAsXG4gIE1peFVzZXJuYW1lUGFzc3dvcmRPYXV0aDJmb3JtYXRNaXNzaW5nVG9rZW5FcnJvcjogYE1peFVzZXJuYW1lUGFzc3dvcmRPYXV0aDJmb3JtYXRNaXNzaW5nVG9rZW5FcnJvcmAsXG4gIE1peFVzZXJuYW1lT2F1dGgyZm9ybWF0VG9rZW5FcnJvcjogYE1peFVzZXJuYW1lT2F1dGgyZm9ybWF0VG9rZW5FcnJvcmAsXG4gIE1peFBhc3N3b3JkT2F1dGgyZm9ybWF0VG9rZW5FcnJvcjogYE1peFBhc3N3b3JkT2F1dGgyZm9ybWF0VG9rZW5FcnJvcmAsXG4gIE1peFVzZXJuYW1lUGFzc3dvcmRPYXV0aDJmb3JtYXRUb2tlbkVycm9yOiBgTWl4VXNlcm5hbWVQYXNzd29yZE9hdXRoMmZvcm1hdFRva2VuRXJyb3JgLFxuICBNYXhTZWFyY2hEZXB0aEV4Y2VlZGVkOiBgTWF4U2VhcmNoRGVwdGhFeGNlZWRlZGAsXG4gIFB1c2hSZWplY3RlZE5vbkZhc3RGb3J3YXJkOiBgUHVzaFJlamVjdGVkTm9uRmFzdEZvcndhcmRgLFxuICBQdXNoUmVqZWN0ZWRUYWdFeGlzdHM6IGBQdXNoUmVqZWN0ZWRUYWdFeGlzdHNgLFxuICBBZGRpbmdSZW1vdGVXb3VsZE92ZXJ3cml0ZTogYEFkZGluZ1JlbW90ZVdvdWxkT3ZlcndyaXRlYCxcbiAgUGx1Z2luVW5kZWZpbmVkOiBgUGx1Z2luVW5kZWZpbmVkYCxcbiAgQ29yZU5vdEZvdW5kOiBgQ29yZU5vdEZvdW5kYCxcbiAgUGx1Z2luU2NoZW1hVmlvbGF0aW9uOiBgUGx1Z2luU2NoZW1hVmlvbGF0aW9uYCxcbiAgUGx1Z2luVW5yZWNvZ25pemVkOiBgUGx1Z2luVW5yZWNvZ25pemVkYCxcbiAgQW1iaWd1b3VzU2hvcnRPaWQ6IGBBbWJpZ3VvdXNTaG9ydE9pZGAsXG4gIFNob3J0T2lkTm90Rm91bmQ6IGBTaG9ydE9pZE5vdEZvdW5kYCxcbiAgQ2hlY2tvdXRDb25mbGljdEVycm9yOiBgQ2hlY2tvdXRDb25mbGljdEVycm9yYFxufVxuXG4iXX0=