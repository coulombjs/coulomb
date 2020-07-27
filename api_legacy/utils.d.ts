export declare function reviveJsonValue(key: string, val: any): any;
export declare type APIResponse<O> = {
    errors: string[];
    result: O | undefined;
};
export declare function getEventNamesForEndpoint(endpointName: string): {
    request: string;
    response: string;
};
export declare function getEventNamesForWindowEndpoint(endpointName: string): {
    request: string;
    response: string;
};
