export class DBError extends Error {
  constructor(msg: string) {
    super(msg);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}


export class UniqueConstraintError extends DBError {
  constructor(public fieldName: string, public objectId: string) {
    super(`Value for field ${fieldName} is non-unique: ${objectId}`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
