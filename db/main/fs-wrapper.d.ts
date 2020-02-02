declare type FilesystemPath = string;
export interface FilesystemWrapper<T> {
    baseDir: string;
    read(objID: string, ...args: any[]): Promise<T>;
    readAll(...args: any[]): Promise<T[]>;
    write(objID: string, newData: T | undefined, ...args: any[]): Promise<FilesystemPath[]>;
    expandPath(objID: string): string;
    exists(objID: string): Promise<boolean>;
    isValidID(filepath: string): Promise<boolean>;
}
export declare abstract class AbstractLockingFilesystemWrapper<T> implements FilesystemWrapper<T> {
    baseDir: string;
    private fileAccessLock;
    constructor(baseDir: string);
    expandPath(objID: string): string;
    makeRelativePath(absPath: string): string;
    isValidID(value: string): Promise<boolean>;
    readAll(...args: any[]): Promise<T[]>;
    exists(objID: string): Promise<boolean>;
    read(objID: string, ...args: any[]): Promise<T>;
    write(objID: string, newContents: T | undefined, ...args: any[]): Promise<string[]>;
    protected abstract parseData(contents: string): T;
    protected abstract dumpData(data: T): string;
}
export {};
