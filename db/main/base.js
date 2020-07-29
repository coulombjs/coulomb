import { listen } from '../../ipc/main';
// Generic backend.
export class Backend {
    setUpIPC(dbID) {
        /* Initializes IPC endpoints to enable the user to e.g. configure the data store
           or invoke housekeeping or utility routines. */
        const prefix = `db-${dbID}`;
        listen(`${prefix}-describe`, async () => {
            return await this.describe();
        });
        listen(`${prefix}-read`, async ({ objectID }) => {
            if (objectID === null) {
                return { object: null };
            }
            else {
                return { object: await this.read(objectID) };
            }
        });
    }
}
// Versioned backend & compatible manager.
export class VersionedBackend extends Backend {
}
export class ModelManager {
    async init() { }
    setUpIPC(modelName) {
        /* Initializes IPC endpoints to query or update data objects. */
        const prefix = `model-${modelName}`;
        listen(`${prefix}-list-ids`, async ({ query }) => ({ ids: (await this.listIDs(query)) }));
        listen(`${prefix}-count`, async ({ query }) => ({ count: await this.count(query) }));
        listen(`${prefix}-read-all`, async ({ query }) => this.readAll(query));
        listen(`${prefix}-read-one`, async ({ objectID }) => {
            if (objectID === null) {
                return { object: null };
            }
            else {
                return { object: await this.read(objectID) };
            }
        });
        listen(`${prefix}-update-one`, async ({ objectID, object, commit }) => {
            await this.update(objectID, object, commit);
            return { success: true };
        });
        listen(`${prefix}-delete-one`, async ({ objectID }) => {
            await this.delete(objectID, true);
            return { success: true };
        });
        listen(`${prefix}-create-one`, async ({ object, commit }) => {
            await this.create(object, commit);
            return { success: true };
        });
    }
}
export class CommitError extends Error {
    constructor(code, msg) {
        super(msg);
        this.code = code;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
// Versioned backend specifically based on local filesystem,
// and requisite manager interface
export class VersionedFilesystemBackend extends VersionedBackend {
}
//# sourceMappingURL=base.js.map