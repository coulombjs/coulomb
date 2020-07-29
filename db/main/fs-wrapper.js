import * as fs from 'fs-extra';
import * as path from 'path';
import AsyncLock from 'async-lock';
export class AbstractLockingFilesystemWrapper {
    constructor(baseDir) {
        this.baseDir = baseDir;
        this.fileAccessLock = new AsyncLock({ maxPending: 100000 });
    }
    expandPath(objID) {
        return path.join(this.baseDir, objID);
    }
    makeRelativePath(absPath) {
        if (path.isAbsolute(absPath)) {
            return path.relative(this.baseDir, absPath);
        }
        else {
            throw new Error("Expecting an absolute path, but got relative");
        }
    }
    async isValidID(value) {
        return true;
    }
    async listIDs(query, ...listArg) {
        const dir = query.subdir ? path.join(this.baseDir, query.subdir) : this.baseDir;
        const potentialIDs = await this.fileAccessLock.acquire(dir, async () => {
            return await fs.readdir(dir);
        });
        var ids = [];
        for (const maybeID of potentialIDs) {
            if (await this.isValidID(query.subdir ? path.join(query.subdir, maybeID) : maybeID)) {
                ids.push(maybeID);
            }
        }
        return ids;
    }
    async readAll(query, ...readArgs) {
        var objIDs = await this.listIDs(query);
        if (query.onlyIDs !== undefined) {
            objIDs = objIDs.filter(id => { var _a; return (_a = query.onlyIDs) === null || _a === void 0 ? void 0 : _a.includes(id); });
        }
        var objs = [];
        for (const objID of objIDs) {
            objs.push(await this.read(objID, ...readArgs));
        }
        return objs;
    }
    async exists(objID) {
        return await fs.pathExists(this.expandPath(objID));
    }
    async read(objID, ...args) {
        const filePath = this.expandPath(objID);
        return await this.fileAccessLock.acquire(filePath, async () => {
            return this.parseData(await fs.readFile(filePath, { encoding: 'utf8' }));
        });
    }
    async write(objID, newContents, ...args) {
        const filePath = this.expandPath(objID);
        return await this.fileAccessLock.acquire(filePath, async () => {
            await fs.ensureDir(path.dirname(filePath));
            if (newContents !== undefined) {
                await fs.writeFile(filePath, this.dumpData(newContents), { encoding: 'utf8' });
            }
            else {
                await fs.remove(filePath);
            }
            return [this.makeRelativePath(filePath)];
        });
    }
}
//# sourceMappingURL=fs-wrapper.js.map