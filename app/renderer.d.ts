import { AppConfig } from '../config/app';
import { RendererConfig } from '../config/renderer';
import { Model, AnyIDType } from '../db/models';
import { Index } from '../db/query';
import '!style-loader!css-loader!@blueprintjs/datetime/lib/css/blueprint-datetime.css';
import '!style-loader!css-loader!@blueprintjs/core/lib/css/blueprint.css';
import '!style-loader!css-loader!./normalize.css';
import '!style-loader!css-loader!./renderer.css';
interface AppRenderer<C extends RendererConfig<any>> {
    root: HTMLElement;
    useCount: UseCountHook<C>;
    useIDs: UseIDsHook<C>;
    useMany: UseManyHook<C>;
    useOne: UseOneHook<C>;
    openPredefinedWindow: (windowID: keyof C["app"]["windows"], params?: object) => Promise<void>;
    openObjectEditor: (objectTypeID: keyof C["app"]["data"], objectID: any, params?: string) => Promise<void>;
}
interface UseManyHookResult<M extends Model> {
    objects: Index<M>;
    isUpdating: boolean;
}
declare type UseManyHook<C extends RendererConfig<any>> = <M extends Model, Q extends object = {}>(modelName: keyof C["app"]["data"], query?: Q) => UseManyHookResult<M>;
interface UseIDsHookResult<IDType extends AnyIDType> {
    ids: IDType[];
    isUpdating: boolean;
}
declare type UseIDsHook<C extends RendererConfig<any>> = <IDType extends AnyIDType, Q extends object = {}>(modelName: keyof C["app"]["data"], query?: Q) => UseIDsHookResult<IDType>;
interface UseCountHookResult {
    count: number;
    isUpdating: boolean;
}
declare type UseCountHook<C extends RendererConfig<any>> = <Q extends object>(modelName: keyof C["app"]["data"], query: Q) => UseCountHookResult;
interface UseOneHookResult<M extends Model> {
    object: M | null;
    isUpdating: boolean;
    refresh: () => void;
}
declare type UseOneHook<C extends RendererConfig<any>> = <M extends Model, IDType extends AnyIDType>(modelName: keyof C["app"]["data"], objectID: IDType | null) => UseOneHookResult<M>;
export declare const renderApp: <A extends AppConfig, C extends RendererConfig<A>>(config: C) => AppRenderer<C>;
export {};
