export declare function useIPCValue<I extends object, O>(endpointName: string, initialValue: O, payload?: I): IPCHook<O>;
export declare function useIPCRequest<I extends object, O>(endpointName: string, payload?: I): Promise<O>;
export declare function useIPCWindowEventRelayer<I extends object = {
    eventName: string;
    eventPayload?: any;
}, O = {
    success: true;
}>(payload: I): Promise<O>;
interface IPCHook<T> {
    value: T;
    errors: string[];
    refresh: () => void;
    _reqCounter: number;
}
export {};
