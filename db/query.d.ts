import { Model } from './models';
export interface Index<M extends Model> {
    [stringifiedFieldValue: string]: M;
}
interface ArraySorter {
    (a: [string, unknown], b: [string, unknown]): number;
}
export declare class QuerySet<M extends Model> {
    index: Index<M>;
    order: ArraySorter;
    items: [string, M][];
    _ordered: boolean;
    constructor(index: Index<M>, order?: ArraySorter, items?: [string, M][] | undefined, ordered?: boolean);
    get(id: string): M;
    add(obj: M): void;
    orderBy(comparison: ArraySorter): QuerySet<M>;
    filter(func: (item: [string, M]) => boolean): QuerySet<M>;
    all(): M[];
}
export declare const sortAlphabeticallyAscending: ArraySorter;
export declare const sortIntegerDescending: ArraySorter;
export declare const sortIntegerAscending: ArraySorter;
export {};
