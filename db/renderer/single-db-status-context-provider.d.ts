import React from 'react';
import { BackendDescription } from '../base';
export declare type SingleDBStatusContextProps = {
    dbName: string;
};
export declare const SingleDBStatusContext: React.Context<BackendDescription<any> | null>;
declare const SingleDBStatusContextProvider: React.FC<SingleDBStatusContextProps>;
export default SingleDBStatusContextProvider;
