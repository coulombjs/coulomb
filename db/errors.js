export class DBError extends Error {
    constructor(msg) {
        super(msg);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
export class UniqueConstraintError extends DBError {
    constructor(fieldName, objectId) {
        super(`Value for field ${fieldName} is non-unique: ${objectId}`);
        this.fieldName = fieldName;
        this.objectId = objectId;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
//# sourceMappingURL=errors.js.map