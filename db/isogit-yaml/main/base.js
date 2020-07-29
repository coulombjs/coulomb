import * as log from 'electron-log';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as keytar from 'keytar';
import { listen } from '../../../ipc/main';
import { Setting } from '../../../settings/main';
import { UniqueConstraintError } from '../../errors';
import { VersionedFilesystemBackend, } from '../../main/base';
import { IsoGitWrapper } from './isogit';
class Backend extends VersionedFilesystemBackend {
    constructor(opts, reportBackendStatus) {
        super();
        this.opts = opts;
        this.reportBackendStatus = reportBackendStatus;
        this.fs = opts.fsWrapper;
        this.git = new IsoGitWrapper(fs, this.opts.repoURL, this.opts.upstreamRepoURL, this.opts.username, { name: this.opts.authorName, email: this.opts.authorEmail }, this.opts.workDir, this.opts.corsProxyURL, 
        // The status of this backend is reduced to Git repo status now.
        // Potentially it should include filesystem-related status as well,
        // reporting issues with e.g. insufficient disk space.
        this.reportBackendStatus);
        this.managers = [];
        this.keytarCredentialsKey = {
            service: `repo-${this.opts.repoURL}`,
            account: this.opts.username,
        };
        this.synchronize = this.synchronize.bind(this);
    }
    async getLocalFilesystemPath(id) {
        return this.fs.expandPath(id);
    }
    async getCurrentCommitterInformation() {
        return {
            username: this.opts.username,
            name: this.opts.authorName,
            email: this.opts.authorEmail,
        };
    }
    async describe() {
        return {
            verboseName: "Git+YAML",
            verboseNameLong: "Git-versioned YAML file tree",
            gitRepo: this.opts.repoURL,
            gitUsername: this.opts.username,
            localClonePath: this.opts.workDir,
            status: this.git.getStatus(),
        };
    }
    static registerSettingsForConfigurableOptions(settings, initialOptions, dbID) {
        const paneLabelPostfix = dbID !== 'default' ? ` for “${dbID}”` : '';
        const settingIDPrefix = `db_${dbID}_`;
        const paneID = `db_${dbID}`;
        settings.configurePane({
            id: paneID,
            label: `Database settings${paneLabelPostfix}`,
            icon: 'git-merge',
        });
        settings.register(new Setting(paneID, `${settingIDPrefix}gitRepoUrl`, 'text', initialOptions.repoURL === undefined, "Git repository URL", "E.g., https://github.com/<username>/<repository name>"));
        settings.register(new Setting(paneID, `${settingIDPrefix}gitUsername`, 'text', initialOptions.username === undefined, "Git username"));
        settings.register(new Setting(paneID, `${settingIDPrefix}gitAuthorName`, 'text', initialOptions.authorName === undefined, "Git author name"));
        settings.register(new Setting(paneID, `${settingIDPrefix}gitAuthorEmail`, 'text', initialOptions.authorEmail === undefined, "Git author email"));
    }
    static async completeOptionsFromSettings(settings, availableOptions, dbID) {
        const settingIDPrefix = `db_${dbID}_`;
        async function getSetting(settingID) {
            return await settings.getValue(`${settingIDPrefix}${settingID}`);
        }
        const fsWrapperClass = availableOptions.fsWrapperClass;
        return {
            workDir: availableOptions.workDir,
            corsProxyURL: availableOptions.corsProxyURL,
            upstreamRepoURL: availableOptions.upstreamRepoURL,
            fsWrapperClass: availableOptions.fsWrapperClass,
            fsWrapper: new fsWrapperClass(availableOptions.workDir),
            repoURL: ((await getSetting('gitRepoUrl'))
                || availableOptions.repoURL),
            username: ((await getSetting('gitUsername'))
                || availableOptions.username),
            authorName: ((await getSetting('gitAuthorName'))
                || availableOptions.authorName),
            authorEmail: ((await getSetting('gitAuthorEmail'))
                || availableOptions.authorEmail),
        };
    }
    async registerManager(manager) {
        this.managers.push(manager);
    }
    async init(forceReset = false) {
        let doInitialize;
        try {
            if (forceReset === true) {
                log.warn("C/db/isogit-yaml: Git is being force reinitialized");
                doInitialize = true;
            }
            else if (!(await this.git.isUsingRemoteURLs({ origin: this.opts.repoURL }))) {
                log.warn("C/db/isogit-yaml: Git has mismatching remote URL(s), reinitializing");
                doInitialize = true;
            }
            else {
                log.info("C/db/isogit-yaml: Git is already initialized");
                doInitialize = false;
            }
        }
        catch (e) {
            doInitialize = true;
        }
        if (doInitialize) {
            await this.git.destroy();
        }
        const pwd = await keytar.getPassword(this.keytarCredentialsKey.service, this.keytarCredentialsKey.account);
        if (pwd !== null && pwd.trim() !== '') {
            await this.git.setPassword(pwd);
        }
        await this.synchronize();
    }
    async read(objID, metaFields) {
        return await this.fs.read(this.getRef(objID), metaFields);
    }
    async readVersion(objID, version) {
        // NOTE: This will fail with YAMLDirectoryWrapper.
        // objID must refer to a single file.
        // TODO: Support compound objects (directories)
        // by moving the file data parsing logic into manager
        // and adding Backend.readTree().
        const blob = await this.git.readFileBlobAtCommit(this.getRef(objID), version);
        return this.fs.parseData(blob);
    }
    async create(obj, objPath, metaFields) {
        if (await this.fs.exists(objPath)) {
            throw new UniqueConstraintError("filesystem path", objPath);
        }
        await this.fs.write(objPath, obj, metaFields);
    }
    async commitAll(msg, removing) {
        // NOTE: Use with care.
        await this.git.stageAndCommit(['.'], msg, removing);
    }
    async commit(objIDs, message, removing = false) {
        await this.resetOrphanedFileChanges();
        const uncommitted = await this.readUncommittedFileInfo();
        const paths = uncommitted.
            filter(fileinfo => gitPathMatches(objIDs, fileinfo.path)).
            map(fileinfo => fileinfo.path);
        log.debug("C/db: Committing objects", objIDs, uncommitted, paths, message);
        if (paths.length > 0) {
            // TODO: Make Git track which files got committed (had changes),
            // and return paths
            await this.git.stageAndCommit(paths, message, removing);
        }
    }
    async discard(objIDs) {
        const paths = (await this.readUncommittedFileInfo()).
            filter(fileinfo => gitPathMatches(objIDs, fileinfo.path)).
            map(fileinfo => fileinfo.path);
        if (paths.length > 0) {
            await this.git.resetFiles(paths);
        }
    }
    async listUncommitted() {
        const files = await this.readUncommittedFileInfo();
        const objIDs = files.
            map(fileinfo => fileinfo.path);
        // Discard duplicates from the list
        return objIDs.filter(function (objID, idx, self) {
            return idx === self.indexOf(objID);
        });
    }
    async listIDs(query) {
        return await this.fs.listIDs({ subdir: query.subdir });
    }
    async getIndex(subdir, idField, onlyIDs, metaFields) {
        const idsToSelect = onlyIDs !== undefined
            ? onlyIDs.map(id => this.getRef(id))
            : undefined;
        const objs = await this.fs.readAll({ subdir, onlyIDs: idsToSelect }, metaFields);
        var idx = {};
        for (const obj of objs) {
            idx[`${obj[idField]}`] = obj;
        }
        return idx;
    }
    async update(objID, newData, metaFields) {
        await this.fs.write(this.getRef(objID), newData, metaFields);
    }
    async delete(objID) {
        await this.fs.write(this.getRef(objID), undefined);
    }
    async resetOrphanedFileChanges() {
        /* Remove from filesystem any files under our FS backend path
           that the backend cannot account for,
           but which may appear as unstaged changes to Git. */
        const orphanFilePaths = (await this.readUncommittedFileInfo()).
            map(fileinfo => fileinfo.path).
            filter(filepath => this.managers.map(mgr => mgr.managesFileAtPath(filepath)).indexOf(true) < 0);
        if (orphanFilePaths.length > 0) {
            log.warn("C/db/isogit-yaml: Resetting orphaned files", orphanFilePaths);
            await this.git.resetFiles(orphanFilePaths);
        }
    }
    async readUncommittedFileInfo() {
        /* Returns a list of objects that map Git-relative paths to actual object IDs.
           Where object ID is undefined, that implies file is “orphaned”
           (not recognized as belonging to any object managed by this store). */
        const changedFiles = await this.git.listChangedFiles(['.']);
        return await Promise.all(changedFiles.map(fp => {
            return { path: fp };
        }));
    }
    getRef(objID) {
        /* Returns FS backend reference from DB backend object ID. */
        return `${objID}`;
    }
    async synchronize() {
        await this.git.synchronize();
        for (const mgr of this.managers) {
            log.debug("C/initMain: Initializing manager");
            await mgr.init();
            await mgr.reportUpdatedData();
        }
    }
    async checkUncommitted() {
        return await this.git.checkUncommitted();
    }
    setUpIPC(dbID) {
        super.setUpIPC(dbID);
        log.verbose("C/db/isogit-yaml: Setting up IPC");
        const prefix = `db-${dbID}`;
        listen(`${prefix}-count-uncommitted`, async () => {
            return { numUncommitted: (await this.git.listChangedFiles()).length };
        });
        listen(`${prefix}-git-trigger-sync`, async () => {
            this.synchronize();
            return { started: true };
        });
        listen(`${prefix}-git-discard-unstaged`, async () => {
            await this.git.resetFiles();
            return { success: true };
        });
        listen(`${prefix}-git-update-status`, async () => {
            return { hasUncommittedChanges: await this.checkUncommitted() };
        });
        listen(`${prefix}-git-set-password`, async ({ password }) => {
            // WARNING: Don’t log password
            log.verbose("C/db/isogit-yaml: received git-set-password request");
            await this.git.setPassword(password);
            await keytar.setPassword(this.keytarCredentialsKey.service, this.keytarCredentialsKey.account, password);
            return { success: true };
        });
        listen(`${prefix}-git-request-push`, async () => {
            this.git.requestPush();
            return { success: true };
        });
        listen(`${prefix}-get-current-committer-info`, async () => {
            const authorInfo = await this.getCurrentCommitterInformation();
            return {
                username: authorInfo.username,
                email: authorInfo.email,
                name: authorInfo.name,
            };
        });
        listen(`${prefix}-git-config-get`, async () => {
            log.verbose("C/db/isogit-yaml: received git-config request");
            return {
                originURL: await this.git.getOriginUrl(),
                // name: await this.git.configGet('user.name'),
                // email: await this.git.configGet('user.email'),
                username: await this.git.configGet('credentials.username'),
            };
        });
    }
}
export const BackendClass = Backend;
export default Backend;
function gitPathMatches(objIDs, gitPath) {
    if (objIDs.indexOf(gitPath) >= 0) {
        return true;
    }
    const parsed = path.parse(gitPath);
    // Backend operates file references as paths without extensions.
    // FS wrapper expands paths, adding extension if necessary.
    // Git, however, doesn’t know about the extensions.
    // For YAML files with extensions (not directories),
    // try comparing with extensions removed.
    // Attempt to compare with directory of the file, for YAML directory
    // backend.
    return objIDs.find(id => id === parsed.dir || id === path.join(parsed.dir, parsed.name)) !== undefined;
}
//# sourceMappingURL=base.js.map