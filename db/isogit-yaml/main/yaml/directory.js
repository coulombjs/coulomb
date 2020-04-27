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
            return super.write(objID, newData);
        }
    }
}
export default YAMLDirectoryWrapper;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGlyZWN0b3J5LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2RiL2lzb2dpdC15YW1sL21haW4veWFtbC9kaXJlY3RvcnkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxLQUFLLElBQUksTUFBTSxNQUFNLENBQUM7QUFDN0IsT0FBTyxLQUFLLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFDL0IsT0FBTyxFQUFFLFFBQVEsRUFBUSxNQUFNLFFBQVEsQ0FBQztBQUN4QyxPQUFPLEVBQUUsT0FBTyxJQUFJLFdBQVcsRUFBRSxNQUFNLFFBQVEsQ0FBQztBQVFoRCxNQUFNLG9CQUFxQixTQUFRLFdBQWlCO0lBQ2xELCtEQUErRDtJQUUvRCxZQUFZLE9BQWUsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBRXhDLG1CQUFtQixDQUFDLEtBQWE7UUFDdkMsT0FBTyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxPQUFPLEVBQUUsS0FBSyxDQUFDLENBQUM7SUFDeEMsQ0FBQztJQUVNLEtBQUssQ0FBQyxNQUFNLENBQUMsS0FBYTtRQUMvQixNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsbUJBQW1CLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDaEQsSUFBSSxNQUFNLEVBQUUsQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDLEVBQUU7WUFDaEMsTUFBTSxJQUFJLEdBQUcsTUFBTSxFQUFFLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1lBQ3BDLElBQUksQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFFLEVBQUU7Z0JBQ3ZCLE1BQU0sSUFBSSxLQUFLLENBQUMsb0NBQW9DLENBQUMsQ0FBQzthQUN2RDtZQUNELE9BQU8sSUFBSSxDQUFDO1NBQ2I7UUFDRCxPQUFPLEtBQUssQ0FBQztJQUNmLENBQUM7SUFFTSxLQUFLLENBQUMsU0FBUyxDQUFDLEtBQWE7UUFDbEMsTUFBTSxRQUFRLEdB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QztZQUU1QixJQUFJLFdBQVcsR0FBbUMsRUFBRSxJQUFJLEVBQUUsRUFBRSxFQUFFLENBQUM7WUFDL0QsSUFBSSxhQUFhLEdBQUcsRUFBYyxDQUFDO1lBRW5DLEtBQUssTUFBTSxHQUFHLElBQUksTUFBTSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsRUFBRTtnQkFDdEMsSUFBSSxVQUFVLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRTtvQkFDaEMsV0FBVyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUM7aUJBQ3RDO3FCQUFNO29CQUNMLFdBQVcsQ0FBQyxHQUFHLENBQUMsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUM7aUJBQ2pDO2FBQ0Y7WUFFRCxLQUFLLE1BQU0sQ0FBQyxTQUFTLEVBQUUsVUFBVSxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUMsRUFBRTtnQkFDakUsYUFBYSxHQUFHO29CQUNkLEdBQUcsYUFBYTtvQkFDaEIsR0FBRyxDQUFDLE1BQU0sS0FBSyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxTQUFTLENBQUMsRUFBRSxVQUFVLENBQUMsQ0FBQztpQkFDaEUsQ0FBQzthQUNIO1lBRUQsT0FBTyxhQUFhLENBQUM7U0FFdEI7YUFBTSxJQUFJLE9BQU8sS0FBSyxTQUFTLEVBQUU7WUFDaEMsTUFBTSxJQUFJLEtBQUssQ0FBQyw2QkFBNkIsQ0FBQyxDQUFDO1NBRWhEO2FBQU07WUFDTCxtRkFBbUY7WUFDbkYsT0FBTyxLQUFLLENBQUMsS0FBSyxDQUFDLEtBQUssRUFBRSxPQUFPLENBQUMsQ0FBQztTQUNwQztJQUNILENBQUM7Q0FDRjtBQUVELGVBQWUsb0JBQW9CLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0ICogYXMgZnMgZnJvbSAnZnMtZXh0cmEnO1xuaW1wb3J0IHsgWUFNTF9FWFQsIFlBTUwgfSBmcm9tICcuL2Jhc2UnO1xuaW1wb3J0IHsgZGVmYXVsdCBhcyBZQU1MV3JhcHBlciB9IGZyb20gJy4vZmlsZSc7XG5cblxuaW50ZXJmYWNlIFlBTUxEaXJlY3RvcnlTdG9yZWFibGVDb250ZW50cyBleHRlbmRzIFlBTUwge1xuICBtZXRhOiBZQU1MXG59XG5cblxuY2xhc3MgWUFNTERpcmVjdG9yeVdyYXBwZXIgZXh0ZW5kcyBZQU1MV3JhcHBlcjxZQU1MPiB7XG4gIC8vIFRPRE86IE1vdmUgZGlyZWN0b3J5LXNwZWNpZmljIGxvZ2ljIGludG8gYSBNYW5hZ2VyIHN1YmNsYXNzLlxuXG4gIGNvbnN0cnVjdG9yKGJhc2VEaXI6IHN0cmluZykgeyBzdXBlcihiYXNlRGlyKTsgfVxuXG4gIHByaXZhdGUgZXhwYW5kRGlyZWN0b3J5UGF0aChvYmpJRDogc3RyaW5nKSB7XG4gICAgcmV0dXJuIHBhdGguam9pbih0aGlzLmJhc2VEaXIsIG9iaklEKTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBleGlzdHMob2JqSUQ6IHN0cmluZykge1xuICAgIGNvbnN0IGRpclBhdGggPSB0aGlzLmV4cGFuZERpcmVjdG9yeVBhdGgob2JqSUQpO1xuICAgIGlmIChhd2FpdCBmcy5wYXRoRXhpc3RzKGRpclBhdGgpKSB7XG4gICAgICBjb25zdCBzdGF0ID0gYXdhaXQgZnMuc3RhdChkaXJQYXRoKTtcbiAgICAgIGlmICghc3RhdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkZpbGUgaXMgZXhwZWN0ZWQgdG8gYmUgYSBkaXJlY3RvcnlcIik7XG4gICAgICB9XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGlzVmFsaWRJRCh2YWx1ZTogc3RyaW5nKSB7XG4gICAgY29uc3QgbWV0YUZpbGUgPSBwYXRoLmpvaW4odGhpcy5leHBhbmREaXJlY3RvcnlQYXRoKHZhbHVlKSwgYG1ldGEke1lBTUxfRVhUfWApO1xuICAgIGxldCBtZXRhRmlsZUlzRmlsZTogYm9vbGVhbjtcbiAgICB0cnkge1xuICAgICAgbWV0YUZpbGVJc0ZpbGUgPSAoYXdhaXQgZnMuc3RhdChtZXRhRmlsZSkpLmlzRmlsZSgpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgaWYgKCFtZXRhRmlsZUlzRmlsZSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gbWV0YUZpbGVJc0ZpbGU7XG4gIH1cblxuICAvLyBUT0RPOiBJbnN0ZWFkIG9mIG1ldGFGaWVsZHMgYXJndW1lbnQsIHNwZWNpZnkgX21ldGEgaW4gb2JqZWN0IHN0cnVjdHVyZS5cbiAgcHVibGljIGFzeW5jIHJlYWQob2JqSUQ6IHN0cmluZywgbWV0YUZpZWxkczogc3RyaW5nW10pIHtcbiAgICBjb25zdCBvYmpBYnNQYXRoID0gdGhpcy5leHBhbmREaXJlY3RvcnlQYXRoKG9iaklEKTtcblxuICAgIGNvbnN0IG1ldGFJZCA9ICdtZXRhJztcblxuICAgIGNvbnN0IG1ldGFBYnNQYXRoID0gcGF0aC5qb2luKG9iakFic1BhdGgsIGAke21ldGFJZH0ke1lBTUxfRVhUfWApO1xuICAgIGxldCBtZXRhRmlsZUlzRmlsZTogYm9vbGVhbjtcbiAgICB0cnkge1xuICAgICAgbWV0YUZpbGVJc0ZpbGUgPSAoYXdhaXQgZnMuc3RhdChtZXRhQWJzUGF0aCkpLmlzRmlsZSgpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgRXhjZXB0aW9uIGFjY2Vzc2luZyBtZXRhIGZpbGUgZm9yICR7b2JqSUR9OiAke21ldGFBYnNQYXRofTogJHtlLnRvU3RyaW5nKCl9ICR7ZS5zdGFja31gKTtcbiAgICB9XG4gICAgaWYgKCFtZXRhRmlsZUlzRmlsZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBNZXRhIGZpbGUgZm9yICR7b2JqSUR9IGlzIG5vdCBhIGZpbGU6ICR7bWV0YUFic1BhdGh9YCk7XG4gICAgfVxuXG4gICAgdmFyIG9iakRhdGE6IFlBTUwgPSB7fTtcblxuICAgIGNvbnN0IG1ldGFQYXRoID0gcGF0aC5qb2luKG9iaklELCBtZXRhSWQpO1xuICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBzdXBlci5yZWFkKG1ldGFQYXRoKSB8fCB7fTtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBtZXRhRmllbGRzKSB7XG4gICAgICBvYmpEYXRhW2tleV0gPSBtZXRhW2tleSBhcyBzdHJpbmddO1xuICAgIH1cblxuICAgIGNvbnN0IGRpckNvbnRlbnRzID0gYXdhaXQgZnMucmVhZGRpcihvYmpBYnNQYXRoKTtcbiAgICBmb3IgKGNvbnN0IGZpbGVuYW1lIG9mIGRpckNvbnRlbnRzKSB7XG4gICAgICBpZiAodGhpcy5pc1lBTUxGaWxlKGZpbGVuYW1lKSkge1xuICAgICAgICBjb25zdCBmaWVsZE5hbWUgPSBwYXRoLmJhc2VuYW1lKGZpbGVuYW1lLCBZQU1MX0VYVCk7XG4gICAgICAgIGlmIChmaWVsZE5hbWUgIT0gJ21ldGEnKSB7XG4gICAgICAgICAgb2JqRGF0YVtmaWVsZE5hbWVdID0gYXdhaXQgc3VwZXIucmVhZChwYXRoLmpvaW4ob2JqSUQsIGZpZWxkTmFtZSkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gQmxpbmRseSBob3BlIHRoYXQgZGF0YSBzdHJ1Y3R1cmUgbG9hZGVkIGZyb20gWUFNTFxuICAgIC8vIGlzIHZhbGlkIGZvciBnaXZlbiB0eXBlLlxuICAgIHJldHVybiBvYmpEYXRhO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIHdyaXRlPFIgZXh0ZW5kcyBZQU1MPihvYmpJRDogc3RyaW5nLCBuZXdEYXRhPzogUiwgbWV0YUZpZWxkcz86IChrZXlvZiBSKVtdKSB7XG4gICAgY29uc3Qgb2JqUGF0aCA9IHRoaXMuZXhwYW5kRGlyZWN0b3J5UGF0aChvYmpJRCk7XG5cbiAgICBpZiAobmV3RGF0YSAhPT0gdW5kZWZpbmVkICYmIG1ldGFGaWVsZHMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgYXdhaXQgZnMuZW5zdXJlRGlyKG9ialBhdGgpO1xuXG4gICAgICB2YXIgZGF0YVRvU3RvcmU6IFlBTUxEaXJlY3RvcnlTdG9yZWFibGVDb250ZW50cyA9IHsgbWV0YToge30gfTtcbiAgICAgIHZhciBtb2RpZmllZFBhdGhzID0gW10gYXMgc3RyaW5nW107XG5cbiAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKG5ld0RhdGEpKSB7XG4gICAgICAgIGlmIChtZXRhRmllbGRzLmluZGV4T2Yoa2V5KSA+PSAwKSB7XG4gICAgICAgICAgZGF0YVRvU3RvcmUubWV0YVtrZXldID0gbmV3RGF0YVtrZXldO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGRhdGFUb1N0b3JlW2tleV0gPSBuZXdEYXRhW2tleV07XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgZm9yIChjb25zdCBbZmllbGROYW1lLCBmaWVsZFZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhkYXRhVG9TdG9yZSkpIHtcbiAgICAgICAgbW9kaWZpZWRQYXRocyA9IFtcbiAgICAgICAgICAuLi5tb2RpZmllZFBhdGhzLFxuICAgICAgICAgIC4uLihhd2FpdCBzdXBlci53cml0ZShwYXRoLmpvaW4ob2JqSUQsIGZpZWxkTmFtZSksIGZpZWxkVmFsdWUpKSxcbiAgICAgICAgXTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIG1vZGlmaWVkUGF0aHM7XG5cbiAgICB9IGVsc2UgaWYgKG5ld0RhdGEgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwibWV0YUZpZWxkcyBpcyBub3Qgc3BlY2lmaWVkXCIpO1xuXG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIFdyaXRpbmcgYGB1bmRlZmluZWRgYCBzaG91bGQgY2F1c2UgRlMgd3JhcHBlciB0byBkZWxldGUgdGhlIGZpbGUgZnJvbSBmaWxlc3lzdGVtXG4gICAgICByZXR1cm4gc3VwZXIud3JpdGUob2JqSUQsIG5ld0RhdGEpO1xuICAgIH1cbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBZQU1MRGlyZWN0b3J5V3JhcHBlcjtcbiJdfQ==