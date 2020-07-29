import * as path from 'path';
import * as fs from 'fs-extra';
import { YAML_EXT } from './base';
import { default as YAMLWrapper } from './file';
class YAMLDirectoryWrapper extends YAMLWrapper {
    // TODO: Move directory-specific logic into a Manager subclass.
    constructor(baseDir) { super(baseDir); }
    expandDirectoryPath(objID) {
        return path.join(this.baseDir, objID);
    }
    async exists(objID) {
        const dirPath = this.expandDirectoryPath(objID);
        if (await fs.pathExists(dirPath)) {
            const stat = await fs.stat(dirPath);
            if (!stat.isDirectory()) {
                throw new Error("File is expected to be a directory");
            }
            return true;
        }
        return false;
    }
    async isValidID(value) {
        const metaFile = path.join(this.expandDirectoryPath(value), `meta${YAML_EXT}`);
        let metaFileIsFile;
        try {
            metaFileIsFile = (await fs.stat(metaFile)).isFile();
        }
        catch (e) {
            return false;
        }
        if (!metaFileIsFile) {
            return false;
        }
        return metaFileIsFile;
    }
    // TODO: Instead of metaFields argument, specify _meta in object structure.
    async read(objID, metaFields) {
        const objAbsPath = this.expandDirectoryPath(objID);
        const metaId = 'meta';
        const metaAbsPath = path.join(objAbsPath, `${metaId}${YAML_EXT}`);
        let metaFileIsFile;
        try {
            metaFileIsFile = (await fs.stat(metaAbsPath)).isFile();
        }
        catch (e) {
            throw new Error(`Exception accessing meta file for ${objID}: ${metaAbsPath}: ${e.toString()} ${e.stack}`);
        }
        if (!metaFileIsFile) {
            throw new Error(`Meta file for ${objID} is not a file: ${metaAbsPath}`);
        }
        var objData = {};
        const metaPath = path.join(objID, metaId);
        const meta = await super.read(metaPath) || {};
        for (const key of metaFields) {
            objData[key] = meta[key];
        }
        const dirContents = await fs.readdir(objAbsPath);
        for (const filename of dirContents) {
            if (this.isYAMLFile(filename)) {
                const fieldName = path.basename(filename, YAML_EXT);
                if (fieldName != 'meta') {
                    objData[fieldName] = await super.read(path.join(objID, fieldName));
                }
            }
        }
        // Blindly hope that data structure loaded from YAML
        // is valid for given type.
        return objData;
    }
    async write(objID, newData, metaFields) {
        const objPath = this.expandDirectoryPath(objID);
        if (newData !== undefined && metaFields !== undefined) {
            await fs.ensureDir(objPath);
            var dataToStore = { meta: {} };
            var modifiedPaths = [];
            for (const key of Object.keys(newData)) {
                if (metaFields.indexOf(key) >= 0) {
                    dataToStore.meta[key] = newData[key];
                }
                else {
                    dataToStore[key] = newData[key];
                }
            }
            for (const [fieldName, fieldValue] of Object.entries(dataToStore)) {
                modifiedPaths = [
                    ...modifiedPaths,
                    ...(await super.write(path.join(objID, fieldName), fieldValue)),
                ];
            }
            return modifiedPaths;
        }
        else if (newData !== undefined) {
            throw new Error("metaFields is not specified");
        }
        else {
            // Writing ``undefined`` should cause FS wrapper to delete the file from filesystem
            await fs.remove(objPath);
            return [objPath];
        }
    }
}
export default YAMLDirectoryWrapper;
//# sourceMappingURL=directory.js.map