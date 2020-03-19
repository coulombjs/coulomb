declare type FilesystemPath = string;
export interface FilesystemWrapper<T> {
    baseDir: string;
    readRaw(objID: string): Promise<string>;
    read(objID: string, ...args: any[]): Promise<T>;
    listIDs(query: {
        subdir?: string;
    }, ...listArgs: any[]): Promise<string[]>;
    readAll(query: {
        subdir?: string;
        onlyIDs?: string[];
    }, ...readArgs: any[]): Promise<T[]>;
    write(objID: string, newData: T | undefined, ...args: any[]): Promise<FilesystemPath[]>;
    expandPath(objID: string): string;
    exists(objID: string): Promise<boolean>;
    isValidID(filepath: string): Promise<boolean>;
    parseData(contents: string): T;
}
export declare abstract class StringLockingFilesystemWrapper<T = string> implements FilesystemWrapper<T> {
    baseDir: string;
    private fileAccessLock;
    constructor(baseDir: string);
    expandPath(objID: string): string;
    makeRelativePath(absPath: string): string;
    isValidID(value: string): Promise<boolean>;
    listIDs(query: {
        subdir?: string;
    }, ...listArg: any[]): Promise<string[]>;
    readAll(query: {
        subdir?: string;
        onlyIDs?: string[];
    }, ...readArgs: any[]): Promise<T[]>;
    exists(objID: string): Promise<boolean>;
    read(objID: string, ...args: any[]): Promise<T>;
    readRaw(objID: string): Promise<string>;
    write(objID: string, newContents: T | undefined, ...args: any[]): Promise<string[]>;
    parseData(contents: string): T;
    protected dumpData(data: T): string;
}
export declare abstract class AbstractLockingFilesystemWrapper<T> extends StringLockingFilesystemWrapper<T> {
    abstract parseData(contents: string): T;
    protected abstract dumpData(data: T): string;
}
export {};
