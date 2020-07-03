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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFzZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9kYi9pc29naXQteWFtbC9tYWluL2Jhc2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUM7QUFDcEMsT0FBTyxLQUFLLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFDL0IsT0FBTyxLQUFLLElBQUksTUFBTSxNQUFNLENBQUM7QUFFN0IsT0FBTyxFQUFFLE1BQU0sRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBQzNDLE9BQU8sRUFBRSxPQUFPLEVBQWtCLE1BQU0sd0JBQXdCLENBQUM7QUFHakUsT0FBTyxFQUFFLHFCQUFxQixFQUFFLE1BQU0sY0FBYyxDQUFDO0FBSXJELE9BQU8sRUFHTCwwQkFBMEIsR0FHM0IsTUFBTSxpQkFBaUIsQ0FBQztBQUl6QixPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sVUFBVSxDQUFDO0FBMkJ6QyxNQUFNLE9BQVEsU0FBUSwwQkFBMEI7SUFPOUMsWUFDWSxJQUFvQixFQUNwQixtQkFBMEM7UUFFcEQsS0FBSyxFQUFFLENBQUM7UUFIRSxTQUFJLEdBQUosSUFBSSxDQUFnQjtRQUNwQix3QkFBbUIsR0FBbkIsbUJBQW1CLENBQXVCO1FBSXBELElBQUksQ0FBQyxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQztRQUV6QixJQUFJLENBQUMsR0FBRyxHQUFHLElBQUksYUFBYSxDQUMxQixFQUFFLEVBQ0YsSUFBSSxDQUFDLElBQUksQ0FBQyxPQUFPLEVBQ2pCLElBQUksQ0FBQyxJQUFJLENBQUMsZUFBZSxFQUN6QixJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFDbEIsRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxVQUFVLEVBQUUsS0FBSyxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFFLEVBQzVELElBQUksQ0FBQyxJQUFJLENBQUMsT0FBTyxFQUNq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QUUsTUFBTSxJQUFJLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxzQkFBc0IsQ0FBQzthQUUzRCxDQUFDO1FBQ0osQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUFFRCxNQUFNLENBQUMsTUFBTSxZQUFZLEdBQTJFLE9BQU8sQ0FBQTtBQUUzRyxlQUFlLE9BQU8sQ0FBQztBQUd2QixTQUFTLGNBQWMsQ0FBQyxNQUFnQixFQUFFLE9BQWU7SUFDdkQsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRTtRQUNoQyxPQUFPLElBQUksQ0FBQztLQUNiO0lBQ0QsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUVuQyxnRUFBZ0U7SUFDaEUsMkRBQTJEO0lBQzNELG1EQUFtRDtJQUNuRCxvREFBb0Q7SUFDcEQseUNBQXlDO0lBRXpDLG9FQUFvRTtJQUNwRSxXQUFXO0lBQ1gsT0FBTyxNQUFNLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQ3RCLEVBQUUsS0FBSyxNQUFNLENBQUMsR0FBRyxJQUFJLEVBQUUsS0FBSyxJQUFJLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxHQUFHLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUMvRCxLQUFLLFNBQVMsQ0FBQztBQUNsQixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgbG9nIGZyb20gJ2VsZWN0cm9uLWxvZyc7XG5pbXBvcnQgKiBhcyBmcyBmcm9tICdmcy1leHRyYSc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuXG5pbXBvcnQgeyBsaXN0ZW4gfSBmcm9tICcuLi8uLi8uLi9pcGMvbWFpbic7XG5pbXBvcnQgeyBTZXR0aW5nLCBTZXR0aW5nTWFuYWdlciB9IGZyb20gJy4uLy4uLy4uL3NldHRpbmdzL21haW4nO1xuXG5pbXBvcnQgeyBJbmRleCB9IGZyb20gJy4uLy4uL3F1ZXJ5JztcbmltcG9ydCB7IFVuaXF1ZUNvbnN0cmFpbnRFcnJvciB9IGZyb20gJy4uLy4uL2Vycm9ycyc7XG5cbmltcG9ydCB7IEZpbGVzeXN0ZW1XcmFwcGVyIH0gZnJvbSAnLi4vLi4vbWFpbi9mcy13cmFwcGVyJztcblxuaW1wb3J0IHtcbiAgQmFja2VuZENsYXNzIGFzIEJhc2VCYWNrZW5kQ2xhc3MsXG4gIEJhY2tlbmRTdGF0dXNSZXBvcnRlciBhcyBCYXNlQmFja2VuZFN0YXR1c1JlcG9ydGVyLFxuICBWZXJzaW9uZWRGaWxlc3lzdGVtQmFja2VuZCxcbiAgTW9kZWxNYW5hZ2VyLFxuICBGaWxlc3lzdGVtTWFuYWdlcixcbn0gZnJvbSAnLi4vLi4vbWFpbi9iYXNlJztcblxuaW1wb3J0IHsgQmFja2VuZERlc2NyaXB0aW9uLCBCYWNrZW5kU3RhdHVzIH0gZnJvbSAnLi4vYmFzZSc7XG5cbmltcG9ydCB7IElzb0dpdFdyYXBwZXIgfSBmcm9tICcuL2lzb2dpdCc7XG5cblxuaW50ZXJmYWNlIEZpeGVkQmFja2VuZE9wdGlvbnMge1xuICAvKiBTZXR0aW5ncyBzdXBwbGllZCBieSB0aGUgZGV2ZWxvcGVyICovXG5cbiAgd29ya0Rpcjogc3RyaW5nXG4gIGNvcnNQcm94eVVSTD86IHN0cmluZ1xuICB1cHN0cmVhbVJlcG9VUkw/OiBzdHJpbmdcbiAgZnNXcmFwcGVyQ2xhc3M6IG5ldyAoYmFzZURpcjogc3RyaW5nKSA9PiBGaWxlc3lzdGVtV3JhcHBlcjxhbnk+XG59XG5pbnRlcmZhY2UgQ29uZmlndXJhYmxlQmFja2VuZE9wdGlvbnMge1xuICAvKiBTZXR0aW5ncyB0aGF0IHVzZXIgY2FuIG9yIG11c3Qgc3BlY2lmeSAqL1xuICByZXBvVVJMOiBzdHJpbmdcbiAgdXNlcm5hbWU6IHN0cmluZ1xuICBhdXRob3JOYW1lOiBzdHJpbmdcbiAgYXV0aG9yRW1haWw6IHN0cmluZ1xufVxudHlwZSBCYWNrZW5kT3B0aW9ucyA9IEZpeGVkQmFja2VuZE9wdGlvbnMgJiBDb25maWd1cmFibGVCYWNrZW5kT3B0aW9ucyAmIHtcbiAgZnNXcmFwcGVyOiBGaWxlc3lzdGVtV3JhcHBlcjxhbnk+XG59XG50eXBlIEluaXRpYWxCYWNrZW5kT3B0aW9ucyA9IEZpeGVkQmFja2VuZE9wdGlvbnMgJiBQYXJ0aWFsPENvbmZpZ3VyYWJsZUJhY2tlbmRPcHRpb25zPlxuXG5cbnR5cGUgQmFja2VuZFN0YXR1c1JlcG9ydGVyID0gQmFzZUJhY2tlbmRTdGF0dXNSZXBvcnRlcjxCYWNrZW5kU3RhdHVzPlxuXG5cbmNsYXNzIEJhY2tlbmQgZXh0ZW5kcyBWZXJzaW9uZWRGaWxlc3lzdGVtQmFja2VuZCB7XG4gIC8qIENvbWJpbmVzIGEgZmlsZXN5c3RlbSBzdG9yYWdlIHdpdGggR2l0LiAqL1xuXG4gIHByaXZhdGUgZ2l0OiBJc29HaXRXcmFwcGVyO1xuICBwcml2YXRlIGZzOiBGaWxlc3lzdGVtV3JhcHBlcjxhbnk+O1xuICBwcml2YXRlIG1hbmFnZXJzOiAoRmlsZXN5c3RlbU1hbmFnZXIgJiBNb2RlbE1hbmFnZXI8YW55LCBhbnksIGFueT4pW107XG5cbiAgY29uc3RydWN0b3IoXG4gICAgICBwcml2YXRlIG9wdHM6IEJhY2tlbmRPcHRpb25zLFxuICAgICAgcHJpdmF0ZSByZXBvcnRCYWNrZW5kU3RhdHVzOiBCYWNrZW5kU3RhdHVzUmVwb3J0ZXIpIHtcblxuICAgIHN1cGVyKCk7XG5cbiAgICB0aGlzLmZzID0gb3B0cy5mc1dyYXBwZXI7XG5cbiAgICB0aGlzLmdpdCA9IG5ldyBJc29HaXRXcmFwcGVyKFxuICAgICAgZnMsXG4gICAgICB0aGlzLm9wdHMucmVwb1VSTCxcbiAgICAgIHRoaXMub3B0cy51cHN0cmVhbVJlcG9VUkwsXG4gICAgICB0aGlzLm9wdHMudXNlcm5hbWUsXG4gICAgICB7IG5hbWU6IHRoaXMub3B0cy5hdXRob3JOYW1lLCBlbWFpbDogdGhpcy5vcHRzLmF1dGhvckVtYWlsIH0sXG4gICAgICB0aGlzLm9wdHMud29ya0RpcixcbiAgICAgIHRoaXMub3B0cy5jb3JzUHJveHlVUkwsXG5cbiAgICAgIC8vIFRoZSBzdGF0dXMgb2YgdGhpcyBiYWNrZW5kIGlzIHJlZHVjZWQgdG8gR2l0IHJlcG8gc3RhdHVzIG5vdy5cbiAgICAgIC8vIFBvdGVudGlhbGx5IGl0IHNob3VsZCBpbmNsdWRlIGZpbGVzeXN0ZW0tcmVsYXRlZCBzdGF0dXMgYXMgd2VsbCxcbiAgICAgIC8vIHJlcG9ydGluZyBpc3N1ZXMgd2l0aCBlLmcuIGluc3VmZmljaWVudCBkaXNrIHNwYWNlLlxuICAgICAgdGhpcy5yZXBvcnRCYWNrZW5kU3RhdHVzLFxuICAgICk7XG5cbiAgICB0aGlzLm1hbmFnZXJzID0gW107XG5cbiAgICB0aGlzLnN5bmNocm9uaXplID0gdGhpcy5zeW5jaHJvbml6ZS5iaW5kKHRoaXMpO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGdldExvY2FsRmlsZXN5c3RlbVBhdGgoaWQ6IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLmZzLmV4cGFuZFBhdGgoaWQpO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGdldEN1cnJlbnRDb21taXR0ZXJJbmZvcm1hdGlvbigpOiBQcm9taXNlPHsgdXNlcm5hbWU6IHN0cmluZywgbmFtZTogc3RyaW5nLCBlbWFpbDogc3RyaW5nIH0+IHtcbiAgICByZXR1cm4ge1xuICAgICAgdXNlcm5hbWU6IHRoaXMub3B0cy51c2VybmFtZSxcbiAgICAgIG5hbWU6IHRoaXMub3B0cy5hdXRob3JOYW1lLFxuICAgICAgZW1haWw6IHRoaXMub3B0cy5hdXRob3JFbWFpbCxcbiAgICB9O1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGRlc2NyaWJlKCk6IFByb21pc2U8QmFja2VuZERlc2NyaXB0aW9uPiB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHZlcmJvc2VOYW1lOiBcIkdpdCtZQU1MXCIsXG4gICAgICB2ZXJib3NlTmFtZUxvbmc6IFwiR2l0LXZlcnNpb25lZCBZQU1MIGZpbGUgdHJlZVwiLFxuICAgICAgZ2l0UmVwbzogdGhpcy5vcHRzLnJlcG9VUkwsXG4gICAgICBnaXRVc2VybmFtZTogdGhpcy5vcHRzLnVzZXJuYW1lLFxuICAgICAgbG9jYWxDbG9uZVBhdGg6IHRoaXMub3B0cy53b3JrRGlyLFxuICAgICAgc3RhdHVzOiB0aGlzLmdpdC5nZXRTdGF0dXMoKSxcbiAgICB9XG4gIH1cblxuICBwdWJsaWMgc3RhdGljIHJlZ2lzdGVyU2V0dGluZ3NGb3JDb25maWd1cmFibGVPcHRpb25zKFxuICAgICAgc2V0dGluZ3M6IFNldHRpbmdNYW5hZ2VyLFxuICAgICAgaW5pdGlhbE9wdGlvbnM6IEluaXRpYWxCYWNrZW5kT3B0aW9ucyxcbiAgICAgIGRiSUQ6IHN0cmluZykge1xuXG4gICAgY29uc3QgcGFuZUxhYmVsUG9zdGZpeCA9IGRiSUQgIT09ICdkZWZhdWx0JyA/IGAgZm9yIOKAnCR7ZGJJRH3igJ1gIDogJyc7XG4gICAgY29uc3Qgc2V0dGluZ0lEUHJlZml4ID0gYGRiXyR7ZGJJRH1fYDtcbiAgICBjb25zdCBwYW5lSUQgPSBgZGJfJHtkYklEfWA7XG5cbiAgICBzZXR0aW5ncy5jb25maWd1cmVQYW5lKHtcbiAgICAgIGlkOiBwYW5lSUQsXG4gICAgICBsYWJlbDogYERhdGFiYXNlIHNldHRpbmdzJHtwYW5lTGFiZWxQb3N0Zml4fWAsXG4gICAgICBpY29uOiAnZ2l0LW1lcmdlJyxcbiAgICB9KTtcblxuICAgIHNldHRpbmdzLnJlZ2lzdGVyKG5ldyBTZXR0aW5nPHN0cmluZz4oXG4gICAgICBwYW5lSUQsXG4gICAgICBgJHtzZXR0aW5nSURQcmVmaXh9Z2l0UmVwb1VybGAsXG4gICAgICAndGV4dCcsXG4gICAgICBpbml0aWFsT3B0aW9ucy5yZXBvVVJMID09PSB1bmRlZmluZWQsXG4gICAgICBcIkdpdCByZXBvc2l0b3J5IFVSTFwiLFxuICAgICAgXCJFLmcuLCBodHRwczovL2dpdGh1Yi5jb20vPHVzZXJuYW1lPi88cmVwb3NpdG9yeSBuYW1lPlwiLFxuICAgICkpO1xuXG4gICAgc2V0dGluZ3MucmVnaXN0ZXIobmV3IFNldHRpbmc8c3RyaW5nPihcbiAgICAgIHBhbmVJRCxcbiAgICAgIGAke3NldHRpbmdJRFByZWZpeH1naXRVc2VybmFtZWAsXG4gICAgICAndGV4dCcsXG4gICAgICBpbml0aWFsT3B0aW9ucy51c2VybmFtZSA9PT0gdW5kZWZpbmVkLFxuICAgICAgXCJHaXQgdXNlcm5hbWVcIixcbiAgICApKTtcblxuICAgIHNldHRpbmdzLnJlZ2lzdGVyKG5ldyBTZXR0aW5nPHN0cmluZz4oXG4gICAgICBwYW5lSUQsXG4gICAgICBgJHtzZXR0aW5nSURQcmVmaXh9Z2l0QXV0aG9yTmFtZWAsXG4gICAgICAndGV4dCcsXG4gICAgICBpbml0aWFsT3B0aW9ucy5hdXRob3JOYW1lID09PSB1bmRlZmluZWQsXG4gICAgICBcIkdpdCBhdXRob3IgbmFtZVwiLFxuICAgICkpO1xuXG4gICAgc2V0dGluZ3MucmVnaXN0ZXIobmV3IFNldHRpbmc8c3RyaW5nPihcbiAgICAgIHBhbmVJRCxcbiAgICAgIGAke3NldHRpbmdJRFByZWZpeH1naXRBdXRob3JFbWFpbGAsXG4gICAgICAndGV4dCcsXG4gICAgICBpbml0aWFsT3B0aW9ucy5hdXRob3JFbWFpbCA9PT0gdW5kZWZpbmVkLFxuICAgICAgXCJHaXQgYXV0aG9yIGVtYWlsXCIsXG4gICAgKSk7XG4gIH1cblxuICBwdWJsaWMgc3RhdGljIGFzeW5jIGNvbXBsZXRlT3B0aW9uc0Zyb21TZXR0aW5ncyhcbiAgICAgIHNldHRpbmdzOiBTZXR0aW5nTWFuYWdlcixcbiAgICAgIGF2YWlsYWJsZU9wdGlvbnM6IEluaXRpYWxCYWNrZW5kT3B0aW9ucyxcbiAgICAgIGRiSUQ6IHN0cmluZykge1xuXG4gICAgY29uc3Qgc2V0dGluZ0lEUHJlZml4ID0gYGRiXyR7ZGJJRH1fYDtcblxuICAgIGFzeW5jIGZ1bmN0aW9uIGdldFNldHRpbmc8VD4oc2V0dGluZ0lEOiBzdHJpbmcpOiBQcm9taXNlPFQ+IHtcbiAgICAgIHJldHVybiBhd2FpdCBzZXR0aW5ncy5nZXRWYWx1ZShgJHtzZXR0aW5nSURQcmVmaXh9JHtzZXR0aW5nSUR9YCkgYXMgVDtcbiAgICB9XG5cbiAgICBjb25zdCBmc1dyYXBwZXJDbGFzcyA9IGF2YWlsYWJsZU9wdGlvbnMuZnNXcmFwcGVyQ2xhc3M7XG5cbiAgICByZXR1cm4ge1xuICAgICAgd29ya0RpcjogYXZhaWxhYmxlT3B0aW9ucy53b3JrRGlyLFxuICAgICAgY29yc1Byb3h5VVJMOiBhdmFpbGFibGVPcHRpb25zLmNvcnNQcm94eVVSTCxcbiAgICAgIHVwc3RyZWFtUmVwb1VSTDogYXZhaWxhYmxlT3B0aW9ucy51cHN0cmVhbVJlcG9VUkwsXG4gICAgICBmc1dyYXBwZXJDbGFzczogYXZhaWxhYmxlT3B0aW9ucy5mc1dyYXBwZXJDbGFzcyxcbiAgICAgIGZzV3JhcHBlcjogbmV3IGZzV3JhcHBlckNsYXNzKGF2YWlsYWJsZU9wdGlvbnMud29ya0RpciksXG5cbiAgICAgIHJlcG9VUkw6IChcbiAgICAgICAgKGF3YWl0IGdldFNldHRpbmc8c3RyaW5nPignZ2l0UmVwb1VybCcpKVxuICAgICAgICB8fCBhdmFpbGFibGVPcHRpb25zLnJlcG9VUkwpIGFzIHN0cmluZyxcbiAgICAgIHVzZXJuYW1lOiAoXG4gICAgICAgIChhd2FpdCBnZXRTZXR0aW5nPHN0cmluZz4oJ2dpdFVzZXJuYW1lJykpXG4gICAgICAgIHx8IGF2YWlsYWJsZU9wdGlvbnMudXNlcm5hbWUpIGFzIHN0cmluZyxcbiAgICAgIGF1dGhvck5hbWU6IChcbiAgICAgICAgKGF3YWl0IGdldFNldHRpbmc8c3RyaW5nPignZ2l0QXV0aG9yTmFtZScpKVxuICAgICAgICB8fCBhdmFpbGFibGVPcHRpb25zLmF1dGhvck5hbWUpIGFzIHN0cmluZyxcbiAgICAgIGF1dGhvckVtYWlsOiAoXG4gICAgICAgIChhd2FpdCBnZXRTZXR0aW5nPHN0cmluZz4oJ2dpdEF1dGhvckVtYWlsJykpXG4gICAgICAgIHx8IGF2YWlsYWJsZU9wdGlvbnMuYXV0aG9yRW1haWwpIGFzIHN0cmluZyxcbiAgICB9XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgcmVnaXN0ZXJNYW5hZ2VyKG1hbmFnZXI6IEZpbGVzeXN0ZW1NYW5hZ2VyICYgTW9kZWxNYW5hZ2VyPGFueSwgYW55LCBhbnk+KSB7XG4gICAgdGhpcy5tYW5hZ2Vycy5wdXNoKG1hbmFnZXIpO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGluaXQoZm9yY2VSZXNldCA9IGZhbHNlKSB7XG4gICAgbGV0IGRvSW5pdGlhbGl6ZTogYm9vbGVhbjtcblxuICAgIHRyeSB7XG4gICAgICBpZiAoZm9yY2VSZXNldCA9PT0gdHJ1ZSkge1xuICAgICAgICBsb2cud2FybihcIkMvZGIvaXNvZ2l0LXlhbWw6IEdpdCBpcyBiZWluZyBmb3JjZSByZWluaXRpYWxpemVkXCIpO1xuICAgICAgICBkb0luaXRpYWxpemUgPSB0cnVlO1xuICAgICAgfSBlbHNlIGlmICghKGF3YWl0IHRoaXMuZ2l0LmlzVXNpbmdSZW1vdGVVUkxzKHtcbiAgICAgICAgICBvcmlnaW46IHRoaXMub3B0cy5yZXBvVVJMLFxuICAgICAgICAgIHVwc3RyZWFtOiB0aGlzLm9wdHMudXBzdHJlYW1SZXBvVVJMfSkpKSB7XG4gICAgICAgIGxvZy53YXJuKFwiQy9kYi9pc29naXQteWFtbDogR2l0IGhhcyBtaXNtYXRjaGluZyByZW1vdGUgVVJMcywgcmVpbml0aWFsaXppbmdcIik7XG4gICAgICAgIGRvSW5pdGlhbGl6ZSA9IHRydWU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBsb2cuaW5mbyhcIkMvZGIvaXNvZ2l0LXlhbWw6IEdpdCBpcyBhbHJlYWR5IGluaXRpYWxpemVkXCIpO1xuICAgICAgICBkb0luaXRpYWxpemUgPSBmYWxzZTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBkb0luaXRpYWxpemUgPSB0cnVlO1xuICAgIH1cblxuICAgIGlmIChkb0luaXRpYWxpemUpIHtcbiAgICAgIGF3YWl0IHRoaXMuZ2l0LmRlc3Ryb3koKTtcbiAgICB9XG5cbiAgICBhd2FpdCB0aGlzLnN5bmNocm9uaXplKCk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgcmVhZChvYmpJRDogc3RyaW5nLCBtZXRhRmllbGRzPzogc3RyaW5nW10pIHtcbiAgICByZXR1cm4gYXdhaXQgdGhpcy5mcy5yZWFkKHRoaXMuZ2V0UmVmKG9iaklEKSwgbWV0YUZpZWxkcykgYXMgb2JqZWN0O1xuICB9XG5cbiAgcHVibGljIGFzeW5jIHJlYWRWZXJzaW9uKG9iaklEOiBzdHJpbmcsIHZlcnNpb246IHN0cmluZykge1xuICAgIC8vIE5PVEU6IFRoaXMgd2lsbCBmYWlsIHdpdGggWUFNTERpcmVjdG9yeVdyYXBwZXIuXG4gICAgLy8gb2JqSUQgbXVzdCByZWZlciB0byBhIHNpbmdsZSBmaWxlLlxuXG4gICAgLy8gVE9ETzogU3VwcG9ydCBjb21wb3VuZCBvYmplY3RzIChkaXJlY3RvcmllcylcbiAgICAvLyBieSBtb3ZpbmcgdGhlIGZpbGUgZGF0YSBwYXJzaW5nIGxvZ2ljIGludG8gbWFuYWdlclxuICAgIC8vIGFuZCBhZGRpbmcgQmFja2VuZC5yZWFkVHJlZSgpLlxuXG4gICAgY29uc3QgYmxvYiA9IGF3YWl0IHRoaXMuZ2l0LnJlYWRGaWxlQmxvYkF0Q29tbWl0KHRoaXMuZ2V0UmVmKG9iaklEKSwgdmVyc2lvbik7XG4gICAgcmV0dXJuIHRoaXMuZnMucGFyc2VEYXRhKGJsb2IpO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGNyZWF0ZTxPIGV4dGVuZHMgUmVjb3JkPHN0cmluZywgYW55Pj4ob2JqOiBPLCBvYmpQYXRoOiBzdHJpbmcsIG1ldGFGaWVsZHM/OiAoa2V5b2YgTylbXSkge1xuICAgIGlmIChhd2FpdCB0aGlzLmZzLmV4aXN0cyhvYmpQYXRoKSkge1xuICAgICAgdGhyb3cgbmV3IFVuaXF1ZUNvbnN0cmFpbnRFcnJvcihcImZpbGVzeXN0ZW0gcGF0aFwiLCBvYmpQYXRoKTtcbiAgICB9XG5cbiAgICBhd2FpdCB0aGlzLmZzLndyaXRlKG9ialBhdGgsIG9iaiwgbWV0YUZpZWxkcyk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgY29tbWl0QWxsKG1zZzogc3RyaW5nLCByZW1vdmluZzogYm9vbGVhbikge1xuICAgIC8vIE5PVEU6IFVzZSB3aXRoIGNhcmUuXG5cbiAgICBhd2FpdCB0aGlzLmdpdC5zdGFnZUFuZENvbW1pdChbJy4nXSwgbXNnLCByZW1vdmluZyk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgY29tbWl0KG9iaklEczogc3RyaW5nW10sIG1lc3NhZ2U6IHN0cmluZywgcmVtb3ZpbmcgPSBmYWxzZSkge1xuICAgIGF3YWl0IHRoaXMucmVzZXRPcnBoYW5lZEZpbGVDaGFuZ2VzKCk7XG5cbiAgICBjb25zdCB1bmNvbW1pdHRlZCA9IGF3YWl0IHRoaXMucmVhZFVuY29tbWl0dGVkRmlsZUluZm8oKTtcblxuICAgIGNvbnN0IHBhdGhzOiBzdHJpbmdbXSA9IHVuY29tbWl0dGVkLlxuICAgICAgZmlsdGVyKGZpbGVpbmZvID0+IGdpdFBhdGhNYXRjaGVzKG9iaklEcywgZmlsZWluZm8ucGF0aCkpLlxuICAgICAgbWFwKGZpbGVpbmZvID0+IGZpbGVpbmZvLnBhdGgpO1xuXG4gICAgbG9nLmRlYnVnKFwiQy9kYjogQ29tbWl0dGluZyBvYmplY3RzXCIsIG9iaklEcywgdW5jb21taXR0ZWQsIHBhdGhzLCBtZXNzYWdlKTtcblxuICAgIGlmIChwYXRocy5sZW5ndGggPiAwKSB7XG4gICAgICAvLyBUT0RPOiBNYWtlIEdpdCB0cmFjayB3aGljaCBmaWxlcyBnb3QgY29tbWl0dGVkIChoYWQgY2hhbmdlcyksXG4gICAgICAvLyBhbmQgcmV0dXJuIHBhdGhzXG4gICAgICBhd2FpdCB0aGlzLmdpdC5zdGFnZUFuZENvbW1pdChwYXRocywgbWVzc2FnZSwgcmVtb3ZpbmcpO1xuICAgIH1cbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBkaXNjYXJkKG9iaklEczogc3RyaW5nW10pIHtcbiAgICBjb25zdCBwYXRoczogc3RyaW5nW10gPSAoYXdhaXQgdGhpcy5yZWFkVW5jb21taXR0ZWRGaWxlSW5mbygpKS5cbiAgICAgIGZpbHRlcihmaWxlaW5mbyA9PiBnaXRQYXRoTWF0Y2hlcyhvYmpJRHMsIGZpbGVpbmZvLnBhdGgpKS5cbiAgICAgIG1hcChmaWxlaW5mbyA9PiBmaWxlaW5mby5wYXRoKTtcblxuICAgIGlmIChwYXRocy5sZW5ndGggPiAwKSB7XG4gICAgICBhd2FpdCB0aGlzLmdpdC5yZXNldEZpbGVzKHBhdGhzKTtcbiAgICB9XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgbGlzdFVuY29tbWl0dGVkKCkge1xuICAgIGNvbnN0IGZpbGVzID0gYXdhaXQgdGhpcy5yZWFkVW5jb21taXR0ZWRGaWxlSW5mbygpO1xuXG4gICAgY29uc3Qgb2JqSURzOiBzdHJpbmdbXSA9IGZpbGVzLlxuICAgICAgbWFwKGZpbGVpbmZvID0+IGZpbGVpbmZvLnBhdGgpO1xuXG4gICAgLy8gRGlzY2FyZCBkdXBsaWNhdGVzIGZyb20gdGhlIGxpc3RcbiAgICByZXR1cm4gb2JqSURzLmZpbHRlcihmdW5jdGlvbiAob2JqSUQsIGlkeCwgc2VsZikge1xuICAgICAgcmV0dXJuIGlkeCA9PT0gc2VsZi5pbmRleE9mKG9iaklEKTtcbiAgICB9KTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBsaXN0SURzKHF1ZXJ5OiB7IHN1YmRpcjogc3RyaW5nIH0pIHtcbiAgICByZXR1cm4gYXdhaXQgdGhpcy5mcy5saXN0SURzKHsgc3ViZGlyOiBxdWVyeS5zdWJkaXIgfSk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgZ2V0SW5kZXgoc3ViZGlyOiBzdHJpbmcsIGlkRmllbGQ6IHN0cmluZywgb25seUlEcz86IHN0cmluZ1tdLCBtZXRhRmllbGRzPzogc3RyaW5nW10pIHtcbiAgICBjb25zdCBpZHNUb1NlbGVjdCA9IG9ubHlJRHMgIT09IHVuZGVmaW5lZFxuICAgICAgPyBvbmx5SURzLm1hcChpZCA9PiB0aGlzLmdldFJlZihpZCkpXG4gICAgICA6IHVuZGVmaW5lZDtcblxuICAgIGNvbnN0IG9ianMgPSBhd2FpdCB0aGlzLmZzLnJlYWRBbGwoeyBzdWJkaXIsIG9ubHlJRHM6IGlkc1RvU2VsZWN0IH0sIG1ldGFGaWVsZHMpO1xuXG4gICAgdmFyIGlkeDogSW5kZXg8YW55PiA9IHt9O1xuICAgIGZvciAoY29uc3Qgb2JqIG9mIG9ianMpIHtcbiAgICAgIGlkeFtgJHtvYmpbaWRGaWVsZF19YF0gPSBvYmo7XG4gICAgfVxuXG4gICAgcmV0dXJuIGlkeDtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyB1cGRhdGUob2JqSUQ6IHN0cmluZywgbmV3RGF0YTogUmVjb3JkPHN0cmluZywgYW55PiwgbWV0YUZpZWxkcz86IHN0cmluZ1tdKSB7XG4gICAgYXdhaXQgdGhpcy5mcy53cml0ZSh0aGlzLmdldFJlZihvYmpJRCksIG5ld0RhdGEsIG1ldGFGaWVsZHMpO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGRlbGV0ZShvYmpJRDogc3RyaW5nKSB7XG4gICAgYXdhaXQgdGhpcy5mcy53cml0ZSh0aGlzLmdldFJlZihvYmpJRCksIHVuZGVmaW5lZCk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgcmVzZXRPcnBoYW5lZEZpbGVDaGFuZ2VzKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIC8qIFJlbW92ZSBmcm9tIGZpbGVzeXN0ZW0gYW55IGZpbGVzIHVuZGVyIG91ciBGUyBiYWNrZW5kIHBhdGhcbiAgICAgICB0aGF0IHRoZSBiYWNrZW5kIGNhbm5vdCBhY2NvdW50IGZvcixcbiAgICAgICBidXQgd2hpY2ggbWF5IGFwcGVhciBhcyB1bnN0YWdlZCBjaGFuZ2VzIHRvIEdpdC4gKi9cblxuICAgIGNvbnN0IG9ycGhhbkZpbGVQYXRocyA9IChhd2FpdCB0aGlzLnJlYWRVbmNvbW1pdHRlZEZpbGVJbmZvKCkpLlxuICAgIG1hcChmaWxlaW5mbyA9PiBmaWxlaW5mby5wYXRoKS5cbiAgICBmaWx0ZXIoZmlsZXBhdGggPT4gdGhpcy5tYW5hZ2Vycy5tYXAobWdyID0+IG1nci5tYW5hZ2VzRmlsZUF0UGF0aChmaWxlcGF0aCkpLmluZGV4T2YodHJ1ZSkgPCAwKTtcblxuICAgIGlmIChvcnBoYW5GaWxlUGF0aHMubGVuZ3RoID4gMCkge1xuICAgICAgbG9nLndhcm4oXCJDL2RiL2lzb2dpdC15YW1sOiBSZXNldHRpbmcgb3JwaGFuZWQgZmlsZXNcIiwgb3JwaGFuRmlsZVBhdGhzKTtcbiAgICAgIGF3YWl0IHRoaXMuZ2l0LnJlc2V0RmlsZXMob3JwaGFuRmlsZVBhdGhzKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlYWRVbmNvbW1pdHRlZEZpbGVJbmZvKCk6IFByb21pc2U8eyBwYXRoOiBzdHJpbmcgfVtdPiB7XG4gICAgLyogUmV0dXJucyBhIGxpc3Qgb2Ygb2JqZWN0cyB0aGF0IG1hcCBHaXQtcmVsYXRpdmUgcGF0aHMgdG8gYWN0dWFsIG9iamVjdCBJRHMuXG4gICAgICAgV2hlcmUgb2JqZWN0IElEIGlzIHVuZGVmaW5lZCwgdGhhdCBpbXBsaWVzIGZpbGUgaXMg4oCcb3JwaGFuZWTigJ1cbiAgICAgICAobm90IHJlY29nbml6ZWQgYXMgYmVsb25naW5nIHRvIGFueSBvYmplY3QgbWFuYWdlZCBieSB0aGlzIHN0b3JlKS4gKi9cblxuICAgIGNvbnN0IGNoYW5nZWRGaWxlczogc3RyaW5nW10gPSBhd2FpdCB0aGlzLmdpdC5saXN0Q2hhbmdlZEZpbGVzKFsnLiddKTtcbiAgICByZXR1cm4gYXdhaXQgUHJvbWlzZS5hbGwoY2hhbmdlZEZpbGVzLm1hcChmcCA9PiB7XG4gICAgICByZXR1cm4geyBwYXRoOiBmcCB9O1xuICAgIH0pKTtcbiAgfVxuXG4gIHByaXZhdGUgZ2V0UmVmKG9iaklEOiBzdHJpbmcgfCBudW1iZXIpOiBzdHJpbmcge1xuICAgIC8qIFJldHVybnMgRlMgYmFja2VuZCByZWZlcmVuY2UgZnJvbSBEQiBiYWNrZW5kIG9iamVjdCBJRC4gKi9cbiAgICByZXR1cm4gYCR7b2JqSUR9YDtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgc3luY2hyb25pemUoKSB7XG4gICAgYXdhaXQgdGhpcy5naXQuc3luY2hyb25pemUoKTtcblxuICAgIGZvciAoY29uc3QgbWdyIG9mIHRoaXMubWFuYWdlcnMpIHtcbiAgICAgIGxvZy5kZWJ1ZyhcIkMvaW5pdE1haW46IEluaXRpYWxpemluZyBtYW5hZ2VyXCIpO1xuICAgICAgYXdhaXQgbWdyLmluaXQoKTtcbiAgICAgIGF3YWl0IG1nci5yZXBvcnRVcGRhdGVkRGF0YSgpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgY2hlY2tVbmNvbW1pdHRlZCgpIHtcbiAgICByZXR1cm4gYXdhaXQgdGhpcy5naXQuY2hlY2tVbmNvbW1pdHRlZCgpO1xuICB9XG5cbiAgcHVibGljIHNldFVwSVBDKGRiSUQ6IHN0cmluZykge1xuICAgIHN1cGVyLnNldFVwSVBDKGRiSUQpO1xuXG4gICAgbG9nLnZlcmJvc2UoXCJDL2RiL2lzb2dpdC15YW1sOiBTZXR0aW5nIHVwIElQQ1wiKTtcblxuICAgIGNvbnN0IHByZWZpeCA9IGBkYi0ke2RiSUR9YDtcblxuICAgIGxpc3Rlbjx7fSwgeyBudW1VbmNvbW1pdHRlZDogbnVtYmVyIH0+XG4gICAgKGAke3ByZWZpeH0tY291bnQtdW5jb21taXR0ZWRgLCBhc3luYyAoKSA9PiB7XG4gICAgICByZXR1cm4geyBudW1VbmNvbW1pdHRlZDogKGF3YWl0IHRoaXMuZ2l0Lmxpc3RDaGFuZ2VkRmlsZXMoKSkubGVuZ3RoIH07XG4gICAgfSk7XG5cbiAgICBsaXN0ZW48e30sIHsgc3RhcnRlZDogdHJ1ZSB9PlxuICAgIChgJHtwcmVmaXh9LWdpdC10cmlnZ2VyLXN5bmNgLCBhc3luYyAoKSA9PiB7XG4gICAgICB0aGlzLnN5bmNocm9uaXplKCk7XG4gICAgICByZXR1cm4geyBzdGFydGVkOiB0cnVlIH07XG4gICAgfSk7XG5cbiAgICBsaXN0ZW48e30sIHsgc3VjY2VzczogdHJ1ZSB9PlxuICAgIChgJHtwcmVmaXh9LWdpdC1kaXNjYXJkLXVuc3RhZ2VkYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgdGhpcy5naXQucmVzZXRGaWxlcygpO1xuICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSB9O1xuICAgIH0pO1xuXG4gICAgbGlzdGVuPHt9LCB7IGhhc1VuY29tbWl0dGVkQ2hhbmdlczogYm9vbGVhbiB9PlxuICAgIChgJHtwcmVmaXh9LWdpdC11cGRhdGUtc3RhdHVzYCwgYXN5bmMgKCkgPT4ge1xuICAgICAgcmV0dXJuIHsgaGFzVW5jb21taXR0ZWRDaGFuZ2VzOiBhd2FpdCB0aGlzLmNoZWNrVW5jb21taXR0ZWQoKSB9O1xuICAgIH0pO1xuXG4gICAgbGlzdGVuPHsgcGFzc3dvcmQ6IHN0cmluZyB9LCB7IHN1Y2Nlc3M6IHRydWUgfT5cbiAgICAoYCR7cHJlZml4fS1naXQtc2V0LXBhc3N3b3JkYCwgYXN5bmMgKHsgcGFzc3dvcmQgfSkgPT4ge1xuICAgICAgLy8gV0FSTklORzogRG9u4oCZdCBsb2cgcGFzc3dvcmRcbiAgICAgIGxvZy52ZXJib3NlKFwiQy9kYi9pc29naXQteWFtbDogcmVjZWl2ZWQgZ2l0LXNldC1wYXNzd29yZCByZXF1ZXN0XCIpO1xuXG4gICAgICB0aGlzLmdpdC5zZXRQYXNzd29yZChwYXNzd29yZCk7XG5cbiAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IHRydWUgfTtcbiAgICB9KTtcblxuICAgIGxpc3Rlbjx7fSwgeyBzdWNjZXNzOiB0cnVlIH0+XG4gICAgKGAke3ByZWZpeH0tZ2l0LXJlcXVlc3QtcHVzaGAsIGFzeW5jICgpID0+IHtcbiAgICAgIHRoaXMuZ2l0LnJlcXVlc3RQdXNoKCk7XG4gICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlIH07XG4gICAgfSk7XG5cbiAgICBsaXN0ZW48e30sIHsgdXNlcm5hbWU6IHN0cmluZywgZW1haWw6IHN0cmluZywgbmFtZTogc3RyaW5nIH0+XG4gICAgKGAke3ByZWZpeH0tZ2V0LWN1cnJlbnQtY29tbWl0dGVyLWluZm9gLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBhdXRob3JJbmZvID0gYXdhaXQgdGhpcy5nZXRDdXJyZW50Q29tbWl0dGVySW5mb3JtYXRpb24oKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHVzZXJuYW1lOiBhdXRob3JJbmZvLnVzZXJuYW1lLFxuICAgICAgICBlbWFpbDogYXV0aG9ySW5mby5lbWFpbCxcbiAgICAgICAgbmFtZTogYXV0aG9ySW5mby5uYW1lLFxuICAgICAgfTtcbiAgICB9KTtcblxuICAgIGxpc3Rlbjx7fSwgeyBvcmlnaW5VUkw6IHN0cmluZyB8IG51bGwsIHVzZXJuYW1lOiBzdHJpbmcgfCBudWxsIH0+XG4gICAgKGAke3ByZWZpeH0tZ2l0LWNvbmZpZy1nZXRgLCBhc3luYyAoKSA9PiB7XG4gICAgICBsb2cudmVyYm9zZShcIkMvZGIvaXNvZ2l0LXlhbWw6IHJlY2VpdmVkIGdpdC1jb25maWcgcmVxdWVzdFwiKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9yaWdpblVSTDogYXdhaXQgdGhpcy5naXQuZ2V0T3JpZ2luVXJsKCksXG4gICAgICAgIC8vIG5hbWU6IGF3YWl0IHRoaXMuZ2l0LmNvbmZpZ0dldCgndXNlci5uYW1lJyksXG4gICAgICAgIC8vIGVtYWlsOiBhd2FpdCB0aGlzLmdpdC5jb25maWdHZXQoJ3VzZXIuZW1haWwnKSxcbiAgICAgICAgdXNlcm5hbWU6IGF3YWl0IHRoaXMuZ2l0LmNvbmZpZ0dldCgnY3JlZGVudGlhbHMudXNlcm5hbWUnKSxcbiAgICAgICAgLy8gUGFzc3dvcmQgbXVzdCBub3QgYmUgcmV0dXJuZWQsIG9mIGNvdXJzZVxuICAgICAgfTtcbiAgICB9KTtcbiAgfVxufVxuXG5leHBvcnQgY29uc3QgQmFja2VuZENsYXNzOiBCYXNlQmFja2VuZENsYXNzPEluaXRpYWxCYWNrZW5kT3B0aW9ucywgQmFja2VuZE9wdGlvbnMsIEJhY2tlbmRTdGF0dXM+ID0gQmFja2VuZFxuXG5leHBvcnQgZGVmYXVsdCBCYWNrZW5kO1xuXG5cbmZ1bmN0aW9uIGdpdFBhdGhNYXRjaGVzKG9iaklEczogc3RyaW5nW10sIGdpdFBhdGg6IHN0cmluZykge1xuICBpZiAob2JqSURzLmluZGV4T2YoZ2l0UGF0aCkgPj0gMCkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGNvbnN0IHBhcnNlZCA9IHBhdGgucGFyc2UoZ2l0UGF0aCk7XG5cbiAgLy8gQmFja2VuZCBvcGVyYXRlcyBmaWxlIHJlZmVyZW5jZXMgYXMgcGF0aHMgd2l0aG91dCBleHRlbnNpb25zLlxuICAvLyBGUyB3cmFwcGVyIGV4cGFuZHMgcGF0aHMsIGFkZGluZyBleHRlbnNpb24gaWYgbmVjZXNzYXJ5LlxuICAvLyBHaXQsIGhvd2V2ZXIsIGRvZXNu4oCZdCBrbm93IGFib3V0IHRoZSBleHRlbnNpb25zLlxuICAvLyBGb3IgWUFNTCBmaWxlcyB3aXRoIGV4dGVuc2lvbnMgKG5vdCBkaXJlY3RvcmllcyksXG4gIC8vIHRyeSBjb21wYXJpbmcgd2l0aCBleHRlbnNpb25zIHJlbW92ZWQuXG5cbiAgLy8gQXR0ZW1wdCB0byBjb21wYXJlIHdpdGggZGlyZWN0b3J5IG9mIHRoZSBmaWxlLCBmb3IgWUFNTCBkaXJlY3RvcnlcbiAgLy8gYmFja2VuZC5cbiAgcmV0dXJuIG9iaklEcy5maW5kKGlkID0+XG4gICAgaWQgPT09IHBhcnNlZC5kaXIgfHwgaWQgPT09IHBhdGguam9pbihwYXJzZWQuZGlyLCBwYXJzZWQubmFtZSlcbiAgKSAhPT0gdW5kZWZpbmVkO1xufSJdfQ==