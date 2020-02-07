import { Model } from './models';


export type Index<M extends Model> = Record<string, M>;


interface ArraySorter { (a: [string, unknown], b: [string, unknown]): number }


export class QuerySet<M extends Model> {
  /* Simplifies some operations on indexes, like a mini-pseudo-ORM. */

  index: Index<M>;
  order: ArraySorter;
  items: [string, M][];
  _ordered: boolean;

  constructor(
      index: Index<M>,
      order: ArraySorter = sortAlphabeticallyAscending,
      items: [string, M][] | undefined = undefined,
      ordered = false) {
    this.index = index;
    this.items = items === undefined ? Object.entries(index) : items;
    this.order = order;
    this._ordered = ordered;
  }
  get(id: string): M {
    return this.index[id];
  }
  add(obj: M): void {
    this.index[obj.id] = obj;
  }
  orderBy(comparison: ArraySorter) {
    return new QuerySet(this.index, this.order, [...this.items].sort(comparison), true);
  }
  filter(func: (item: [string, M]) => boolean) {
    return new QuerySet(this.index, this.order, this.items.filter(func), this._ordered);
  }
  all() {
    return this._ordered
      ? this.items.map(item => item[1])
      : this.orderBy(this.order).items.map(item => item[1]);
  }
}



export const sortAlphabeticallyAscending: ArraySorter = function (a, b) {
  return a[0].localeCompare(b[0]);
}
export const sortIntegerDescending: ArraySorter = function (a: [string, unknown], b: [string, unknown]): number {
  return parseInt(b[0], 10) - parseInt(a[0], 10);
}
export const sortIntegerAscending: ArraySorter = function (a: [string, unknown], b: [string, unknown]): number {
  return parseInt(a[0], 10) - parseInt(b[0], 10);
}
