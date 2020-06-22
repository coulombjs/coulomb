import * as log from 'electron-log';
import * as fs from 'fs-extra';
import * as path from 'path';
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
            else if (!(await this.git.isUsingRemoteURLs({
                origin: this.opts.repoURL,
                upstream: this.opts.upstreamRepoURL
            }))) {
                log.warn("C/db/isogit-yaml: Git has mismatching remote URLs, reinitializing");
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
            this.git.setPassword(password);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFzZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9kYi9pc29naXQteWFtbC9tYWluL2Jhc2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUM7QUFDcEMsT0FBTyxLQUFLLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFDL0IsT0FBTyxLQUFLLElBQUksTUFBTSxNQUFNLENBQUM7QUFFN0IsT0FBTyxFQUFFLE1BQU0sRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBQzNDLE9BQU8sRUFBRSxPQUFPLEVBQWtCLE1BQU0sd0JBQXdCLENBQUM7QUFHakUsT0FBTyxFQUFFLHFCQUFxQixFQUFFLE1BQU0sY0FBYyxDQUFDO0FBSXJELE9BQU8sRUFHTCwwQkFBMEIsR0FHM0IsTUFBTSxpQkFBaUIsQ0FBQztBQUl6QixPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sVUFBVSxDQUFDO0FBMkJ6QyxNQUFNLE9BQVEsU0FBUSwwQkFBMEI7SUFPOUMsWUFDWSxJQUFvQixFQUNwQixtQkFBMEM7UUFFcEQsS0FBSyxFQUFFLENBQUM7UUFIRSxTQUFJLEdBQUosSUFBSSxDQUFnQjtRQUNwQix3QkFBbUIsR0FBbkIsbUJBQW1CLENBQXVCO1FBSXBELElBQUksQ0FBQyxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQztRQUV6QixJQUFJLENBQUMsR0FBRyxHQUFHLElBQUksYUFBYSxDQUMxQixFQUFFLEVBQ0YsSUFBSSxDQUFDLElBQUksQ0FBQyxPQUFPLEVBQ2pCLElBQUksQ0FBQyxJQUFJLENBQUMsZUFBZSxFQUN6QixJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFDbEIsRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxVQUFVLEVBQUUsS0FBSyxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFFLEVBQzVELElBQUksQ0FBQyxJQUFJLENBQUMsT0FBTyxFQUNq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QUUsTUFBTSxJQUFJLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxzQkFBc0IsQ0FBQzthQUUzRCxDQUFDO1FBQ0osQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUFFRCxNQUFNLENBQUMsTUFBTSxZQUFZLEdBQTJFLE9BQU8sQ0FBQTtBQUUzRyxlQUFlLE9BQU8sQ0FBQztBQUd2QixTQUFTLGNBQWMsQ0FBQyxNQUFnQixFQUFFLE9BQWU7SUFDdkQsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRTtRQUNoQyxPQUFPLElBQUksQ0FBQztLQUNiO0lBQ0QsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUVuQyxnRUFBZ0U7SUFDaEUsMkRBQTJEO0lBQzNELG1EQUFtRDtJQUNuRCxvREFBb0Q7SUFDcEQseUNBQXlDO0lBRXpDLG9FQUFvRTtJQUNwRSxXQUFXO0lBQ1gsT0FBTyxNQUFNLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQ3RCLEVBQUUsS0FBSyxNQUFNLENBQUMsR0FBRyxJQUFJLEVBQUUsS0FBSyxJQUFJLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxHQUFHLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUMvRCxLQUFLLFNBQVMsQ0FBQztBQUNsQixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgbG9nIGZyb20gJ2VsZWN0cm9uLWxvZyc7XG5pbXBvcnQgKiBhcyBmcyBmcm9tICdmcy1leHRyYSc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuXG5pbXBvcnQgeyBsaXN0ZW4gfSBmcm9tICcuLi8uLi8uLi9pcGMvbWFpbic7XG5pbXBvcnQgeyBTZXR0aW5nLCBTZXR0aW5nTWFuYWdlciB9IGZyb20gJy4uLy4uLy4uL3NldHRpbmdzL21haW4nO1xuXG5pbXBvcnQgeyBJbmRleCB9IGZyb20gJy4uLy4uL3F1ZXJ5JztcbmltcG9ydCB7IFVuaXF1ZUNvbnN0cmFpbnRFcnJvciB9IGZyb20gJy4uLy4uL2Vycm9ycyc7XG5cbmltcG9ydCB7IEZpbGVzeXN0ZW1XcmFwcGVyIH0gZnJvbSAnLi4vLi4vbWFpbi9mcy13cmFwcGVyJztcblxuaW1wb3J0IHtcbiAgQmFja2VuZENsYXNzIGFzIEJhc2VCYWNrZW5kQ2xhc3MsXG4gIEJhY2tlbmRTdGF0dXNSZXBvcnRlciBhcyBCYXNlQmFja2VuZFN0YXR1c1JlcG9ydGVyLFxuICBWZXJzaW9uZWRGaWxlc3lzdGVtQmFja2VuZCxcbiAgTW9kZWxNYW5hZ2VyLFxuICBGaWxlc3lzdGVtTWFuYWdlcixcbn0gZnJvbSAnLi4vLi4vbWFpbi9iYXNlJztcblxuaW1wb3J0IHsgQmFja2VuZERlc2NyaXB0aW9uLCBCYWNrZW5kU3RhdHVzIH0gZnJvbSAnLi4vYmFzZSc7XG5cbmltcG9ydCB7IElzb0dpdFdyYXBwZXIgfSBmcm9tICcuL2lzb2dpdCc7XG5cblxuaW50ZXJmYWNlIEZpeGVkQmFja2VuZE9wdGlvbnMge1xuICAvKiBTZXR0aW5ncyBzdXBwbGllZCBieSB0aGUgZGV2ZWxvcGVyICovXG5cbiAgd29ya0Rpcjogc3RyaW5nXG4gIGNvcnNQcm94eVVSTDogc3RyaW5nXG4gIHVwc3RyZWFtUmVwb1VSTD86IHN0cmluZ1xuICBmc1dyYXBwZXJDbGFzczogbmV3IChiYXNlRGlyOiBzdHJpbmcpID0+IEZpbGVzeXN0ZW1XcmFwcGVyPGFueT5cbn1cbmludGVyZmFjZSBDb25maWd1cmFibGVCYWNrZW5kT3B0aW9ucyB7XG4gIC8qIFNldHRpbmdzIHRoYXQgdXNlciBjYW4gb3IgbXVzdCBzcGVjaWZ5ICovXG4gIHJlcG9VUkw6IHN0cmluZ1xuICB1c2VybmFtZTogc3RyaW5nXG4gIGF1dGhvck5hbWU6IHN0cmluZ1xuICBhdXRob3JFbWFpbDogc3RyaW5nXG59XG50eXBlIEJhY2tlbmRPcHRpb25zID0gRml4ZWRCYWNrZW5kT3B0aW9ucyAmIENvbmZpZ3VyYWJsZUJhY2tlbmRPcHRpb25zICYge1xuICBmc1dyYXBwZXI6IEZpbGVzeXN0ZW1XcmFwcGVyPGFueT5cbn1cbnR5cGUgSW5pdGlhbEJhY2tlbmRPcHRpb25zID0gRml4ZWRCYWNrZW5kT3B0aW9ucyAmIFBhcnRpYWw8Q29uZmlndXJhYmxlQmFja2VuZE9wdGlvbnM+XG5cblxudHlwZSBCYWNrZW5kU3RhdHVzUmVwb3J0ZXIgPSBCYXNlQmFja2VuZFN0YXR1c1JlcG9ydGVyPEJhY2tlbmRTdGF0dXM+XG5cblxuY2xhc3MgQmFja2VuZCBleHRlbmRzIFZlcnNpb25lZEZpbGVzeXN0ZW1CYWNrZW5kIHtcbiAgLyogQ29tYmluZXMgYSBmaWxlc3lzdGVtIHN0b3JhZ2Ugd2l0aCBHaXQuICovXG5cbiAgcHJpdmF0ZSBnaXQ6IElzb0dpdFdyYXBwZXI7XG4gIHByaXZhdGUgZnM6IEZpbGVzeXN0ZW1XcmFwcGVyPGFueT47XG4gIHByaXZhdGUgbWFuYWdlcnM6IChGaWxlc3lzdGVtTWFuYWdlciAmIE1vZGVsTWFuYWdlcjxhbnksIGFueSwgYW55PilbXTtcblxuICBjb25zdHJ1Y3RvcihcbiAgICAgIHByaXZhdGUgb3B0czogQmFja2VuZE9wdGlvbnMsXG4gICAgICBwcml2YXRlIHJlcG9ydEJhY2tlbmRTdGF0dXM6IEJhY2tlbmRTdGF0dXNSZXBvcnRlcikge1xuXG4gICAgc3VwZXIoKTtcblxuICAgIHRoaXMuZnMgPSBvcHRzLmZzV3JhcHBlcjtcblxuICAgIHRoaXMuZ2l0ID0gbmV3IElzb0dpdFdyYXBwZXIoXG4gICAgICBmcyxcbiAgICAgIHRoaXMub3B0cy5yZXBvVVJMLFxuICAgICAgdGhpcy5vcHRzLnVwc3RyZWFtUmVwb1VSTCxcbiAgICAgIHRoaXMub3B0cy51c2VybmFtZSxcbiAgICAgIHsgbmFtZTogdGhpcy5vcHRzLmF1dGhvck5hbWUsIGVtYWlsOiB0aGlzLm9wdHMuYXV0aG9yRW1haWwgfSxcbiAgICAgIHRoaXMub3B0cy53b3JrRGlyLFxuICAgICAgdGhpcy5vcHRzLmNvcnNQcm94eVVSTCxcblxuICAgICAgLy8gVGhlIHN0YXR1cyBvZiB0aGlzIGJhY2tlbmQgaXMgcmVkdWNlZCB0byBHaXQgcmVwbyBzdGF0dXMgbm93LlxuICAgICAgLy8gUG90ZW50aWFsbHkgaXQgc2hvdWxkIGluY2x1ZGUgZmlsZXN5c3RlbS1yZWxhdGVkIHN0YXR1cyBhcyB3ZWxsLFxuICAgICAgLy8gcmVwb3J0aW5nIGlzc3VlcyB3aXRoIGUuZy4gaW5zdWZmaWNpZW50IGRpc2sgc3BhY2UuXG4gICAgICB0aGlzLnJlcG9ydEJhY2tlbmRTdGF0dXMsXG4gICAgKTtcblxuICAgIHRoaXMubWFuYWdlcnMgPSBbXTtcblxuICAgIHRoaXMuc3luY2hyb25pemUgPSB0aGlzLnN5bmNocm9uaXplLmJpbmQodGhpcyk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgZ2V0TG9jYWxGaWxlc3lzdGVtUGF0aChpZDogc3RyaW5nKSB7XG4gICAgcmV0dXJuIHRoaXMuZnMuZXhwYW5kUGF0aChpZCk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgZ2V0Q3VycmVudENvbW1pdHRlckluZm9ybWF0aW9uKCk6IFByb21pc2U8eyB1c2VybmFtZTogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIGVtYWlsOiBzdHJpbmcgfT4ge1xuICAgIHJldHVybiB7XG4gICAgICB1c2VybmFtZTogdGhpcy5vcHRzLnVzZXJuYW1lLFxuICAgICAgbmFtZTogdGhpcy5vcHRzLmF1dGhvck5hbWUsXG4gICAgICBlbWFpbDogdGhpcy5vcHRzLmF1dGhvckVtYWlsLFxuICAgIH07XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgZGVzY3JpYmUoKTogUHJvbWlzZTxCYWNrZW5kRGVzY3JpcHRpb24+IHtcbiAgICByZXR1cm4ge1xuICAgICAgdmVyYm9zZU5hbWU6IFwiR2l0K1lBTUxcIixcbiAgICAgIHZlcmJvc2VOYW1lTG9uZzogXCJHaXQtdmVyc2lvbmVkIFlBTUwgZmlsZSB0cmVlXCIsXG4gICAgICBnaXRSZXBvOiB0aGlzLm9wdHMucmVwb1VSTCxcbiAgICAgIGdpdFVzZXJuYW1lOiB0aGlzLm9wdHMudXNlcm5hbWUsXG4gICAgICBsb2NhbENsb25lUGF0aDogdGhpcy5vcHRzLndvcmtEaXIsXG4gICAgICBzdGF0dXM6IHRoaXMuZ2l0LmdldFN0YXR1cygpLFxuICAgIH1cbiAgfVxuXG4gIHB1YmxpYyBzdGF0aWMgcmVnaXN0ZXJTZXR0aW5nc0ZvckNvbmZpZ3VyYWJsZU9wdGlvbnMoXG4gICAgICBzZXR0aW5nczogU2V0dGluZ01hbmFnZXIsXG4gICAgICBpbml0aWFsT3B0aW9uczogSW5pdGlhbEJhY2tlbmRPcHRpb25zLFxuICAgICAgZGJJRDogc3RyaW5nKSB7XG5cbiAgICBjb25zdCBwYW5lTGFiZWxQb3N0Zml4ID0gZGJJRCAhPT0gJ2RlZmF1bHQnID8gYCBmb3Ig4oCcJHtkYklEfeKAnWAgOiAnJztcbiAgICBjb25zdCBzZXR0aW5nSURQcmVmaXggPSBgZGJfJHtkYklEfV9gO1xuICAgIGNvbnN0IHBhbmVJRCA9IGBkYl8ke2RiSUR9YDtcblxuICAgIHNldHRpbmdzLmNvbmZpZ3VyZVBhbmUoe1xuICAgICAgaWQ6IHBhbmVJRCxcbiAgICAgIGxhYmVsOiBgRGF0YWJhc2Ugc2V0dGluZ3Mke3BhbmVMYWJlbFBvc3RmaXh9YCxcbiAgICAgIGljb246ICdnaXQtbWVyZ2UnLFxuICAgIH0pO1xuXG4gICAgc2V0dGluZ3MucmVnaXN0ZXIobmV3IFNldHRpbmc8c3RyaW5nPihcbiAgICAgIHBhbmVJRCxcbiAgICAgIGAke3NldHRpbmdJRFByZWZpeH1naXRSZXBvVXJsYCxcbiAgICAgICd0ZXh0JyxcbiAgICAgIGluaXRpYWxPcHRpb25zLnJlcG9VUkwgPT09IHVuZGVmaW5lZCxcbiAgICAgIFwiR2l0IHJlcG9zaXRvcnkgVVJMXCIsXG4gICAgICBcIkUuZy4sIGh0dHBzOi8vZ2l0aHViLmNvbS88dXNlcm5hbWU+LzxyZXBvc2l0b3J5IG5hbWU+XCIsXG4gICAgKSk7XG5cbiAgICBzZXR0aW5ncy5yZWdpc3RlcihuZXcgU2V0dGluZzxzdHJpbmc+KFxuICAgICAgcGFuZUlELFxuICAgICAgYCR7c2V0dGluZ0lEUHJlZml4fWdpdFVzZXJuYW1lYCxcbiAgICAgICd0ZXh0JyxcbiAgICAgIGluaXRpYWxPcHRpb25zLnVzZXJuYW1lID09PSB1bmRlZmluZWQsXG4gICAgICBcIkdpdCB1c2VybmFtZVwiLFxuICAgICkpO1xuXG4gICAgc2V0dGluZ3MucmVnaXN0ZXIobmV3IFNldHRpbmc8c3RyaW5nPihcbiAgICAgIHBhbmVJRCxcbiAgICAgIGAke3NldHRpbmdJRFByZWZpeH1naXRBdXRob3JOYW1lYCxcbiAgICAgICd0ZXh0JyxcbiAgICAgIGluaXRpYWxPcHRpb25zLmF1dGhvck5hbWUgPT09IHVuZGVmaW5lZCxcbiAgICAgIFwiR2l0IGF1dGhvciBuYW1lXCIsXG4gICAgKSk7XG5cbiAgICBzZXR0aW5ncy5yZWdpc3RlcihuZXcgU2V0dGluZzxzdHJpbmc+KFxuICAgICAgcGFuZUlELFxuICAgICAgYCR7c2V0dGluZ0lEUHJlZml4fWdpdEF1dGhvckVtYWlsYCxcbiAgICAgICd0ZXh0JyxcbiAgICAgIGluaXRpYWxPcHRpb25zLmF1dGhvckVtYWlsID09PSB1bmRlZmluZWQsXG4gICAgICBcIkdpdCBhdXRob3IgZW1haWxcIixcbiAgICApKTtcbiAgfVxuXG4gIHB1YmxpYyBzdGF0aWMgYXN5bmMgY29tcGxldGVPcHRpb25zRnJvbVNldHRpbmdzKFxuICAgICAgc2V0dGluZ3M6IFNldHRpbmdNYW5hZ2VyLFxuICAgICAgYXZhaWxhYmxlT3B0aW9uczogSW5pdGlhbEJhY2tlbmRPcHRpb25zLFxuICAgICAgZGJJRDogc3RyaW5nKSB7XG5cbiAgICBjb25zdCBzZXR0aW5nSURQcmVmaXggPSBgZGJfJHtkYklEfV9gO1xuXG4gICAgYXN5bmMgZnVuY3Rpb24gZ2V0U2V0dGluZzxUPihzZXR0aW5nSUQ6IHN0cmluZyk6IFByb21pc2U8VD4ge1xuICAgICAgcmV0dXJuIGF3YWl0IHNldHRpbmdzLmdldFZhbHVlKGAke3NldHRpbmdJRFByZWZpeH0ke3NldHRpbmdJRH1gKSBhcyBUO1xuICAgIH1cblxuICAgIGNvbnN0IGZzV3JhcHBlckNsYXNzID0gYXZhaWxhYmxlT3B0aW9ucy5mc1dyYXBwZXJDbGFzcztcblxuICAgIHJldHVybiB7XG4gICAgICB3b3JrRGlyOiBhdmFpbGFibGVPcHRpb25zLndvcmtEaXIsXG4gICAgICBjb3JzUHJveHlVUkw6IGF2YWlsYWJsZU9wdGlvbnMuY29yc1Byb3h5VVJMLFxuICAgICAgdXBzdHJlYW1SZXBvVVJMOiBhdmFpbGFibGVPcHRpb25zLnVwc3RyZWFtUmVwb1VSTCxcbiAgICAgIGZzV3JhcHBlckNsYXNzOiBhdmFpbGFibGVPcHRpb25zLmZzV3JhcHBlckNsYXNzLFxuICAgICAgZnNXcmFwcGVyOiBuZXcgZnNXcmFwcGVyQ2xhc3MoYXZhaWxhYmxlT3B0aW9ucy53b3JrRGlyKSxcblxuICAgICAgcmVwb1VSTDogKFxuICAgICAgICAoYXdhaXQgZ2V0U2V0dGluZzxzdHJpbmc+KCdnaXRSZXBvVXJsJykpXG4gICAgICAgIHx8IGF2YWlsYWJsZU9wdGlvbnMucmVwb1VSTCkgYXMgc3RyaW5nLFxuICAgICAgdXNlcm5hbWU6IChcbiAgICAgICAgKGF3YWl0IGdldFNldHRpbmc8c3RyaW5nPignZ2l0VXNlcm5hbWUnKSlcbiAgICAgICAgfHwgYXZhaWxhYmxlT3B0aW9ucy51c2VybmFtZSkgYXMgc3RyaW5nLFxuICAgICAgYXV0aG9yTmFtZTogKFxuICAgICAgICAoYXdhaXQgZ2V0U2V0dGluZzxzdHJpbmc+KCdnaXRBdXRob3JOYW1lJykpXG4gICAgICAgIHx8IGF2YWlsYWJsZU9wdGlvbnMuYXV0aG9yTmFtZSkgYXMgc3RyaW5nLFxuICAgICAgYXV0aG9yRW1haWw6IChcbiAgICAgICAgKGF3YWl0IGdldFNldHRpbmc8c3RyaW5nPignZ2l0QXV0aG9yRW1haWwnKSlcbiAgICAgICAgfHwgYXZhaWxhYmxlT3B0aW9ucy5hdXRob3JFbWFpbCkgYXMgc3RyaW5nLFxuICAgIH1cbiAgfVxuXG4gIHB1YmxpYyBhc3luYyByZWdpc3Rlck1hbmFnZXIobWFuYWdlcjogRmlsZXN5c3RlbU1hbmFnZXIgJiBNb2RlbE1hbmFnZXI8YW55LCBhbnksIGFueT4pIHtcbiAgICB0aGlzLm1hbmFnZXJzLnB1c2gobWFuYWdlcik7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgaW5pdChmb3JjZVJlc2V0ID0gZmFsc2UpIHtcbiAgICBsZXQgZG9Jbml0aWFsaXplOiBib29sZWFuO1xuXG4gICAgdHJ5IHtcbiAgICAgIGlmIChmb3JjZVJlc2V0ID09PSB0cnVlKSB7XG4gICAgICAgIGxvZy53YXJuKFwiQy9kYi9pc29naXQteWFtbDogR2l0IGlzIGJlaW5nIGZvcmNlIHJlaW5pdGlhbGl6ZWRcIik7XG4gICAgICAgIGRvSW5pdGlhbGl6ZSA9IHRydWU7XG4gICAgICB9IGVsc2UgaWYgKCEoYXdhaXQgdGhpcy5naXQuaXNVc2luZ1JlbW90ZVVSTHMoe1xuICAgICAgICAgIG9yaWdpbjogdGhpcy5vcHRzLnJlcG9VUkwsXG4gICAgICAgICAgdXBzdHJlYW06IHRoaXMub3B0cy51cHN0cmVhbVJlcG9VUkx9KSkpIHtcbiAgICAgICAgbG9nLndhcm4oXCJDL2RiL2lzb2dpdC15YW1sOiBHaXQgaGFzIG1pc21hdGNoaW5nIHJlbW90ZSBVUkxzLCByZWluaXRpYWxpemluZ1wiKTtcbiAgICAgICAgZG9Jbml0aWFsaXplID0gdHJ1ZTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGxvZy5pbmZvKFwiQy9kYi9pc29naXQteWFtbDogR2l0IGlzIGFscmVhZHkgaW5pdGlhbGl6ZWRcIik7XG4gICAgICAgIGRvSW5pdGlhbGl6ZSA9IGZhbHNlO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGRvSW5pdGlhbGl6ZSA9IHRydWU7XG4gICAgfVxuXG4gICAgaWYgKGRvSW5pdGlhbGl6ZSkge1xuICAgICAgYXdhaXQgdGhpcy5naXQuZGVzdHJveSgpO1xuICAgIH1cblxuICAgIGF3YWl0IHRoaXMuc3luY2hyb25pemUoKTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyByZWFkKG9iaklEOiBzdHJpbmcsIG1ldGFGaWVsZHM/OiBzdHJpbmdbXSkge1xuICAgIHJldHVybiBhd2FpdCB0aGlzLmZzLnJlYWQodGhpcy5nZXRSZWYob2JqSUQpLCBtZXRhRmllbGRzKSBhcyBvYmplY3Q7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgcmVhZFZlcnNpb24ob2JqSUQ6IHN0cmluZywgdmVyc2lvbjogc3RyaW5nKSB7XG4gICAgLy8gTk9URTogVGhpcyB3aWxsIGZhaWwgd2l0aCBZQU1MRGlyZWN0b3J5V3JhcHBlci5cbiAgICAvLyBvYmpJRCBtdXN0IHJlZmVyIHRvIGEgc2luZ2xlIGZpbGUuXG5cbiAgICAvLyBUT0RPOiBTdXBwb3J0IGNvbXBvdW5kIG9iamVjdHMgKGRpcmVjdG9yaWVzKVxuICAgIC8vIGJ5IG1vdmluZyB0aGUgZmlsZSBkYXRhIHBhcnNpbmcgbG9naWMgaW50byBtYW5hZ2VyXG4gICAgLy8gYW5kIGFkZGluZyBCYWNrZW5kLnJlYWRUcmVlKCkuXG5cbiAgICBjb25zdCBibG9iID0gYXdhaXQgdGhpcy5naXQucmVhZEZpbGVCbG9iQXRDb21taXQodGhpcy5nZXRSZWYob2JqSUQpLCB2ZXJzaW9uKTtcbiAgICByZXR1cm4gdGhpcy5mcy5wYXJzZURhdGEoYmxvYik7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgY3JlYXRlPE8gZXh0ZW5kcyBSZWNvcmQ8c3RyaW5nLCBhbnk+PihvYmo6IE8sIG9ialBhdGg6IHN0cmluZywgbWV0YUZpZWxkcz86IChrZXlvZiBPKVtdKSB7XG4gICAgaWYgKGF3YWl0IHRoaXMuZnMuZXhpc3RzKG9ialBhdGgpKSB7XG4gICAgICB0aHJvdyBuZXcgVW5pcXVlQ29uc3RyYWludEVycm9yKFwiZmlsZXN5c3RlbSBwYXRoXCIsIG9ialBhdGgpO1xuICAgIH1cblxuICAgIGF3YWl0IHRoaXMuZnMud3JpdGUob2JqUGF0aCwgb2JqLCBtZXRhRmllbGRzKTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBjb21taXRBbGwobXNnOiBzdHJpbmcsIHJlbW92aW5nOiBib29sZWFuKSB7XG4gICAgLy8gTk9URTogVXNlIHdpdGggY2FyZS5cblxuICAgIGF3YWl0IHRoaXMuZ2l0LnN0YWdlQW5kQ29tbWl0KFsnLiddLCBtc2csIHJlbW92aW5nKTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBjb21taXQob2JqSURzOiBzdHJpbmdbXSwgbWVzc2FnZTogc3RyaW5nLCByZW1vdmluZyA9IGZhbHNlKSB7XG4gICAgYXdhaXQgdGhpcy5yZXNldE9ycGhhbmVkRmlsZUNoYW5nZXMoKTtcblxuICAgIGNvbnN0IHVuY29tbWl0dGVkID0gYXdhaXQgdGhpcy5yZWFkVW5jb21taXR0ZWRGaWxlSW5mbygpO1xuXG4gICAgY29uc3QgcGF0aHM6IHN0cmluZ1tdID0gdW5jb21taXR0ZWQuXG4gICAgICBmaWx0ZXIoZmlsZWluZm8gPT4gZ2l0UGF0aE1hdGNoZXMob2JqSURzLCBmaWxlaW5mby5wYXRoKSkuXG4gICAgICBtYXAoZmlsZWluZm8gPT4gZmlsZWluZm8ucGF0aCk7XG5cbiAgICBsb2cuZGVidWcoXCJDL2RiOiBDb21taXR0aW5nIG9iamVjdHNcIiwgb2JqSURzLCB1bmNvbW1pdHRlZCwgcGF0aHMsIG1lc3NhZ2UpO1xuXG4gICAgaWYgKHBhdGhzLmxlbmd0aCA+IDApIHtcbiAgICAgIC8vIFRPRE86IE1ha2UgR2l0IHRyYWNrIHdoaWNoIGZpbGVzIGdvdCBjb21taXR0ZWQgKGhhZCBjaGFuZ2VzKSxcbiAgICAgIC8vIGFuZCByZXR1cm4gcGF0aHNcbiAgICAgIGF3YWl0IHRoaXMuZ2l0LnN0YWdlQW5kQ29tbWl0KHBhdGhzLCBtZXNzYWdlLCByZW1vdmluZyk7XG4gICAgfVxuICB9XG5cbiAgcHVibGljIGFzeW5jIGRpc2NhcmQob2JqSURzOiBzdHJpbmdbXSkge1xuICAgIGNvbnN0IHBhdGhzOiBzdHJpbmdbXSA9IChhd2FpdCB0aGlzLnJlYWRVbmNvbW1pdHRlZEZpbGVJbmZvKCkpLlxuICAgICAgZmlsdGVyKGZpbGVpbmZvID0+IGdpdFBhdGhNYXRjaGVzKG9iaklEcywgZmlsZWluZm8ucGF0aCkpLlxuICAgICAgbWFwKGZpbGVpbmZvID0+IGZpbGVpbmZvLnBhdGgpO1xuXG4gICAgaWYgKHBhdGhzLmxlbmd0aCA+IDApIHtcbiAgICAgIGF3YWl0IHRoaXMuZ2l0LnJlc2V0RmlsZXMocGF0aHMpO1xuICAgIH1cbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBsaXN0VW5jb21taXR0ZWQoKSB7XG4gICAgY29uc3QgZmlsZXMgPSBhd2FpdCB0aGlzLnJlYWRVbmNvbW1pdHRlZEZpbGVJbmZvKCk7XG5cbiAgICBjb25zdCBvYmpJRHM6IHN0cmluZ1tdID0gZmlsZXMuXG4gICAgICBtYXAoZmlsZWluZm8gPT4gZmlsZWluZm8ucGF0aCk7XG5cbiAgICAvLyBEaXNjYXJkIGR1cGxpY2F0ZXMgZnJvbSB0aGUgbGlzdFxuICAgIHJldHVybiBvYmpJRHMuZmlsdGVyKGZ1bmN0aW9uIChvYmpJRCwgaWR4LCBzZWxmKSB7XG4gICAgICByZXR1cm4gaWR4ID09PSBzZWxmLmluZGV4T2Yob2JqSUQpO1xuICAgIH0pO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGxpc3RJRHMocXVlcnk6IHsgc3ViZGlyOiBzdHJpbmcgfSkge1xuICAgIHJldHVybiBhd2FpdCB0aGlzLmZzLmxpc3RJRHMoeyBzdWJkaXI6IHF1ZXJ5LnN1YmRpciB9KTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBnZXRJbmRleChzdWJkaXI6IHN0cmluZywgaWRGaWVsZDogc3RyaW5nLCBvbmx5SURzPzogc3RyaW5nW10sIG1ldGFGaWVsZHM/OiBzdHJpbmdbXSkge1xuICAgIGNvbnN0IGlkc1RvU2VsZWN0ID0gb25seUlEcyAhPT0gdW5kZWZpbmVkXG4gICAgICA/IG9ubHlJRHMubWFwKGlkID0+IHRoaXMuZ2V0UmVmKGlkKSlcbiAgICAgIDogdW5kZWZpbmVkO1xuXG4gICAgY29uc3Qgb2JqcyA9IGF3YWl0IHRoaXMuZnMucmVhZEFsbCh7IHN1YmRpciwgb25seUlEczogaWRzVG9TZWxlY3QgfSwgbWV0YUZpZWxkcyk7XG5cbiAgICB2YXIgaWR4OiBJbmRleDxhbnk+ID0ge307XG4gICAgZm9yIChjb25zdCBvYmogb2Ygb2Jqcykge1xuICAgICAgaWR4W2Ake29ialtpZEZpZWxkXX1gXSA9IG9iajtcbiAgICB9XG5cbiAgICByZXR1cm4gaWR4O1xuICB9XG5cbiAgcHVibGljIGFzeW5jIHVwZGF0ZShvYmpJRDogc3RyaW5nLCBuZXdEYXRhOiBSZWNvcmQ8c3RyaW5nLCBhbnk+LCBtZXRhRmllbGRzPzogc3RyaW5nW10pIHtcbiAgICBhd2FpdCB0aGlzLmZzLndyaXRlKHRoaXMuZ2V0UmVmKG9iaklEKSwgbmV3RGF0YSwgbWV0YUZpZWxkcyk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgZGVsZXRlKG9iaklEOiBzdHJpbmcpIHtcbiAgICBhd2FpdCB0aGlzLmZzLndyaXRlKHRoaXMuZ2V0UmVmKG9iaklEKSwgdW5kZWZpbmVkKTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyByZXNldE9ycGhhbmVkRmlsZUNoYW5nZXMoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgLyogUmVtb3ZlIGZyb20gZmlsZXN5c3RlbSBhbnkgZmlsZXMgdW5kZXIgb3VyIEZTIGJhY2tlbmQgcGF0aFxuICAgICAgIHRoYXQgdGhlIGJhY2tlbmQgY2Fubm90IGFjY291bnQgZm9yLFxuICAgICAgIGJ1dCB3aGljaCBtYXkgYXBwZWFyIGFzIHVuc3RhZ2VkIGNoYW5nZXMgdG8gR2l0LiAqL1xuXG4gICAgY29uc3Qgb3JwaGFuRmlsZVBhdGhzID0gKGF3YWl0IHRoaXMucmVhZFVuY29tbWl0dGVkRmlsZUluZm8oKSkuXG4gICAgbWFwKGZpbGVpbmZvID0+IGZpbGVpbmZvLnBhdGgpLlxuICAgIGZpbHRlcihmaWxlcGF0aCA9PiB0aGlzLm1hbmFnZXJzLm1hcChtZ3IgPT4gbWdyLm1hbmFnZXNGaWxlQXRQYXRoKGZpbGVwYXRoKSkuaW5kZXhPZih0cnVlKSA8IDApO1xuXG4gICAgaWYgKG9ycGhhbkZpbGVQYXRocy5sZW5ndGggPiAwKSB7XG4gICAgICBsb2cud2FybihcIkMvZGIvaXNvZ2l0LXlhbWw6IFJlc2V0dGluZyBvcnBoYW5lZCBmaWxlc1wiLCBvcnBoYW5GaWxlUGF0aHMpO1xuICAgICAgYXdhaXQgdGhpcy5naXQucmVzZXRGaWxlcyhvcnBoYW5GaWxlUGF0aHMpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVhZFVuY29tbWl0dGVkRmlsZUluZm8oKTogUHJvbWlzZTx7IHBhdGg6IHN0cmluZyB9W10+IHtcbiAgICAvKiBSZXR1cm5zIGEgbGlzdCBvZiBvYmplY3RzIHRoYXQgbWFwIEdpdC1yZWxhdGl2ZSBwYXRocyB0byBhY3R1YWwgb2JqZWN0IElEcy5cbiAgICAgICBXaGVyZSBvYmplY3QgSUQgaXMgdW5kZWZpbmVkLCB0aGF0IGltcGxpZXMgZmlsZSBpcyDigJxvcnBoYW5lZOKAnVxuICAgICAgIChub3QgcmVjb2duaXplZCBhcyBiZWxvbmdpbmcgdG8gYW55IG9iamVjdCBtYW5hZ2VkIGJ5IHRoaXMgc3RvcmUpLiAqL1xuXG4gICAgY29uc3QgY2hhbmdlZEZpbGVzOiBzdHJpbmdbXSA9IGF3YWl0IHRoaXMuZ2l0Lmxpc3RDaGFuZ2VkRmlsZXMoWycuJ10pO1xuICAgIHJldHVybiBhd2FpdCBQcm9taXNlLmFsbChjaGFuZ2VkRmlsZXMubWFwKGZwID0+IHtcbiAgICAgIHJldHVybiB7IHBhdGg6IGZwIH07XG4gICAgfSkpO1xuICB9XG5cbiAgcHJpdmF0ZSBnZXRSZWYob2JqSUQ6IHN0cmluZyB8IG51bWJlcik6IHN0cmluZyB7XG4gICAgLyogUmV0dXJucyBGUyBiYWNrZW5kIHJlZmVyZW5jZSBmcm9tIERCIGJhY2tlbmQgb2JqZWN0IElELiAqL1xuICAgIHJldHVybiBgJHtvYmpJRH1gO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBzeW5jaHJvbml6ZSgpIHtcbiAgICBhd2FpdCB0aGlzLmdpdC5zeW5jaHJvbml6ZSgpO1xuXG4gICAgZm9yIChjb25zdCBtZ3Igb2YgdGhpcy5tYW5hZ2Vycykge1xuICAgICAgbG9nLmRlYnVnKFwiQy9pbml0TWFpbjogSW5pdGlhbGl6aW5nIG1hbmFnZXJcIik7XG4gICAgICBhd2FpdCBtZ3IuaW5pdCgpO1xuICAgICAgYXdhaXQgbWdyLnJlcG9ydFVwZGF0ZWREYXRhKCk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBjaGVja1VuY29tbWl0dGVkKCkge1xuICAgIHJldHVybiBhd2FpdCB0aGlzLmdpdC5jaGVja1VuY29tbWl0dGVkKCk7XG4gIH1cblxuICBwdWJsaWMgc2V0VXBJUEMoZGJJRDogc3RyaW5nKSB7XG4gICAgc3VwZXIuc2V0VXBJUEMoZGJJRCk7XG5cbiAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0LXlhbWw6IFNldHRpbmcgdXAgSVBDXCIpO1xuXG4gICAgY29uc3QgcHJlZml4ID0gYGRiLSR7ZGJJRH1gO1xuXG4gICAgbGlzdGVuPHt9LCB7IG51bVVuY29tbWl0dGVkOiBudW1iZXIgfT5cbiAgICAoYCR7cHJlZml4fS1jb3VudC11bmNvbW1pdHRlZGAsIGFzeW5jICgpID0+IHtcbiAgICAgIHJldHVybiB7IG51bVVuY29tbWl0dGVkOiAoYXdhaXQgdGhpcy5naXQubGlzdENoYW5nZWRGaWxlcygpKS5sZW5ndGggfTtcbiAgICB9KTtcblxuICAgIGxpc3Rlbjx7fSwgeyBzdGFydGVkOiB0cnVlIH0+XG4gICAgKGAke3ByZWZpeH0tZ2l0LXRyaWdnZXItc3luY2AsIGFzeW5jICgpID0+IHtcbiAgICAgIHRoaXMuc3luY2hyb25pemUoKTtcbiAgICAgIHJldHVybiB7IHN0YXJ0ZWQ6IHRydWUgfTtcbiAgICB9KTtcblxuICAgIGxpc3Rlbjx7fSwgeyBzdWNjZXNzOiB0cnVlIH0+XG4gICAgKGAke3ByZWZpeH0tZ2l0LWRpc2NhcmQtdW5zdGFnZWRgLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCB0aGlzLmdpdC5yZXNldEZpbGVzKCk7XG4gICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlIH07XG4gICAgfSk7XG5cbiAgICBsaXN0ZW48e30sIHsgaGFzVW5jb21taXR0ZWRDaGFuZ2VzOiBib29sZWFuIH0+XG4gICAgKGAke3ByZWZpeH0tZ2l0LXVwZGF0ZS1zdGF0dXNgLCBhc3luYyAoKSA9PiB7XG4gICAgICByZXR1cm4geyBoYXNVbmNvbW1pdHRlZENoYW5nZXM6IGF3YWl0IHRoaXMuY2hlY2tVbmNvbW1pdHRlZCgpIH07XG4gICAgfSk7XG5cbiAgICBsaXN0ZW48eyBwYXNzd29yZDogc3RyaW5nIH0sIHsgc3VjY2VzczogdHJ1ZSB9PlxuICAgIChgJHtwcmVmaXh9LWdpdC1zZXQtcGFzc3dvcmRgLCBhc3luYyAoeyBwYXNzd29yZCB9KSA9PiB7XG4gICAgICAvLyBXQVJOSU5HOiBEb27igJl0IGxvZyBwYXNzd29yZFxuICAgICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdC15YW1sOiByZWNlaXZlZCBnaXQtc2V0LXBhc3N3b3JkIHJlcXVlc3RcIik7XG5cbiAgICAgIHRoaXMuZ2l0LnNldFBhc3N3b3JkKHBhc3N3b3JkKTtcblxuICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSB9O1xuICAgIH0pO1xuXG4gICAgbGlzdGVuPHt9LCB7IHN1Y2Nlc3M6IHRydWUgfT5cbiAgICAoYCR7cHJlZml4fS1naXQtcmVxdWVzdC1wdXNoYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgdGhpcy5naXQucmVxdWVzdFB1c2goKTtcbiAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IHRydWUgfTtcbiAgICB9KTtcblxuICAgIGxpc3Rlbjx7fSwgeyB1c2VybmFtZTogc3RyaW5nLCBlbWFpbDogc3RyaW5nLCBuYW1lOiBzdHJpbmcgfT5cbiAgICAoYCR7cHJlZml4fS1nZXQtY3VycmVudC1jb21taXR0ZXItaW5mb2AsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGF1dGhvckluZm8gPSBhd2FpdCB0aGlzLmdldEN1cnJlbnRDb21taXR0ZXJJbmZvcm1hdGlvbigpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdXNlcm5hbWU6IGF1dGhvckluZm8udXNlcm5hbWUsXG4gICAgICAgIGVtYWlsOiBhdXRob3JJbmZvLmVtYWlsLFxuICAgICAgICBuYW1lOiBhdXRob3JJbmZvLm5hbWUsXG4gICAgICB9O1xuICAgIH0pO1xuXG4gICAgbGlzdGVuPHt9LCB7IG9yaWdpblVSTDogc3RyaW5nIHwgbnVsbCwgdXNlcm5hbWU6IHN0cmluZyB8IG51bGwgfT5cbiAgICAoYCR7cHJlZml4fS1naXQtY29uZmlnLWdldGAsIGFzeW5jICgpID0+IHtcbiAgICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQteWFtbDogcmVjZWl2ZWQgZ2l0LWNvbmZpZyByZXF1ZXN0XCIpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb3JpZ2luVVJMOiBhd2FpdCB0aGlzLmdpdC5nZXRPcmlnaW5VcmwoKSxcbiAgICAgICAgLy8gbmFtZTogYXdhaXQgdGhpcy5naXQuY29uZmlnR2V0KCd1c2VyLm5hbWUnKSxcbiAgICAgICAgLy8gZW1haWw6IGF3YWl0IHRoaXMuZ2l0LmNvbmZpZ0dldCgndXNlci5lbWFpbCcpLFxuICAgICAgICB1c2VybmFtZTogYXdhaXQgdGhpcy5naXQuY29uZmlnR2V0KCdjcmVkZW50aWFscy51c2VybmFtZScpLFxuICAgICAgICAvLyBQYXNzd29yZCBtdXN0IG5vdCBiZSByZXR1cm5lZCwgb2YgY291cnNlXG4gICAgICB9O1xuICAgIH0pO1xuICB9XG59XG5cbmV4cG9ydCBjb25zdCBCYWNrZW5kQ2xhc3M6IEJhc2VCYWNrZW5kQ2xhc3M8SW5pdGlhbEJhY2tlbmRPcHRpb25zLCBCYWNrZW5kT3B0aW9ucywgQmFja2VuZFN0YXR1cz4gPSBCYWNrZW5kXG5cbmV4cG9ydCBkZWZhdWx0IEJhY2tlbmQ7XG5cblxuZnVuY3Rpb24gZ2l0UGF0aE1hdGNoZXMob2JqSURzOiBzdHJpbmdbXSwgZ2l0UGF0aDogc3RyaW5nKSB7XG4gIGlmIChvYmpJRHMuaW5kZXhPZihnaXRQYXRoKSA+PSAwKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgY29uc3QgcGFyc2VkID0gcGF0aC5wYXJzZShnaXRQYXRoKTtcblxuICAvLyBCYWNrZW5kIG9wZXJhdGVzIGZpbGUgcmVmZXJlbmNlcyBhcyBwYXRocyB3aXRob3V0IGV4dGVuc2lvbnMuXG4gIC8vIEZTIHdyYXBwZXIgZXhwYW5kcyBwYXRocywgYWRkaW5nIGV4dGVuc2lvbiBpZiBuZWNlc3NhcnkuXG4gIC8vIEdpdCwgaG93ZXZlciwgZG9lc27igJl0IGtub3cgYWJvdXQgdGhlIGV4dGVuc2lvbnMuXG4gIC8vIEZvciBZQU1MIGZpbGVzIHdpdGggZXh0ZW5zaW9ucyAobm90IGRpcmVjdG9yaWVzKSxcbiAgLy8gdHJ5IGNvbXBhcmluZyB3aXRoIGV4dGVuc2lvbnMgcmVtb3ZlZC5cblxuICAvLyBBdHRlbXB0IHRvIGNvbXBhcmUgd2l0aCBkaXJlY3Rvcnkgb2YgdGhlIGZpbGUsIGZvciBZQU1MIGRpcmVjdG9yeVxuICAvLyBiYWNrZW5kLlxuICByZXR1cm4gb2JqSURzLmZpbmQoaWQgPT5cbiAgICBpZCA9PT0gcGFyc2VkLmRpciB8fCBpZCA9PT0gcGF0aC5qb2luKHBhcnNlZC5kaXIsIHBhcnNlZC5uYW1lKVxuICApICE9PSB1bmRlZmluZWQ7XG59Il19