interface IPCHook<T> {
    value: T;
    errors: string[];
    isUpdating: boolean;
    refresh: () => void;
    _reqCounter: number;
}
export declare function useIPCEvent<P extends object>(endpointName: string, handler: (payload: P) => void, memoizeArguments?: any[]): void;
export declare function useIPCValue<I extends object, O>(endpointName: string, initialValue: O, payload?: I): IPCHook<O>;
export declare function callIPC<I extends object, O>(endpointName: string, payload?: I): Promise<O>;
export declare function relayIPCEvent<I extends object = {
    eventName: string;
    eventPayload?: any;
}, O = {
    success: true;
}>(payload: I): Promise<O>;
export {};
