export class QuerySet {
    constructor(index, order = sortAlphabeticallyAscending, items = undefined, ordered = false) {
        this.index = index;
        this.items = items === undefined ? Object.entries(index) : items;
        this.order = order;
        this._ordered = ordered;
    }
    get(id) {
        return this.index[id];
    }
    add(obj) {
        this.index[obj.id] = obj;
    }
    orderBy(comparison) {
        return new QuerySet(this.index, this.order, [...this.items].sort(comparison), true);
    }
    filter(func) {
        return new QuerySet(this.index, this.order, this.items.filter(func), this._ordered);
    }
    all() {
        return this._ordered
            ? this.items.map(item => item[1])
            : this.orderBy(this.order).items.map(item => item[1]);
    }
}
export const sortAlphabeticallyAscending = function (a, b) {
    return a[0].localeCompare(b[0]);
};
export const sortIntegerDescending = function (a, b) {
    return parseInt(b[0], 10) - parseInt(a[0], 10);
};
export const sortIntegerAscending = function (a, b) {
    return parseInt(a[0], 10) - parseInt(b[0], 10);
};
//# sourceMappingURL=query.js.map