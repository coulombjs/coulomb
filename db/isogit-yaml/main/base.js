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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFzZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9kYi9pc29naXQteWFtbC9tYWluL2Jhc2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUM7QUFDcEMsT0FBTyxLQUFLLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFDL0IsT0FBTyxLQUFLLElBQUksTUFBTSxNQUFNLENBQUM7QUFDN0IsT0FBTyxLQUFLLE1BQU0sTUFBTSxRQUFRLENBQUM7QUFFakMsT0FBTyxFQUFFLE1BQU0sRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBQzNDLE9BQU8sRUFBRSxPQUFPLEVBQWtCLE1BQU0sd0JBQXdCLENBQUM7QUFHakUsT0FBTyxFQUFFLHFCQUFxQixFQUFFLE1BQU0sY0FBYyxDQUFDO0FBSXJELE9BQU8sRUFHTCwwQkFBMEIsR0FHM0IsTUFBTSxpQkFBaUIsQ0FBQztBQUl6QixPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sVUFBVSxDQUFDO0FBMkJ6QyxNQUFNLE9BQVEsU0FBUSwwQkFBMEI7SUFZOUMsWUFDWSxJQUFvQixFQUNwQixtQkFBMEM7UUFFcEQsS0FBSyxFQUFFLENBQUM7UUFIRSxTQUFJLEdBQUosSUFBSSxDQUFnQjtRQUNwQix3QkFBbUIsR0FBbkIsbUJBQW1CLENBQXVCO1FBSXBELElBQUksQ0FBQyxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQztRQUV6QixJQUFJLENBQUMsR0FBRyxHQUFHLElBQUksYUFBYSxDQUMxQixFQUFFLEVBQ0YsSUFBSSxDQUFDLElBQUksQ0FBQyxPQUFPLEVBQ2pCLElBQUksQ0FBQyxJQUFJLENBQUMsZUFBZSxFQUN6QixJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFDbEIsRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxVQUFVLEVBQUUsS0FBSyxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFF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QUFXO0lBQ1gsT0FBTyxNQUFNLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQ3RCLEVBQUUsS0FBSyxNQUFNLENBQUMsR0FBRyxJQUFJLEVBQUUsS0FBSyxJQUFJLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxHQUFHLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUMvRCxLQUFLLFNBQVMsQ0FBQztBQUNsQixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgbG9nIGZyb20gJ2VsZWN0cm9uLWxvZyc7XG5pbXBvcnQgKiBhcyBmcyBmcm9tICdmcy1leHRyYSc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0ICogYXMga2V5dGFyIGZyb20gJ2tleXRhcic7XG5cbmltcG9ydCB7IGxpc3RlbiB9IGZyb20gJy4uLy4uLy4uL2lwYy9tYWluJztcbmltcG9ydCB7IFNldHRpbmcsIFNldHRpbmdNYW5hZ2VyIH0gZnJvbSAnLi4vLi4vLi4vc2V0dGluZ3MvbWFpbic7XG5cbmltcG9ydCB7IEluZGV4IH0gZnJvbSAnLi4vLi4vcXVlcnknO1xuaW1wb3J0IHsgVW5pcXVlQ29uc3RyYWludEVycm9yIH0gZnJvbSAnLi4vLi4vZXJyb3JzJztcblxuaW1wb3J0IHsgRmlsZXN5c3RlbVdyYXBwZXIgfSBmcm9tICcuLi8uLi9tYWluL2ZzLXdyYXBwZXInO1xuXG5pbXBvcnQge1xuICBCYWNrZW5kQ2xhc3MgYXMgQmFzZUJhY2tlbmRDbGFzcyxcbiAgQmFja2VuZFN0YXR1c1JlcG9ydGVyIGFzIEJhc2VCYWNrZW5kU3RhdHVzUmVwb3J0ZXIsXG4gIFZlcnNpb25lZEZpbGVzeXN0ZW1CYWNrZW5kLFxuICBNb2RlbE1hbmFnZXIsXG4gIEZpbGVzeXN0ZW1NYW5hZ2VyLFxufSBmcm9tICcuLi8uLi9tYWluL2Jhc2UnO1xuXG5pbXBvcnQgeyBCYWNrZW5kRGVzY3JpcHRpb24sIEJhY2tlbmRTdGF0dXMgfSBmcm9tICcuLi9iYXNlJztcblxuaW1wb3J0IHsgSXNvR2l0V3JhcHBlciB9IGZyb20gJy4vaXNvZ2l0JztcblxuXG5pbnRlcmZhY2UgRml4ZWRCYWNrZW5kT3B0aW9ucyB7XG4gIC8qIFNldHRpbmdzIHN1cHBsaWVkIGJ5IHRoZSBkZXZlbG9wZXIgKi9cblxuICB3b3JrRGlyOiBzdHJpbmdcbiAgY29yc1Byb3h5VVJMPzogc3RyaW5nXG4gIHVwc3RyZWFtUmVwb1VSTD86IHN0cmluZ1xuICBmc1dyYXBwZXJDbGFzczogbmV3IChiYXNlRGlyOiBzdHJpbmcpID0+IEZpbGVzeXN0ZW1XcmFwcGVyPGFueT5cbn1cbmludGVyZmFjZSBDb25maWd1cmFibGVCYWNrZW5kT3B0aW9ucyB7XG4gIC8qIFNldHRpbmdzIHRoYXQgdXNlciBjYW4gb3IgbXVzdCBzcGVjaWZ5ICovXG4gIHJlcG9VUkw6IHN0cmluZ1xuICB1c2VybmFtZTogc3RyaW5nXG4gIGF1dGhvck5hbWU6IHN0cmluZ1xuICBhdXRob3JFbWFpbDogc3RyaW5nXG59XG50eXBlIEJhY2tlbmRPcHRpb25zID0gRml4ZWRCYWNrZW5kT3B0aW9ucyAmIENvbmZpZ3VyYWJsZUJhY2tlbmRPcHRpb25zICYge1xuICBmc1dyYXBwZXI6IEZpbGVzeXN0ZW1XcmFwcGVyPGFueT5cbn1cbnR5cGUgSW5pdGlhbEJhY2tlbmRPcHRpb25zID0gRml4ZWRCYWNrZW5kT3B0aW9ucyAmIFBhcnRpYWw8Q29uZmlndXJhYmxlQmFja2VuZE9wdGlvbnM+XG5cblxudHlwZSBCYWNrZW5kU3RhdHVzUmVwb3J0ZXIgPSBCYXNlQmFja2VuZFN0YXR1c1JlcG9ydGVyPEJhY2tlbmRTdGF0dXM+XG5cblxuY2xhc3MgQmFja2VuZCBleHRlbmRzIFZlcnNpb25lZEZpbGVzeXN0ZW1CYWNrZW5kIHtcbiAgLyogQ29tYmluZXMgYSBmaWxlc3lzdGVtIHN0b3JhZ2Ugd2l0aCBHaXQuICovXG5cbiAgcHJpdmF0ZSBnaXQ6IElzb0dpdFdyYXBwZXI7XG4gIHByaXZhdGUgZnM6IEZpbGVzeXN0ZW1XcmFwcGVyPGFueT47XG4gIHByaXZhdGUgbWFuYWdlcnM6IChGaWxlc3lzdGVtTWFuYWdlciAmIE1vZGVsTWFuYWdlcjxhbnksIGFueSwgYW55PilbXTtcblxuICBwcml2YXRlIGtleXRhckNyZWRlbnRpYWxzS2V5OiB7XG4gICAgc2VydmljZTogc3RyaW5nXG4gICAgYWNjb3VudDogc3RyaW5nXG4gIH1cblxuICBjb25zdHJ1Y3RvcihcbiAgICAgIHByaXZhdGUgb3B0czogQmFja2VuZE9wdGlvbnMsXG4gICAgICBwcml2YXRlIHJlcG9ydEJhY2tlbmRTdGF0dXM6IEJhY2tlbmRTdGF0dXNSZXBvcnRlcikge1xuXG4gICAgc3VwZXIoKTtcblxuICAgIHRoaXMuZnMgPSBvcHRzLmZzV3JhcHBlcjtcblxuICAgIHRoaXMuZ2l0ID0gbmV3IElzb0dpdFdyYXBwZXIoXG4gICAgICBmcyxcbiAgICAgIHRoaXMub3B0cy5yZXBvVVJMLFxuICAgICAgdGhpcy5vcHRzLnVwc3RyZWFtUmVwb1VSTCxcbiAgICAgIHRoaXMub3B0cy51c2VybmFtZSxcbiAgICAgIHsgbmFtZTogdGhpcy5vcHRzLmF1dGhvck5hbWUsIGVtYWlsOiB0aGlzLm9wdHMuYXV0aG9yRW1haWwgfSxcbiAgICAgIHRoaXMub3B0cy53b3JrRGlyLFxuICAgICAgdGhpcy5vcHRzLmNvcnNQcm94eVVSTCxcblxuICAgICAgLy8gVGhlIHN0YXR1cyBvZiB0aGlzIGJhY2tlbmQgaXMgcmVkdWNlZCB0byBHaXQgcmVwbyBzdGF0dXMgbm93LlxuICAgICAgLy8gUG90ZW50aWFsbHkgaXQgc2hvdWxkIGluY2x1ZGUgZmlsZXN5c3RlbS1yZWxhdGVkIHN0YXR1cyBhcyB3ZWxsLFxuICAgICAgLy8gcmVwb3J0aW5nIGlzc3VlcyB3aXRoIGUuZy4gaW5zdWZmaWNpZW50IGRpc2sgc3BhY2UuXG4gICAgICB0aGlzLnJlcG9ydEJhY2tlbmRTdGF0dXMsXG4gICAgKTtcblxuICAgIHRoaXMubWFuYWdlcnMgPSBbXTtcblxuICAgIHRoaXMua2V5dGFyQ3JlZGVudGlhbHNLZXkgPSB7XG4gICAgICBzZXJ2aWNlOiBgcmVwby0ke3RoaXMub3B0cy5yZXBvVVJMfWAsXG4gICAgICBhY2NvdW50OiB0aGlzLm9wdHMudXNlcm5hbWUsXG4gICAgfTtcblxuICAgIHRoaXMuc3luY2hyb25pemUgPSB0aGlzLnN5bmNocm9uaXplLmJpbmQodGhpcyk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgZ2V0TG9jYWxGaWxlc3lzdGVtUGF0aChpZDogc3RyaW5nKSB7XG4gICAgcmV0dXJuIHRoaXMuZnMuZXhwYW5kUGF0aChpZCk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgZ2V0Q3VycmVudENvbW1pdHRlckluZm9ybWF0aW9uKCk6IFByb21pc2U8eyB1c2VybmFtZTogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIGVtYWlsOiBzdHJpbmcgfT4ge1xuICAgIHJldHVybiB7XG4gICAgICB1c2VybmFtZTogdGhpcy5vcHRzLnVzZXJuYW1lLFxuICAgICAgbmFtZTogdGhpcy5vcHRzLmF1dGhvck5hbWUsXG4gICAgICBlbWFpbDogdGhpcy5vcHRzLmF1dGhvckVtYWlsLFxuICAgIH07XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgZGVzY3JpYmUoKTogUHJvbWlzZTxCYWNrZW5kRGVzY3JpcHRpb24+IHtcbiAgICByZXR1cm4ge1xuICAgICAgdmVyYm9zZU5hbWU6IFwiR2l0K1lBTUxcIixcbiAgICAgIHZlcmJvc2VOYW1lTG9uZzogXCJHaXQtdmVyc2lvbmVkIFlBTUwgZmlsZSB0cmVlXCIsXG4gICAgICBnaXRSZXBvOiB0aGlzLm9wdHMucmVwb1VSTCxcbiAgICAgIGdpdFVzZXJuYW1lOiB0aGlzLm9wdHMudXNlcm5hbWUsXG4gICAgICBsb2NhbENsb25lUGF0aDogdGhpcy5vcHRzLndvcmtEaXIsXG4gICAgICBzdGF0dXM6IHRoaXMuZ2l0LmdldFN0YXR1cygpLFxuICAgIH1cbiAgfVxuXG4gIHB1YmxpYyBzdGF0aWMgcmVnaXN0ZXJTZXR0aW5nc0ZvckNvbmZpZ3VyYWJsZU9wdGlvbnMoXG4gICAgICBzZXR0aW5nczogU2V0dGluZ01hbmFnZXIsXG4gICAgICBpbml0aWFsT3B0aW9uczogSW5pdGlhbEJhY2tlbmRPcHRpb25zLFxuICAgICAgZGJJRDogc3RyaW5nKSB7XG5cbiAgICBjb25zdCBwYW5lTGFiZWxQb3N0Zml4ID0gZGJJRCAhPT0gJ2RlZmF1bHQnID8gYCBmb3Ig4oCcJHtkYklEfeKAnWAgOiAnJztcbiAgICBjb25zdCBzZXR0aW5nSURQcmVmaXggPSBgZGJfJHtkYklEfV9gO1xuICAgIGNvbnN0IHBhbmVJRCA9IGBkYl8ke2RiSUR9YDtcblxuICAgIHNldHRpbmdzLmNvbmZpZ3VyZVBhbmUoe1xuICAgICAgaWQ6IHBhbmVJRCxcbiAgICAgIGxhYmVsOiBgRGF0YWJhc2Ugc2V0dGluZ3Mke3BhbmVMYWJlbFBvc3RmaXh9YCxcbiAgICAgIGljb246ICdnaXQtbWVyZ2UnLFxuICAgIH0pO1xuXG4gICAgc2V0dGluZ3MucmVnaXN0ZXIobmV3IFNldHRpbmc8c3RyaW5nPihcbiAgICAgIHBhbmVJRCxcbiAgICAgIGAke3NldHRpbmdJRFByZWZpeH1naXRSZXBvVXJsYCxcbiAgICAgICd0ZXh0JyxcbiAgICAgIGluaXRpYWxPcHRpb25zLnJlcG9VUkwgPT09IHVuZGVmaW5lZCxcbiAgICAgIFwiR2l0IHJlcG9zaXRvcnkgVVJMXCIsXG4gICAgICBcIkUuZy4sIGh0dHBzOi8vZ2l0aHViLmNvbS88dXNlcm5hbWU+LzxyZXBvc2l0b3J5IG5hbWU+XCIsXG4gICAgKSk7XG5cbiAgICBzZXR0aW5ncy5yZWdpc3RlcihuZXcgU2V0dGluZzxzdHJpbmc+KFxuICAgICAgcGFuZUlELFxuICAgICAgYCR7c2V0dGluZ0lEUHJlZml4fWdpdFVzZXJuYW1lYCxcbiAgICAgICd0ZXh0JyxcbiAgICAgIGluaXRpYWxPcHRpb25zLnVzZXJuYW1lID09PSB1bmRlZmluZWQsXG4gICAgICBcIkdpdCB1c2VybmFtZVwiLFxuICAgICkpO1xuXG4gICAgc2V0dGluZ3MucmVnaXN0ZXIobmV3IFNldHRpbmc8c3RyaW5nPihcbiAgICAgIHBhbmVJRCxcbiAgICAgIGAke3NldHRpbmdJRFByZWZpeH1naXRBdXRob3JOYW1lYCxcbiAgICAgICd0ZXh0JyxcbiAgICAgIGluaXRpYWxPcHRpb25zLmF1dGhvck5hbWUgPT09IHVuZGVmaW5lZCxcbiAgICAgIFwiR2l0IGF1dGhvciBuYW1lXCIsXG4gICAgKSk7XG5cbiAgICBzZXR0aW5ncy5yZWdpc3RlcihuZXcgU2V0dGluZzxzdHJpbmc+KFxuICAgICAgcGFuZUlELFxuICAgICAgYCR7c2V0dGluZ0lEUHJlZml4fWdpdEF1dGhvckVtYWlsYCxcbiAgICAgICd0ZXh0JyxcbiAgICAgIGluaXRpYWxPcHRpb25zLmF1dGhvckVtYWlsID09PSB1bmRlZmluZWQsXG4gICAgICBcIkdpdCBhdXRob3IgZW1haWxcIixcbiAgICApKTtcbiAgfVxuXG4gIHB1YmxpYyBzdGF0aWMgYXN5bmMgY29tcGxldGVPcHRpb25zRnJvbVNldHRpbmdzKFxuICAgICAgc2V0dGluZ3M6IFNldHRpbmdNYW5hZ2VyLFxuICAgICAgYXZhaWxhYmxlT3B0aW9uczogSW5pdGlhbEJhY2tlbmRPcHRpb25zLFxuICAgICAgZGJJRDogc3RyaW5nKSB7XG5cbiAgICBjb25zdCBzZXR0aW5nSURQcmVmaXggPSBgZGJfJHtkYklEfV9gO1xuXG4gICAgYXN5bmMgZnVuY3Rpb24gZ2V0U2V0dGluZzxUPihzZXR0aW5nSUQ6IHN0cmluZyk6IFByb21pc2U8VD4ge1xuICAgICAgcmV0dXJuIGF3YWl0IHNldHRpbmdzLmdldFZhbHVlKGAke3NldHRpbmdJRFByZWZpeH0ke3NldHRpbmdJRH1gKSBhcyBUO1xuICAgIH1cblxuICAgIGNvbnN0IGZzV3JhcHBlckNsYXNzID0gYXZhaWxhYmxlT3B0aW9ucy5mc1dyYXBwZXJDbGFzcztcblxuICAgIHJldHVybiB7XG4gICAgICB3b3JrRGlyOiBhdmFpbGFibGVPcHRpb25zLndvcmtEaXIsXG4gICAgICBjb3JzUHJveHlVUkw6IGF2YWlsYWJsZU9wdGlvbnMuY29yc1Byb3h5VVJMLFxuICAgICAgdXBzdHJlYW1SZXBvVVJMOiBhdmFpbGFibGVPcHRpb25zLnVwc3RyZWFtUmVwb1VSTCxcbiAgICAgIGZzV3JhcHBlckNsYXNzOiBhdmFpbGFibGVPcHRpb25zLmZzV3JhcHBlckNsYXNzLFxuICAgICAgZnNXcmFwcGVyOiBuZXcgZnNXcmFwcGVyQ2xhc3MoYXZhaWxhYmxlT3B0aW9ucy53b3JrRGlyKSxcblxuICAgICAgcmVwb1VSTDogKFxuICAgICAgICAoYXdhaXQgZ2V0U2V0dGluZzxzdHJpbmc+KCdnaXRSZXBvVXJsJykpXG4gICAgICAgIHx8IGF2YWlsYWJsZU9wdGlvbnMucmVwb1VSTCkgYXMgc3RyaW5nLFxuICAgICAgdXNlcm5hbWU6IChcbiAgICAgICAgKGF3YWl0IGdldFNldHRpbmc8c3RyaW5nPignZ2l0VXNlcm5hbWUnKSlcbiAgICAgICAgfHwgYXZhaWxhYmxlT3B0aW9ucy51c2VybmFtZSkgYXMgc3RyaW5nLFxuICAgICAgYXV0aG9yTmFtZTogKFxuICAgICAgICAoYXdhaXQgZ2V0U2V0dGluZzxzdHJpbmc+KCdnaXRBdXRob3JOYW1lJykpXG4gICAgICAgIHx8IGF2YWlsYWJsZU9wdGlvbnMuYXV0aG9yTmFtZSkgYXMgc3RyaW5nLFxuICAgICAgYXV0aG9yRW1haWw6IChcbiAgICAgICAgKGF3YWl0IGdldFNldHRpbmc8c3RyaW5nPignZ2l0QXV0aG9yRW1haWwnKSlcbiAgICAgICAgfHwgYXZhaWxhYmxlT3B0aW9ucy5hdXRob3JFbWFpbCkgYXMgc3RyaW5nLFxuICAgIH1cbiAgfVxuXG4gIHB1YmxpYyBhc3luYyByZWdpc3Rlck1hbmFnZXIobWFuYWdlcjogRmlsZXN5c3RlbU1hbmFnZXIgJiBNb2RlbE1hbmFnZXI8YW55LCBhbnksIGFueT4pIHtcbiAgICB0aGlzLm1hbmFnZXJzLnB1c2gobWFuYWdlcik7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgaW5pdChmb3JjZVJlc2V0ID0gZmFsc2UpIHtcbiAgICBsZXQgZG9Jbml0aWFsaXplOiBib29sZWFuO1xuXG4gICAgdHJ5IHtcbiAgICAgIGlmIChmb3JjZVJlc2V0ID09PSB0cnVlKSB7XG4gICAgICAgIGxvZy53YXJuKFwiQy9kYi9pc29naXQteWFtbDogR2l0IGlzIGJlaW5nIGZvcmNlIHJlaW5pdGlhbGl6ZWRcIik7XG4gICAgICAgIGRvSW5pdGlhbGl6ZSA9IHRydWU7XG4gICAgICB9IGVsc2UgaWYgKCEoYXdhaXQgdGhpcy5naXQuaXNVc2luZ1JlbW90ZVVSTHMoeyBvcmlnaW46IHRoaXMub3B0cy5yZXBvVVJMIH0pKSkge1xuICAgICAgICBsb2cud2FybihcIkMvZGIvaXNvZ2l0LXlhbWw6IEdpdCBoYXMgbWlzbWF0Y2hpbmcgcmVtb3RlIFVSTChzKSwgcmVpbml0aWFsaXppbmdcIik7XG4gICAgICAgIGRvSW5pdGlhbGl6ZSA9IHRydWU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBsb2cuaW5mbyhcIkMvZGIvaXNvZ2l0LXlhbWw6IEdpdCBpcyBhbHJlYWR5IGluaXRpYWxpemVkXCIpO1xuICAgICAgICBkb0luaXRpYWxpemUgPSBmYWxzZTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBkb0luaXRpYWxpemUgPSB0cnVlO1xuICAgIH1cblxuICAgIGlmIChkb0luaXRpYWxpemUpIHtcbiAgICAgIGF3YWl0IHRoaXMuZ2l0LmRlc3Ryb3koKTtcbiAgICB9XG5cbiAgICBjb25zdCBwd2QgPSBhd2FpdCBrZXl0YXIuZ2V0UGFzc3dvcmQoXG4gICAgICB0aGlzLmtleXRhckNyZWRlbnRpYWxzS2V5LnNlcnZpY2UsXG4gICAgICB0aGlzLmtleXRhckNyZWRlbnRpYWxzS2V5LmFjY291bnQpO1xuXG4gICAgaWYgKHB3ZCAhPT0gbnVsbCAmJiBwd2QudHJpbSgpICE9PSAnJykge1xuICAgICAgYXdhaXQgdGhpcy5naXQuc2V0UGFzc3dvcmQocHdkKTtcbiAgICB9XG5cbiAgICBhd2FpdCB0aGlzLnN5bmNocm9uaXplKCk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgcmVhZChvYmpJRDogc3RyaW5nLCBtZXRhRmllbGRzPzogc3RyaW5nW10pIHtcbiAgICByZXR1cm4gYXdhaXQgdGhpcy5mcy5yZWFkKHRoaXMuZ2V0UmVmKG9iaklEKSwgbWV0YUZpZWxkcykgYXMgb2JqZWN0O1xuICB9XG5cbiAgcHVibGljIGFzeW5jIHJlYWRWZXJzaW9uKG9iaklEOiBzdHJpbmcsIHZlcnNpb246IHN0cmluZykge1xuICAgIC8vIE5PVEU6IFRoaXMgd2lsbCBmYWlsIHdpdGggWUFNTERpcmVjdG9yeVdyYXBwZXIuXG4gICAgLy8gb2JqSUQgbXVzdCByZWZlciB0byBhIHNpbmdsZSBmaWxlLlxuXG4gICAgLy8gVE9ETzogU3VwcG9ydCBjb21wb3VuZCBvYmplY3RzIChkaXJlY3RvcmllcylcbiAgICAvLyBieSBtb3ZpbmcgdGhlIGZpbGUgZGF0YSBwYXJzaW5nIGxvZ2ljIGludG8gbWFuYWdlclxuICAgIC8vIGFuZCBhZGRpbmcgQmFja2VuZC5yZWFkVHJlZSgpLlxuXG4gICAgY29uc3QgYmxvYiA9IGF3YWl0IHRoaXMuZ2l0LnJlYWRGaWxlQmxvYkF0Q29tbWl0KHRoaXMuZ2V0UmVmKG9iaklEKSwgdmVyc2lvbik7XG4gICAgcmV0dXJuIHRoaXMuZnMucGFyc2VEYXRhKGJsb2IpO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGNyZWF0ZTxPIGV4dGVuZHMgUmVjb3JkPHN0cmluZywgYW55Pj4ob2JqOiBPLCBvYmpQYXRoOiBzdHJpbmcsIG1ldGFGaWVsZHM/OiAoa2V5b2YgTylbXSkge1xuICAgIGlmIChhd2FpdCB0aGlzLmZzLmV4aXN0cyhvYmpQYXRoKSkge1xuICAgICAgdGhyb3cgbmV3IFVuaXF1ZUNvbnN0cmFpbnRFcnJvcihcImZpbGVzeXN0ZW0gcGF0aFwiLCBvYmpQYXRoKTtcbiAgICB9XG5cbiAgICBhd2FpdCB0aGlzLmZzLndyaXRlKG9ialBhdGgsIG9iaiwgbWV0YUZpZWxkcyk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgY29tbWl0QWxsKG1zZzogc3RyaW5nLCByZW1vdmluZzogYm9vbGVhbikge1xuICAgIC8vIE5PVEU6IFVzZSB3aXRoIGNhcmUuXG5cbiAgICBhd2FpdCB0aGlzLmdpdC5zdGFnZUFuZENvbW1pdChbJy4nXSwgbXNnLCByZW1vdmluZyk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgY29tbWl0KG9iaklEczogc3RyaW5nW10sIG1lc3NhZ2U6IHN0cmluZywgcmVtb3ZpbmcgPSBmYWxzZSkge1xuICAgIGF3YWl0IHRoaXMucmVzZXRPcnBoYW5lZEZpbGVDaGFuZ2VzKCk7XG5cbiAgICBjb25zdCB1bmNvbW1pdHRlZCA9IGF3YWl0IHRoaXMucmVhZFVuY29tbWl0dGVkRmlsZUluZm8oKTtcblxuICAgIGNvbnN0IHBhdGhzOiBzdHJpbmdbXSA9IHVuY29tbWl0dGVkLlxuICAgICAgZmlsdGVyKGZpbGVpbmZvID0+IGdpdFBhdGhNYXRjaGVzKG9iaklEcywgZmlsZWluZm8ucGF0aCkpLlxuICAgICAgbWFwKGZpbGVpbmZvID0+IGZpbGVpbmZvLnBhdGgpO1xuXG4gICAgbG9nLmRlYnVnKFwiQy9kYjogQ29tbWl0dGluZyBvYmplY3RzXCIsIG9iaklEcywgdW5jb21taXR0ZWQsIHBhdGhzLCBtZXNzYWdlKTtcblxuICAgIGlmIChwYXRocy5sZW5ndGggPiAwKSB7XG4gICAgICAvLyBUT0RPOiBNYWtlIEdpdCB0cmFjayB3aGljaCBmaWxlcyBnb3QgY29tbWl0dGVkIChoYWQgY2hhbmdlcyksXG4gICAgICAvLyBhbmQgcmV0dXJuIHBhdGhzXG4gICAgICBhd2FpdCB0aGlzLmdpdC5zdGFnZUFuZENvbW1pdChwYXRocywgbWVzc2FnZSwgcmVtb3ZpbmcpO1xuICAgIH1cbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBkaXNjYXJkKG9iaklEczogc3RyaW5nW10pIHtcbiAgICBjb25zdCBwYXRoczogc3RyaW5nW10gPSAoYXdhaXQgdGhpcy5yZWFkVW5jb21taXR0ZWRGaWxlSW5mbygpKS5cbiAgICAgIGZpbHRlcihmaWxlaW5mbyA9PiBnaXRQYXRoTWF0Y2hlcyhvYmpJRHMsIGZpbGVpbmZvLnBhdGgpKS5cbiAgICAgIG1hcChmaWxlaW5mbyA9PiBmaWxlaW5mby5wYXRoKTtcblxuICAgIGlmIChwYXRocy5sZW5ndGggPiAwKSB7XG4gICAgICBhd2FpdCB0aGlzLmdpdC5yZXNldEZpbGVzKHBhdGhzKTtcbiAgICB9XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgbGlzdFVuY29tbWl0dGVkKCkge1xuICAgIGNvbnN0IGZpbGVzID0gYXdhaXQgdGhpcy5yZWFkVW5jb21taXR0ZWRGaWxlSW5mbygpO1xuXG4gICAgY29uc3Qgb2JqSURzOiBzdHJpbmdbXSA9IGZpbGVzLlxuICAgICAgbWFwKGZpbGVpbmZvID0+IGZpbGVpbmZvLnBhdGgpO1xuXG4gICAgLy8gRGlzY2FyZCBkdXBsaWNhdGVzIGZyb20gdGhlIGxpc3RcbiAgICByZXR1cm4gb2JqSURzLmZpbHRlcihmdW5jdGlvbiAob2JqSUQsIGlkeCwgc2VsZikge1xuICAgICAgcmV0dXJuIGlkeCA9PT0gc2VsZi5pbmRleE9mKG9iaklEKTtcbiAgICB9KTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBsaXN0SURzKHF1ZXJ5OiB7IHN1YmRpcjogc3RyaW5nIH0pIHtcbiAgICByZXR1cm4gYXdhaXQgdGhpcy5mcy5saXN0SURzKHsgc3ViZGlyOiBxdWVyeS5zdWJkaXIgfSk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgZ2V0SW5kZXgoc3ViZGlyOiBzdHJpbmcsIGlkRmllbGQ6IHN0cmluZywgb25seUlEcz86IHN0cmluZ1tdLCBtZXRhRmllbGRzPzogc3RyaW5nW10pIHtcbiAgICBjb25zdCBpZHNUb1NlbGVjdCA9IG9ubHlJRHMgIT09IHVuZGVmaW5lZFxuICAgICAgPyBvbmx5SURzLm1hcChpZCA9PiB0aGlzLmdldFJlZihpZCkpXG4gICAgICA6IHVuZGVmaW5lZDtcblxuICAgIGNvbnN0IG9ianMgPSBhd2FpdCB0aGlzLmZzLnJlYWRBbGwoeyBzdWJkaXIsIG9ubHlJRHM6IGlkc1RvU2VsZWN0IH0sIG1ldGFGaWVsZHMpO1xuXG4gICAgdmFyIGlkeDogSW5kZXg8YW55PiA9IHt9O1xuICAgIGZvciAoY29uc3Qgb2JqIG9mIG9ianMpIHtcbiAgICAgIGlkeFtgJHtvYmpbaWRGaWVsZF19YF0gPSBvYmo7XG4gICAgfVxuXG4gICAgcmV0dXJuIGlkeDtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyB1cGRhdGUob2JqSUQ6IHN0cmluZywgbmV3RGF0YTogUmVjb3JkPHN0cmluZywgYW55PiwgbWV0YUZpZWxkcz86IHN0cmluZ1tdKSB7XG4gICAgYXdhaXQgdGhpcy5mcy53cml0ZSh0aGlzLmdldFJlZihvYmpJRCksIG5ld0RhdGEsIG1ldGFGaWVsZHMpO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGRlbGV0ZShvYmpJRDogc3RyaW5nKSB7XG4gICAgYXdhaXQgdGhpcy5mcy53cml0ZSh0aGlzLmdldFJlZihvYmpJRCksIHVuZGVmaW5lZCk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgcmVzZXRPcnBoYW5lZEZpbGVDaGFuZ2VzKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIC8qIFJlbW92ZSBmcm9tIGZpbGVzeXN0ZW0gYW55IGZpbGVzIHVuZGVyIG91ciBGUyBiYWNrZW5kIHBhdGhcbiAgICAgICB0aGF0IHRoZSBiYWNrZW5kIGNhbm5vdCBhY2NvdW50IGZvcixcbiAgICAgICBidXQgd2hpY2ggbWF5IGFwcGVhciBhcyB1bnN0YWdlZCBjaGFuZ2VzIHRvIEdpdC4gKi9cblxuICAgIGNvbnN0IG9ycGhhbkZpbGVQYXRocyA9IChhd2FpdCB0aGlzLnJlYWRVbmNvbW1pdHRlZEZpbGVJbmZvKCkpLlxuICAgIG1hcChmaWxlaW5mbyA9PiBmaWxlaW5mby5wYXRoKS5cbiAgICBmaWx0ZXIoZmlsZXBhdGggPT4gdGhpcy5tYW5hZ2Vycy5tYXAobWdyID0+IG1nci5tYW5hZ2VzRmlsZUF0UGF0aChmaWxlcGF0aCkpLmluZGV4T2YodHJ1ZSkgPCAwKTtcblxuICAgIGlmIChvcnBoYW5GaWxlUGF0aHMubGVuZ3RoID4gMCkge1xuICAgICAgbG9nLndhcm4oXCJDL2RiL2lzb2dpdC15YW1sOiBSZXNldHRpbmcgb3JwaGFuZWQgZmlsZXNcIiwgb3JwaGFuRmlsZVBhdGhzKTtcbiAgICAgIGF3YWl0IHRoaXMuZ2l0LnJlc2V0RmlsZXMob3JwaGFuRmlsZVBhdGhzKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlYWRVbmNvbW1pdHRlZEZpbGVJbmZvKCk6IFByb21pc2U8eyBwYXRoOiBzdHJpbmcgfVtdPiB7XG4gICAgLyogUmV0dXJucyBhIGxpc3Qgb2Ygb2JqZWN0cyB0aGF0IG1hcCBHaXQtcmVsYXRpdmUgcGF0aHMgdG8gYWN0dWFsIG9iamVjdCBJRHMuXG4gICAgICAgV2hlcmUgb2JqZWN0IElEIGlzIHVuZGVmaW5lZCwgdGhhdCBpbXBsaWVzIGZpbGUgaXMg4oCcb3JwaGFuZWTigJ1cbiAgICAgICAobm90IHJlY29nbml6ZWQgYXMgYmVsb25naW5nIHRvIGFueSBvYmplY3QgbWFuYWdlZCBieSB0aGlzIHN0b3JlKS4gKi9cblxuICAgIGNvbnN0IGNoYW5nZWRGaWxlczogc3RyaW5nW10gPSBhd2FpdCB0aGlzLmdpdC5saXN0Q2hhbmdlZEZpbGVzKFsnLiddKTtcbiAgICByZXR1cm4gYXdhaXQgUHJvbWlzZS5hbGwoY2hhbmdlZEZpbGVzLm1hcChmcCA9PiB7XG4gICAgICByZXR1cm4geyBwYXRoOiBmcCB9O1xuICAgIH0pKTtcbiAgfVxuXG4gIHByaXZhdGUgZ2V0UmVmKG9iaklEOiBzdHJpbmcgfCBudW1iZXIpOiBzdHJpbmcge1xuICAgIC8qIFJldHVybnMgRlMgYmFja2VuZCByZWZlcmVuY2UgZnJvbSBEQiBiYWNrZW5kIG9iamVjdCBJRC4gKi9cbiAgICByZXR1cm4gYCR7b2JqSUR9YDtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgc3luY2hyb25pemUoKSB7XG4gICAgYXdhaXQgdGhpcy5naXQuc3luY2hyb25pemUoKTtcblxuICAgIGZvciAoY29uc3QgbWdyIG9mIHRoaXMubWFuYWdlcnMpIHtcbiAgICAgIGxvZy5kZWJ1ZyhcIkMvaW5pdE1haW46IEluaXRpYWxpemluZyBtYW5hZ2VyXCIpO1xuICAgICAgYXdhaXQgbWdyLmluaXQoKTtcbiAgICAgIGF3YWl0IG1nci5yZXBvcnRVcGRhdGVkRGF0YSgpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgY2hlY2tVbmNvbW1pdHRlZCgpIHtcbiAgICByZXR1cm4gYXdhaXQgdGhpcy5naXQuY2hlY2tVbmNvbW1pdHRlZCgpO1xuICB9XG5cbiAgcHVibGljIHNldFVwSVBDKGRiSUQ6IHN0cmluZykge1xuICAgIHN1cGVyLnNldFVwSVBDKGRiSUQpO1xuXG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdC15YW1sOiBTZXR0aW5nIHVwIElQQ1wiKTtcblxuICAgIGNvbnN0IHByZWZpeCA9IGBkYi0ke2RiSUR9YDtcblxuICAgIGxpc3Rlbjx7fSwgeyBudW1VbmNvbW1pdHRlZDogbnVtYmVyIH0+XG4gICAgKGAke3ByZWZpeH0tY291bnQtdW5jb21taXR0ZWRgLCBhc3luYyAoKSA9PiB7XG4gICAgICByZXR1cm4geyBudW1VbmNvbW1pdHRlZDogKGF3YWl0IHRoaXMuZ2l0Lmxpc3RDaGFuZ2VkRmlsZXMoKSkubGVuZ3RoIH07XG4gICAgfSk7XG5cbiAgICBsaXN0ZW48e30sIHsgc3RhcnRlZDogdHJ1ZSB9PlxuICAgIChgJHtwcmVmaXh9LWdpdC10cmlnZ2VyLXN5bmNgLCBhc3luYyAoKSA9PiB7XG4gICAgICB0aGlzLnN5bmNocm9uaXplKCk7XG4gICAgICByZXR1cm4geyBzdGFydGVkOiB0cnVlIH07XG4gICAgfSk7XG5cbiAgICBsaXN0ZW48e30sIHsgc3VjY2VzczogdHJ1ZSB9PlxuICAgIChgJHtwcmVmaXh9LWdpdC1kaXNjYXJkLXVuc3RhZ2VkYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgdGhpcy5naXQucmVzZXRGaWxlcygpO1xuICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSB9O1xuICAgIH0pO1xuXG4gICAgbGlzdGVuPHt9LCB7IGhhc1VuY29tbWl0dGVkQ2hhbmdlczogYm9vbGVhbiB9PlxuICAgIChgJHtwcmVmaXh9LWdpdC11cGRhdGUtc3RhdHVzYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgcmV0dXJuIHsgaGFzVW5jb21taXR0ZWRDaGFuZ2VzOiBhd2FpdCB0aGlzLmNoZWNrVW5jb21taXR0ZWQoKSB9O1xuICAgIH0pO1xuXG4gICAgbGlzdGVuPHsgcGFzc3dvcmQ6IHN0cmluZyB9LCB7IHN1Y2Nlc3M6IHRydWUgfT5cbiAgICAoYCR7cHJlZml4fS1naXQtc2V0LXBhc3N3b3JkYCwgYXN5bmMgKHsgcGFzc3dvcmQgfSkgPT4ge1xuICAgICAgLy8gV0FSTklORzogRG9u4oCZdCBsb2cgcGFzc3dvcmRcbiAgICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQteWFtbDogcmVjZWl2ZWQgZ2l0LXNldC1wYXNzd29yZCByZXF1ZXN0XCIpO1xuXG4gICAgICBhd2FpdCB0aGlzLmdpdC5zZXRQYXNzd29yZChwYXNzd29yZCk7XG5cbiAgICAgIGF3YWl0IGtleXRhci5zZXRQYXNzd29yZChcbiAgICAgICAgdGhpcy5rZXl0YXJDcmVkZW50aWFsc0tleS5zZXJ2aWNlLFxuICAgICAgICB0aGlzLmtleXRhckNyZWRlbnRpYWxzS2V5LmFjY291bnQsXG4gICAgICAgIHBhc3N3b3JkKTtcblxuICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSB9O1xuICAgIH0pO1xuXG4gICAgbGlzdGVuPHt9LCB7IHN1Y2Nlc3M6IHRydWUgfT5cbiAgICAoYCR7cHJlZml4fS1naXQtcmVxdWVzdC1wdXNoYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgdGhpcy5naXQucmVxdWVzdFB1c2goKTtcbiAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IHRydWUgfTtcbiAgICB9KTtcblxuICAgIGxpc3Rlbjx7fSwgeyB1c2VybmFtZTogc3RyaW5nLCBlbWFpbDogc3RyaW5nLCBuYW1lOiBzdHJpbmcgfT5cbiAgICAoYCR7cHJlZml4fS1nZXQtY3VycmVudC1jb21taXR0ZXItaW5mb2AsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGF1dGhvckluZm8gPSBhd2FpdCB0aGlzLmdldEN1cnJlbnRDb21taXR0ZXJJbmZvcm1hdGlvbigpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdXNlcm5hbWU6IGF1dGhvckluZm8udXNlcm5hbWUsXG4gICAgICAgIGVtYWlsOiBhdXRob3JJbmZvLmVtYWlsLFxuICAgICAgICBuYW1lOiBhdXRob3JJbmZvLm5hbWUsXG4gICAgICB9O1xuICAgIH0pO1xuXG4gICAgbGlzdGVuPHt9LCB7IG9yaWdpblVSTDogc3RyaW5nIHwgbnVsbCwgdXNlcm5hbWU6IHN0cmluZyB8IG51bGwgfT5cbiAgICAoYCR7cHJlZml4fS1naXQtY29uZmlnLWdldGAsIGFzeW5jICgpID0+IHtcbiAgICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQteWFtbDogcmVjZWl2ZWQgZ2l0LWNvbmZpZyByZXF1ZXN0XCIpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb3JpZ2luVVJMOiBhd2FpdCB0aGlzLmdpdC5nZXRPcmlnaW5VcmwoKSxcbiAgICAgICAgLy8gbmFtZTogYXdhaXQgdGhpcy5naXQuY29uZmlnR2V0KCd1c2VyLm5hbWUnKSxcbiAgICAgICAgLy8gZW1haWw6IGF3YWl0IHRoaXMuZ2l0LmNvbmZpZ0dldCgndXNlci5lbWFpbCcpLFxuICAgICAgICB1c2VybmFtZTogYXdhaXQgdGhpcy5naXQuY29uZmlnR2V0KCdjcmVkZW50aWFscy51c2VybmFtZScpLFxuICAgICAgICAvLyBQYXNzd29yZCBtdXN0IG5vdCBiZSByZXR1cm5lZCwgb2YgY291cnNlXG4gICAgICB9O1xuICAgIH0pO1xuICB9XG59XG5cbmV4cG9ydCBjb25zdCBCYWNrZW5kQ2xhc3M6IEJhc2VCYWNrZW5kQ2xhc3M8SW5pdGlhbEJhY2tlbmRPcHRpb25zLCBCYWNrZW5kT3B0aW9ucywgQmFja2VuZFN0YXR1cz4gPSBCYWNrZW5kXG5cbmV4cG9ydCBkZWZhdWx0IEJhY2tlbmQ7XG5cblxuZnVuY3Rpb24gZ2l0UGF0aE1hdGNoZXMob2JqSURzOiBzdHJpbmdbXSwgZ2l0UGF0aDogc3RyaW5nKSB7XG4gIGlmIChvYmpJRHMuaW5kZXhPZihnaXRQYXRoKSA+PSAwKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgY29uc3QgcGFyc2VkID0gcGF0aC5wYXJzZShnaXRQYXRoKTtcblxuICAvLyBCYWNrZW5kIG9wZXJhdGVzIGZpbGUgcmVmZXJlbmNlcyBhcyBwYXRocyB3aXRob3V0IGV4dGVuc2lvbnMuXG4gIC8vIEZTIHdyYXBwZXIgZXhwYW5kcyBwYXRocywgYWRkaW5nIGV4dGVuc2lvbiBpZiBuZWNlc3NhcnkuXG4gIC8vIEdpdCwgaG93ZXZlciwgZG9lc27igJl0IGtub3cgYWJvdXQgdGhlIGV4dGVuc2lvbnMuXG4gIC8vIEZvciBZQU1MIGZpbGVzIHdpdGggZXh0ZW5zaW9ucyAobm90IGRpcmVjdG9yaWVzKSxcbiAgLy8gdHJ5IGNvbXBhcmluZyB3aXRoIGV4dGVuc2lvbnMgcmVtb3ZlZC5cblxuICAvLyBBdHRlbXB0IHRvIGNvbXBhcmUgd2l0aCBkaXJlY3Rvcnkgb2YgdGhlIGZpbGUsIGZvciBZQU1MIGRpcmVjdG9yeVxuICAvLyBiYWNrZW5kLlxuICByZXR1cm4gb2JqSURzLmZpbmQoaWQgPT5cbiAgICBpZCA9PT0gcGFyc2VkLmRpciB8fCBpZCA9PT0gcGF0aC5qb2luKHBhcnNlZC5kaXIsIHBhcnNlZC5uYW1lKVxuICApICE9PSB1bmRlZmluZWQ7XG59XG4iXX0=