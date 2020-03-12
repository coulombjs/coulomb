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
        return origin === remoteUrls.origin && upstream === remoteUrls.upstream;
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
            log.debug("C/db/isogit: Initialize: Adding upstream remote", this.repoUrl);
            await git.addRemote({
                dir: this.workDir,
                remote: UPSTREAM_REMOTE,
                url: this.upstreamRepoUrl,
            });
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
    async stage(pathSpecs) {
        log.verbose(`C/db/isogit: Adding changes: ${pathSpecs.join(', ')}`);
        for (const pathSpec of pathSpecs) {
            await git.add({
                dir: this.workDir,
                filepath: pathSpec,
            });
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
    async stageAndCommit(pathSpecs, msg) {
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
                        await this.setStatus({ isPushing: false, isPulling: false });
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFzZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9kYi9pc29naXQteWFtbC9tYWluL2lzb2dpdC9iYXNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sS0FBSyxLQUFLLE1BQU0sT0FBTyxDQUFDO0FBQy9CLE9BQU8sS0FBSyxJQUFJLE1BQU0sTUFBTSxDQUFDO0FBQzdCLE9BQU8sU0FBUyxNQUFNLFlBQVksQ0FBQztBQUNuQyxPQUFPLEtBQUssR0FBRyxNQUFNLGdCQUFnQixDQUFDO0FBQ3RDLE9BQU8sS0FBSyxHQUFHLE1BQU0sY0FBYyxDQUFDO0FBTXBDLE1BQU0sZUFBZSxHQUFHLFVBQVUsQ0FBQztBQUNuQyxNQUFNLFdBQVcsR0FBRyxRQUFRLENBQUM7QUFHN0IsTUFBTSxjQUFjLEdBQWM7SUFDaEMsUUFBUSxFQUFFLEtBQUs7SUFDZixlQUFlLEVBQUUsS0FBSztJQUN0QixlQUFlLEVBQUUsS0FBSztJQUN0QixhQUFhLEVBQUUsS0FBSztJQUNwQixxQkFBcUIsRUFBRSxTQUFTO0lBQ2hDLGdCQUFnQixFQUFFLElBQUk7SUFDdEIsU0FBUyxFQUFFLEtBQUs7SUFDaEIsU0FBUyxFQUFFLEtBQUs7Q0FDakIsQ0FBQTtBQUdELE1BQU0sT0FBTyxhQUFhO0lBUXhCLFlBQ1ksRUFBTyxFQUNQLE9BQWUsRUFDZixlQUF1QixFQUMvQixRQUFnQixFQUNSLE1BQXVDLEVBQ3hDLE9BQWUsRUFDZCxTQUFpQixFQUNqQixjQUFxRDtRQVByRCxPQUFFLEdBQUYsRUFBRSxDQUFLO1FBQ1AsWUFBTyxHQUFQLE9BQU8sQ0FBUTtRQUNmLG9CQUFlLEdBQWYsZUFBZSxDQUFRO1FBRXZCLFdBQU0sR0FBTixNQUFNLENBQWlDO1FBQ3hDLFlBQU8sR0FBUCxPQUFPLENBQVE7UUFDZCxjQUFTLEdBQVQsU0FBUyxDQUFRO1FBQ2pCLG1CQUFjLEdBQWQsY0FBYyxDQUF1QztRQWR6RCxTQUFJLEdBQXNCLEVBQUUsQ0FB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LEVBQUUsc0JBQXNCO0lBQzVDLHFCQUFxQixFQUFFLHVCQUF1QjtJQUM5Qyw2QkFBNkIsRUFBRSwrQkFBK0I7SUFDOUQsaUJBQWlCLEVBQUUsbUJBQW1CO0lBQ3RDLHdDQUF3QyxFQUFFLDBDQUEwQztJQUNwRix3Q0FBd0MsRUFBRSwwQ0FBMEM7SUFDcEYsZ0RBQWdELEVBQUUsa0RBQWtEO0lBQ3BHLGlDQUFpQyxFQUFFLG1DQUFtQztJQUN0RSxpQ0FBaUMsRUFBRSxtQ0FBbUM7SUFDdEUseUNBQXlDLEVBQUUsMkNBQTJDO0lBQ3RGLHNCQUFzQixFQUFFLHdCQUF3QjtJQUNoRCwwQkFBMEIsRUFBRSw0QkFBNEI7SUFDeEQscUJBQXFCLEVBQUUsdUJBQXVCO0lBQzlDLDBCQUEwQixFQUFFLDRCQUE0QjtJQUN4RCxlQUFlLEVBQUUsaUJBQWlCO0lBQ2xDLFlBQVksRUFBRSxjQUFjO0lBQzVCLHFCQUFxQixFQUFFLHVCQUF1QjtJQUM5QyxrQkFBa0IsRUFBRSxvQkFBb0I7SUFDeEMsaUJBQWlCLEVBQUUsbUJBQW1CO0lBQ3RDLGdCQUFnQixFQUFFLGtCQUFrQjtJQUNwQyxxQkFBcUIsRUFBRSx1QkFBdUI7Q0FDL0MsQ0FBQSIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGh0dHBzIGZyb20gJ2h0dHBzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgQXN5bmNMb2NrIGZyb20gJ2FzeW5jLWxvY2snO1xuaW1wb3J0ICogYXMgZ2l0IGZyb20gJ2lzb21vcnBoaWMtZ2l0JztcbmltcG9ydCAqIGFzIGxvZyBmcm9tICdlbGVjdHJvbi1sb2cnO1xuXG5pbXBvcnQgeyBHaXRTdGF0dXMgfSBmcm9tICcuLi8uLi9iYXNlJztcbmltcG9ydCB7IEdpdEF1dGhlbnRpY2F0aW9uIH0gZnJvbSAnLi90eXBlcyc7XG5cblxuY29uc3QgVVBTVFJFQU1fUkVNT1RFID0gJ3Vwc3RyZWFtJztcbmNvbnN0IE1BSU5fUkVNT1RFID0gJ29yaWdpbic7XG5cblxuY29uc3QgSU5JVElBTF9TVEFUVVM6IEdpdFN0YXR1cyA9IHtcbiAgaXNPbmxpbmU6IGZhbHNlLFxuICBpc01pc2NvbmZpZ3VyZWQ6IGZhbHNlLFxuICBoYXNMb2NhbENoYW5nZXM6IGZhbHNlLFxuICBuZWVkc1Bhc3N3b3JkOiBmYWxzZSxcbiAgc3RhdHVzUmVsYXRpdmVUb0xvY2FsOiB1bmRlZmluZWQsXG4gIGxhc3RTeW5jaHJvbml6ZWQ6IG51bGwsXG4gIGlzUHVzaGluZzogZmFsc2UsXG4gIGlzUHVsbGluZzogZmFsc2UsXG59XG5cblxuZXhwb3J0IGNsYXNzIElzb0dpdFdyYXBwZXIge1xuXG4gIHByaXZhdGUgYXV0aDogR2l0QXV0aGVudGljYXRpb24gPSB7fTtcblxuICBwcml2YXRlIHN0YWdpbmdMb2NrOiBBc3luY0xvY2s7XG5cbiAgcHJpdmF0ZSBzdGF0dXM6IEdpdFN0YXR1cztcblxuICBjb25zdHJ1Y3RvcihcbiAgICAgIHByaXZhdGUgZnM6IGFueSxcbiAgICAgIHByaXZhdGUgcmVwb1VybDogc3RyaW5nLFxuICAgICAgcHJpdmF0ZSB1cHN0cmVhbVJlcG9Vcmw6IHN0cmluZyxcbiAgICAgIHVzZXJuYW1lOiBzdHJpbmcsXG4gICAgICBwcml2YXRlIGF1dGhvcjogeyBuYW1lOiBzdHJpbmcsIGVtYWlsOiBzdHJpbmcgfSxcbiAgICAgIHB1YmxpYyB3b3JrRGlyOiBzdHJpbmcsXG4gICAgICBwcml2YXRlIGNvcnNQcm94eTogc3RyaW5nLFxuICAgICAgcHJpdmF0ZSBzdGF0dXNSZXBvcnRlcjogKHBheWxvYWQ6IEdpdFN0YXR1cykgPT4gUHJvbWlzZTx2b2lkPikge1xuXG4gICAgZ2l0LnBsdWdpbnMuc2V0KCdmcycsIGZzKTtcblxuICAgIHRoaXMuc3RhZ2luZ0xvY2sgPSBuZXcgQXN5bmNMb2NrKHsgdGltZW91dDogMjAwMDAsIG1heFBlbmRpbmc6IDIgfSk7XG5cbiAgICAvLyBNYWtlcyBpdCBlYXNpZXIgdG8gYmluZCB0aGVzZSB0byBJUEMgZXZlbnRzXG4gICAgdGhpcy5zeW5jaHJvbml6ZSA9IHRoaXMuc3luY2hyb25pemUuYmluZCh0aGlzKTtcbiAgICB0aGlzLnJlc2V0RmlsZXMgPSB0aGlzLnJlc2V0RmlsZXMuYmluZCh0aGlzKTtcbiAgICB0aGlzLmNoZWNrVW5jb21taXR0ZWQgPSB0aGlzLmNoZWNrVW5jb21taXR0ZWQuYmluZCh0aGlzKTtcblxuICAgIHRoaXMuYXV0aC51c2VybmFtZSA9IHVzZXJuYW1lO1xuXG4gICAgdGhpcy5zdGF0dXMgPSBJTklUSUFMX1NUQVRVUztcbiAgfVxuXG5cbiAgLy8gUmVwb3J0aW5nIEdpdCBzdGF0dXMgdG8gREIgYmFja2VuZCxcbiAgLy8gc28gdGhhdCBpdCBjYW4gYmUgcmVmbGVjdGVkIGluIHRoZSBHVUlcblxuICBwcml2YXRlIGFzeW5jIHJlcG9ydFN0YXR1cygpIHtcbiAgICByZXR1cm4gYXdhaXQgdGhpcy5zdGF0dXNSZXBvcnRlcih0aGlzLnN0YXR1cyk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHNldFN0YXR1cyhzdGF0dXM6IFBhcnRpYWw8R2l0U3RhdHVzPikge1xuICAgIE9iamVjdC5hc3NpZ24odGhpcy5zdGF0dXMsIHN0YXR1cyk7XG4gICAgYXdhaXQgdGhpcy5yZXBvcnRTdGF0dXMoKTtcbiAgfVxuXG4gIHB1YmxpYyBnZXRTdGF0dXMoKTogR2l0U3RhdHVzIHtcbiAgICByZXR1cm4gdGhpcy5zdGF0dXM7XG4gIH1cblxuXG4gIC8vIEluaXRpbGFpemF0aW9uXG5cbiAgcHVibGljIGFzeW5jIGlzSW5pdGlhbGl6ZWQoKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgbGV0IGhhc0dpdERpcmVjdG9yeTogYm9vbGVhbjtcbiAgICB0cnkge1xuICAgICAgaGFzR2l0RGlyZWN0b3J5ID0gKGF3YWl0IHRoaXMuZnMuc3RhdChwYXRoLmpvaW4odGhpcy53b3JrRGlyLCAnLmdpdCcpKSkuaXNEaXJlY3RvcnkoKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBoYXNHaXREaXJlY3RvcnkgPSBmYWxzZTtcbiAgICB9XG4gICAgcmV0dXJuIGhhc0dpdERpcmVjdG9yeTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBpc1VzaW5nUmVtb3RlVVJMcyhyZW1vdGVVcmxzOiB7IG9yaWdpbjogc3RyaW5nLCB1cHN0cmVhbTogc3RyaW5nIH0pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICBjb25zdCBvcmlnaW4gPSAoYXdhaXQgdGhpcy5nZXRPcmlnaW5VcmwoKSB8fCAnJykudHJpbSgpO1xuICAgIGNvbnN0IHVwc3RyZWFtID0gKGF3YWl0IHRoaXMuZ2V0VXBzdHJlYW1VcmwoKSB8fCAnJykudHJpbSgpO1xuICAgIHJldHVybiBvcmlnaW4gPT09IHJlbW90ZVVybHMub3JpZ2luICYmIHVwc3RyZWFtID09PSByZW1vdGVVcmxzLnVwc3RyZWFtO1xuICB9XG5cbiAgcHVibGljIG5lZWRzUGFzc3dvcmQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuICh0aGlzLmF1dGgucGFzc3dvcmQgfHwgJycpLnRyaW0oKSA9PT0gJyc7XG4gIH1cblxuICBwdWJsaWMgZ2V0VXNlcm5hbWUoKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5hdXRoLnVzZXJuYW1lO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGRlc3Ryb3koKSB7XG4gICAgLyogUmVtb3ZlcyB3b3JraW5nIGRpcmVjdG9yeS5cbiAgICAgICBPbiBuZXh0IHN5bmMgR2l0IHJlcG8gd2lsbCBoYXZlIHRvIGJlIHJlaW5pdGlhbGl6ZWQsIGNsb25lZCBldGMuICovXG5cbiAgICBsb2cud2FybihcIkMvZGIvaXNvZ2l0OiBJbml0aWFsaXplOiBSZW1vdmluZyBkYXRhIGRpcmVjdG9yeVwiKTtcbiAgICBhd2FpdCB0aGlzLmZzLnJlbW92ZSh0aGlzLndvcmtEaXIpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBmb3JjZUluaXRpYWxpemUoKSB7XG4gICAgLyogSW5pdGlhbGl6ZXMgZnJvbSBzY3JhdGNoOiB3aXBlcyB3b3JrIGRpcmVjdG9yeSwgY2xvbmVzIHJlcG9zaXRvcnksIGFkZHMgcmVtb3Rlcy4gKi9cblxuICAgIGxvZy53YXJuKFwiQy9kYi9pc29naXQ6IEluaXRpYWxpemluZ1wiKTtcblxuICAgIGxvZy5zaWxseShcIkMvZGIvaXNvZ2l0OiBJbml0aWFsaXplOiBFbnN1cmluZyBkYXRhIGRpcmVjdG9yeSBleGlzdHNcIik7XG4gICAgYXdhaXQgdGhpcy5mcy5lbnN1cmVEaXIodGhpcy53b3JrRGlyKTtcblxuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IEluaXRpYWxpemU6IENsb25pbmdcIiwgdGhpcy5yZXBvVXJsKTtcblxuICAgIHRyeSB7XG4gICAgICBhd2FpdCBnaXQuY2xvbmUoe1xuICAgICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgdXJsOiB0aGlzLnJlcG9VcmwsXG4gICAgICAgIHJlZjogJ21hc3RlcicsXG4gICAgICAgIHNpbmdsZUJyYW5jaDogdHJ1ZSxcbiAgICAgICAgZGVwdGg6IDUsXG4gICAgICAgIGNvcnNQcm94eTogdGhpcy5jb3JzUHJveHksXG4gICAgICAgIC4uLnRoaXMuYXV0aCxcbiAgICAgIH0pO1xuXG4gICAgICBsb2cuZGVidWcoXCJDL2RiL2lzb2dpdDogSW5pdGlhbGl6ZTogQWRkaW5nIHVwc3RyZWFtIHJlbW90ZVwiLCB0aGlzLnJlcG9VcmwpO1xuICAgICAgYXdhaXQgZ2l0LmFkZFJlbW90ZSh7XG4gICAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgICByZW1vdGU6IFVQU1RSRUFNX1JFTU9URSxcbiAgICAgICAgdXJsOiB0aGlzLnVwc3RyZWFtUmVwb1VybCxcbiAgICAgIH0pO1xuXG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgbG9nLmVycm9yKFwiQy9kYi9pc29naXQ6IEVycm9yIGR1cmluZyBpbml0aWFsaXphdGlvblwiKVxuICAgICAgYXdhaXQgdGhpcy5mcy5yZW1vdmUodGhpcy53b3JrRGlyKTtcbiAgICAgIGF3YWl0IHRoaXMuX2hhbmRsZUdpdEVycm9yKGUpO1xuICAgICAgdGhyb3cgZTtcbiAgICB9XG4gIH1cblxuXG4gIC8vIEF1dGhlbnRpY2F0aW9uXG5cbiAgcHVibGljIHNldFBhc3N3b3JkKHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgICB0aGlzLmF1dGgucGFzc3dvcmQgPSB2YWx1ZTtcbiAgfVxuXG5cbiAgLy8gR2l0IG9wZXJhdGlvbnNcblxuICBhc3luYyBjb25maWdTZXQocHJvcDogc3RyaW5nLCB2YWw6IHN0cmluZykge1xuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IFNldCBjb25maWdcIik7XG4gICAgYXdhaXQgZ2l0LmNvbmZpZyh7IGRpcjogdGhpcy53b3JrRGlyLCBwYXRoOiBwcm9wLCB2YWx1ZTogdmFsIH0pO1xuICB9XG5cbiAgYXN5bmMgY29uZmlnR2V0KHByb3A6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogR2V0IGNvbmZpZ1wiLCBwcm9wKTtcbiAgICByZXR1cm4gYXdhaXQgZ2l0LmNvbmZpZyh7IGRpcjogdGhpcy53b3JrRGlyLCBwYXRoOiBwcm9wIH0pO1xuICB9XG5cbiAgYXN5bmMgcmVhZEZpbGVCbG9iQXRDb21taXQocmVsYXRpdmVGaWxlUGF0aDogc3RyaW5nLCBjb21taXRIYXNoOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIC8qIFJlYWRzIGZpbGUgY29udGVudHMgYXQgZ2l2ZW4gcGF0aCBhcyBvZiBnaXZlbiBjb21taXQuIEZpbGUgY29udGVudHMgbXVzdCB1c2UgVVRGLTggZW5jb2RpbmcuICovXG5cbiAgICByZXR1cm4gKGF3YWl0IGdpdC5yZWFkQmxvYih7XG4gICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgIG9pZDogY29tbWl0SGFzaCxcbiAgICAgIGZpbGVwYXRoOiByZWxhdGl2ZUZpbGVQYXRoLFxuICAgIH0pKS5ibG9iLnRvU3RyaW5nKCk7XG4gIH1cblxuICBhc3luYyBwdWxsKCkge1xuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IFB1bGxpbmcgbWFzdGVyIHdpdGggZmFzdC1mb3J3YXJkIG1lcmdlXCIpO1xuXG4gICAgcmV0dXJuIGF3YWl0IGdpdC5wdWxsKHtcbiAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgc2luZ2xlQnJhbmNoOiB0cnVlLFxuICAgICAgZmFzdEZvcndhcmRPbmx5OiB0cnVlLFxuXG4gICAgICBmYXN0OiB0cnVlLFxuICAgICAgLy8gTk9URTogVHlwZVNjcmlwdCBpcyBrbm93biB0byBjb21wbGFpbiBhYm91dCB0aGUgYGBmYXN0YGAgb3B0aW9uLlxuICAgICAgLy8gU2VlbXMgbGlrZSBhIHByb2JsZW0gd2l0aCB0eXBpbmdzLlxuXG4gICAgICAuLi50aGlzLmF1dGgsXG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBzdGFnZShwYXRoU3BlY3M6IHN0cmluZ1tdKSB7XG4gICAgbG9nLnZlcmJvc2UoYEMvZGIvaXNvZ2l0OiBBZGRpbmcgY2hhbmdlczogJHtwYXRoU3BlY3Muam9pbignLCAnKX1gKTtcblxuICAgIGZvciAoY29uc3QgcGF0aFNwZWMgb2YgcGF0aFNwZWNzKSB7XG4gICAgICBhd2FpdCBnaXQuYWRkKHtcbiAgICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICAgIGZpbGVwYXRoOiBwYXRoU3BlYyxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIGNvbW1pdChtc2c6IHN0cmluZykge1xuICAgIGxvZy52ZXJib3NlKGBDL2RiL2lzb2dpdDogQ29tbWl0dGluZyB3aXRoIG1lc3NhZ2UgJHttc2d9YCk7XG5cbiAgICByZXR1cm4gYXdhaXQgZ2l0LmNvbW1pdCh7XG4gICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgIG1lc3NhZ2U6IG1zZyxcbiAgICAgIGF1dGhvcjogdGhpcy5hdXRob3IsXG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBmZXRjaFJlbW90ZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCBnaXQuZmV0Y2goeyBkaXI6IHRoaXMud29ya0RpciwgcmVtb3RlOiBNQUlOX1JFTU9URSwgLi4udGhpcy5hdXRoIH0pO1xuICB9XG5cbiAgYXN5bmMgZmV0Y2hVcHN0cmVhbSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCBnaXQuZmV0Y2goeyBkaXI6IHRoaXMud29ya0RpciwgcmVtb3RlOiBVUFNUUkVBTV9SRU1PVEUsIC4uLnRoaXMuYXV0aCB9KTtcbiAgfVxuXG4gIGFzeW5jIHB1c2goZm9yY2UgPSBmYWxzZSkge1xuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IFB1c2hpbmdcIik7XG5cbiAgICByZXR1cm4gYXdhaXQgZ2l0LnB1c2goe1xuICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICByZW1vdGU6IE1BSU5fUkVNT1RFLFxuICAgICAgZm9yY2U6IGZvcmNlLFxuICAgICAgLi4udGhpcy5hdXRoLFxuICAgIH0pO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIHJlc2V0RmlsZXMocGF0aHM/OiBzdHJpbmdbXSkge1xuICAgIHJldHVybiBhd2FpdCB0aGlzLnN0YWdpbmdMb2NrLmFjcXVpcmUoJzEnLCBhc3luYyAoKSA9PiB7XG4gICAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBGb3JjZSByZXNldHRpbmcgZmlsZXNcIik7XG5cbiAgICAgIHJldHVybiBhd2FpdCBnaXQuZmFzdENoZWNrb3V0KHtcbiAgICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICAgIGZvcmNlOiB0cnVlLFxuICAgICAgICBmaWxlcGF0aHM6IHBhdGhzIHx8IChhd2FpdCB0aGlzLmxpc3RDaGFuZ2VkRmlsZXMoKSksXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIGdldE9yaWdpblVybCgpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgICByZXR1cm4gKChhd2FpdCBnaXQubGlzdFJlbW90ZXMoe1xuICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgfSkpLmZpbmQociA9PiByLnJlbW90ZSA9PT0gTUFJTl9SRU1PVEUpIHx8IHsgdXJsOiBudWxsIH0pLnVybDtcbiAgfVxuXG4gIGFzeW5jIGdldFVwc3RyZWFtVXJsKCk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICAgIHJldHVybiAoKGF3YWl0IGdpdC5saXN0UmVtb3Rlcyh7XG4gICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICB9KSkuZmluZChyID0+IHIucmVtb3RlID09PSBVUFNUUkVBTV9SRU1PVEUpIHx8IHsgdXJsOiBudWxsIH0pLnVybDtcbiAgfVxuXG4gIGFzeW5jIGxpc3RMb2NhbENvbW1pdHMoKTogUHJvbWlzZTxzdHJpbmdbXT4ge1xuICAgIC8qIFJldHVybnMgYSBsaXN0IG9mIGNvbW1pdCBtZXNzYWdlcyBmb3IgY29tbWl0cyB0aGF0IHdlcmUgbm90IHB1c2hlZCB5ZXQuXG5cbiAgICAgICBVc2VmdWwgdG8gY2hlY2sgd2hpY2ggY29tbWl0cyB3aWxsIGJlIHRocm93biBvdXRcbiAgICAgICBpZiB3ZSBmb3JjZSB1cGRhdGUgdG8gcmVtb3RlIG1hc3Rlci5cblxuICAgICAgIERvZXMgc28gYnkgd2Fsa2luZyB0aHJvdWdoIGxhc3QgMTAwIGNvbW1pdHMgc3RhcnRpbmcgZnJvbSBjdXJyZW50IEhFQUQuXG4gICAgICAgV2hlbiBpdCBlbmNvdW50ZXJzIHRoZSBmaXJzdCBsb2NhbCBjb21taXQgdGhhdCBkb2VzbuKAmXQgZGVzY2VuZHMgZnJvbSByZW1vdGUgbWFzdGVyIEhFQUQsXG4gICAgICAgaXQgY29uc2lkZXJzIGFsbCBwcmVjZWRpbmcgY29tbWl0cyB0byBiZSBhaGVhZC9sb2NhbCBhbmQgcmV0dXJucyB0aGVtLlxuXG4gICAgICAgSWYgaXQgZmluaXNoZXMgdGhlIHdhbGsgd2l0aG91dCBmaW5kaW5nIGFuIGFuY2VzdG9yLCB0aHJvd3MgYW4gZXJyb3IuXG4gICAgICAgSXQgaXMgYXNzdW1lZCB0aGF0IHRoZSBhcHAgZG9lcyBub3QgYWxsb3cgdG8gYWNjdW11bGF0ZVxuICAgICAgIG1vcmUgdGhhbiAxMDAgY29tbWl0cyB3aXRob3V0IHB1c2hpbmcgKGV2ZW4gMTAwIGlzIHRvbyBtYW55ISksXG4gICAgICAgc28gdGhlcmXigJlzIHByb2JhYmx5IHNvbWV0aGluZyBzdHJhbmdlIGdvaW5nIG9uLlxuXG4gICAgICAgT3RoZXIgYXNzdW1wdGlvbnM6XG5cbiAgICAgICAqIGdpdC5sb2cgcmV0dXJucyBjb21taXRzIGZyb20gbmV3ZXN0IHRvIG9sZGVzdC5cbiAgICAgICAqIFRoZSByZW1vdGUgd2FzIGFscmVhZHkgZmV0Y2hlZC5cblxuICAgICovXG5cbiAgICByZXR1cm4gYXdhaXQgdGhpcy5zdGFnaW5nTG9jay5hY3F1aXJlKCcxJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgbGF0ZXN0UmVtb3RlQ29tbWl0ID0gYXdhaXQgZ2l0LnJlc29sdmVSZWYoe1xuICAgICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgcmVmOiBgJHtNQUlOX1JFTU9URX0vbWFzdGVyYCxcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBsb2NhbENvbW1pdHMgPSBhd2FpdCBnaXQubG9nKHtcbiAgICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICAgIGRlcHRoOiAxMDAsXG4gICAgICB9KTtcblxuICAgICAgdmFyIGNvbW1pdHMgPSBbXSBhcyBzdHJpbmdbXTtcbiAgICAgIGZvciAoY29uc3QgY29tbWl0IG9mIGxvY2FsQ29tbWl0cykge1xuICAgICAgICBpZiAoYXdhaXQgZ2l0LmlzRGVzY2VuZGVudCh7IGRpcjogdGhpcy53b3JrRGlyLCBvaWQ6IGNvbW1pdC5vaWQsIGFuY2VzdG9yOiBsYXRlc3RSZW1vdGVDb21taXQgfSkpIHtcbiAgICAgICAgICBjb21taXRzLnB1c2goY29tbWl0Lm1lc3NhZ2UpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJldHVybiBjb21taXRzO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkRpZCBub3QgZmluZCBhIGxvY2FsIGNvbW1pdCB0aGF0IGlzIGFuIGFuY2VzdG9yIG9mIHJlbW90ZSBtYXN0ZXJcIik7XG4gICAgfSk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgbGlzdENoYW5nZWRGaWxlcyhwYXRoU3BlY3MgPSBbJy4nXSk6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgICAvKiBMaXN0cyByZWxhdGl2ZSBwYXRocyB0byBhbGwgZmlsZXMgdGhhdCB3ZXJlIGNoYW5nZWQgYW5kIGhhdmUgbm90IGJlZW4gY29tbWl0dGVkLiAqL1xuXG4gICAgY29uc3QgRklMRSA9IDAsIEhFQUQgPSAxLCBXT1JLRElSID0gMjtcblxuICAgIHJldHVybiAoYXdhaXQgZ2l0LnN0YXR1c01hdHJpeCh7IGRpcjogdGhpcy53b3JrRGlyLCBmaWxlcGF0aHM6IHBhdGhTcGVjcyB9KSlcbiAgICAgIC5maWx0ZXIocm93ID0+IHJvd1tIRUFEXSAhPT0gcm93W1dPUktESVJdKVxuICAgICAgLm1hcChyb3cgPT4gcm93W0ZJTEVdKVxuICAgICAgLmZpbHRlcihmaWxlcGF0aCA9PiAhZmlsZXBhdGguc3RhcnRzV2l0aCgnLi4nKSk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgc3RhZ2VBbmRDb21taXQocGF0aFNwZWNzOiBzdHJpbmdbXSwgbXNnOiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcj4ge1xuICAgIC8qIFN0YWdlcyBhbmQgY29tbWl0cyBmaWxlcyBtYXRjaGluZyBnaXZlbiBwYXRoIHNwZWMgd2l0aCBnaXZlbiBtZXNzYWdlLlxuXG4gICAgICAgQW55IG90aGVyIGZpbGVzIHN0YWdlZCBhdCB0aGUgdGltZSBvZiB0aGUgY2FsbCB3aWxsIGJlIHVuc3RhZ2VkLlxuXG4gICAgICAgUmV0dXJucyB0aGUgbnVtYmVyIG9mIG1hdGNoaW5nIGZpbGVzIHdpdGggdW5zdGFnZWQgY2hhbmdlcyBwcmlvciB0byBzdGFnaW5nLlxuICAgICAgIElmIG5vIG1hdGNoaW5nIGZpbGVzIHdlcmUgZm91bmQgaGF2aW5nIHVuc3RhZ2VkIGNoYW5nZXMsXG4gICAgICAgc2tpcHMgdGhlIHJlc3QgYW5kIHJldHVybnMgemVyby5cblxuICAgICAgIElmIGZhaWxJZkRpdmVyZ2VkIGlzIGdpdmVuLCBhdHRlbXB0cyBhIGZhc3QtZm9yd2FyZCBwdWxsIGFmdGVyIHRoZSBjb21taXQuXG4gICAgICAgSXQgd2lsbCBmYWlsIGltbWVkaWF0ZWx5IGlmIG1haW4gcmVtb3RlIGhhZCBvdGhlciBjb21taXRzIGFwcGVhciBpbiBtZWFudGltZS5cblxuICAgICAgIExvY2tzIHNvIHRoYXQgdGhpcyBtZXRob2QgY2Fubm90IGJlIHJ1biBjb25jdXJyZW50bHkgKGJ5IHNhbWUgaW5zdGFuY2UpLlxuICAgICovXG5cbiAgICBpZiAocGF0aFNwZWNzLmxlbmd0aCA8IDEpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIldhc27igJl0IGdpdmVuIGFueSBwYXRocyB0byBjb21taXQhXCIpO1xuICAgIH1cblxuICAgIHJldHVybiBhd2FpdCB0aGlzLnN0YWdpbmdMb2NrLmFjcXVpcmUoJzEnLCBhc3luYyAoKSA9PiB7XG4gICAgICBsb2cudmVyYm9zZShgQy9kYi9pc29naXQ6IFN0YWdpbmcgYW5kIGNvbW1pdHRpbmc6ICR7cGF0aFNwZWNzLmpvaW4oJywgJyl9YCk7XG5cbiAgICAgIGNvbnN0IGZpbGVzQ2hhbmdlZCA9IChhd2FpdCB0aGlzLmxpc3RDaGFuZ2VkRmlsZXMocGF0aFNwZWNzKSkubGVuZ3RoO1xuICAgICAgaWYgKGZpbGVzQ2hhbmdlZCA8IDEpIHtcbiAgICAgICAgcmV0dXJuIDA7XG4gICAgICB9XG5cbiAgICAgIGF3YWl0IHRoaXMudW5zdGFnZUFsbCgpO1xuICAgICAgYXdhaXQgdGhpcy5zdGFnZShwYXRoU3BlY3MpO1xuICAgICAgYXdhaXQgdGhpcy5jb21taXQobXNnKTtcblxuICAgICAgcmV0dXJuIGZpbGVzQ2hhbmdlZDtcbiAgICB9KTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBjaGVja1VuY29tbWl0dGVkKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIC8qIENoZWNrcyBmb3IgYW55IHVuY29tbWl0dGVkIGNoYW5nZXMgbG9jYWxseSBwcmVzZW50LlxuICAgICAgIE5vdGlmaWVzIGFsbCB3aW5kb3dzIGFib3V0IHRoZSBzdGF0dXMuICovXG5cbiAgICBsb2cuZGVidWcoXCJDL2RiL2lzb2dpdDogQ2hlY2tpbmcgZm9yIHVuY29tbWl0dGVkIGNoYW5nZXNcIik7XG4gICAgY29uc3QgaGFzVW5jb21taXR0ZWRDaGFuZ2VzID0gKGF3YWl0IHRoaXMubGlzdENoYW5nZWRGaWxlcygpKS5sZW5ndGggPiAwO1xuICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaGFzTG9jYWxDaGFuZ2VzOiBoYXNVbmNvbW1pdHRlZENoYW5nZXMgfSk7XG4gICAgcmV0dXJuIGhhc1VuY29tbWl0dGVkQ2hhbmdlcztcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBzeW5jaHJvbml6ZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAvKiBDaGVja3MgZm9yIGNvbm5lY3Rpb24sIGxvY2FsIGNoYW5nZXMgYW5kIHVucHVzaGVkIGNvbW1pdHMsXG4gICAgICAgdHJpZXMgdG8gcHVzaCBhbmQgcHVsbCB3aGVuIHRoZXJl4oCZcyBvcHBvcnR1bml0eS5cblxuICAgICAgIE5vdGlmaWVzIGFsbCB3aW5kb3dzIGFib3V0IHRoZSBzdGF0dXMgaW4gcHJvY2Vzcy4gKi9cblxuICAgIGlmICh0aGlzLnN0YWdpbmdMb2NrLmlzQnVzeSgpKSB7XG4gICAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBMb2NrIGlzIGJ1c3ksIHNraXBwaW5nIHN5bmNcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogUXVldWVpbmcgc3luY1wiKTtcblxuICAgIHJldHVybiBhd2FpdCB0aGlzLnN0YWdpbmdMb2NrLmFjcXVpcmUoJzEnLCBhc3luYyAoKSA9PiB7XG4gICAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBTdGFydGluZyBzeW5jXCIpO1xuXG4gICAgICBjb25zdCBpc09ubGluZSA9IChhd2FpdCBjaGVja09ubGluZVN0YXR1cygpKSA9PT0gdHJ1ZTtcblxuICAgICAgaWYgKGlzT25saW5lKSB7XG4gICAgICAgIGNvbnN0IG5lZWRzUGFzc3dvcmQgPSB0aGlzLm5lZWRzUGFzc3dvcmQoKTtcbiAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBuZWVkc1Bhc3N3b3JkIH0pO1xuICAgICAgICBpZiAobmVlZHNQYXNzd29yZCkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghKGF3YWl0IHRoaXMuaXNJbml0aWFsaXplZCgpKSkge1xuICAgICAgICAgIGF3YWl0IHRoaXMuZm9yY2VJbml0aWFsaXplKCk7XG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzT25saW5lOiB0cnVlIH0pO1xuXG4gICAgICAgIGNvbnN0IGhhc1VuY29tbWl0dGVkQ2hhbmdlcyA9IGF3YWl0IHRoaXMuY2hlY2tVbmNvbW1pdHRlZCgpO1xuXG4gICAgICAgIC8vIERvIG5vdCBydW4gcHVsbCBpZiB0aGVyZSBhcmUgdW5zdGFnZWQvdW5jb21taXR0ZWQgY2hhbmdlc1xuICAgICAgICBpZiAoIWhhc1VuY29tbWl0dGVkQ2hhbmdlcykge1xuICAgICAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaXNQdWxsaW5nOiB0cnVlIH0pO1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnB1bGwoKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICBsb2cuZXJyb3IoZSk7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzUHVzaGluZzogZmFsc2UsIGlzUHVsbGluZzogZmFsc2UgfSk7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9oYW5kbGVHaXRFcnJvcihlKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy9hd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzUHVsbGluZzogZmFsc2UgfSk7XG5cbiAgICAgICAgICAvLyBSdW4gcHVzaCBBRlRFUiBwdWxsLiBNYXkgcmVzdWx0IGluIGZhbHNlLXBvc2l0aXZlIG5vbi1mYXN0LWZvcndhcmQgcmVqZWN0aW9uXG4gICAgICAgICAgLy9hd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzUHVzaGluZzogdHJ1ZSB9KTtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wdXNoKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgbG9nLmVycm9yKGUpO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBpc1B1bGxpbmc6IGZhbHNlLCBpc1B1c2hpbmc6IGZhbHNlIH0pO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5faGFuZGxlR2l0RXJyb3IoZSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBpc1B1c2hpbmc6IGZhbHNlIH0pO1xuXG4gICAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoe1xuICAgICAgICAgICAgc3RhdHVzUmVsYXRpdmVUb0xvY2FsOiAndXBkYXRlZCcsXG4gICAgICAgICAgICBpc01pc2NvbmZpZ3VyZWQ6IGZhbHNlLFxuICAgICAgICAgICAgbmVlZHNQYXNzd29yZDogZmFsc2UsXG4gICAgICAgICAgICBpc1B1c2hpbmc6IGZhbHNlLFxuICAgICAgICAgICAgaXNQdWxsaW5nOiBmYWxzZSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyB1bnN0YWdlQWxsKCkge1xuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IFVuc3RhZ2luZyBhbGwgY2hhbmdlc1wiKTtcbiAgICBhd2FpdCBnaXQucmVtb3ZlKHsgZGlyOiB0aGlzLndvcmtEaXIsIGZpbGVwYXRoOiAnLicgfSk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIF9oYW5kbGVHaXRFcnJvcihlOiBFcnJvciAmIHsgY29kZTogc3RyaW5nIH0pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBsb2cuZGVidWcoXCJIYW5kbGluZyBHaXQgZXJyb3JcIiwgZSk7XG5cbiAgICBpZiAoZS5jb2RlID09PSAnRmFzdEZvcndhcmRGYWlsJyB8fCBlLmNvZGUgPT09ICdNZXJnZU5vdFN1cHBvcnRlZEZhaWwnKSB7XG4gICAgICAvLyBOT1RFOiBUaGVyZeKAmXMgYWxzbyBQdXNoUmVqZWN0ZWROb25GYXN0Rm9yd2FyZCwgYnV0IGl0IHNlZW1zIHRvIGJlIHRocm93blxuICAgICAgLy8gZm9yIHVucmVsYXRlZCBjYXNlcyBkdXJpbmcgcHVzaCAoZmFsc2UgcG9zaXRpdmUpLlxuICAgICAgLy8gQmVjYXVzZSBvZiB0aGF0IGZhbHNlIHBvc2l0aXZlLCB3ZSBpZ25vcmUgdGhhdCBlcnJvciBhbmQgaW5zdGVhZCBkbyBwdWxsIGZpcnN0LFxuICAgICAgLy8gY2F0Y2hpbmcgYWN0dWFsIGZhc3QtZm9yd2FyZCBmYWlscyBvbiB0aGF0IHN0ZXAgYmVmb3JlIHB1c2guXG4gICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IHN0YXR1c1JlbGF0aXZlVG9Mb2NhbDogJ2RpdmVyZ2VkJyB9KTtcbiAgICB9IGVsc2UgaWYgKFsnTWlzc2luZ1VzZXJuYW1lRXJyb3InLCAnTWlzc2luZ0F1dGhvckVycm9yJywgJ01pc3NpbmdDb21taXR0ZXJFcnJvciddLmluZGV4T2YoZS5jb2RlKSA+PSAwKSB7XG4gICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzTWlzY29uZmlndXJlZDogdHJ1ZSB9KTtcbiAgICB9IGVsc2UgaWYgKFxuICAgICAgICBlLmNvZGUgPT09ICdNaXNzaW5nUGFzc3dvcmRUb2tlbkVycm9yJ1xuICAgICAgICB8fCAoZS5jb2RlID09PSAnSFRUUEVycm9yJyAmJiBlLm1lc3NhZ2UuaW5kZXhPZignVW5hdXRob3JpemVkJykgPj0gMCkpIHtcbiAgICAgIGxvZy53YXJuKFwiUGFzc3dvcmQgaW5wdXQgcmVxdWlyZWRcIik7XG4gICAgICB0aGlzLnNldFBhc3N3b3JkKHVuZGVmaW5lZCk7XG4gICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IG5lZWRzUGFzc3dvcmQ6IHRydWUgfSk7XG4gICAgfVxuICB9XG59XG5cblxuYXN5bmMgZnVuY3Rpb24gY2hlY2tPbmxpbmVTdGF0dXModGltZW91dCA9IDQ1MDApOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgLy8gVE9ETzogTW92ZSB0byBnZW5lcmFsIHV0aWxpdHkgZnVuY3Rpb25zXG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgIGxvZy5kZWJ1ZyhcIkMvZGIvaXNvZ2l0OiBDb25uZWN0aW9uIHRlc3Q6IFN0YXJ0aW5nXCIpO1xuXG4gICAgY29uc3QgcmVxID0gaHR0cHMuZ2V0KCdodHRwczovL2dpdGh1Yi5jb20vJywgeyB0aW1lb3V0IH0sIHJlcG9ydE9ubGluZSk7XG5cbiAgICByZXEub24oJ2Vycm9yJywgKCkgPT4gcmVxLmFib3J0KCkpO1xuICAgIHJlcS5vbigncmVzcG9uc2UnLCByZXBvcnRPbmxpbmUpO1xuICAgIHJlcS5vbignY29ubmVjdCcsIHJlcG9ydE9ubGluZSk7XG4gICAgcmVxLm9uKCdjb250aW51ZScsIHJlcG9ydE9ubGluZSk7XG4gICAgcmVxLm9uKCd1cGdyYWRlJywgcmVwb3J0T25saW5lKTtcbiAgICByZXEub24oJ3RpbWVvdXQnLCByZXBvcnRPZmZsaW5lKTtcblxuICAgIHJlcS5lbmQoKTtcblxuICAgIGNvbnN0IGNoZWNrVGltZW91dCA9IHNldFRpbWVvdXQocmVwb3J0T2ZmbGluZSwgdGltZW91dCk7XG5cbiAgICBmdW5jdGlvbiByZXBvcnRPZmZsaW5lKCkge1xuICAgICAgbG9nLndhcm4oXCJDL2RiL2lzb2dpdDogQ29ubmVjdGlvbiB0ZXN0OiBSZXBvcnQgb2ZmbGluZVwiKTtcbiAgICAgIHRyeSB7IHJlcS5hYm9ydCgpOyB9IGNhdGNoIChlKSB7fVxuICAgICAgY2xlYXJUaW1lb3V0KGNoZWNrVGltZW91dCk7XG4gICAgICByZXNvbHZlKGZhbHNlKTtcbiAgICB9XG4gICAgZnVuY3Rpb24gcmVwb3J0T25saW5lKCkge1xuICAgICAgbG9nLmluZm8oXCJDL2RiL2lzb2dpdDogQ29ubmVjdGlvbiB0ZXN0OiBSZXBvcnQgb25saW5lXCIpO1xuICAgICAgdHJ5IHsgcmVxLmFib3J0KCk7IH0gY2F0Y2ggKGUpIHt9XG4gICAgICBjbGVhclRpbWVvdXQoY2hlY2tUaW1lb3V0KTtcbiAgICAgIHJlc29sdmUodHJ1ZSk7XG4gICAgfVxuICB9KTtcbn1cblxuXG4vLyBUT0RPOiBUZW1wb3Jhcnkgd29ya2Fyb3VuZCBzaW5jZSBpc29tb3JwaGljLWdpdCBkb2VzbuKAmXQgc2VlbSB0byBleHBvcnQgaXRzIEdpdEVycm9yIGNsYXNzXG4vLyBpbiBhbnkgd2F5IGF2YWlsYWJsZSB0byBUUywgc28gd2UgY2Fu4oCZdCB1c2UgaW5zdGFuY2VvZiA6KFxuXG5leHBvcnQgZnVuY3Rpb24gaXNHaXRFcnJvcihlOiBFcnJvciAmIHsgY29kZTogc3RyaW5nIH0pIHtcbiAgaWYgKCFlLmNvZGUpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIE9iamVjdC5rZXlzKElzb21vcnBoaWNHaXRFcnJvckNvZGVzKS5pbmRleE9mKGUuY29kZSkgPj0gMDtcbn1cblxuY29uc3QgSXNvbW9ycGhpY0dpdEVycm9yQ29kZXMgPSB7XG4gIEZpbGVSZWFkRXJyb3I6IGBGaWxlUmVhZEVycm9yYCxcbiAgTWlzc2luZ1JlcXVpcmVkUGFyYW1ldGVyRXJyb3I6IGBNaXNzaW5nUmVxdWlyZWRQYXJhbWV0ZXJFcnJvcmAsXG4gIEludmFsaWRSZWZOYW1lRXJyb3I6IGBJbnZhbGlkUmVmTmFtZUVycm9yYCxcbiAgSW52YWxpZFBhcmFtZXRlckNvbWJpbmF0aW9uRXJyb3I6IGBJbnZhbGlkUGFyYW1ldGVyQ29tYmluYXRpb25FcnJvcmAsXG4gIFJlZkV4aXN0c0Vycm9yOiBgUmVmRXhpc3RzRXJyb3JgLFxuICBSZWZOb3RFeGlzdHNFcnJvcjogYFJlZk5vdEV4aXN0c0Vycm9yYCxcbiAgQnJhbmNoRGVsZXRlRXJyb3I6IGBCcmFuY2hEZWxldGVFcnJvcmAsXG4gIE5vSGVhZENvbW1pdEVycm9yOiBgTm9IZWFkQ29tbWl0RXJyb3JgLFxuICBDb21taXROb3RGZXRjaGVkRXJyb3I6IGBDb21taXROb3RGZXRjaGVkRXJyb3JgLFxuICBPYmplY3RUeXBlVW5rbm93bkZhaWw6IGBPYmplY3RUeXBlVW5rbm93bkZhaWxgLFxuICBPYmplY3RUeXBlQXNzZXJ0aW9uRmFpbDogYE9iamVjdFR5cGVBc3NlcnRpb25GYWlsYCxcbiAgT2JqZWN0VHlwZUFzc2VydGlvbkluVHJlZUZhaWw6IGBPYmplY3RUeXBlQXNzZXJ0aW9uSW5UcmVlRmFpbGAsXG4gIE9iamVjdFR5cGVBc3NlcnRpb25JblJlZkZhaWw6IGBPYmplY3RUeXBlQXNzZXJ0aW9uSW5SZWZGYWlsYCxcbiAgT2JqZWN0VHlwZUFzc2VydGlvbkluUGF0aEZhaWw6IGBPYmplY3RUeXBlQXNzZXJ0aW9uSW5QYXRoRmFpbGAsXG4gIE1pc3NpbmdBdXRob3JFcnJvcjogYE1pc3NpbmdBdXRob3JFcnJvcmAsXG4gIE1pc3NpbmdDb21taXR0ZXJFcnJvcjogYE1pc3NpbmdDb21taXR0ZXJFcnJvcmAsXG4gIE1pc3NpbmdUYWdnZXJFcnJvcjogYE1pc3NpbmdUYWdnZXJFcnJvcmAsXG4gIEdpdFJvb3ROb3RGb3VuZEVycm9yOiBgR2l0Um9vdE5vdEZvdW5kRXJyb3JgLFxuICBVbnBhcnNlYWJsZVNlcnZlclJlc3BvbnNlRmFpbDogYFVucGFyc2VhYmxlU2VydmVyUmVzcG9uc2VGYWlsYCxcbiAgSW52YWxpZERlcHRoUGFyYW1ldGVyRXJyb3I6IGBJbnZhbGlkRGVwdGhQYXJhbWV0ZXJFcnJvcmAsXG4gIFJlbW90ZURvZXNOb3RTdXBwb3J0U2hhbGxvd0ZhaWw6IGBSZW1vdGVEb2VzTm90U3VwcG9ydFNoYWxsb3dGYWlsYCxcbiAgUmVtb3RlRG9lc05vdFN1cHBvcnREZWVwZW5TaW5jZUZhaWw6IGBSZW1vdGVEb2VzTm90U3VwcG9ydERlZXBlblNpbmNlRmFpbGAsXG4gIFJlbW90ZURvZXNOb3RTdXBwb3J0RGVlcGVuTm90RmFpbDogYFJlbW90ZURvZXNOb3RTdXBwb3J0RGVlcGVuTm90RmFpbGAsXG4gIFJlbW90ZURvZXNOb3RTdXBwb3J0RGVlcGVuUmVsYXRpdmVGYWlsOiBgUmVtb3RlRG9lc05vdFN1cHBvcnREZWVwZW5SZWxhdGl2ZUZhaWxgLFxuICBSZW1vdGVEb2VzTm90U3VwcG9ydFNtYXJ0SFRUUDogYFJlbW90ZURvZXNOb3RTdXBwb3J0U21hcnRIVFRQYCxcbiAgQ29ycnVwdFNoYWxsb3dPaWRGYWlsOiBgQ29ycnVwdFNoYWxsb3dPaWRGYWlsYCxcbiAgRmFzdEZvcndhcmRGYWlsOiBgRmFzdEZvcndhcmRGYWlsYCxcbiAgTWVyZ2VOb3RTdXBwb3J0ZWRGYWlsOiBgTWVyZ2VOb3RTdXBwb3J0ZWRGYWlsYCxcbiAgRGlyZWN0b3J5U2VwYXJhdG9yc0Vycm9yOiBgRGlyZWN0b3J5U2VwYXJhdG9yc0Vycm9yYCxcbiAgUmVzb2x2ZVRyZWVFcnJvcjogYFJlc29sdmVUcmVlRXJyb3JgLFxuICBSZXNvbHZlQ29tbWl0RXJyb3I6IGBSZXNvbHZlQ29tbWl0RXJyb3JgLFxuICBEaXJlY3RvcnlJc0FGaWxlRXJyb3I6IGBEaXJlY3RvcnlJc0FGaWxlRXJyb3JgLFxuICBUcmVlT3JCbG9iTm90Rm91bmRFcnJvcjogYFRyZWVPckJsb2JOb3RGb3VuZEVycm9yYCxcbiAgTm90SW1wbGVtZW50ZWRGYWlsOiBgTm90SW1wbGVtZW50ZWRGYWlsYCxcbiAgUmVhZE9iamVjdEZhaWw6IGBSZWFkT2JqZWN0RmFpbGAsXG4gIE5vdEFuT2lkRmFpbDogYE5vdEFuT2lkRmFpbGAsXG4gIE5vUmVmc3BlY0NvbmZpZ3VyZWRFcnJvcjogYE5vUmVmc3BlY0NvbmZpZ3VyZWRFcnJvcmAsXG4gIE1pc21hdGNoUmVmVmFsdWVFcnJvcjogYE1pc21hdGNoUmVmVmFsdWVFcnJvcmAsXG4gIFJlc29sdmVSZWZFcnJvcjogYFJlc29sdmVSZWZFcnJvcmAsXG4gIEV4cGFuZFJlZkVycm9yOiBgRXhwYW5kUmVmRXJyb3JgLFxuICBFbXB0eVNlcnZlclJlc3BvbnNlRmFpbDogYEVtcHR5U2VydmVyUmVzcG9uc2VGYWlsYCxcbiAgQXNzZXJ0U2VydmVyUmVzcG9uc2VGYWlsOiBgQXNzZXJ0U2VydmVyUmVzcG9uc2VGYWlsYCxcbiAgSFRUUEVycm9yOiBgSFRUUEVycm9yYCxcbiAgUmVtb3RlVXJsUGFyc2VFcnJvcjogYFJlbW90ZVVybFBhcnNlRXJyb3JgLFxuICBVbmtub3duVHJhbnNwb3J0RXJyb3I6IGBVbmtub3duVHJhbnNwb3J0RXJyb3JgLFxuICBBY3F1aXJlTG9ja0ZpbGVGYWlsOiBgQWNxdWlyZUxvY2tGaWxlRmFpbGAsXG4gIERvdWJsZVJlbGVhc2VMb2NrRmlsZUZhaWw6IGBEb3VibGVSZWxlYXNlTG9ja0ZpbGVGYWlsYCxcbiAgSW50ZXJuYWxGYWlsOiBgSW50ZXJuYWxGYWlsYCxcbiAgVW5rbm93bk9hdXRoMkZvcm1hdDogYFVua25vd25PYXV0aDJGb3JtYXRgLFxuICBNaXNzaW5nUGFzc3dvcmRUb2tlbkVycm9yOiBgTWlzc2luZ1Bhc3N3b3JkVG9rZW5FcnJvcmAsXG4gIE1pc3NpbmdVc2VybmFtZUVycm9yOiBgTWlzc2luZ1VzZXJuYW1lRXJyb3JgLFxuICBNaXhQYXNzd29yZFRva2VuRXJyb3I6IGBNaXhQYXNzd29yZFRva2VuRXJyb3JgLFxuICBNaXhVc2VybmFtZVBhc3N3b3JkVG9rZW5FcnJvcjogYE1peFVzZXJuYW1lUGFzc3dvcmRUb2tlbkVycm9yYCxcbiAgTWlzc2luZ1Rva2VuRXJyb3I6IGBNaXNzaW5nVG9rZW5FcnJvcmAsXG4gIE1peFVzZXJuYW1lT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3I6IGBNaXhVc2VybmFtZU9hdXRoMmZvcm1hdE1pc3NpbmdUb2tlbkVycm9yYCxcbiAgTWl4UGFzc3dvcmRPYXV0aDJmb3JtYXRNaXNzaW5nVG9rZW5FcnJvcjogYE1peFBhc3N3b3JkT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3JgLFxuICBNaXhVc2VybmFtZVBhc3N3b3JkT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3I6IGBNaXhVc2VybmFtZVBhc3N3b3JkT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3JgLFxuICBNaXhVc2VybmFtZU9hdXRoMmZvcm1hdFRva2VuRXJyb3I6IGBNaXhVc2VybmFtZU9hdXRoMmZvcm1hdFRva2VuRXJyb3JgLFxuICBNaXhQYXNzd29yZE9hdXRoMmZvcm1hdFRva2VuRXJyb3I6IGBNaXhQYXNzd29yZE9hdXRoMmZvcm1hdFRva2VuRXJyb3JgLFxuICBNaXhVc2VybmFtZVBhc3N3b3JkT2F1dGgyZm9ybWF0VG9rZW5FcnJvcjogYE1peFVzZXJuYW1lUGFzc3dvcmRPYXV0aDJmb3JtYXRUb2tlbkVycm9yYCxcbiAgTWF4U2VhcmNoRGVwdGhFeGNlZWRlZDogYE1heFNlYXJjaERlcHRoRXhjZWVkZWRgLFxuICBQdXNoUmVqZWN0ZWROb25GYXN0Rm9yd2FyZDogYFB1c2hSZWplY3RlZE5vbkZhc3RGb3J3YXJkYCxcbiAgUHVzaFJlamVjdGVkVGFnRXhpc3RzOiBgUHVzaFJlamVjdGVkVGFnRXhpc3RzYCxcbiAgQWRkaW5nUmVtb3RlV291bGRPdmVyd3JpdGU6IGBBZGRpbmdSZW1vdGVXb3VsZE92ZXJ3cml0ZWAsXG4gIFBsdWdpblVuZGVmaW5lZDogYFBsdWdpblVuZGVmaW5lZGAsXG4gIENvcmVOb3RGb3VuZDogYENvcmVOb3RGb3VuZGAsXG4gIFBsdWdpblNjaGVtYVZpb2xhdGlvbjogYFBsdWdpblNjaGVtYVZpb2xhdGlvbmAsXG4gIFBsdWdpblVucmVjb2duaXplZDogYFBsdWdpblVucmVjb2duaXplZGAsXG4gIEFtYmlndW91c1Nob3J0T2lkOiBgQW1iaWd1b3VzU2hvcnRPaWRgLFxuICBTaG9ydE9pZE5vdEZvdW5kOiBgU2hvcnRPaWROb3RGb3VuZGAsXG4gIENoZWNrb3V0Q29uZmxpY3RFcnJvcjogYENoZWNrb3V0Q29uZmxpY3RFcnJvcmBcbn1cblxuIl19