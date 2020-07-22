import { Worker } from 'worker_threads';
import * as https from 'https';
import fs from 'fs-extra';
import * as path from 'path';
import AsyncLock from 'async-lock';
import * as git from 'isomorphic-git';
import * as log from 'electron-log';
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
const workerFilePath = __dirname.endsWith('app.asar')
    ? path.resolve(__dirname, '..', 'isogit-worker.js')
    : path.resolve(__dirname, 'worker.js');
const workerContents = fs.readFileSync(workerFilePath, { encoding: 'utf8' });
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
        this.stagingLock = new AsyncLock({ timeout: 20000, maxPending: 2 });
        if (this.corsProxy) {
            log.warn("C/db/isogit: CORS proxy parameter is obsolete and will be removed.");
        }
        if (this.upstreamRepoUrl !== undefined) {
            log.warn("C/db/isogit: the upstreamRepoUrl parameter is obsolete and will be removed.");
        }
        this.worker = new Worker(workerContents, { eval: true });
        this.worker.on('exit', (code) => {
            log.error("C/db/isogit: Worker exited!", code);
        });
        this.worker.on('error', (err) => {
            log.error("C/db/isogit: Worker error", err);
        });
        // Makes it easier to bind these to IPC events
        this.synchronize = this.synchronize.bind(this);
        this.resetFiles = this.resetFiles.bind(this);
        this.checkUncommitted = this.checkUncommitted.bind(this);
        this.auth.username = username;
        this.status = INITIAL_STATUS;
    }
    async postMessage(msg, resolveOnResponse, failOnResponse) {
        this.worker.postMessage(msg);
        if (!resolveOnResponse && !failOnResponse) {
            return;
        }
        else {
            return new Promise((resolve, reject) => {
                this.worker.once('message', (msg) => {
                    if (failOnResponse !== undefined && failOnResponse(msg)) {
                        reject(msg);
                    }
                    if (resolveOnResponse !== undefined && resolveOnResponse(msg)) {
                        resolve(msg);
                    }
                });
            });
        }
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
        return origin === remoteUrls.origin;
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
            var _a, _b, _c;
            log.warn("C/db/isogit: Initializing");
            log.silly("C/db/isogit: Initialize: Ensuring data directory exists");
            await this.fs.ensureDir(this.workDir);
            log.verbose("C/db/isogit: Initialize: Cloning", this.repoUrl);
            try {
                const result = await this.postMessage({
                    action: 'clone',
                    workDir: this.workDir,
                    repoURL: this.repoUrl,
                    auth: this.auth,
                }, ((msg) => msg.cloned !== undefined), ((msg) => msg.error !== undefined));
                if (((_a = result) === null || _a === void 0 ? void 0 : _a.cloned) !== true) {
                    log.error("C/db/isogit: Failed to clone", (_b = result) === null || _b === void 0 ? void 0 : _b.error);
                    if ((_c = result) === null || _c === void 0 ? void 0 : _c.error) {
                        throw new result.error;
                    }
                    else {
                        throw new Error("Failed to clone");
                    }
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
        await git.setConfig({ fs: this.fs, dir: this.workDir, path: prop, value: val });
    }
    async configGet(prop) {
        log.verbose("C/db/isogit: Get config", prop);
        return await git.getConfig({ fs: this.fs, dir: this.workDir, path: prop });
    }
    async readFileBlobAtCommit(relativeFilePath, commitHash) {
        /* Reads file contents at given path as of given commit. File contents must use UTF-8 encoding. */
        return (await git.readBlob({
            fs: this.fs,
            dir: this.workDir,
            oid: commitHash,
            filepath: relativeFilePath,
        })).blob.toString();
    }
    async pull() {
        var _a, _b, _c, _d;
        log.verbose("C/db/isogit: Pulling master with fast-forward merge");
        const result = await this.postMessage({
            action: 'pull',
            workDir: this.workDir,
            repoURL: this.repoUrl,
            auth: this.auth,
            author: this.author,
        }, ((msg) => msg.pulled !== undefined), ((msg) => msg.error !== undefined));
        if (((_a = result) === null || _a === void 0 ? void 0 : _a.pulled) !== true) {
            log.error("C/db/isogit: Failed to pull", (_b = result) === null || _b === void 0 ? void 0 : _b.error);
            if ((_c = result) === null || _c === void 0 ? void 0 : _c.error) {
                throw (_d = result) === null || _d === void 0 ? void 0 : _d.error;
            }
            else {
                throw new Error("Failed to pull");
            }
        }
    }
    async stage(pathSpecs, removing = false) {
        log.verbose(`C/db/isogit: Staging changes: ${pathSpecs.join(', ')} using ${removing ? "remove()" : "add()"}`);
        for (const pathSpec of pathSpecs) {
            if (removing !== true) {
                await git.add({
                    fs: this.fs,
                    dir: this.workDir,
                    filepath: pathSpec,
                });
            }
            else {
                await git.remove({
                    fs: this.fs,
                    dir: this.workDir,
                    filepath: pathSpec,
                });
            }
        }
    }
    async commit(msg) {
        log.verbose(`C/db/isogit: Committing with message ${msg}`);
        return await git.commit({
            fs: this.fs,
            dir: this.workDir,
            message: msg,
            author: this.author,
        });
    }
    async push() {
        var _a, _b, _c, _d;
        log.verbose("C/db/isogit: Pushing");
        const result = await this.postMessage({
            action: 'push',
            workDir: this.workDir,
            repoURL: this.repoUrl,
            auth: this.auth,
        }, ((msg) => msg.pushed !== undefined), ((msg) => msg.error !== undefined));
        if (((_a = result) === null || _a === void 0 ? void 0 : _a.pushed) !== true) {
            log.error("C/db/isogit: Failed to push", (_b = result) === null || _b === void 0 ? void 0 : _b.error);
            if ((_c = result) === null || _c === void 0 ? void 0 : _c.error) {
                throw (_d = result) === null || _d === void 0 ? void 0 : _d.error;
            }
            else {
                throw new Error("Failed to push");
            }
        }
    }
    async resetFiles(paths) {
        return await this.stagingLock.acquire('1', async () => {
            log.verbose("C/db/isogit: Force resetting files");
            return await git.checkout({
                fs: this.fs,
                dir: this.workDir,
                force: true,
                filepaths: paths || (await this.listChangedFiles()),
            });
        });
    }
    async getOriginUrl() {
        return ((await git.listRemotes({
            fs: this.fs,
            dir: this.workDir,
        })).find(r => r.remote === MAIN_REMOTE) || { url: null }).url;
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
                fs: this.fs,
                dir: this.workDir,
                ref: `${MAIN_REMOTE}/master`,
            });
            const localCommits = await git.log({
                fs: this.fs,
                dir: this.workDir,
                depth: 100,
            });
            var commits = [];
            for (const commit of localCommits) {
                if (await git.isDescendent({
                    fs: this.fs,
                    dir: this.workDir,
                    oid: commit.oid,
                    ancestor: latestRemoteCommit,
                })) {
                    commits.push(commit.commit.message);
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
        return (await git.statusMatrix({ fs: this.fs, dir: this.workDir, filepaths: pathSpecs }))
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
                        isPulling: false,
                        isPushing: false,
                        lastSynchronized: new Date(),
                        isOnline: false,
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
                            isPulling: false,
                            isPushing: false,
                            lastSynchronized: new Date(),
                        });
                        await this._handleGitError(e);
                        return;
                    }
                    this.pushPending = false;
                    //await this.setStatus({ isPushing: false });
                }
                await this.setStatus({
                    statusRelativeToLocal: 'updated',
                    isOnline: true,
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
        await git.remove({ fs: this.fs, dir: this.workDir, filepath: '.' });
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFzZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9kYi9pc29naXQteWFtbC9tYWluL2lzb2dpdC9iYXNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxNQUFNLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUN4QyxPQUFPLEtBQUssS0FBSyxNQUFNLE9BQU8sQ0FBQztBQUMvQixPQUFPLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFDMUIsT0FBTyxLQUFLLElBQUksTUFBTSxNQUFNLENBQUM7QUFDN0IsT0FBTyxTQUFTLE1BQU0sWUFBWSxDQUFDO0FBQ25DLE9BQU8sS0FBSyxHQUFHLE1BQU0sZ0JBQWdCLENBQUM7QUFDdEMsT0FBTyxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUM7QUFNcEMsTUFBTSxXQUFXLEdBQUcsUUFBUSxDQUFDO0FBRzdCLE1BQU0sY0FBYyxHQUFjO0lBQ2hDLFFBQVEsRUFBRSxLQUFLO0lBQ2YsZUFBZSxFQUFFLEtBQUs7SUFDdEIsZUFBZSxFQUFFLEtBQUs7SUFDdEIsYUFBYSxFQUFFLEtBQUs7SUFDcEIscUJBQXFCLEVBQUUsU0FBUztJQUNoQyxnQkFBZ0IsRUFBRSxJQUFJO0lBQ3RCLFNBQVMsRUFBRSxLQUFLO0lBQ2hCLFNBQVMsRUFBRSxLQUFLO0NBQ1IsQ0FBQztBQUdYLE1BQU0sY0FBYyxHQUFHLFNBQVMsQ0FBQyxRQUFRLENBQUMsVUFBVSxDQUFDO0lBQ25ELENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLFNBQVMsRUFBRSxJQUFJLEVBQUUsa0JBQWtCLENBQUM7SUFDbkQsQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsU0FBUyxFQUFFLFdBQVcsQ0FBQyxDQUFDO0FBRXpDLE1BQU0sY0FBYyxHQUFJLEVBQUUsQ0FBQyxZQUFZLENBQUMsY0FBYyxFQUFFLEVBQUUsUUFBUSxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUM7QUFHOUUsTUFBTSxPQUFP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Q0FBd0MsRUFBRSwwQ0FBMEM7SUFDcEYsZ0RBQWdELEVBQUUsa0RBQWtEO0lBQ3BHLGlDQUFpQyxFQUFFLG1DQUFtQztJQUN0RSxpQ0FBaUMsRUFBRSxtQ0FBbUM7SUFDdEUseUNBQXlDLEVBQUUsMkNBQTJDO0lBQ3RGLHNCQUFzQixFQUFFLHdCQUF3QjtJQUNoRCwwQkFBMEIsRUFBRSw0QkFBNEI7SUFDeEQscUJBQXFCLEVBQUUsdUJBQXVCO0lBQzlDLDBCQUEwQixFQUFFLDRCQUE0QjtJQUN4RCxlQUFlLEVBQUUsaUJBQWlCO0lBQ2xDLFlBQVksRUFBRSxjQUFjO0lBQzVCLHFCQUFxQixFQUFFLHVCQUF1QjtJQUM5QyxrQkFBa0IsRUFBRSxvQkFBb0I7SUFDeEMsaUJBQWlCLEVBQUUsbUJBQW1CO0lBQ3RDLGdCQUFnQixFQUFFLGtCQUFrQjtJQUNwQyxxQkFBcUIsRUFBRSx1QkFBdUI7Q0FDL0MsQ0FBQSIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFdvcmtlciB9IGZyb20gJ3dvcmtlcl90aHJlYWRzJztcbmltcG9ydCAqIGFzIGh0dHBzIGZyb20gJ2h0dHBzJztcbmltcG9ydCBmcyBmcm9tICdmcy1leHRyYSc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0IEFzeW5jTG9jayBmcm9tICdhc3luYy1sb2NrJztcbmltcG9ydCAqIGFzIGdpdCBmcm9tICdpc29tb3JwaGljLWdpdCc7XG5pbXBvcnQgKiBhcyBsb2cgZnJvbSAnZWxlY3Ryb24tbG9nJztcblxuaW1wb3J0IHsgR2l0U3RhdHVzIH0gZnJvbSAnLi4vLi4vYmFzZSc7XG5pbXBvcnQgeyBHaXRBdXRoZW50aWNhdGlvbiwgV29ya2VyTWVzc2FnZSB9IGZyb20gJy4vdHlwZXMnO1xuXG5cbmNvbnN0IE1BSU5fUkVNT1RFID0gJ29yaWdpbic7XG5cblxuY29uc3QgSU5JVElBTF9TVEFUVVM6IEdpdFN0YXR1cyA9IHtcbiAgaXNPbmxpbmU6IGZhbHNlLFxuICBpc01pc2NvbmZpZ3VyZWQ6IGZhbHNlLFxuICBoYXNMb2NhbENoYW5nZXM6IGZhbHNlLFxuICBuZWVkc1Bhc3N3b3JkOiBmYWxzZSxcbiAgc3RhdHVzUmVsYXRpdmVUb0xvY2FsOiB1bmRlZmluZWQsXG4gIGxhc3RTeW5jaHJvbml6ZWQ6IG51bGwsXG4gIGlzUHVzaGluZzogZmFsc2UsXG4gIGlzUHVsbGluZzogZmFsc2UsXG59IGFzIGNvbnN0O1xuXG5cbmNvbnN0IHdvcmtlckZpbGVQYXRoID0gX19kaXJuYW1lLmVuZHNXaXRoKCdhcHAuYXNhcicpXG4gID8gcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgJy4uJywgJ2lzb2dpdC13b3JrZXIuanMnKVxuICA6IHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsICd3b3JrZXIuanMnKTtcblxuY29uc3Qgd29ya2VyQ29udGVudHMgPSAgZnMucmVhZEZpbGVTeW5jKHdvcmtlckZpbGVQYXRoLCB7IGVuY29kaW5nOiAndXRmOCcgfSk7XG5cblxuZXhwb3J0IGNsYXNzIElzb0dpdFdyYXBwZXIge1xuXG4gIHByaXZhdGUgYXV0aDogR2l0QXV0aGVudGljYXRpb24gPSB7fTtcblxuICBwcml2YXRlIHB1c2hQZW5kaW5nID0gZmFsc2U7XG5cbiAgcHJpdmF0ZSBzdGFnaW5nTG9jazogQXN5bmNMb2NrO1xuXG4gIHByaXZhdGUgc3RhdHVzOiBHaXRTdGF0dXM7XG5cbiAgcHJpdmF0ZSB3b3JrZXI6IFdvcmtlcjtcblxuICBjb25zdHJ1Y3RvcihcbiAgICAgIHByaXZhdGUgZnM6IGFueSxcbiAgICAgIHByaXZhdGUgcmVwb1VybDogc3RyaW5nLFxuICAgICAgcHJpdmF0ZSB1cHN0cmVhbVJlcG9Vcmw6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgIHVzZXJuYW1lOiBzdHJpbmcsXG4gICAgICBwcml2YXRlIGF1dGhvcjogeyBuYW1lOiBzdHJpbmcsIGVtYWlsOiBzdHJpbmcgfSxcbiAgICAgIHB1YmxpYyB3b3JrRGlyOiBzdHJpbmcsXG4gICAgICBwcml2YXRlIGNvcnNQcm94eTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICAgICAgcHJpdmF0ZSBzdGF0dXNSZXBvcnRlcjogKHBheWxvYWQ6IEdpdFN0YXR1cykgPT4gUHJvbWlzZTx2b2lkPikge1xuXG4gICAgdGhpcy5zdGFnaW5nTG9jayA9IG5ldyBBc3luY0xvY2soeyB0aW1lb3V0OiAyMDAwMCwgbWF4UGVuZGluZzogMiB9KTtcblxuICAgIGlmICh0aGlzLmNvcnNQcm94eSkge1xuICAgICAgbG9nLndhcm4oXCJDL2RiL2lzb2dpdDogQ09SUyBwcm94eSBwYXJhbWV0ZXIgaXMgb2Jzb2xldGUgYW5kIHdpbGwgYmUgcmVtb3ZlZC5cIik7XG4gICAgfVxuICAgIGlmICh0aGlzLnVwc3RyZWFtUmVwb1VybCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBsb2cud2FybihcIkMvZGIvaXNvZ2l0OiB0aGUgdXBzdHJlYW1SZXBvVXJsIHBhcmFtZXRlciBpcyBvYnNvbGV0ZSBhbmQgd2lsbCBiZSByZW1vdmVkLlwiKTtcbiAgICB9XG5cbiAgICB0aGlzLndvcmtlciA9IG5ldyBXb3JrZXIod29ya2VyQ29udGVudHMsIHsgZXZhbDogdHJ1ZSB9KTtcblxuICAgIHRoaXMud29ya2VyLm9uKCdleGl0JywgKGNvZGUpID0+IHtcbiAgICAgIGxvZy5lcnJvcihcIkMvZGIvaXNvZ2l0OiBXb3JrZXIgZXhpdGVkIVwiLCBjb2RlKTtcbiAgICB9KTtcblxuICAgIHRoaXMud29ya2VyLm9uKCdlcnJvcicsIChlcnIpID0+IHtcbiAgICAgIGxvZy5lcnJvcihcIkMvZGIvaXNvZ2l0OiBXb3JrZXIgZXJyb3JcIiwgZXJyKTtcbiAgICB9KTtcblxuICAgIC8vIE1ha2VzIGl0IGVhc2llciB0byBiaW5kIHRoZXNlIHRvIElQQyBldmVudHNcbiAgICB0aGlzLnN5bmNocm9uaXplID0gdGhpcy5zeW5jaHJvbml6ZS5iaW5kKHRoaXMpO1xuICAgIHRoaXMucmVzZXRGaWxlcyA9IHRoaXMucmVzZXRGaWxlcy5iaW5kKHRoaXMpO1xuICAgIHRoaXMuY2hlY2tVbmNvbW1pdHRlZCA9IHRoaXMuY2hlY2tVbmNvbW1pdHRlZC5iaW5kKHRoaXMpO1xuXG4gICAgdGhpcy5hdXRoLnVzZXJuYW1lID0gdXNlcm5hbWU7XG5cbiAgICB0aGlzLnN0YXR1cyA9IElOSVRJQUxfU1RBVFVTO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBwb3N0TWVzc2FnZTxUIGV4dGVuZHMgb2JqZWN0PihcbiAgICAgIG1zZzogV29ya2VyTWVzc2FnZSxcbiAgICAgIHJlc29sdmVPblJlc3BvbnNlPzogKHJlc3A6IFQpID0+IGJvb2xlYW4sXG4gICAgICBmYWlsT25SZXNwb25zZT86IChyZXNwOiBUKSA9PiBib29sZWFuKTogUHJvbWlzZTxUIHwgdW5kZWZpbmVkPiB7XG4gICAgdGhpcy53b3JrZXIucG9zdE1lc3NhZ2UobXNnKTtcblxuICAgIGlmICghcmVzb2x2ZU9uUmVzcG9uc2UgJiYgIWZhaWxPblJlc3BvbnNlKSB7XG4gICAgICByZXR1cm47XG5cbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgdGhpcy53b3JrZXIub25jZSgnbWVzc2FnZScsIChtc2c6IFQpID0+IHtcbiAgICAgICAgICBpZiAoZmFpbE9uUmVzcG9uc2UgIT09IHVuZGVmaW5lZCAmJiBmYWlsT25SZXNwb25zZShtc2cpKSB7XG4gICAgICAgICAgICByZWplY3QobXNnKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlc29sdmVPblJlc3BvbnNlICE9PSB1bmRlZmluZWQgJiYgcmVzb2x2ZU9uUmVzcG9uc2UobXNnKSkge1xuICAgICAgICAgICAgcmVzb2x2ZShtc2cpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuXG4gIC8vIFJlcG9ydGluZyBHaXQgc3RhdHVzIHRvIERCIGJhY2tlbmQsXG4gIC8vIHNvIHRoYXQgaXQgY2FuIGJlIHJlZmxlY3RlZCBpbiB0aGUgR1VJXG5cbiAgcHJpdmF0ZSBhc3luYyByZXBvcnRTdGF0dXMoKSB7XG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuc3RhdHVzUmVwb3J0ZXIodGhpcy5zdGF0dXMpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBzZXRTdGF0dXMoc3RhdHVzOiBQYXJ0aWFsPEdpdFN0YXR1cz4pIHtcbiAgICBPYmplY3QuYXNzaWduKHRoaXMuc3RhdHVzLCBzdGF0dXMpO1xuICAgIGF3YWl0IHRoaXMucmVwb3J0U3RhdHVzKCk7XG4gIH1cblxuICBwdWJsaWMgZ2V0U3RhdHVzKCk6IEdpdFN0YXR1cyB7XG4gICAgcmV0dXJuIHRoaXMuc3RhdHVzO1xuICB9XG5cblxuICAvLyBJbml0aWxhaXphdGlvblxuXG4gIHB1YmxpYyBhc3luYyBpc0luaXRpYWxpemVkKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIGxldCBoYXNHaXREaXJlY3Rvcnk6IGJvb2xlYW47XG4gICAgdHJ5IHtcbiAgICAgIGhhc0dpdERpcmVjdG9yeSA9IChhd2FpdCB0aGlzLmZzLnN0YXQocGF0aC5qb2luKHRoaXMud29ya0RpciwgJy5naXQnKSkpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaGFzR2l0RGlyZWN0b3J5ID0gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiBoYXNHaXREaXJlY3Rvcnk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgaXNVc2luZ1JlbW90ZVVSTHMocmVtb3RlVXJsczogeyBvcmlnaW46IHN0cmluZyB9KTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgY29uc3Qgb3JpZ2luID0gKGF3YWl0IHRoaXMuZ2V0T3JpZ2luVXJsKCkgfHwgJycpLnRyaW0oKTtcbiAgICByZXR1cm4gb3JpZ2luID09PSByZW1vdGVVcmxzLm9yaWdpbjtcbiAgfVxuXG4gIHB1YmxpYyBuZWVkc1Bhc3N3b3JkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiAodGhpcy5hdXRoLnBhc3N3b3JkIHx8ICcnKS50cmltKCkgPT09ICcnO1xuICB9XG5cbiAgcHVibGljIGdldFVzZXJuYW1lKCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMuYXV0aC51c2VybmFtZTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBkZXN0cm95KCkge1xuICAgIC8qIFJlbW92ZXMgd29ya2luZyBkaXJlY3RvcnkuXG4gICAgICAgT24gbmV4dCBzeW5jIEdpdCByZXBvIHdpbGwgaGF2ZSB0byBiZSByZWluaXRpYWxpemVkLCBjbG9uZWQgZXRjLiAqL1xuXG4gICAgbG9nLndhcm4oXCJDL2RiL2lzb2dpdDogSW5pdGlhbGl6ZTogUmVtb3ZpbmcgZGF0YSBkaXJlY3RvcnlcIik7XG4gICAgYXdhaXQgdGhpcy5mcy5yZW1vdmUodGhpcy53b3JrRGlyKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgZm9yY2VJbml0aWFsaXplKCkge1xuICAgIC8qIEluaXRpYWxpemVzIGZyb20gc2NyYXRjaDogd2lwZXMgd29yayBkaXJlY3RvcnksIGNsb25lcyByZXBvc2l0b3J5LCBhZGRzIHJlbW90ZXMuICovXG5cbiAgICByZXR1cm4gYXdhaXQgdGhpcy5zdGFnaW5nTG9jay5hY3F1aXJlKCcxJywgYXN5bmMgKCkgPT4ge1xuICAgICAgbG9nLndhcm4oXCJDL2RiL2lzb2dpdDogSW5pdGlhbGl6aW5nXCIpO1xuXG4gICAgICBsb2cuc2lsbHkoXCJDL2RiL2lzb2dpdDogSW5pdGlhbGl6ZTogRW5zdXJpbmcgZGF0YSBkaXJlY3RvcnkgZXhpc3RzXCIpO1xuICAgICAgYXdhaXQgdGhpcy5mcy5lbnN1cmVEaXIodGhpcy53b3JrRGlyKTtcblxuICAgICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogSW5pdGlhbGl6ZTogQ2xvbmluZ1wiLCB0aGlzLnJlcG9VcmwpO1xuXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLnBvc3RNZXNzYWdlPHsgY2xvbmVkOiBib29sZWFuLCBlcnJvcj86IGFueSB9Pih7XG4gICAgICAgICAgYWN0aW9uOiAnY2xvbmUnLFxuICAgICAgICAgIHdvcmtEaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgICByZXBvVVJMOiB0aGlzLnJlcG9VcmwsXG4gICAgICAgICAgYXV0aDogdGhpcy5hdXRoLFxuICAgICAgICB9LCAoKG1zZykgPT4gbXNnLmNsb25lZCAhPT0gdW5kZWZpbmVkKSwgKChtc2cpID0+IG1zZy5lcnJvciAhPT0gdW5kZWZpbmVkKSk7XG5cbiAgICAgICAgaWYgKHJlc3VsdD8uY2xvbmVkICE9PSB0cnVlKSB7XG4gICAgICAgICAgbG9nLmVycm9yKFwiQy9kYi9pc29naXQ6IEZhaWxlZCB0byBjbG9uZVwiLCByZXN1bHQ/LmVycm9yKTtcbiAgICAgICAgICBpZiAocmVzdWx0Py5lcnJvcikge1xuICAgICAgICAgICAgdGhyb3cgbmV3IHJlc3VsdC5lcnJvcjtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiRmFpbGVkIHRvIGNsb25lXCIpXG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgbG9nLmVycm9yKFwiQy9kYi9pc29naXQ6IEVycm9yIGR1cmluZyBpbml0aWFsaXphdGlvblwiKVxuICAgICAgICBhd2FpdCB0aGlzLmZzLnJlbW92ZSh0aGlzLndvcmtEaXIpO1xuICAgICAgICBhd2FpdCB0aGlzLl9oYW5kbGVHaXRFcnJvcihlKTtcbiAgICAgICAgdGhyb3cgZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG5cbiAgLy8gQXV0aGVudGljYXRpb25cblxuICBwdWJsaWMgc2V0UGFzc3dvcmQodmFsdWU6IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICAgIHRoaXMuYXV0aC5wYXNzd29yZCA9IHZhbHVlO1xuICAgIHRoaXMuc2V0U3RhdHVzKHsgbmVlZHNQYXNzd29yZDogZmFsc2UgfSk7XG4gIH1cblxuXG4gIC8vIEdpdCBvcGVyYXRpb25zXG5cbiAgYXN5bmMgY29uZmlnU2V0KHByb3A6IHN0cmluZywgdmFsOiBzdHJpbmcpIHtcbiAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBTZXQgY29uZmlnXCIpO1xuICAgIGF3YWl0IGdpdC5zZXRDb25maWcoeyBmczogdGhpcy5mcywgZGlyOiB0aGlzLndvcmtEaXIsIHBhdGg6IHByb3AsIHZhbHVlOiB2YWwgfSk7XG4gIH1cblxuICBhc3luYyBjb25maWdHZXQocHJvcDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBHZXQgY29uZmlnXCIsIHByb3ApO1xuICAgIHJldHVybiBhd2FpdCBnaXQuZ2V0Q29uZmlnKHsgZnM6IHRoaXMuZnMsIGRpcjogdGhpcy53b3JrRGlyLCBwYXRoOiBwcm9wIH0pO1xuICB9XG5cbiAgYXN5bmMgcmVhZEZpbGVCbG9iQXRDb21taXQocmVsYXRpdmVGaWxlUGF0aDogc3RyaW5nLCBjb21taXRIYXNoOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIC8qIFJlYWRzIGZpbGUgY29udGVudHMgYXQgZ2l2ZW4gcGF0aCBhcyBvZiBnaXZlbiBjb21taXQuIEZpbGUgY29udGVudHMgbXVzdCB1c2UgVVRGLTggZW5jb2RpbmcuICovXG5cbiAgICByZXR1cm4gKGF3YWl0IGdpdC5yZWFkQmxvYih7XG4gICAgICBmczogdGhpcy5mcyxcbiAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgb2lkOiBjb21taXRIYXNoLFxuICAgICAgZmlsZXBhdGg6IHJlbGF0aXZlRmlsZVBhdGgsXG4gICAgfSkpLmJsb2IudG9TdHJpbmcoKTtcbiAgfVxuXG4gIGFzeW5jIHB1bGwoKSB7XG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogUHVsbGluZyBtYXN0ZXIgd2l0aCBmYXN0LWZvcndhcmQgbWVyZ2VcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLnBvc3RNZXNzYWdlPHsgcHVsbGVkOiB0cnVlLCBlcnJvcj86IGFueSB9Pih7XG4gICAgICBhY3Rpb246ICdwdWxsJyxcbiAgICAgIHdvcmtEaXI6IHRoaXMud29ya0RpcixcbiAgICAgIHJlcG9VUkw6IHRoaXMucmVwb1VybCxcbiAgICAgIGF1dGg6IHRoaXMuYXV0aCxcbiAgICAgIGF1dGhvcjogdGhpcy5hdXRob3IsXG4gICAgfSwgKChtc2cpID0+IG1zZy5wdWxsZWQgIT09IHVuZGVmaW5lZCksICgobXNnKSA9PiBtc2cuZXJyb3IgIT09IHVuZGVmaW5lZCkpO1xuXG4gICAgaWYgKHJlc3VsdD8ucHVsbGVkICE9PSB0cnVlKSB7XG4gICAgICBsb2cuZXJyb3IoXCJDL2RiL2lzb2dpdDogRmFpbGVkIHRvIHB1bGxcIiwgcmVzdWx0Py5lcnJvcik7XG4gICAgICBpZiAocmVzdWx0Py5lcnJvcikge1xuICAgICAgICB0aHJvdyByZXN1bHQ/LmVycm9yO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiRmFpbGVkIHRvIHB1bGxcIik7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgc3RhZ2UocGF0aFNwZWNzOiBzdHJpbmdbXSwgcmVtb3ZpbmcgPSBmYWxzZSkge1xuICAgIGxvZy52ZXJib3NlKGBDL2RiL2lzb2dpdDogU3RhZ2luZyBjaGFuZ2VzOiAke3BhdGhTcGVjcy5qb2luKCcsICcpfSB1c2luZyAke3JlbW92aW5nID8gXCJyZW1vdmUoKVwiIDogXCJhZGQoKVwifWApO1xuXG4gICAgZm9yIChjb25zdCBwYXRoU3BlYyBvZiBwYXRoU3BlY3MpIHtcbiAgICAgIGlmIChyZW1vdmluZyAhPT0gdHJ1ZSkge1xuICAgICAgICBhd2FpdCBnaXQuYWRkKHtcbiAgICAgICAgICBmczogdGhpcy5mcyxcbiAgICAgICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgICBmaWxlcGF0aDogcGF0aFNwZWMsXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYXdhaXQgZ2l0LnJlbW92ZSh7XG4gICAgICAgICAgZnM6IHRoaXMuZnMsXG4gICAgICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICAgICAgZmlsZXBhdGg6IHBhdGhTcGVjLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBhc3luYyBjb21taXQobXNnOiBzdHJpbmcpIHtcbiAgICBsb2cudmVyYm9zZShgQy9kYi9pc29naXQ6IENvbW1pdHRpbmcgd2l0aCBtZXNzYWdlICR7bXNnfWApO1xuXG4gICAgcmV0dXJuIGF3YWl0IGdpdC5jb21taXQoe1xuICAgICAgZnM6IHRoaXMuZnMsXG4gICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgIG1lc3NhZ2U6IG1zZyxcbiAgICAgIGF1dGhvcjogdGhpcy5hdXRob3IsXG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBwdXNoKCkge1xuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IFB1c2hpbmdcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLnBvc3RNZXNzYWdlPHsgcHVzaGVkOiB0cnVlLCBlcnJvcj86IGFueSB9Pih7XG4gICAgICBhY3Rpb246ICdwdXNoJyxcbiAgICAgIHdvcmtEaXI6IHRoaXMud29ya0RpcixcbiAgICAgIHJlcG9VUkw6IHRoaXMucmVwb1VybCxcbiAgICAgIGF1dGg6IHRoaXMuYXV0aCxcbiAgICB9LCAoKG1zZykgPT4gbXNnLnB1c2hlZCAhPT0gdW5kZWZpbmVkKSwgKChtc2cpID0+IG1zZy5lcnJvciAhPT0gdW5kZWZpbmVkKSk7XG5cbiAgICBpZiAocmVzdWx0Py5wdXNoZWQgIT09IHRydWUpIHtcbiAgICAgIGxvZy5lcnJvcihcIkMvZGIvaXNvZ2l0OiBGYWlsZWQgdG8gcHVzaFwiLCByZXN1bHQ/LmVycm9yKTtcbiAgICAgIGlmIChyZXN1bHQ/LmVycm9yKSB7XG4gICAgICAgIHRocm93IHJlc3VsdD8uZXJyb3I7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJGYWlsZWQgdG8gcHVzaFwiKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgcmVzZXRGaWxlcyhwYXRocz86IHN0cmluZ1tdKSB7XG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuc3RhZ2luZ0xvY2suYWNxdWlyZSgnMScsIGFzeW5jICgpID0+IHtcbiAgICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IEZvcmNlIHJlc2V0dGluZyBmaWxlc1wiKTtcblxuICAgICAgcmV0dXJuIGF3YWl0IGdpdC5jaGVja291dCh7XG4gICAgICAgIGZzOiB0aGlzLmZzLFxuICAgICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgZm9yY2U6IHRydWUsXG4gICAgICAgIGZpbGVwYXRoczogcGF0aHMgfHwgKGF3YWl0IHRoaXMubGlzdENoYW5nZWRGaWxlcygpKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgZ2V0T3JpZ2luVXJsKCk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICAgIHJldHVybiAoKGF3YWl0IGdpdC5saXN0UmVtb3Rlcyh7XG4gICAgICBmczogdGhpcy5mcyxcbiAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgIH0pKS5maW5kKHIgPT4gci5yZW1vdGUgPT09IE1BSU5fUkVNT1RFKSB8fCB7IHVybDogbnVsbCB9KS51cmw7XG4gIH1cblxuICBhc3luYyBsaXN0TG9jYWxDb21taXRzKCk6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgICAvKiBSZXR1cm5zIGEgbGlzdCBvZiBjb21taXQgbWVzc2FnZXMgZm9yIGNvbW1pdHMgdGhhdCB3ZXJlIG5vdCBwdXNoZWQgeWV0LlxuXG4gICAgICAgVXNlZnVsIHRvIGNoZWNrIHdoaWNoIGNvbW1pdHMgd2lsbCBiZSB0aHJvd24gb3V0XG4gICAgICAgaWYgd2UgZm9yY2UgdXBkYXRlIHRvIHJlbW90ZSBtYXN0ZXIuXG5cbiAgICAgICBEb2VzIHNvIGJ5IHdhbGtpbmcgdGhyb3VnaCBsYXN0IDEwMCBjb21taXRzIHN0YXJ0aW5nIGZyb20gY3VycmVudCBIRUFELlxuICAgICAgIFdoZW4gaXQgZW5jb3VudGVycyB0aGUgZmlyc3QgbG9jYWwgY29tbWl0IHRoYXQgZG9lc27igJl0IGRlc2NlbmRzIGZyb20gcmVtb3RlIG1hc3RlciBIRUFELFxuICAgICAgIGl0IGNvbnNpZGVycyBhbGwgcHJlY2VkaW5nIGNvbW1pdHMgdG8gYmUgYWhlYWQvbG9jYWwgYW5kIHJldHVybnMgdGhlbS5cblxuICAgICAgIElmIGl0IGZpbmlzaGVzIHRoZSB3YWxrIHdpdGhvdXQgZmluZGluZyBhbiBhbmNlc3RvciwgdGhyb3dzIGFuIGVycm9yLlxuICAgICAgIEl0IGlzIGFzc3VtZWQgdGhhdCB0aGUgYXBwIGRvZXMgbm90IGFsbG93IHRvIGFjY3VtdWxhdGVcbiAgICAgICBtb3JlIHRoYW4gMTAwIGNvbW1pdHMgd2l0aG91dCBwdXNoaW5nIChldmVuIDEwMCBpcyB0b28gbWFueSEpLFxuICAgICAgIHNvIHRoZXJl4oCZcyBwcm9iYWJseSBzb21ldGhpbmcgc3RyYW5nZSBnb2luZyBvbi5cblxuICAgICAgIE90aGVyIGFzc3VtcHRpb25zOlxuXG4gICAgICAgKiBnaXQubG9nIHJldHVybnMgY29tbWl0cyBmcm9tIG5ld2VzdCB0byBvbGRlc3QuXG4gICAgICAgKiBUaGUgcmVtb3RlIHdhcyBhbHJlYWR5IGZldGNoZWQuXG5cbiAgICAqL1xuXG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuc3RhZ2luZ0xvY2suYWNxdWlyZSgnMScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGxhdGVzdFJlbW90ZUNvbW1pdCA9IGF3YWl0IGdpdC5yZXNvbHZlUmVmKHtcbiAgICAgICAgZnM6IHRoaXMuZnMsXG4gICAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgICByZWY6IGAke01BSU5fUkVNT1RFfS9tYXN0ZXJgLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IGxvY2FsQ29tbWl0cyA9IGF3YWl0IGdpdC5sb2coe1xuICAgICAgICBmczogdGhpcy5mcyxcbiAgICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICAgIGRlcHRoOiAxMDAsXG4gICAgICB9KTtcblxuICAgICAgdmFyIGNvbW1pdHMgPSBbXSBhcyBzdHJpbmdbXTtcbiAgICAgIGZvciAoY29uc3QgY29tbWl0IG9mIGxvY2FsQ29tbWl0cykge1xuICAgICAgICBpZiAoYXdhaXQgZ2l0LmlzRGVzY2VuZGVudCh7XG4gICAgICAgICAgICBmczogdGhpcy5mcyxcbiAgICAgICAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgICAgICAgb2lkOiBjb21taXQub2lkLFxuICAgICAgICAgICAgYW5jZXN0b3I6IGxhdGVzdFJlbW90ZUNvbW1pdCxcbiAgICAgICAgICB9KSkge1xuICAgICAgICAgIGNvbW1pdHMucHVzaChjb21taXQuY29tbWl0Lm1lc3NhZ2UpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJldHVybiBjb21taXRzO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkRpZCBub3QgZmluZCBhIGxvY2FsIGNvbW1pdCB0aGF0IGlzIGFuIGFuY2VzdG9yIG9mIHJlbW90ZSBtYXN0ZXJcIik7XG4gICAgfSk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgbGlzdENoYW5nZWRGaWxlcyhwYXRoU3BlY3MgPSBbJy4nXSk6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgICAvKiBMaXN0cyByZWxhdGl2ZSBwYXRocyB0byBhbGwgZmlsZXMgdGhhdCB3ZXJlIGNoYW5nZWQgYW5kIGhhdmUgbm90IGJlZW4gY29tbWl0dGVkLiAqL1xuXG4gICAgY29uc3QgRklMRSA9IDAsIEhFQUQgPSAxLCBXT1JLRElSID0gMjtcblxuICAgIHJldHVybiAoYXdhaXQgZ2l0LnN0YXR1c01hdHJpeCh7IGZzOiB0aGlzLmZzLCBkaXI6IHRoaXMud29ya0RpciwgZmlsZXBhdGhzOiBwYXRoU3BlY3MgfSkpXG4gICAgICAuZmlsdGVyKHJvdyA9PiByb3dbSEVBRF0gIT09IHJvd1tXT1JLRElSXSlcbiAgICAgIC5tYXAocm93ID0+IHJvd1tGSUxFXSlcbiAgICAgIC5maWx0ZXIoZmlsZXBhdGggPT4gIWZpbGVwYXRoLnN0YXJ0c1dpdGgoJy4uJykgJiYgZmlsZXBhdGggIT09IFwiLkRTX1N0b3JlXCIpO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIHN0YWdlQW5kQ29tbWl0KHBhdGhTcGVjczogc3RyaW5nW10sIG1zZzogc3RyaW5nLCByZW1vdmluZyA9IGZhbHNlKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgICAvKiBTdGFnZXMgYW5kIGNvbW1pdHMgZmlsZXMgbWF0Y2hpbmcgZ2l2ZW4gcGF0aCBzcGVjIHdpdGggZ2l2ZW4gbWVzc2FnZS5cblxuICAgICAgIEFueSBvdGhlciBmaWxlcyBzdGFnZWQgYXQgdGhlIHRpbWUgb2YgdGhlIGNhbGwgd2lsbCBiZSB1bnN0YWdlZC5cblxuICAgICAgIFJldHVybnMgdGhlIG51bWJlciBvZiBtYXRjaGluZyBmaWxlcyB3aXRoIHVuc3RhZ2VkIGNoYW5nZXMgcHJpb3IgdG8gc3RhZ2luZy5cbiAgICAgICBJZiBubyBtYXRjaGluZyBmaWxlcyB3ZXJlIGZvdW5kIGhhdmluZyB1bnN0YWdlZCBjaGFuZ2VzLFxuICAgICAgIHNraXBzIHRoZSByZXN0IGFuZCByZXR1cm5zIHplcm8uXG5cbiAgICAgICBJZiBmYWlsSWZEaXZlcmdlZCBpcyBnaXZlbiwgYXR0ZW1wdHMgYSBmYXN0LWZvcndhcmQgcHVsbCBhZnRlciB0aGUgY29tbWl0LlxuICAgICAgIEl0IHdpbGwgZmFpbCBpbW1lZGlhdGVseSBpZiBtYWluIHJlbW90ZSBoYWQgb3RoZXIgY29tbWl0cyBhcHBlYXIgaW4gbWVhbnRpbWUuXG5cbiAgICAgICBMb2NrcyBzbyB0aGF0IHRoaXMgbWV0aG9kIGNhbm5vdCBiZSBydW4gY29uY3VycmVudGx5IChieSBzYW1lIGluc3RhbmNlKS5cbiAgICAqL1xuXG4gICAgaWYgKHBhdGhTcGVjcy5sZW5ndGggPCAxKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJXYXNu4oCZdCBnaXZlbiBhbnkgcGF0aHMgdG8gY29tbWl0IVwiKTtcbiAgICB9XG5cbiAgICByZXR1cm4gYXdhaXQgdGhpcy5zdGFnaW5nTG9jay5hY3F1aXJlKCcxJywgYXN5bmMgKCkgPT4ge1xuICAgICAgbG9nLnZlcmJvc2UoYEMvZGIvaXNvZ2l0OiBTdGFnaW5nIGFuZCBjb21taXR0aW5nOiAke3BhdGhTcGVjcy5qb2luKCcsICcpfWApO1xuXG4gICAgICBjb25zdCBmaWxlc0NoYW5nZWQgPSAoYXdhaXQgdGhpcy5saXN0Q2hhbmdlZEZpbGVzKHBhdGhTcGVjcykpLmxlbmd0aDtcbiAgICAgIGlmIChmaWxlc0NoYW5nZWQgPCAxKSB7XG4gICAgICAgIHJldHVybiAwO1xuICAgICAgfVxuXG4gICAgICBhd2FpdCB0aGlzLnVuc3RhZ2VBbGwoKTtcbiAgICAgIGF3YWl0IHRoaXMuc3RhZ2UocGF0aFNwZWNzLCByZW1vdmluZyk7XG4gICAgICBhd2FpdCB0aGlzLmNvbW1pdChtc2cpO1xuXG4gICAgICByZXR1cm4gZmlsZXNDaGFuZ2VkO1xuICAgIH0pO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGNoZWNrVW5jb21taXR0ZWQoKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgLyogQ2hlY2tzIGZvciBhbnkgdW5jb21taXR0ZWQgY2hhbmdlcyBsb2NhbGx5IHByZXNlbnQuXG4gICAgICAgTm90aWZpZXMgYWxsIHdpbmRvd3MgYWJvdXQgdGhlIHN0YXR1cy4gKi9cblxuICAgIGxvZy5kZWJ1ZyhcIkMvZGIvaXNvZ2l0OiBDaGVja2luZyBmb3IgdW5jb21taXR0ZWQgY2hhbmdlc1wiKTtcbiAgICBjb25zdCBjaGFuZ2VkRmlsZXMgPSBhd2FpdCB0aGlzLmxpc3RDaGFuZ2VkRmlsZXMoKTtcbiAgICBsb2cuZGVidWcoXCJDL2RiL2lzb2dpdDogQ2hhbmdlZCBmaWxlczpcIiwgY2hhbmdlZEZpbGVzKTtcbiAgICBjb25zdCBoYXNMb2NhbENoYW5nZXMgPSBjaGFuZ2VkRmlsZXMubGVuZ3RoID4gMDtcbiAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGhhc0xvY2FsQ2hhbmdlcyB9KTtcbiAgICByZXR1cm4gaGFzTG9jYWxDaGFuZ2VzO1xuICB9XG5cbiAgcHVibGljIHJlcXVlc3RQdXNoKCkge1xuICAgIHRoaXMucHVzaFBlbmRpbmcgPSB0cnVlO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIHN5bmNocm9uaXplKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIC8qIENoZWNrcyBmb3IgY29ubmVjdGlvbiwgbG9jYWwgY2hhbmdlcyBhbmQgdW5wdXNoZWQgY29tbWl0cyxcbiAgICAgICB0cmllcyB0byBwdXNoIGFuZCBwdWxsIHdoZW4gdGhlcmXigJlzIG9wcG9ydHVuaXR5LlxuXG4gICAgICAgTm90aWZpZXMgYWxsIHdpbmRvd3MgYWJvdXQgdGhlIHN0YXR1cyBpbiBwcm9jZXNzLiAqL1xuXG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogQ2hlY2tpbmcgaWYgY2xvbmUgZXhpc3RzXCIpO1xuXG4gICAgaWYgKCEoYXdhaXQgdGhpcy5pc0luaXRpYWxpemVkKCkpKSB7XG4gICAgICBhd2FpdCB0aGlzLmZvcmNlSW5pdGlhbGl6ZSgpO1xuXG4gICAgfSBlbHNlIHtcbiAgICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IENoZWNraW5nIGZvciB1bmNvbW1pdHRlZCBjaGFuZ2VzXCIpO1xuXG4gICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7XG4gICAgICAgIC4uLklOSVRJQUxfU1RBVFVTLFxuICAgICAgICBoYXNMb2NhbENoYW5nZXM6IGZhbHNlLFxuICAgICAgICBsYXN0U3luY2hyb25pemVkOiB0aGlzLnN0YXR1cy5sYXN0U3luY2hyb25pemVkLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IGhhc1VuY29tbWl0dGVkQ2hhbmdlcyA9IGF3YWl0IHRoaXMuY2hlY2tVbmNvbW1pdHRlZCgpO1xuXG4gICAgICBpZiAoaGFzVW5jb21taXR0ZWRDaGFuZ2VzKSB7XG4gICAgICAgIC8vIERvIG5vdCBydW4gcHVsbCBpZiB0aGVyZSBhcmUgdW5zdGFnZWQvdW5jb21taXR0ZWQgY2hhbmdlc1xuICAgICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGhhc0xvY2FsQ2hhbmdlczogdHJ1ZSB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gSWYgdW5jb21taXR0ZWQgY2hhbmdlcyB3ZXJlbuKAmXQgZGV0ZWN0ZWQsIHRoZXJlIG1heSBzdGlsbCBiZSBjaGFuZ2VkIGZpbGVzXG4gICAgICAgIC8vIHRoYXQgYXJlIG5vdCBtYW5hZ2VkIGJ5IHRoZSBiYWNrZW5kIChlLmcuLCAuRFNfU3RvcmUpLiBEaXNjYXJkIGFueSBzdHVmZiBsaWtlIHRoYXQuXG4gICAgICAgIGF3YWl0IHRoaXMucmVzZXRGaWxlcyhbJy4nXSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuc3RhZ2luZ0xvY2suaXNCdXN5KCkpIHtcbiAgICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IExvY2sgaXMgYnVzeSwgc2tpcHBpbmcgc3luY1wiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBRdWV1ZWluZyBzeW5jIG5vdywgbG9jayBpcyBub3QgYnVzeVwiKTtcblxuICAgIHJldHVybiBhd2FpdCB0aGlzLnN0YWdpbmdMb2NrLmFjcXVpcmUoJzEnLCBhc3luYyAoKSA9PiB7XG4gICAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBTdGFydGluZyBzeW5jXCIpO1xuXG4gICAgICBjb25zdCBpc09ubGluZSA9IChhd2FpdCBjaGVja09ubGluZVN0YXR1cygpKSA9PT0gdHJ1ZTtcblxuICAgICAgaWYgKGlzT25saW5lKSB7XG4gICAgICAgIGNvbnN0IG5lZWRzUGFzc3dvcmQgPSB0aGlzLm5lZWRzUGFzc3dvcmQoKTtcbiAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBuZWVkc1Bhc3N3b3JkIH0pO1xuICAgICAgICBpZiAobmVlZHNQYXNzd29yZCkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaXNPbmxpbmU6IHRydWUgfSk7XG5cbiAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBpc1B1bGxpbmc6IHRydWUgfSk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgdGhpcy5wdWxsKCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBsb2cuZXJyb3IoZSk7XG4gICAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoe1xuICAgICAgICAgICAgaXNQdWxsaW5nOiBmYWxzZSxcbiAgICAgICAgICAgIGlzUHVzaGluZzogZmFsc2UsXG4gICAgICAgICAgICBsYXN0U3luY2hyb25pemVkOiBuZXcgRGF0ZSgpLFxuICAgICAgICAgICAgaXNPbmxpbmU6IGZhbHNlLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGF3YWl0IHRoaXMuX2hhbmRsZUdpdEVycm9yKGUpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICAvL2F3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaXNQdWxsaW5nOiBmYWxzZSB9KTtcblxuICAgICAgICBpZiAodGhpcy5wdXNoUGVuZGluZykge1xuICAgICAgICAgIC8vIFJ1biBwdXNoIEFGVEVSIHB1bGwuIE1heSByZXN1bHQgaW4gZmFsc2UtcG9zaXRpdmUgbm9uLWZhc3QtZm9yd2FyZCByZWplY3Rpb25cbiAgICAgICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzUHVzaGluZzogdHJ1ZSB9KTtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wdXNoKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgbG9nLmVycm9yKGUpO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoe1xuICAgICAgICAgICAgICBpc1B1bGxpbmc6IGZhbHNlLFxuICAgICAgICAgICAgICBpc1B1c2hpbmc6IGZhbHNlLFxuICAgICAgICAgICAgICBsYXN0U3luY2hyb25pemVkOiBuZXcgRGF0ZSgpLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9oYW5kbGVHaXRFcnJvcihlKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhpcy5wdXNoUGVuZGluZyA9IGZhbHNlO1xuICAgICAgICAgIC8vYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBpc1B1c2hpbmc6IGZhbHNlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoe1xuICAgICAgICAgIHN0YXR1c1JlbGF0aXZlVG9Mb2NhbDogJ3VwZGF0ZWQnLFxuICAgICAgICAgIGlzT25saW5lOiB0cnVlLFxuICAgICAgICAgIGlzTWlzY29uZmlndXJlZDogZmFsc2UsXG4gICAgICAgICAgbGFzdFN5bmNocm9uaXplZDogbmV3IERhdGUoKSxcbiAgICAgICAgICBuZWVkc1Bhc3N3b3JkOiBmYWxzZSxcbiAgICAgICAgICBpc1B1c2hpbmc6IGZhbHNlLFxuICAgICAgICAgIGlzUHVsbGluZzogZmFsc2UsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyB1bnN0YWdlQWxsKCkge1xuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IFVuc3RhZ2luZyBhbGwgY2hhbmdlc1wiKTtcbiAgICBhd2FpdCBnaXQucmVtb3ZlKHsgZnM6IHRoaXMuZnMsIGRpcjogdGhpcy53b3JrRGlyLCBmaWxlcGF0aDogJy4nIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBfaGFuZGxlR2l0RXJyb3IoZTogRXJyb3IgJiB7IGNvZGU6IHN0cmluZyB9KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgbG9nLmRlYnVnKFwiSGFuZGxpbmcgR2l0IGVycm9yXCIsIGUuY29kZSwgZSk7XG5cbiAgICBpZiAoZS5jb2RlID09PSAnRmFzdEZvcndhcmRGYWlsJyB8fCBlLmNvZGUgPT09ICdNZXJnZU5vdFN1cHBvcnRlZEZhaWwnKSB7XG4gICAgICAvLyBOT1RFOiBUaGVyZeKAmXMgYWxzbyBQdXNoUmVqZWN0ZWROb25GYXN0Rm9yd2FyZCwgYnV0IGl0IHNlZW1zIHRvIGJlIHRocm93blxuICAgICAgLy8gZm9yIHVucmVsYXRlZCBjYXNlcyBkdXJpbmcgcHVzaCAoZmFsc2UgcG9zaXRpdmUpLlxuICAgICAgLy8gQmVjYXVzZSBvZiB0aGF0IGZhbHNlIHBvc2l0aXZlLCB3ZSBpZ25vcmUgdGhhdCBlcnJvciBhbmQgaW5zdGVhZCBkbyBwdWxsIGZpcnN0LFxuICAgICAgLy8gY2F0Y2hpbmcgYWN0dWFsIGZhc3QtZm9yd2FyZCBmYWlscyBvbiB0aGF0IHN0ZXAgYmVmb3JlIHB1c2guXG4gICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IHN0YXR1c1JlbGF0aXZlVG9Mb2NhbDogJ2RpdmVyZ2VkJyB9KTtcbiAgICB9IGVsc2UgaWYgKFsnTWlzc2luZ1VzZXJuYW1lRXJyb3InLCAnTWlzc2luZ0F1dGhvckVycm9yJywgJ01pc3NpbmdDb21taXR0ZXJFcnJvciddLmluZGV4T2YoZS5jb2RlKSA+PSAwKSB7XG4gICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzTWlzY29uZmlndXJlZDogdHJ1ZSB9KTtcbiAgICB9IGVsc2UgaWYgKGUuY29kZSA9PT0gJ0VIT1NURE9XTicpIHtcbiAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaXNPbmxpbmU6IGZhbHNlIH0pO1xuICAgICAgbG9nLndhcm4oXCJQb3NzaWJsZSBjb25uZWN0aW9uIGlzc3Vlc1wiKTtcbiAgICB9IGVsc2UgaWYgKFxuICAgICAgICBlLmNvZGUgPT09ICdNaXNzaW5nUGFzc3dvcmRUb2tlbkVycm9yJ1xuICAgICAgICB8fCAoZS5jb2RlID09PSAnSFRUUEVycm9yJyAmJiBlLm1lc3NhZ2UuaW5kZXhPZignVW5hdXRob3JpemVkJykgPj0gMCkpIHtcbiAgICAgIGxvZy53YXJuKFwiUGFzc3dvcmQgaW5wdXQgcmVxdWlyZWRcIik7XG4gICAgICB0aGlzLnNldFBhc3N3b3JkKHVuZGVmaW5lZCk7XG4gICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IG5lZWRzUGFzc3dvcmQ6IHRydWUgfSk7XG4gICAgfVxuICB9XG59XG5cblxuYXN5bmMgZnVuY3Rpb24gY2hlY2tPbmxpbmVTdGF0dXModGltZW91dCA9IDQ1MDApOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgLy8gVE9ETzogTW92ZSB0byBnZW5lcmFsIHV0aWxpdHkgZnVuY3Rpb25zXG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgIGxvZy5kZWJ1ZyhcIkMvZGIvaXNvZ2l0OiBDb25uZWN0aW9uIHRlc3Q6IFN0YXJ0aW5nXCIpO1xuXG4gICAgY29uc3QgcmVxID0gaHR0cHMuZ2V0KCdodHRwczovL2dpdGh1Yi5jb20vJywgeyB0aW1lb3V0IH0sIHJlcG9ydE9ubGluZSk7XG5cbiAgICByZXEub24oJ2Vycm9yJywgKCkgPT4gcmVxLmFib3J0KCkpO1xuICAgIHJlcS5vbigncmVzcG9uc2UnLCByZXBvcnRPbmxpbmUpO1xuICAgIHJlcS5vbignY29ubmVjdCcsIHJlcG9ydE9ubGluZSk7XG4gICAgcmVxLm9uKCdjb250aW51ZScsIHJlcG9ydE9ubGluZSk7XG4gICAgcmVxLm9uKCd1cGdyYWRlJywgcmVwb3J0T25saW5lKTtcbiAgICByZXEub24oJ3RpbWVvdXQnLCByZXBvcnRPZmZsaW5lKTtcblxuICAgIHJlcS5lbmQoKTtcblxuICAgIGNvbnN0IGNoZWNrVGltZW91dCA9IHNldFRpbWVvdXQocmVwb3J0T2ZmbGluZSwgdGltZW91dCk7XG5cbiAgICBmdW5jdGlvbiByZXBvcnRPZmZsaW5lKCkge1xuICAgICAgbG9nLndhcm4oXCJDL2RiL2lzb2dpdDogQ29ubmVjdGlvbiB0ZXN0OiBSZXBvcnQgb2ZmbGluZVwiKTtcbiAgICAgIHRyeSB7IHJlcS5hYm9ydCgpOyB9IGNhdGNoIChlKSB7fVxuICAgICAgY2xlYXJUaW1lb3V0KGNoZWNrVGltZW91dCk7XG4gICAgICByZXNvbHZlKGZhbHNlKTtcbiAgICB9XG4gICAgZnVuY3Rpb24gcmVwb3J0T25saW5lKCkge1xuICAgICAgbG9nLmluZm8oXCJDL2RiL2lzb2dpdDogQ29ubmVjdGlvbiB0ZXN0OiBSZXBvcnQgb25saW5lXCIpO1xuICAgICAgdHJ5IHsgcmVxLmFib3J0KCk7IH0gY2F0Y2ggKGUpIHt9XG4gICAgICBjbGVhclRpbWVvdXQoY2hlY2tUaW1lb3V0KTtcbiAgICAgIHJlc29sdmUodHJ1ZSk7XG4gICAgfVxuICB9KTtcbn1cblxuXG4vLyBUT0RPOiBUZW1wb3Jhcnkgd29ya2Fyb3VuZCBzaW5jZSBpc29tb3JwaGljLWdpdCBkb2VzbuKAmXQgc2VlbSB0byBleHBvcnQgaXRzIEdpdEVycm9yIGNsYXNzXG4vLyBpbiBhbnkgd2F5IGF2YWlsYWJsZSB0byBUUywgc28gd2UgY2Fu4oCZdCB1c2UgaW5zdGFuY2VvZiA6KFxuXG5leHBvcnQgZnVuY3Rpb24gaXNHaXRFcnJvcihlOiBFcnJvciAmIHsgY29kZTogc3RyaW5nIH0pIHtcbiAgaWYgKCFlLmNvZGUpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIE9iamVjdC5rZXlzKElzb21vcnBoaWNHaXRFcnJvckNvZGVzKS5pbmRleE9mKGUuY29kZSkgPj0gMDtcbn1cblxuY29uc3QgSXNvbW9ycGhpY0dpdEVycm9yQ29kZXMgPSB7XG4gIEZpbGVSZWFkRXJyb3I6IGBGaWxlUmVhZEVycm9yYCxcbiAgTWlzc2luZ1JlcXVpcmVkUGFyYW1ldGVyRXJyb3I6IGBNaXNzaW5nUmVxdWlyZWRQYXJhbWV0ZXJFcnJvcmAsXG4gIEludmFsaWRSZWZOYW1lRXJyb3I6IGBJbnZhbGlkUmVmTmFtZUVycm9yYCxcbiAgSW52YWxpZFBhcmFtZXRlckNvbWJpbmF0aW9uRXJyb3I6IGBJbnZhbGlkUGFyYW1ldGVyQ29tYmluYXRpb25FcnJvcmAsXG4gIFJlZkV4aXN0c0Vycm9yOiBgUmVmRXhpc3RzRXJyb3JgLFxuICBSZWZOb3RFeGlzdHNFcnJvcjogYFJlZk5vdEV4aXN0c0Vycm9yYCxcbiAgQnJhbmNoRGVsZXRlRXJyb3I6IGBCcmFuY2hEZWxldGVFcnJvcmAsXG4gIE5vSGVhZENvbW1pdEVycm9yOiBgTm9IZWFkQ29tbWl0RXJyb3JgLFxuICBDb21taXROb3RGZXRjaGVkRXJyb3I6IGBDb21taXROb3RGZXRjaGVkRXJyb3JgLFxuICBPYmplY3RUeXBlVW5rbm93bkZhaWw6IGBPYmplY3RUeXBlVW5rbm93bkZhaWxgLFxuICBPYmplY3RUeXBlQXNzZXJ0aW9uRmFpbDogYE9iamVjdFR5cGVBc3NlcnRpb25GYWlsYCxcbiAgT2JqZWN0VHlwZUFzc2VydGlvbkluVHJlZUZhaWw6IGBPYmplY3RUeXBlQXNzZXJ0aW9uSW5UcmVlRmFpbGAsXG4gIE9iamVjdFR5cGVBc3NlcnRpb25JblJlZkZhaWw6IGBPYmplY3RUeXBlQXNzZXJ0aW9uSW5SZWZGYWlsYCxcbiAgT2JqZWN0VHlwZUFzc2VydGlvbkluUGF0aEZhaWw6IGBPYmplY3RUeXBlQXNzZXJ0aW9uSW5QYXRoRmFpbGAsXG4gIE1pc3NpbmdBdXRob3JFcnJvcjogYE1pc3NpbmdBdXRob3JFcnJvcmAsXG4gIE1pc3NpbmdDb21taXR0ZXJFcnJvcjogYE1pc3NpbmdDb21taXR0ZXJFcnJvcmAsXG4gIE1pc3NpbmdUYWdnZXJFcnJvcjogYE1pc3NpbmdUYWdnZXJFcnJvcmAsXG4gIEdpdFJvb3ROb3RGb3VuZEVycm9yOiBgR2l0Um9vdE5vdEZvdW5kRXJyb3JgLFxuICBVbnBhcnNlYWJsZVNlcnZlclJlc3BvbnNlRmFpbDogYFVucGFyc2VhYmxlU2VydmVyUmVzcG9uc2VGYWlsYCxcbiAgSW52YWxpZERlcHRoUGFyYW1ldGVyRXJyb3I6IGBJbnZhbGlkRGVwdGhQYXJhbWV0ZXJFcnJvcmAsXG4gIFJlbW90ZURvZXNOb3RTdXBwb3J0U2hhbGxvd0ZhaWw6IGBSZW1vdGVEb2VzTm90U3VwcG9ydFNoYWxsb3dGYWlsYCxcbiAgUmVtb3RlRG9lc05vdFN1cHBvcnREZWVwZW5TaW5jZUZhaWw6IGBSZW1vdGVEb2VzTm90U3VwcG9ydERlZXBlblNpbmNlRmFpbGAsXG4gIFJlbW90ZURvZXNOb3RTdXBwb3J0RGVlcGVuTm90RmFpbDogYFJlbW90ZURvZXNOb3RTdXBwb3J0RGVlcGVuTm90RmFpbGAsXG4gIFJlbW90ZURvZXNOb3RTdXBwb3J0RGVlcGVuUmVsYXRpdmVGYWlsOiBgUmVtb3RlRG9lc05vdFN1cHBvcnREZWVwZW5SZWxhdGl2ZUZhaWxgLFxuICBSZW1vdGVEb2VzTm90U3VwcG9ydFNtYXJ0SFRUUDogYFJlbW90ZURvZXNOb3RTdXBwb3J0U21hcnRIVFRQYCxcbiAgQ29ycnVwdFNoYWxsb3dPaWRGYWlsOiBgQ29ycnVwdFNoYWxsb3dPaWRGYWlsYCxcbiAgRmFzdEZvcndhcmRGYWlsOiBgRmFzdEZvcndhcmRGYWlsYCxcbiAgTWVyZ2VOb3RTdXBwb3J0ZWRGYWlsOiBgTWVyZ2VOb3RTdXBwb3J0ZWRGYWlsYCxcbiAgRGlyZWN0b3J5U2VwYXJhdG9yc0Vycm9yOiBgRGlyZWN0b3J5U2VwYXJhdG9yc0Vycm9yYCxcbiAgUmVzb2x2ZVRyZWVFcnJvcjogYFJlc29sdmVUcmVlRXJyb3JgLFxuICBSZXNvbHZlQ29tbWl0RXJyb3I6IGBSZXNvbHZlQ29tbWl0RXJyb3JgLFxuICBEaXJlY3RvcnlJc0FGaWxlRXJyb3I6IGBEaXJlY3RvcnlJc0FGaWxlRXJyb3JgLFxuICBUcmVlT3JCbG9iTm90Rm91bmRFcnJvcjogYFRyZWVPckJsb2JOb3RGb3VuZEVycm9yYCxcbiAgTm90SW1wbGVtZW50ZWRGYWlsOiBgTm90SW1wbGVtZW50ZWRGYWlsYCxcbiAgUmVhZE9iamVjdEZhaWw6IGBSZWFkT2JqZWN0RmFpbGAsXG4gIE5vdEFuT2lkRmFpbDogYE5vdEFuT2lkRmFpbGAsXG4gIE5vUmVmc3BlY0NvbmZpZ3VyZWRFcnJvcjogYE5vUmVmc3BlY0NvbmZpZ3VyZWRFcnJvcmAsXG4gIE1pc21hdGNoUmVmVmFsdWVFcnJvcjogYE1pc21hdGNoUmVmVmFsdWVFcnJvcmAsXG4gIFJlc29sdmVSZWZFcnJvcjogYFJlc29sdmVSZWZFcnJvcmAsXG4gIEV4cGFuZFJlZkVycm9yOiBgRXhwYW5kUmVmRXJyb3JgLFxuICBFbXB0eVNlcnZlclJlc3BvbnNlRmFpbDogYEVtcHR5U2VydmVyUmVzcG9uc2VGYWlsYCxcbiAgQXNzZXJ0U2VydmVyUmVzcG9uc2VGYWlsOiBgQXNzZXJ0U2VydmVyUmVzcG9uc2VGYWlsYCxcbiAgSFRUUEVycm9yOiBgSFRUUEVycm9yYCxcbiAgUmVtb3RlVXJsUGFyc2VFcnJvcjogYFJlbW90ZVVybFBhcnNlRXJyb3JgLFxuICBVbmtub3duVHJhbnNwb3J0RXJyb3I6IGBVbmtub3duVHJhbnNwb3J0RXJyb3JgLFxuICBBY3F1aXJlTG9ja0ZpbGVGYWlsOiBgQWNxdWlyZUxvY2tGaWxlRmFpbGAsXG4gIERvdWJsZVJlbGVhc2VMb2NrRmlsZUZhaWw6IGBEb3VibGVSZWxlYXNlTG9ja0ZpbGVGYWlsYCxcbiAgSW50ZXJuYWxGYWlsOiBgSW50ZXJuYWxGYWlsYCxcbiAgVW5rbm93bk9hdXRoMkZvcm1hdDogYFVua25vd25PYXV0aDJGb3JtYXRgLFxuICBNaXNzaW5nUGFzc3dvcmRUb2tlbkVycm9yOiBgTWlzc2luZ1Bhc3N3b3JkVG9rZW5FcnJvcmAsXG4gIE1pc3NpbmdVc2VybmFtZUVycm9yOiBgTWlzc2luZ1VzZXJuYW1lRXJyb3JgLFxuICBNaXhQYXNzd29yZFRva2VuRXJyb3I6IGBNaXhQYXNzd29yZFRva2VuRXJyb3JgLFxuICBNaXhVc2VybmFtZVBhc3N3b3JkVG9rZW5FcnJvcjogYE1peFVzZXJuYW1lUGFzc3dvcmRUb2tlbkVycm9yYCxcbiAgTWlzc2luZ1Rva2VuRXJyb3I6IGBNaXNzaW5nVG9rZW5FcnJvcmAsXG4gIE1peFVzZXJuYW1lT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3I6IGBNaXhVc2VybmFtZU9hdXRoMmZvcm1hdE1pc3NpbmdUb2tlbkVycm9yYCxcbiAgTWl4UGFzc3dvcmRPYXV0aDJmb3JtYXRNaXNzaW5nVG9rZW5FcnJvcjogYE1peFBhc3N3b3JkT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3JgLFxuICBNaXhVc2VybmFtZVBhc3N3b3JkT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3I6IGBNaXhVc2VybmFtZVBhc3N3b3JkT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3JgLFxuICBNaXhVc2VybmFtZU9hdXRoMmZvcm1hdFRva2VuRXJyb3I6IGBNaXhVc2VybmFtZU9hdXRoMmZvcm1hdFRva2VuRXJyb3JgLFxuICBNaXhQYXNzd29yZE9hdXRoMmZvcm1hdFRva2VuRXJyb3I6IGBNaXhQYXNzd29yZE9hdXRoMmZvcm1hdFRva2VuRXJyb3JgLFxuICBNaXhVc2VybmFtZVBhc3N3b3JkT2F1dGgyZm9ybWF0VG9rZW5FcnJvcjogYE1peFVzZXJuYW1lUGFzc3dvcmRPYXV0aDJmb3JtYXRUb2tlbkVycm9yYCxcbiAgTWF4U2VhcmNoRGVwdGhFeGNlZWRlZDogYE1heFNlYXJjaERlcHRoRXhjZWVkZWRgLFxuICBQdXNoUmVqZWN0ZWROb25GYXN0Rm9yd2FyZDogYFB1c2hSZWplY3RlZE5vbkZhc3RGb3J3YXJkYCxcbiAgUHVzaFJlamVjdGVkVGFnRXhpc3RzOiBgUHVzaFJlamVjdGVkVGFnRXhpc3RzYCxcbiAgQWRkaW5nUmVtb3RlV291bGRPdmVyd3JpdGU6IGBBZGRpbmdSZW1vdGVXb3VsZE92ZXJ3cml0ZWAsXG4gIFBsdWdpblVuZGVmaW5lZDogYFBsdWdpblVuZGVmaW5lZGAsXG4gIENvcmVOb3RGb3VuZDogYENvcmVOb3RGb3VuZGAsXG4gIFBsdWdpblNjaGVtYVZpb2xhdGlvbjogYFBsdWdpblNjaGVtYVZpb2xhdGlvbmAsXG4gIFBsdWdpblVucmVjb2duaXplZDogYFBsdWdpblVucmVjb2duaXplZGAsXG4gIEFtYmlndW91c1Nob3J0T2lkOiBgQW1iaWd1b3VzU2hvcnRPaWRgLFxuICBTaG9ydE9pZE5vdEZvdW5kOiBgU2hvcnRPaWROb3RGb3VuZGAsXG4gIENoZWNrb3V0Q29uZmxpY3RFcnJvcjogYENoZWNrb3V0Q29uZmxpY3RFcnJvcmBcbn1cblxuIl19