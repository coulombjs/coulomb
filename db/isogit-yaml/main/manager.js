import * as log from 'electron-log';
import * as path from 'path';
import { listen } from '../../../ipc/main';
import { ModelManager, CommitError } from '../../main/base';
import { isGitError } from './isogit/base';
class Manager extends ModelManager {
    constructor(db, managerConfig, modelInfo, reportUpdatedData) {
        super();
        this.db = db;
        this.managerConfig = managerConfig;
        this.modelInfo = modelInfo;
        this.reportUpdatedData = reportUpdatedData;
        db.registerManager(this);
    }
    async getLocalFilesystemPath(id) {
        return `${await this.db.getLocalFilesystemPath(this.getDBRef(id))}`;
    }
    managesFileAtPath(filePath) {
        return true;
    }
    async listIDs(query) {
        return (await this.db.listIDs({ subdir: this.managerConfig.workDir })).
            map(ref => this.getObjID(ref));
    }
    async count(query) {
        return (await this.listIDs(query)).length;
    }
    // CRUD methods
    async create(obj, commit = false) {
        const objID = obj[this.managerConfig.idField];
        await this.db.create(obj, this.getDBRef(objID), this.managerConfig.metaFields);
        if (commit !== false) {
            await this.commitOne(objID, commit !== true ? commit : null, 'create', false);
            await this.reportUpdatedData([objID]);
        }
    }
    async read(objID) {
        return await this.db.read(this.getDBRef(objID), this.managerConfig.metaFields ? this.managerConfig.metaFields : undefined);
    }
    async readVersion(objID, version) {
        return await this.db.readVersion(this.getDBRef(objID), version);
    }
    async commit(objIDs, message) {
        if (objIDs.length > 0) {
            await this.db.commit(objIDs.map(objID => this.getDBRef(objID)), message);
            await this.reportUpdatedData(objIDs);
        }
    }
    async discard(objIDs) {
        if (objIDs.length > 0) {
            await this.db.discard(objIDs.map(objID => this.getDBRef(objID)));
            await this.reportUpdatedData(objIDs);
        }
    }
    async listUncommitted() {
        if (this.db.listUncommitted) {
            const dbRefs = await this.db.listUncommitted();
            const objIDs = dbRefs.
                filter(ref => this.managesFileAtPath(ref)).
                map(ref => this.getObjID(ref));
            return objIDs.filter(function (objID, idx, self) {
                // Discard duplicates from the list
                return idx === self.indexOf(objID);
            });
        }
        else {
            throw new Error("listUncommitted() is not implemented by DB backend");
        }
    }
    async readAll(query) {
        var idx = await this.db.getIndex(this.managerConfig.workDir, this.managerConfig.idField, (query === null || query === void 0 ? void 0 : query.onlyIDs) !== undefined
            ? query.onlyIDs.map(id => this.getDBRef(id))
            : undefined, this.managerConfig.metaFields
            ? this.managerConfig.metaFields
            : undefined);
        return idx;
    }
    // Update skipping commit and notifications
    async rawUpdate(objID, newData) {
        if (objID !== newData[this.managerConfig.idField]) {
            log.error("Attempt to update object ID", objID, newData);
            throw new Error("Updating object IDs is not supported at the moment.");
        }
        await this.db.update(this.getDBRef(objID), newData, this.managerConfig.metaFields
            ? this.managerConfig.metaFields
            : undefined);
    }
    async update(objID, newData, commit = false) {
        await this.rawUpdate(objID, newData);
        await this.reportUpdatedData([objID]);
        if (commit !== false) {
            await this.commitOne(objID, commit !== true ? commit : null, 'update', false, newData);
        }
    }
    async delete(objID, commit = false) {
        await this.db.delete(this.getDBRef(objID));
        if (commit !== false) {
            await this.commitOne(objID, commit !== true ? commit : null, 'delete', true);
            await this.reportUpdatedData([objID]);
        }
    }
    async commitOne(objID, commitMessage, verb, removing = false, obj) {
        try {
            await this.db.commit([this.getDBRef(objID)], commitMessage !== null
                ? commitMessage
                : this.formatCommitMessage(verb, objID, obj), removing);
        }
        catch (e) {
            // TODO: This is the only thing that makes this manager Git-specific.
            // Get rid of it and make it generic!
            if (isGitError(e)) {
                throw new CommitError(e.code, e.message);
            }
            else {
                throw e;
            }
        }
    }
    formatObjectName(objID, obj) {
        return `${objID}`;
    }
    formatCommitMessage(verb, objID, obj) {
        return `${verb} ${this.modelInfo.shortName} ${this.formatObjectName(objID, obj)}`;
    }
    getDBRef(objID) {
        /* Returns DB backend’s full ID given object ID. */
        return path.join(this.managerConfig.workDir, `${objID}`);
    }
    getObjID(dbRef) {
        if (path.isAbsolute(dbRef)) {
            throw new Error("getObjID() received dbRef which is an absolute filesystem path");
        }
        var relativeRef = path.relative(this.managerConfig.workDir, dbRef);
        // `path.relative()` prepends unnecessary "../" when DB ref is plain filename.
        // This condition is necessary when DB ref is received from `db.listIDs()`,
        // and not necessary when DB ref is received from `db.listUncommitted()`.
        // TODO: See how `listUncommitted()` results are and make `listIDs()` consistent.
        if (relativeRef.startsWith('../')) {
            relativeRef = relativeRef.replace('../', '');
        }
        const baseComponent = relativeRef.split(path.sep)[0];
        // if (!objId || !(await this.isValidId(objId))) {
        //   throw new Error(`Unable to resolve object ID for path ${filepath}`);
        // }
        return baseComponent;
        // NOTE: Will cause errors if IDType is not a string.
        // If IDType is not a string, subclass must cast properly.
    }
    setUpIPC(modelName) {
        super.setUpIPC(modelName);
        const prefix = `model-${modelName}`;
        listen(`${prefix}-read-uncommitted-ids`, async () => {
            return await this.listUncommitted();
        });
        listen(`${prefix}-get-modified-status`, async ({ objectID }) => {
            return { modified: (await this.listUncommitted()).includes(objectID) };
        });
        listen(`${prefix}-commit-objects`, async ({ objectIDs, commitMessage }) => {
            await this.commit(objectIDs, commitMessage);
            return { success: true };
        });
        listen(`${prefix}-discard-all-uncommitted`, async ({ objectIDs }) => {
            await this.discard(objectIDs);
            return { success: true };
        });
        listen(`${prefix}-get-filesystem-path`, async ({ objectID }) => {
            return { path: await this.getLocalFilesystemPath(objectID) };
        });
    }
}
export const ManagerClass = Manager;
export default Manager;
//# sourceMappingURL=manager.js.map