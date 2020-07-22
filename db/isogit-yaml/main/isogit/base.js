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
const workerContents = fs.readFileSync(path.resolve(__dirname, 'worker.js'), { encoding: 'utf8' });
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFzZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9kYi9pc29naXQteWFtbC9tYWluL2lzb2dpdC9iYXNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxNQUFNLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUN4QyxPQUFPLEtBQUssS0FBSyxNQUFNLE9BQU8sQ0FBQztBQUMvQixPQUFPLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFDMUIsT0FBTyxLQUFLLElBQUksTUFBTSxNQUFNLENBQUM7QUFDN0IsT0FBTyxTQUFTLE1BQU0sWUFBWSxDQUFDO0FBQ25DLE9BQU8sS0FBSyxHQUFHLE1BQU0sZ0JBQWdCLENBQUM7QUFDdEMsT0FBTyxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUM7QUFNcEMsTUFBTSxXQUFXLEdBQUcsUUFBUSxDQUFDO0FBRzdCLE1BQU0sY0FBYyxHQUFjO0lBQ2hDLFFBQVEsRUFBRSxLQUFLO0lBQ2YsZUFBZSxFQUFFLEtBQUs7SUFDdEIsZUFBZSxFQUFFLEtBQUs7SUFDdEIsYUFBYSxFQUFFLEtBQUs7SUFDcEIscUJBQXFCLEVBQUUsU0FBUztJQUNoQyxnQkFBZ0IsRUFBRSxJQUFJO0lBQ3RCLFNBQVMsRUFBRSxLQUFLO0lBQ2hCLFNBQVMsRUFBRSxLQUFLO0NBQ1IsQ0FBQztBQUdYLE1BQU0sY0FBYyxHQUFJLEVBQUUsQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEVBQUUsV0FBVyxDQUFDLEVBQUUsRUFBRSxRQUFRLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQztBQUdwRyxNQUFNLE9BQU8sYUFBYTtJQVl4QixZQUNZLEVBQU8sRUFDUCxPQUFlLEVBQ2YsZUFBbUMsRUFDM0MsUUFBZ0IsRUFDUixNQUF1QyxFQUN4QyxPQUFlLEVBQ2QsU0FBNkIsRUFDN0IsY0FBcUQ7UUFQckQsT0FBRSxHQUFGLEVBQUUsQ0FBSztRQUNQLFlBQU8sR0FBUCxPQUFP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Q2hELDBCQUEwQixFQUFFLDRCQUE0QjtJQUN4RCxxQkFBcUIsRUFBRSx1QkFBdUI7SUFDOUMsMEJBQTBCLEVBQUUsNEJBQTRCO0lBQ3hELGVBQWUsRUFBRSxpQkFBaUI7SUFDbEMsWUFBWSxFQUFFLGNBQWM7SUFDNUIscUJBQXFCLEVBQUUsdUJBQXVCO0lBQzlDLGtCQUFrQixFQUFFLG9CQUFvQjtJQUN4QyxpQkFBaUIsRUFBRSxtQkFBbUI7SUFDdEMsZ0JBQWdCLEVBQUUsa0JBQWtCO0lBQ3BDLHFCQUFxQixFQUFFLHVCQUF1QjtDQUMvQyxDQUFBIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgV29ya2VyIH0gZnJvbSAnd29ya2VyX3RocmVhZHMnO1xuaW1wb3J0ICogYXMgaHR0cHMgZnJvbSAnaHR0cHMnO1xuaW1wb3J0IGZzIGZyb20gJ2ZzLWV4dHJhJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgQXN5bmNMb2NrIGZyb20gJ2FzeW5jLWxvY2snO1xuaW1wb3J0ICogYXMgZ2l0IGZyb20gJ2lzb21vcnBoaWMtZ2l0JztcbmltcG9ydCAqIGFzIGxvZyBmcm9tICdlbGVjdHJvbi1sb2cnO1xuXG5pbXBvcnQgeyBHaXRTdGF0dXMgfSBmcm9tICcuLi8uLi9iYXNlJztcbmltcG9ydCB7IEdpdEF1dGhlbnRpY2F0aW9uLCBXb3JrZXJNZXNzYWdlIH0gZnJvbSAnLi90eXBlcyc7XG5cblxuY29uc3QgTUFJTl9SRU1PVEUgPSAnb3JpZ2luJztcblxuXG5jb25zdCBJTklUSUFMX1NUQVRVUzogR2l0U3RhdHVzID0ge1xuICBpc09ubGluZTogZmFsc2UsXG4gIGlzTWlzY29uZmlndXJlZDogZmFsc2UsXG4gIGhhc0xvY2FsQ2hhbmdlczogZmFsc2UsXG4gIG5lZWRzUGFzc3dvcmQ6IGZhbHNlLFxuICBzdGF0dXNSZWxhdGl2ZVRvTG9jYWw6IHVuZGVmaW5lZCxcbiAgbGFzdFN5bmNocm9uaXplZDogbnVsbCxcbiAgaXNQdXNoaW5nOiBmYWxzZSxcbiAgaXNQdWxsaW5nOiBmYWxzZSxcbn0gYXMgY29uc3Q7XG5cblxuY29uc3Qgd29ya2VyQ29udGVudHMgPSAgZnMucmVhZEZpbGVTeW5jKHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsICd3b3JrZXIuanMnKSwgeyBlbmNvZGluZzogJ3V0ZjgnIH0pO1xuXG5cbmV4cG9ydCBjbGFzcyBJc29HaXRXcmFwcGVyIHtcblxuICBwcml2YXRlIGF1dGg6IEdpdEF1dGhlbnRpY2F0aW9uID0ge307XG5cbiAgcHJpdmF0ZSBwdXNoUGVuZGluZyA9IGZhbHNlO1xuXG4gIHByaXZhdGUgc3RhZ2luZ0xvY2s6IEFzeW5jTG9jaztcblxuICBwcml2YXRlIHN0YXR1czogR2l0U3RhdHVzO1xuXG4gIHByaXZhdGUgd29ya2VyOiBXb3JrZXI7XG5cbiAgY29uc3RydWN0b3IoXG4gICAgICBwcml2YXRlIGZzOiBhbnksXG4gICAgICBwcml2YXRlIHJlcG9Vcmw6IHN0cmluZyxcbiAgICAgIHByaXZhdGUgdXBzdHJlYW1SZXBvVXJsOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICAgICB1c2VybmFtZTogc3RyaW5nLFxuICAgICAgcHJpdmF0ZSBhdXRob3I6IHsgbmFtZTogc3RyaW5nLCBlbWFpbDogc3RyaW5nIH0sXG4gICAgICBwdWJsaWMgd29ya0Rpcjogc3RyaW5nLFxuICAgICAgcHJpdmF0ZSBjb3JzUHJveHk6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgIHByaXZhdGUgc3RhdHVzUmVwb3J0ZXI6IChwYXlsb2FkOiBHaXRTdGF0dXMpID0+IFByb21pc2U8dm9pZD4pIHtcblxuICAgIHRoaXMuc3RhZ2luZ0xvY2sgPSBuZXcgQXN5bmNMb2NrKHsgdGltZW91dDogMjAwMDAsIG1heFBlbmRpbmc6IDIgfSk7XG5cbiAgICBpZiAodGhpcy5jb3JzUHJveHkpIHtcbiAgICAgIGxvZy53YXJuKFwiQy9kYi9pc29naXQ6IENPUlMgcHJveHkgcGFyYW1ldGVyIGlzIG9ic29sZXRlIGFuZCB3aWxsIGJlIHJlbW92ZWQuXCIpO1xuICAgIH1cbiAgICBpZiAodGhpcy51cHN0cmVhbVJlcG9VcmwgIT09IHVuZGVmaW5lZCkge1xuICAgICAgbG9nLndhcm4oXCJDL2RiL2lzb2dpdDogdGhlIHVwc3RyZWFtUmVwb1VybCBwYXJhbWV0ZXIgaXMgb2Jzb2xldGUgYW5kIHdpbGwgYmUgcmVtb3ZlZC5cIik7XG4gICAgfVxuXG4gICAgdGhpcy53b3JrZXIgPSBuZXcgV29ya2VyKHdvcmtlckNvbnRlbnRzLCB7IGV2YWw6IHRydWUgfSk7XG5cbiAgICB0aGlzLndvcmtlci5vbignZXhpdCcsIChjb2RlKSA9PiB7XG4gICAgICBsb2cuZXJyb3IoXCJDL2RiL2lzb2dpdDogV29ya2VyIGV4aXRlZCFcIiwgY29kZSk7XG4gICAgfSk7XG5cbiAgICB0aGlzLndvcmtlci5vbignZXJyb3InLCAoZXJyKSA9PiB7XG4gICAgICBsb2cuZXJyb3IoXCJDL2RiL2lzb2dpdDogV29ya2VyIGVycm9yXCIsIGVycik7XG4gICAgfSk7XG5cbiAgICAvLyBNYWtlcyBpdCBlYXNpZXIgdG8gYmluZCB0aGVzZSB0byBJUEMgZXZlbnRzXG4gICAgdGhpcy5zeW5jaHJvbml6ZSA9IHRoaXMuc3luY2hyb25pemUuYmluZCh0aGlzKTtcbiAgICB0aGlzLnJlc2V0RmlsZXMgPSB0aGlzLnJlc2V0RmlsZXMuYmluZCh0aGlzKTtcbiAgICB0aGlzLmNoZWNrVW5jb21taXR0ZWQgPSB0aGlzLmNoZWNrVW5jb21taXR0ZWQuYmluZCh0aGlzKTtcblxuICAgIHRoaXMuYXV0aC51c2VybmFtZSA9IHVzZXJuYW1lO1xuXG4gICAgdGhpcy5zdGF0dXMgPSBJTklUSUFMX1NUQVRVUztcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcG9zdE1lc3NhZ2U8VCBleHRlbmRzIG9iamVjdD4oXG4gICAgICBtc2c6IFdvcmtlck1lc3NhZ2UsXG4gICAgICByZXNvbHZlT25SZXNwb25zZT86IChyZXNwOiBUKSA9PiBib29sZWFuLFxuICAgICAgZmFpbE9uUmVzcG9uc2U/OiAocmVzcDogVCkgPT4gYm9vbGVhbik6IFByb21pc2U8VCB8IHVuZGVmaW5lZD4ge1xuICAgIHRoaXMud29ya2VyLnBvc3RNZXNzYWdlKG1zZyk7XG5cbiAgICBpZiAoIXJlc29sdmVPblJlc3BvbnNlICYmICFmYWlsT25SZXNwb25zZSkge1xuICAgICAgcmV0dXJuO1xuXG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgIHRoaXMud29ya2VyLm9uY2UoJ21lc3NhZ2UnLCAobXNnOiBUKSA9PiB7XG4gICAgICAgICAgaWYgKGZhaWxPblJlc3BvbnNlICE9PSB1bmRlZmluZWQgJiYgZmFpbE9uUmVzcG9uc2UobXNnKSkge1xuICAgICAgICAgICAgcmVqZWN0KG1zZyk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChyZXNvbHZlT25SZXNwb25zZSAhPT0gdW5kZWZpbmVkICYmIHJlc29sdmVPblJlc3BvbnNlKG1zZykpIHtcbiAgICAgICAgICAgIHJlc29sdmUobXNnKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgfVxuICB9XG5cblxuICAvLyBSZXBvcnRpbmcgR2l0IHN0YXR1cyB0byBEQiBiYWNrZW5kLFxuICAvLyBzbyB0aGF0IGl0IGNhbiBiZSByZWZsZWN0ZWQgaW4gdGhlIEdVSVxuXG4gIHByaXZhdGUgYXN5bmMgcmVwb3J0U3RhdHVzKCkge1xuICAgIHJldHVybiBhd2FpdCB0aGlzLnN0YXR1c1JlcG9ydGVyKHRoaXMuc3RhdHVzKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgc2V0U3RhdHVzKHN0YXR1czogUGFydGlhbDxHaXRTdGF0dXM+KSB7XG4gICAgT2JqZWN0LmFzc2lnbih0aGlzLnN0YXR1cywgc3RhdHVzKTtcbiAgICBhd2FpdCB0aGlzLnJlcG9ydFN0YXR1cygpO1xuICB9XG5cbiAgcHVibGljIGdldFN0YXR1cygpOiBHaXRTdGF0dXMge1xuICAgIHJldHVybiB0aGlzLnN0YXR1cztcbiAgfVxuXG5cbiAgLy8gSW5pdGlsYWl6YXRpb25cblxuICBwdWJsaWMgYXN5bmMgaXNJbml0aWFsaXplZCgpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICBsZXQgaGFzR2l0RGlyZWN0b3J5OiBib29sZWFuO1xuICAgIHRyeSB7XG4gICAgICBoYXNHaXREaXJlY3RvcnkgPSAoYXdhaXQgdGhpcy5mcy5zdGF0KHBhdGguam9pbih0aGlzLndvcmtEaXIsICcuZ2l0JykpKS5pc0RpcmVjdG9yeSgpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGhhc0dpdERpcmVjdG9yeSA9IGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gaGFzR2l0RGlyZWN0b3J5O1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGlzVXNpbmdSZW1vdGVVUkxzKHJlbW90ZVVybHM6IHsgb3JpZ2luOiBzdHJpbmcgfSk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIGNvbnN0IG9yaWdpbiA9IChhd2FpdCB0aGlzLmdldE9yaWdpblVybCgpIHx8ICcnKS50cmltKCk7XG4gICAgcmV0dXJuIG9yaWdpbiA9PT0gcmVtb3RlVXJscy5vcmlnaW47XG4gIH1cblxuICBwdWJsaWMgbmVlZHNQYXNzd29yZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gKHRoaXMuYXV0aC5wYXNzd29yZCB8fCAnJykudHJpbSgpID09PSAnJztcbiAgfVxuXG4gIHB1YmxpYyBnZXRVc2VybmFtZSgpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0aGlzLmF1dGgudXNlcm5hbWU7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgZGVzdHJveSgpIHtcbiAgICAvKiBSZW1vdmVzIHdvcmtpbmcgZGlyZWN0b3J5LlxuICAgICAgIE9uIG5leHQgc3luYyBHaXQgcmVwbyB3aWxsIGhhdmUgdG8gYmUgcmVpbml0aWFsaXplZCwgY2xvbmVkIGV0Yy4gKi9cblxuICAgIGxvZy53YXJuKFwiQy9kYi9pc29naXQ6IEluaXRpYWxpemU6IFJlbW92aW5nIGRhdGEgZGlyZWN0b3J5XCIpO1xuICAgIGF3YWl0IHRoaXMuZnMucmVtb3ZlKHRoaXMud29ya0Rpcik7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGZvcmNlSW5pdGlhbGl6ZSgpIHtcbiAgICAvKiBJbml0aWFsaXplcyBmcm9tIHNjcmF0Y2g6IHdpcGVzIHdvcmsgZGlyZWN0b3J5LCBjbG9uZXMgcmVwb3NpdG9yeSwgYWRkcyByZW1vdGVzLiAqL1xuXG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuc3RhZ2luZ0xvY2suYWNxdWlyZSgnMScsIGFzeW5jICgpID0+IHtcbiAgICAgIGxvZy53YXJuKFwiQy9kYi9pc29naXQ6IEluaXRpYWxpemluZ1wiKTtcblxuICAgICAgbG9nLnNpbGx5KFwiQy9kYi9pc29naXQ6IEluaXRpYWxpemU6IEVuc3VyaW5nIGRhdGEgZGlyZWN0b3J5IGV4aXN0c1wiKTtcbiAgICAgIGF3YWl0IHRoaXMuZnMuZW5zdXJlRGlyKHRoaXMud29ya0Rpcik7XG5cbiAgICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IEluaXRpYWxpemU6IENsb25pbmdcIiwgdGhpcy5yZXBvVXJsKTtcblxuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5wb3N0TWVzc2FnZTx7IGNsb25lZDogYm9vbGVhbiwgZXJyb3I/OiBhbnkgfT4oe1xuICAgICAgICAgIGFjdGlvbjogJ2Nsb25lJyxcbiAgICAgICAgICB3b3JrRGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICAgICAgcmVwb1VSTDogdGhpcy5yZXBvVXJsLFxuICAgICAgICAgIGF1dGg6IHRoaXMuYXV0aCxcbiAgICAgICAgfSwgKChtc2cpID0+IG1zZy5jbG9uZWQgIT09IHVuZGVmaW5lZCksICgobXNnKSA9PiBtc2cuZXJyb3IgIT09IHVuZGVmaW5lZCkpO1xuXG4gICAgICAgIGlmIChyZXN1bHQ/LmNsb25lZCAhPT0gdHJ1ZSkge1xuICAgICAgICAgIGxvZy5lcnJvcihcIkMvZGIvaXNvZ2l0OiBGYWlsZWQgdG8gY2xvbmVcIiwgcmVzdWx0Py5lcnJvcik7XG4gICAgICAgICAgaWYgKHJlc3VsdD8uZXJyb3IpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyByZXN1bHQuZXJyb3I7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkZhaWxlZCB0byBjbG9uZVwiKVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGxvZy5lcnJvcihcIkMvZGIvaXNvZ2l0OiBFcnJvciBkdXJpbmcgaW5pdGlhbGl6YXRpb25cIilcbiAgICAgICAgYXdhaXQgdGhpcy5mcy5yZW1vdmUodGhpcy53b3JrRGlyKTtcbiAgICAgICAgYXdhaXQgdGhpcy5faGFuZGxlR2l0RXJyb3IoZSk7XG4gICAgICAgIHRocm93IGU7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuXG4gIC8vIEF1dGhlbnRpY2F0aW9uXG5cbiAgcHVibGljIHNldFBhc3N3b3JkKHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgICB0aGlzLmF1dGgucGFzc3dvcmQgPSB2YWx1ZTtcbiAgICB0aGlzLnNldFN0YXR1cyh7IG5lZWRzUGFzc3dvcmQ6IGZhbHNlIH0pO1xuICB9XG5cblxuICAvLyBHaXQgb3BlcmF0aW9uc1xuXG4gIGFzeW5jIGNvbmZpZ1NldChwcm9wOiBzdHJpbmcsIHZhbDogc3RyaW5nKSB7XG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogU2V0IGNvbmZpZ1wiKTtcbiAgICBhd2FpdCBnaXQuc2V0Q29uZmlnKHsgZnM6IHRoaXMuZnMsIGRpcjogdGhpcy53b3JrRGlyLCBwYXRoOiBwcm9wLCB2YWx1ZTogdmFsIH0pO1xuICB9XG5cbiAgYXN5bmMgY29uZmlnR2V0KHByb3A6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogR2V0IGNvbmZpZ1wiLCBwcm9wKTtcbiAgICByZXR1cm4gYXdhaXQgZ2l0LmdldENvbmZpZyh7IGZzOiB0aGlzLmZzLCBkaXI6IHRoaXMud29ya0RpciwgcGF0aDogcHJvcCB9KTtcbiAgfVxuXG4gIGFzeW5jIHJlYWRGaWxlQmxvYkF0Q29tbWl0KHJlbGF0aXZlRmlsZVBhdGg6IHN0cmluZywgY29tbWl0SGFzaDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICAvKiBSZWFkcyBmaWxlIGNvbnRlbnRzIGF0IGdpdmVuIHBhdGggYXMgb2YgZ2l2ZW4gY29tbWl0LiBGaWxlIGNvbnRlbnRzIG11c3QgdXNlIFVURi04IGVuY29kaW5nLiAqL1xuXG4gICAgcmV0dXJuIChhd2FpdCBnaXQucmVhZEJsb2Ioe1xuICAgICAgZnM6IHRoaXMuZnMsXG4gICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgIG9pZDogY29tbWl0SGFzaCxcbiAgICAgIGZpbGVwYXRoOiByZWxhdGl2ZUZpbGVQYXRoLFxuICAgIH0pKS5ibG9iLnRvU3RyaW5nKCk7XG4gIH1cblxuICBhc3luYyBwdWxsKCkge1xuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IFB1bGxpbmcgbWFzdGVyIHdpdGggZmFzdC1mb3J3YXJkIG1lcmdlXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5wb3N0TWVzc2FnZTx7IHB1bGxlZDogdHJ1ZSwgZXJyb3I/OiBhbnkgfT4oe1xuICAgICAgYWN0aW9uOiAncHVsbCcsXG4gICAgICB3b3JrRGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICByZXBvVVJMOiB0aGlzLnJlcG9VcmwsXG4gICAgICBhdXRoOiB0aGlzLmF1dGgsXG4gICAgICBhdXRob3I6IHRoaXMuYXV0aG9yLFxuICAgIH0sICgobXNnKSA9PiBtc2cucHVsbGVkICE9PSB1bmRlZmluZWQpLCAoKG1zZykgPT4gbXNnLmVycm9yICE9PSB1bmRlZmluZWQpKTtcblxuICAgIGlmIChyZXN1bHQ/LnB1bGxlZCAhPT0gdHJ1ZSkge1xuICAgICAgbG9nLmVycm9yKFwiQy9kYi9pc29naXQ6IEZhaWxlZCB0byBwdWxsXCIsIHJlc3VsdD8uZXJyb3IpO1xuICAgICAgaWYgKHJlc3VsdD8uZXJyb3IpIHtcbiAgICAgICAgdGhyb3cgcmVzdWx0Py5lcnJvcjtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkZhaWxlZCB0byBwdWxsXCIpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGFzeW5jIHN0YWdlKHBhdGhTcGVjczogc3RyaW5nW10sIHJlbW92aW5nID0gZmFsc2UpIHtcbiAgICBsb2cudmVyYm9zZShgQy9kYi9pc29naXQ6IFN0YWdpbmcgY2hhbmdlczogJHtwYXRoU3BlY3Muam9pbignLCAnKX0gdXNpbmcgJHtyZW1vdmluZyA/IFwicmVtb3ZlKClcIiA6IFwiYWRkKClcIn1gKTtcblxuICAgIGZvciAoY29uc3QgcGF0aFNwZWMgb2YgcGF0aFNwZWNzKSB7XG4gICAgICBpZiAocmVtb3ZpbmcgIT09IHRydWUpIHtcbiAgICAgICAgYXdhaXQgZ2l0LmFkZCh7XG4gICAgICAgICAgZnM6IHRoaXMuZnMsXG4gICAgICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICAgICAgZmlsZXBhdGg6IHBhdGhTcGVjLFxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGF3YWl0IGdpdC5yZW1vdmUoe1xuICAgICAgICAgIGZzOiB0aGlzLmZzLFxuICAgICAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgICAgIGZpbGVwYXRoOiBwYXRoU3BlYyxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgY29tbWl0KG1zZzogc3RyaW5nKSB7XG4gICAgbG9nLnZlcmJvc2UoYEMvZGIvaXNvZ2l0OiBDb21taXR0aW5nIHdpdGggbWVzc2FnZSAke21zZ31gKTtcblxuICAgIHJldHVybiBhd2FpdCBnaXQuY29tbWl0KHtcbiAgICAgIGZzOiB0aGlzLmZzLFxuICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICBtZXNzYWdlOiBtc2csXG4gICAgICBhdXRob3I6IHRoaXMuYXV0aG9yLFxuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgcHVzaCgpIHtcbiAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBQdXNoaW5nXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5wb3N0TWVzc2FnZTx7IHB1c2hlZDogdHJ1ZSwgZXJyb3I/OiBhbnkgfT4oe1xuICAgICAgYWN0aW9uOiAncHVzaCcsXG4gICAgICB3b3JrRGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICByZXBvVVJMOiB0aGlzLnJlcG9VcmwsXG4gICAgICBhdXRoOiB0aGlzLmF1dGgsXG4gICAgfSwgKChtc2cpID0+IG1zZy5wdXNoZWQgIT09IHVuZGVmaW5lZCksICgobXNnKSA9PiBtc2cuZXJyb3IgIT09IHVuZGVmaW5lZCkpO1xuXG4gICAgaWYgKHJlc3VsdD8ucHVzaGVkICE9PSB0cnVlKSB7XG4gICAgICBsb2cuZXJyb3IoXCJDL2RiL2lzb2dpdDogRmFpbGVkIHRvIHB1c2hcIiwgcmVzdWx0Py5lcnJvcik7XG4gICAgICBpZiAocmVzdWx0Py5lcnJvcikge1xuICAgICAgICB0aHJvdyByZXN1bHQ/LmVycm9yO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiRmFpbGVkIHRvIHB1c2hcIik7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcHVibGljIGFzeW5jIHJlc2V0RmlsZXMocGF0aHM/OiBzdHJpbmdbXSkge1xuICAgIHJldHVybiBhd2FpdCB0aGlzLnN0YWdpbmdMb2NrLmFjcXVpcmUoJzEnLCBhc3luYyAoKSA9PiB7XG4gICAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBGb3JjZSByZXNldHRpbmcgZmlsZXNcIik7XG5cbiAgICAgIHJldHVybiBhd2FpdCBnaXQuY2hlY2tvdXQoe1xuICAgICAgICBmczogdGhpcy5mcyxcbiAgICAgICAgZGlyOiB0aGlzLndvcmtEaXIsXG4gICAgICAgIGZvcmNlOiB0cnVlLFxuICAgICAgICBmaWxlcGF0aHM6IHBhdGhzIHx8IChhd2FpdCB0aGlzLmxpc3RDaGFuZ2VkRmlsZXMoKSksXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIGdldE9yaWdpblVybCgpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgICByZXR1cm4gKChhd2FpdCBnaXQubGlzdFJlbW90ZXMoe1xuICAgICAgZnM6IHRoaXMuZnMsXG4gICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICB9KSkuZmluZChyID0+IHIucmVtb3RlID09PSBNQUlOX1JFTU9URSkgfHwgeyB1cmw6IG51bGwgfSkudXJsO1xuICB9XG5cbiAgYXN5bmMgbGlzdExvY2FsQ29tbWl0cygpOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gICAgLyogUmV0dXJucyBhIGxpc3Qgb2YgY29tbWl0IG1lc3NhZ2VzIGZvciBjb21taXRzIHRoYXQgd2VyZSBub3QgcHVzaGVkIHlldC5cblxuICAgICAgIFVzZWZ1bCB0byBjaGVjayB3aGljaCBjb21taXRzIHdpbGwgYmUgdGhyb3duIG91dFxuICAgICAgIGlmIHdlIGZvcmNlIHVwZGF0ZSB0byByZW1vdGUgbWFzdGVyLlxuXG4gICAgICAgRG9lcyBzbyBieSB3YWxraW5nIHRocm91Z2ggbGFzdCAxMDAgY29tbWl0cyBzdGFydGluZyBmcm9tIGN1cnJlbnQgSEVBRC5cbiAgICAgICBXaGVuIGl0IGVuY291bnRlcnMgdGhlIGZpcnN0IGxvY2FsIGNvbW1pdCB0aGF0IGRvZXNu4oCZdCBkZXNjZW5kcyBmcm9tIHJlbW90ZSBtYXN0ZXIgSEVBRCxcbiAgICAgICBpdCBjb25zaWRlcnMgYWxsIHByZWNlZGluZyBjb21taXRzIHRvIGJlIGFoZWFkL2xvY2FsIGFuZCByZXR1cm5zIHRoZW0uXG5cbiAgICAgICBJZiBpdCBmaW5pc2hlcyB0aGUgd2FsayB3aXRob3V0IGZpbmRpbmcgYW4gYW5jZXN0b3IsIHRocm93cyBhbiBlcnJvci5cbiAgICAgICBJdCBpcyBhc3N1bWVkIHRoYXQgdGhlIGFwcCBkb2VzIG5vdCBhbGxvdyB0byBhY2N1bXVsYXRlXG4gICAgICAgbW9yZSB0aGFuIDEwMCBjb21taXRzIHdpdGhvdXQgcHVzaGluZyAoZXZlbiAxMDAgaXMgdG9vIG1hbnkhKSxcbiAgICAgICBzbyB0aGVyZeKAmXMgcHJvYmFibHkgc29tZXRoaW5nIHN0cmFuZ2UgZ29pbmcgb24uXG5cbiAgICAgICBPdGhlciBhc3N1bXB0aW9uczpcblxuICAgICAgICogZ2l0LmxvZyByZXR1cm5zIGNvbW1pdHMgZnJvbSBuZXdlc3QgdG8gb2xkZXN0LlxuICAgICAgICogVGhlIHJlbW90ZSB3YXMgYWxyZWFkeSBmZXRjaGVkLlxuXG4gICAgKi9cblxuICAgIHJldHVybiBhd2FpdCB0aGlzLnN0YWdpbmdMb2NrLmFjcXVpcmUoJzEnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBsYXRlc3RSZW1vdGVDb21taXQgPSBhd2FpdCBnaXQucmVzb2x2ZVJlZih7XG4gICAgICAgIGZzOiB0aGlzLmZzLFxuICAgICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgcmVmOiBgJHtNQUlOX1JFTU9URX0vbWFzdGVyYCxcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBsb2NhbENvbW1pdHMgPSBhd2FpdCBnaXQubG9nKHtcbiAgICAgICAgZnM6IHRoaXMuZnMsXG4gICAgICAgIGRpcjogdGhpcy53b3JrRGlyLFxuICAgICAgICBkZXB0aDogMTAwLFxuICAgICAgfSk7XG5cbiAgICAgIHZhciBjb21taXRzID0gW10gYXMgc3RyaW5nW107XG4gICAgICBmb3IgKGNvbnN0IGNvbW1pdCBvZiBsb2NhbENvbW1pdHMpIHtcbiAgICAgICAgaWYgKGF3YWl0IGdpdC5pc0Rlc2NlbmRlbnQoe1xuICAgICAgICAgICAgZnM6IHRoaXMuZnMsXG4gICAgICAgICAgICBkaXI6IHRoaXMud29ya0RpcixcbiAgICAgICAgICAgIG9pZDogY29tbWl0Lm9pZCxcbiAgICAgICAgICAgIGFuY2VzdG9yOiBsYXRlc3RSZW1vdGVDb21taXQsXG4gICAgICAgICAgfSkpIHtcbiAgICAgICAgICBjb21taXRzLnB1c2goY29tbWl0LmNvbW1pdC5tZXNzYWdlKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXR1cm4gY29tbWl0cztcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJEaWQgbm90IGZpbmQgYSBsb2NhbCBjb21taXQgdGhhdCBpcyBhbiBhbmNlc3RvciBvZiByZW1vdGUgbWFzdGVyXCIpO1xuICAgIH0pO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGxpc3RDaGFuZ2VkRmlsZXMocGF0aFNwZWNzID0gWycuJ10pOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gICAgLyogTGlzdHMgcmVsYXRpdmUgcGF0aHMgdG8gYWxsIGZpbGVzIHRoYXQgd2VyZSBjaGFuZ2VkIGFuZCBoYXZlIG5vdCBiZWVuIGNvbW1pdHRlZC4gKi9cblxuICAgIGNvbnN0IEZJTEUgPSAwLCBIRUFEID0gMSwgV09SS0RJUiA9IDI7XG5cbiAgICByZXR1cm4gKGF3YWl0IGdpdC5zdGF0dXNNYXRyaXgoeyBmczogdGhpcy5mcywgZGlyOiB0aGlzLndvcmtEaXIsIGZpbGVwYXRoczogcGF0aFNwZWNzIH0pKVxuICAgICAgLmZpbHRlcihyb3cgPT4gcm93W0hFQURdICE9PSByb3dbV09SS0RJUl0pXG4gICAgICAubWFwKHJvdyA9PiByb3dbRklMRV0pXG4gICAgICAuZmlsdGVyKGZpbGVwYXRoID0+ICFmaWxlcGF0aC5zdGFydHNXaXRoKCcuLicpICYmIGZpbGVwYXRoICE9PSBcIi5EU19TdG9yZVwiKTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBzdGFnZUFuZENvbW1pdChwYXRoU3BlY3M6IHN0cmluZ1tdLCBtc2c6IHN0cmluZywgcmVtb3ZpbmcgPSBmYWxzZSk6IFByb21pc2U8bnVtYmVyPiB7XG4gICAgLyogU3RhZ2VzIGFuZCBjb21taXRzIGZpbGVzIG1hdGNoaW5nIGdpdmVuIHBhdGggc3BlYyB3aXRoIGdpdmVuIG1lc3NhZ2UuXG5cbiAgICAgICBBbnkgb3RoZXIgZmlsZXMgc3RhZ2VkIGF0IHRoZSB0aW1lIG9mIHRoZSBjYWxsIHdpbGwgYmUgdW5zdGFnZWQuXG5cbiAgICAgICBSZXR1cm5zIHRoZSBudW1iZXIgb2YgbWF0Y2hpbmcgZmlsZXMgd2l0aCB1bnN0YWdlZCBjaGFuZ2VzIHByaW9yIHRvIHN0YWdpbmcuXG4gICAgICAgSWYgbm8gbWF0Y2hpbmcgZmlsZXMgd2VyZSBmb3VuZCBoYXZpbmcgdW5zdGFnZWQgY2hhbmdlcyxcbiAgICAgICBza2lwcyB0aGUgcmVzdCBhbmQgcmV0dXJucyB6ZXJvLlxuXG4gICAgICAgSWYgZmFpbElmRGl2ZXJnZWQgaXMgZ2l2ZW4sIGF0dGVtcHRzIGEgZmFzdC1mb3J3YXJkIHB1bGwgYWZ0ZXIgdGhlIGNvbW1pdC5cbiAgICAgICBJdCB3aWxsIGZhaWwgaW1tZWRpYXRlbHkgaWYgbWFpbiByZW1vdGUgaGFkIG90aGVyIGNvbW1pdHMgYXBwZWFyIGluIG1lYW50aW1lLlxuXG4gICAgICAgTG9ja3Mgc28gdGhhdCB0aGlzIG1ldGhvZCBjYW5ub3QgYmUgcnVuIGNvbmN1cnJlbnRseSAoYnkgc2FtZSBpbnN0YW5jZSkuXG4gICAgKi9cblxuICAgIGlmIChwYXRoU3BlY3MubGVuZ3RoIDwgMSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiV2FzbuKAmXQgZ2l2ZW4gYW55IHBhdGhzIHRvIGNvbW1pdCFcIik7XG4gICAgfVxuXG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuc3RhZ2luZ0xvY2suYWNxdWlyZSgnMScsIGFzeW5jICgpID0+IHtcbiAgICAgIGxvZy52ZXJib3NlKGBDL2RiL2lzb2dpdDogU3RhZ2luZyBhbmQgY29tbWl0dGluZzogJHtwYXRoU3BlY3Muam9pbignLCAnKX1gKTtcblxuICAgICAgY29uc3QgZmlsZXNDaGFuZ2VkID0gKGF3YWl0IHRoaXMubGlzdENoYW5nZWRGaWxlcyhwYXRoU3BlY3MpKS5sZW5ndGg7XG4gICAgICBpZiAoZmlsZXNDaGFuZ2VkIDwgMSkge1xuICAgICAgICByZXR1cm4gMDtcbiAgICAgIH1cblxuICAgICAgYXdhaXQgdGhpcy51bnN0YWdlQWxsKCk7XG4gICAgICBhd2FpdCB0aGlzLnN0YWdlKHBhdGhTcGVjcywgcmVtb3ZpbmcpO1xuICAgICAgYXdhaXQgdGhpcy5jb21taXQobXNnKTtcblxuICAgICAgcmV0dXJuIGZpbGVzQ2hhbmdlZDtcbiAgICB9KTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBjaGVja1VuY29tbWl0dGVkKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIC8qIENoZWNrcyBmb3IgYW55IHVuY29tbWl0dGVkIGNoYW5nZXMgbG9jYWxseSBwcmVzZW50LlxuICAgICAgIE5vdGlmaWVzIGFsbCB3aW5kb3dzIGFib3V0IHRoZSBzdGF0dXMuICovXG5cbiAgICBsb2cuZGVidWcoXCJDL2RiL2lzb2dpdDogQ2hlY2tpbmcgZm9yIHVuY29tbWl0dGVkIGNoYW5nZXNcIik7XG4gICAgY29uc3QgY2hhbmdlZEZpbGVzID0gYXdhaXQgdGhpcy5saXN0Q2hhbmdlZEZpbGVzKCk7XG4gICAgbG9nLmRlYnVnKFwiQy9kYi9pc29naXQ6IENoYW5nZWQgZmlsZXM6XCIsIGNoYW5nZWRGaWxlcyk7XG4gICAgY29uc3QgaGFzTG9jYWxDaGFuZ2VzID0gY2hhbmdlZEZpbGVzLmxlbmd0aCA+IDA7XG4gICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBoYXNMb2NhbENoYW5nZXMgfSk7XG4gICAgcmV0dXJuIGhhc0xvY2FsQ2hhbmdlcztcbiAgfVxuXG4gIHB1YmxpYyByZXF1ZXN0UHVzaCgpIHtcbiAgICB0aGlzLnB1c2hQZW5kaW5nID0gdHJ1ZTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBzeW5jaHJvbml6ZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAvKiBDaGVja3MgZm9yIGNvbm5lY3Rpb24sIGxvY2FsIGNoYW5nZXMgYW5kIHVucHVzaGVkIGNvbW1pdHMsXG4gICAgICAgdHJpZXMgdG8gcHVzaCBhbmQgcHVsbCB3aGVuIHRoZXJl4oCZcyBvcHBvcnR1bml0eS5cblxuICAgICAgIE5vdGlmaWVzIGFsbCB3aW5kb3dzIGFib3V0IHRoZSBzdGF0dXMgaW4gcHJvY2Vzcy4gKi9cblxuICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQ6IENoZWNraW5nIGlmIGNsb25lIGV4aXN0c1wiKTtcblxuICAgIGlmICghKGF3YWl0IHRoaXMuaXNJbml0aWFsaXplZCgpKSkge1xuICAgICAgYXdhaXQgdGhpcy5mb3JjZUluaXRpYWxpemUoKTtcblxuICAgIH0gZWxzZSB7XG4gICAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBDaGVja2luZyBmb3IgdW5jb21taXR0ZWQgY2hhbmdlc1wiKTtcblxuICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoe1xuICAgICAgICAuLi5JTklUSUFMX1NUQVRVUyxcbiAgICAgICAgaGFzTG9jYWxDaGFuZ2VzOiBmYWxzZSxcbiAgICAgICAgbGFzdFN5bmNocm9uaXplZDogdGhpcy5zdGF0dXMubGFzdFN5bmNocm9uaXplZCxcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBoYXNVbmNvbW1pdHRlZENoYW5nZXMgPSBhd2FpdCB0aGlzLmNoZWNrVW5jb21taXR0ZWQoKTtcblxuICAgICAgaWYgKGhhc1VuY29tbWl0dGVkQ2hhbmdlcykge1xuICAgICAgICAvLyBEbyBub3QgcnVuIHB1bGwgaWYgdGhlcmUgYXJlIHVuc3RhZ2VkL3VuY29tbWl0dGVkIGNoYW5nZXNcbiAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBoYXNMb2NhbENoYW5nZXM6IHRydWUgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIElmIHVuY29tbWl0dGVkIGNoYW5nZXMgd2VyZW7igJl0IGRldGVjdGVkLCB0aGVyZSBtYXkgc3RpbGwgYmUgY2hhbmdlZCBmaWxlc1xuICAgICAgICAvLyB0aGF0IGFyZSBub3QgbWFuYWdlZCBieSB0aGUgYmFja2VuZCAoZS5nLiwgLkRTX1N0b3JlKS4gRGlzY2FyZCBhbnkgc3R1ZmYgbGlrZSB0aGF0LlxuICAgICAgICBhd2FpdCB0aGlzLnJlc2V0RmlsZXMoWycuJ10pO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmICh0aGlzLnN0YWdpbmdMb2NrLmlzQnVzeSgpKSB7XG4gICAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBMb2NrIGlzIGJ1c3ksIHNraXBwaW5nIHN5bmNcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogUXVldWVpbmcgc3luYyBub3csIGxvY2sgaXMgbm90IGJ1c3lcIik7XG5cbiAgICByZXR1cm4gYXdhaXQgdGhpcy5zdGFnaW5nTG9jay5hY3F1aXJlKCcxJywgYXN5bmMgKCkgPT4ge1xuICAgICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdDogU3RhcnRpbmcgc3luY1wiKTtcblxuICAgICAgY29uc3QgaXNPbmxpbmUgPSAoYXdhaXQgY2hlY2tPbmxpbmVTdGF0dXMoKSkgPT09IHRydWU7XG5cbiAgICAgIGlmIChpc09ubGluZSkge1xuICAgICAgICBjb25zdCBuZWVkc1Bhc3N3b3JkID0gdGhpcy5uZWVkc1Bhc3N3b3JkKCk7XG4gICAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgbmVlZHNQYXNzd29yZCB9KTtcbiAgICAgICAgaWYgKG5lZWRzUGFzc3dvcmQpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzT25saW5lOiB0cnVlIH0pO1xuXG4gICAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaXNQdWxsaW5nOiB0cnVlIH0pO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGF3YWl0IHRoaXMucHVsbCgpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgbG9nLmVycm9yKGUpO1xuICAgICAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHtcbiAgICAgICAgICAgIGlzUHVsbGluZzogZmFsc2UsXG4gICAgICAgICAgICBpc1B1c2hpbmc6IGZhbHNlLFxuICAgICAgICAgICAgbGFzdFN5bmNocm9uaXplZDogbmV3IERhdGUoKSxcbiAgICAgICAgICAgIGlzT25saW5lOiBmYWxzZSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBhd2FpdCB0aGlzLl9oYW5kbGVHaXRFcnJvcihlKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgLy9hd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzUHVsbGluZzogZmFsc2UgfSk7XG5cbiAgICAgICAgaWYgKHRoaXMucHVzaFBlbmRpbmcpIHtcbiAgICAgICAgICAvLyBSdW4gcHVzaCBBRlRFUiBwdWxsLiBNYXkgcmVzdWx0IGluIGZhbHNlLXBvc2l0aXZlIG5vbi1mYXN0LWZvcndhcmQgcmVqZWN0aW9uXG4gICAgICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBpc1B1c2hpbmc6IHRydWUgfSk7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucHVzaCgpO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIGxvZy5lcnJvcihlKTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHtcbiAgICAgICAgICAgICAgaXNQdWxsaW5nOiBmYWxzZSxcbiAgICAgICAgICAgICAgaXNQdXNoaW5nOiBmYWxzZSxcbiAgICAgICAgICAgICAgbGFzdFN5bmNocm9uaXplZDogbmV3IERhdGUoKSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5faGFuZGxlR2l0RXJyb3IoZSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIHRoaXMucHVzaFBlbmRpbmcgPSBmYWxzZTtcbiAgICAgICAgICAvL2F3YWl0IHRoaXMuc2V0U3RhdHVzKHsgaXNQdXNoaW5nOiBmYWxzZSB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IHRoaXMuc2V0U3RhdHVzKHtcbiAgICAgICAgICBzdGF0dXNSZWxhdGl2ZVRvTG9jYWw6ICd1cGRhdGVkJyxcbiAgICAgICAgICBpc09ubGluZTogdHJ1ZSxcbiAgICAgICAgICBpc01pc2NvbmZpZ3VyZWQ6IGZhbHNlLFxuICAgICAgICAgIGxhc3RTeW5jaHJvbml6ZWQ6IG5ldyBEYXRlKCksXG4gICAgICAgICAgbmVlZHNQYXNzd29yZDogZmFsc2UsXG4gICAgICAgICAgaXNQdXNoaW5nOiBmYWxzZSxcbiAgICAgICAgICBpc1B1bGxpbmc6IGZhbHNlLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgdW5zdGFnZUFsbCgpIHtcbiAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0OiBVbnN0YWdpbmcgYWxsIGNoYW5nZXNcIik7XG4gICAgYXdhaXQgZ2l0LnJlbW92ZSh7IGZzOiB0aGlzLmZzLCBkaXI6IHRoaXMud29ya0RpciwgZmlsZXBhdGg6ICcuJyB9KTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgX2hhbmRsZUdpdEVycm9yKGU6IEVycm9yICYgeyBjb2RlOiBzdHJpbmcgfSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGxvZy5kZWJ1ZyhcIkhhbmRsaW5nIEdpdCBlcnJvclwiLCBlLmNvZGUsIGUpO1xuXG4gICAgaWYgKGUuY29kZSA9PT0gJ0Zhc3RGb3J3YXJkRmFpbCcgfHwgZS5jb2RlID09PSAnTWVyZ2VOb3RTdXBwb3J0ZWRGYWlsJykge1xuICAgICAgLy8gTk9URTogVGhlcmXigJlzIGFsc28gUHVzaFJlamVjdGVkTm9uRmFzdEZvcndhcmQsIGJ1dCBpdCBzZWVtcyB0byBiZSB0aHJvd25cbiAgICAgIC8vIGZvciB1bnJlbGF0ZWQgY2FzZXMgZHVyaW5nIHB1c2ggKGZhbHNlIHBvc2l0aXZlKS5cbiAgICAgIC8vIEJlY2F1c2Ugb2YgdGhhdCBmYWxzZSBwb3NpdGl2ZSwgd2UgaWdub3JlIHRoYXQgZXJyb3IgYW5kIGluc3RlYWQgZG8gcHVsbCBmaXJzdCxcbiAgICAgIC8vIGNhdGNoaW5nIGFjdHVhbCBmYXN0LWZvcndhcmQgZmFpbHMgb24gdGhhdCBzdGVwIGJlZm9yZSBwdXNoLlxuICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBzdGF0dXNSZWxhdGl2ZVRvTG9jYWw6ICdkaXZlcmdlZCcgfSk7XG4gICAgfSBlbHNlIGlmIChbJ01pc3NpbmdVc2VybmFtZUVycm9yJywgJ01pc3NpbmdBdXRob3JFcnJvcicsICdNaXNzaW5nQ29tbWl0dGVyRXJyb3InXS5pbmRleE9mKGUuY29kZSkgPj0gMCkge1xuICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBpc01pc2NvbmZpZ3VyZWQ6IHRydWUgfSk7XG4gICAgfSBlbHNlIGlmIChlLmNvZGUgPT09ICdFSE9TVERPV04nKSB7XG4gICAgICBhd2FpdCB0aGlzLnNldFN0YXR1cyh7IGlzT25saW5lOiBmYWxzZSB9KTtcbiAgICAgIGxvZy53YXJuKFwiUG9zc2libGUgY29ubmVjdGlvbiBpc3N1ZXNcIik7XG4gICAgfSBlbHNlIGlmIChcbiAgICAgICAgZS5jb2RlID09PSAnTWlzc2luZ1Bhc3N3b3JkVG9rZW5FcnJvcidcbiAgICAgICAgfHwgKGUuY29kZSA9PT0gJ0hUVFBFcnJvcicgJiYgZS5tZXNzYWdlLmluZGV4T2YoJ1VuYXV0aG9yaXplZCcpID49IDApKSB7XG4gICAgICBsb2cud2FybihcIlBhc3N3b3JkIGlucHV0IHJlcXVpcmVkXCIpO1xuICAgICAgdGhpcy5zZXRQYXNzd29yZCh1bmRlZmluZWQpO1xuICAgICAgYXdhaXQgdGhpcy5zZXRTdGF0dXMoeyBuZWVkc1Bhc3N3b3JkOiB0cnVlIH0pO1xuICAgIH1cbiAgfVxufVxuXG5cbmFzeW5jIGZ1bmN0aW9uIGNoZWNrT25saW5lU3RhdHVzKHRpbWVvdXQgPSA0NTAwKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIC8vIFRPRE86IE1vdmUgdG8gZ2VuZXJhbCB1dGlsaXR5IGZ1bmN0aW9uc1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICBsb2cuZGVidWcoXCJDL2RiL2lzb2dpdDogQ29ubmVjdGlvbiB0ZXN0OiBTdGFydGluZ1wiKTtcblxuICAgIGNvbnN0IHJlcSA9IGh0dHBzLmdldCgnaHR0cHM6Ly9naXRodWIuY29tLycsIHsgdGltZW91dCB9LCByZXBvcnRPbmxpbmUpO1xuXG4gICAgcmVxLm9uKCdlcnJvcicsICgpID0+IHJlcS5hYm9ydCgpKTtcbiAgICByZXEub24oJ3Jlc3BvbnNlJywgcmVwb3J0T25saW5lKTtcbiAgICByZXEub24oJ2Nvbm5lY3QnLCByZXBvcnRPbmxpbmUpO1xuICAgIHJlcS5vbignY29udGludWUnLCByZXBvcnRPbmxpbmUpO1xuICAgIHJlcS5vbigndXBncmFkZScsIHJlcG9ydE9ubGluZSk7XG4gICAgcmVxLm9uKCd0aW1lb3V0JywgcmVwb3J0T2ZmbGluZSk7XG5cbiAgICByZXEuZW5kKCk7XG5cbiAgICBjb25zdCBjaGVja1RpbWVvdXQgPSBzZXRUaW1lb3V0KHJlcG9ydE9mZmxpbmUsIHRpbWVvdXQpO1xuXG4gICAgZnVuY3Rpb24gcmVwb3J0T2ZmbGluZSgpIHtcbiAgICAgIGxvZy53YXJuKFwiQy9kYi9pc29naXQ6IENvbm5lY3Rpb24gdGVzdDogUmVwb3J0IG9mZmxpbmVcIik7XG4gICAgICB0cnkgeyByZXEuYWJvcnQoKTsgfSBjYXRjaCAoZSkge31cbiAgICAgIGNsZWFyVGltZW91dChjaGVja1RpbWVvdXQpO1xuICAgICAgcmVzb2x2ZShmYWxzZSk7XG4gICAgfVxuICAgIGZ1bmN0aW9uIHJlcG9ydE9ubGluZSgpIHtcbiAgICAgIGxvZy5pbmZvKFwiQy9kYi9pc29naXQ6IENvbm5lY3Rpb24gdGVzdDogUmVwb3J0IG9ubGluZVwiKTtcbiAgICAgIHRyeSB7IHJlcS5hYm9ydCgpOyB9IGNhdGNoIChlKSB7fVxuICAgICAgY2xlYXJUaW1lb3V0KGNoZWNrVGltZW91dCk7XG4gICAgICByZXNvbHZlKHRydWUpO1xuICAgIH1cbiAgfSk7XG59XG5cblxuLy8gVE9ETzogVGVtcG9yYXJ5IHdvcmthcm91bmQgc2luY2UgaXNvbW9ycGhpYy1naXQgZG9lc27igJl0IHNlZW0gdG8gZXhwb3J0IGl0cyBHaXRFcnJvciBjbGFzc1xuLy8gaW4gYW55IHdheSBhdmFpbGFibGUgdG8gVFMsIHNvIHdlIGNhbuKAmXQgdXNlIGluc3RhbmNlb2YgOihcblxuZXhwb3J0IGZ1bmN0aW9uIGlzR2l0RXJyb3IoZTogRXJyb3IgJiB7IGNvZGU6IHN0cmluZyB9KSB7XG4gIGlmICghZS5jb2RlKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiBPYmplY3Qua2V5cyhJc29tb3JwaGljR2l0RXJyb3JDb2RlcykuaW5kZXhPZihlLmNvZGUpID49IDA7XG59XG5cbmNvbnN0IElzb21vcnBoaWNHaXRFcnJvckNvZGVzID0ge1xuICBGaWxlUmVhZEVycm9yOiBgRmlsZVJlYWRFcnJvcmAsXG4gIE1pc3NpbmdSZXF1aXJlZFBhcmFtZXRlckVycm9yOiBgTWlzc2luZ1JlcXVpcmVkUGFyYW1ldGVyRXJyb3JgLFxuICBJbnZhbGlkUmVmTmFtZUVycm9yOiBgSW52YWxpZFJlZk5hbWVFcnJvcmAsXG4gIEludmFsaWRQYXJhbWV0ZXJDb21iaW5hdGlvbkVycm9yOiBgSW52YWxpZFBhcmFtZXRlckNvbWJpbmF0aW9uRXJyb3JgLFxuICBSZWZFeGlzdHNFcnJvcjogYFJlZkV4aXN0c0Vycm9yYCxcbiAgUmVmTm90RXhpc3RzRXJyb3I6IGBSZWZOb3RFeGlzdHNFcnJvcmAsXG4gIEJyYW5jaERlbGV0ZUVycm9yOiBgQnJhbmNoRGVsZXRlRXJyb3JgLFxuICBOb0hlYWRDb21taXRFcnJvcjogYE5vSGVhZENvbW1pdEVycm9yYCxcbiAgQ29tbWl0Tm90RmV0Y2hlZEVycm9yOiBgQ29tbWl0Tm90RmV0Y2hlZEVycm9yYCxcbiAgT2JqZWN0VHlwZVVua25vd25GYWlsOiBgT2JqZWN0VHlwZVVua25vd25GYWlsYCxcbiAgT2JqZWN0VHlwZUFzc2VydGlvbkZhaWw6IGBPYmplY3RUeXBlQXNzZXJ0aW9uRmFpbGAsXG4gIE9iamVjdFR5cGVBc3NlcnRpb25JblRyZWVGYWlsOiBgT2JqZWN0VHlwZUFzc2VydGlvbkluVHJlZUZhaWxgLFxuICBPYmplY3RUeXBlQXNzZXJ0aW9uSW5SZWZGYWlsOiBgT2JqZWN0VHlwZUFzc2VydGlvbkluUmVmRmFpbGAsXG4gIE9iamVjdFR5cGVBc3NlcnRpb25JblBhdGhGYWlsOiBgT2JqZWN0VHlwZUFzc2VydGlvbkluUGF0aEZhaWxgLFxuICBNaXNzaW5nQXV0aG9yRXJyb3I6IGBNaXNzaW5nQXV0aG9yRXJyb3JgLFxuICBNaXNzaW5nQ29tbWl0dGVyRXJyb3I6IGBNaXNzaW5nQ29tbWl0dGVyRXJyb3JgLFxuICBNaXNzaW5nVGFnZ2VyRXJyb3I6IGBNaXNzaW5nVGFnZ2VyRXJyb3JgLFxuICBHaXRSb290Tm90Rm91bmRFcnJvcjogYEdpdFJvb3ROb3RGb3VuZEVycm9yYCxcbiAgVW5wYXJzZWFibGVTZXJ2ZXJSZXNwb25zZUZhaWw6IGBVbnBhcnNlYWJsZVNlcnZlclJlc3BvbnNlRmFpbGAsXG4gIEludmFsaWREZXB0aFBhcmFtZXRlckVycm9yOiBgSW52YWxpZERlcHRoUGFyYW1ldGVyRXJyb3JgLFxuICBSZW1vdGVEb2VzTm90U3VwcG9ydFNoYWxsb3dGYWlsOiBgUmVtb3RlRG9lc05vdFN1cHBvcnRTaGFsbG93RmFpbGAsXG4gIFJlbW90ZURvZXNOb3RTdXBwb3J0RGVlcGVuU2luY2VGYWlsOiBgUmVtb3RlRG9lc05vdFN1cHBvcnREZWVwZW5TaW5jZUZhaWxgLFxuICBSZW1vdGVEb2VzTm90U3VwcG9ydERlZXBlbk5vdEZhaWw6IGBSZW1vdGVEb2VzTm90U3VwcG9ydERlZXBlbk5vdEZhaWxgLFxuICBSZW1vdGVEb2VzTm90U3VwcG9ydERlZXBlblJlbGF0aXZlRmFpbDogYFJlbW90ZURvZXNOb3RTdXBwb3J0RGVlcGVuUmVsYXRpdmVGYWlsYCxcbiAgUmVtb3RlRG9lc05vdFN1cHBvcnRTbWFydEhUVFA6IGBSZW1vdGVEb2VzTm90U3VwcG9ydFNtYXJ0SFRUUGAsXG4gIENvcnJ1cHRTaGFsbG93T2lkRmFpbDogYENvcnJ1cHRTaGFsbG93T2lkRmFpbGAsXG4gIEZhc3RGb3J3YXJkRmFpbDogYEZhc3RGb3J3YXJkRmFpbGAsXG4gIE1lcmdlTm90U3VwcG9ydGVkRmFpbDogYE1lcmdlTm90U3VwcG9ydGVkRmFpbGAsXG4gIERpcmVjdG9yeVNlcGFyYXRvcnNFcnJvcjogYERpcmVjdG9yeVNlcGFyYXRvcnNFcnJvcmAsXG4gIFJlc29sdmVUcmVlRXJyb3I6IGBSZXNvbHZlVHJlZUVycm9yYCxcbiAgUmVzb2x2ZUNvbW1pdEVycm9yOiBgUmVzb2x2ZUNvbW1pdEVycm9yYCxcbiAgRGlyZWN0b3J5SXNBRmlsZUVycm9yOiBgRGlyZWN0b3J5SXNBRmlsZUVycm9yYCxcbiAgVHJlZU9yQmxvYk5vdEZvdW5kRXJyb3I6IGBUcmVlT3JCbG9iTm90Rm91bmRFcnJvcmAsXG4gIE5vdEltcGxlbWVudGVkRmFpbDogYE5vdEltcGxlbWVudGVkRmFpbGAsXG4gIFJlYWRPYmplY3RGYWlsOiBgUmVhZE9iamVjdEZhaWxgLFxuICBOb3RBbk9pZEZhaWw6IGBOb3RBbk9pZEZhaWxgLFxuICBOb1JlZnNwZWNDb25maWd1cmVkRXJyb3I6IGBOb1JlZnNwZWNDb25maWd1cmVkRXJyb3JgLFxuICBNaXNtYXRjaFJlZlZhbHVlRXJyb3I6IGBNaXNtYXRjaFJlZlZhbHVlRXJyb3JgLFxuICBSZXNvbHZlUmVmRXJyb3I6IGBSZXNvbHZlUmVmRXJyb3JgLFxuICBFeHBhbmRSZWZFcnJvcjogYEV4cGFuZFJlZkVycm9yYCxcbiAgRW1wdHlTZXJ2ZXJSZXNwb25zZUZhaWw6IGBFbXB0eVNlcnZlclJlc3BvbnNlRmFpbGAsXG4gIEFzc2VydFNlcnZlclJlc3BvbnNlRmFpbDogYEFzc2VydFNlcnZlclJlc3BvbnNlRmFpbGAsXG4gIEhUVFBFcnJvcjogYEhUVFBFcnJvcmAsXG4gIFJlbW90ZVVybFBhcnNlRXJyb3I6IGBSZW1vdGVVcmxQYXJzZUVycm9yYCxcbiAgVW5rbm93blRyYW5zcG9ydEVycm9yOiBgVW5rbm93blRyYW5zcG9ydEVycm9yYCxcbiAgQWNxdWlyZUxvY2tGaWxlRmFpbDogYEFjcXVpcmVMb2NrRmlsZUZhaWxgLFxuICBEb3VibGVSZWxlYXNlTG9ja0ZpbGVGYWlsOiBgRG91YmxlUmVsZWFzZUxvY2tGaWxlRmFpbGAsXG4gIEludGVybmFsRmFpbDogYEludGVybmFsRmFpbGAsXG4gIFVua25vd25PYXV0aDJGb3JtYXQ6IGBVbmtub3duT2F1dGgyRm9ybWF0YCxcbiAgTWlzc2luZ1Bhc3N3b3JkVG9rZW5FcnJvcjogYE1pc3NpbmdQYXNzd29yZFRva2VuRXJyb3JgLFxuICBNaXNzaW5nVXNlcm5hbWVFcnJvcjogYE1pc3NpbmdVc2VybmFtZUVycm9yYCxcbiAgTWl4UGFzc3dvcmRUb2tlbkVycm9yOiBgTWl4UGFzc3dvcmRUb2tlbkVycm9yYCxcbiAgTWl4VXNlcm5hbWVQYXNzd29yZFRva2VuRXJyb3I6IGBNaXhVc2VybmFtZVBhc3N3b3JkVG9rZW5FcnJvcmAsXG4gIE1pc3NpbmdUb2tlbkVycm9yOiBgTWlzc2luZ1Rva2VuRXJyb3JgLFxuICBNaXhVc2VybmFtZU9hdXRoMmZvcm1hdE1pc3NpbmdUb2tlbkVycm9yOiBgTWl4VXNlcm5hbWVPYXV0aDJmb3JtYXRNaXNzaW5nVG9rZW5FcnJvcmAsXG4gIE1peFBhc3N3b3JkT2F1dGgyZm9ybWF0TWlzc2luZ1Rva2VuRXJyb3I6IGBNaXhQYXNzd29yZE9hdXRoMmZvcm1hdE1pc3NpbmdUb2tlbkVycm9yYCxcbiAgTWl4VXNlcm5hbWVQYXNzd29yZE9hdXRoMmZvcm1hdE1pc3NpbmdUb2tlbkVycm9yOiBgTWl4VXNlcm5hbWVQYXNzd29yZE9hdXRoMmZvcm1hdE1pc3NpbmdUb2tlbkVycm9yYCxcbiAgTWl4VXNlcm5hbWVPYXV0aDJmb3JtYXRUb2tlbkVycm9yOiBgTWl4VXNlcm5hbWVPYXV0aDJmb3JtYXRUb2tlbkVycm9yYCxcbiAgTWl4UGFzc3dvcmRPYXV0aDJmb3JtYXRUb2tlbkVycm9yOiBgTWl4UGFzc3dvcmRPYXV0aDJmb3JtYXRUb2tlbkVycm9yYCxcbiAgTWl4VXNlcm5hbWVQYXNzd29yZE9hdXRoMmZvcm1hdFRva2VuRXJyb3I6IGBNaXhVc2VybmFtZVBhc3N3b3JkT2F1dGgyZm9ybWF0VG9rZW5FcnJvcmAsXG4gIE1heFNlYXJjaERlcHRoRXhjZWVkZWQ6IGBNYXhTZWFyY2hEZXB0aEV4Y2VlZGVkYCxcbiAgUHVzaFJlamVjdGVkTm9uRmFzdEZvcndhcmQ6IGBQdXNoUmVqZWN0ZWROb25GYXN0Rm9yd2FyZGAsXG4gIFB1c2hSZWplY3RlZFRhZ0V4aXN0czogYFB1c2hSZWplY3RlZFRhZ0V4aXN0c2AsXG4gIEFkZGluZ1JlbW90ZVdvdWxkT3ZlcndyaXRlOiBgQWRkaW5nUmVtb3RlV291bGRPdmVyd3JpdGVgLFxuICBQbHVnaW5VbmRlZmluZWQ6IGBQbHVnaW5VbmRlZmluZWRgLFxuICBDb3JlTm90Rm91bmQ6IGBDb3JlTm90Rm91bmRgLFxuICBQbHVnaW5TY2hlbWFWaW9sYXRpb246IGBQbHVnaW5TY2hlbWFWaW9sYXRpb25gLFxuICBQbHVnaW5VbnJlY29nbml6ZWQ6IGBQbHVnaW5VbnJlY29nbml6ZWRgLFxuICBBbWJpZ3VvdXNTaG9ydE9pZDogYEFtYmlndW91c1Nob3J0T2lkYCxcbiAgU2hvcnRPaWROb3RGb3VuZDogYFNob3J0T2lkTm90Rm91bmRgLFxuICBDaGVja291dENvbmZsaWN0RXJyb3I6IGBDaGVja291dENvbmZsaWN0RXJyb3JgXG59XG5cbiJdfQ==