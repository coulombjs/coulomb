export declare class DBError extends Error {
    constructor(msg: string);
}
export declare class UniqueConstraintError extends DBError {
    fieldName: string;
    objectId: string;
    constructor(fieldName: string, objectId: string);
}
