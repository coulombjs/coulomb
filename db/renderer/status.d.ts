import React from 'react';
import { AppConfig, DatabaseInfo } from '../../config/app';
import { RendererConfig, DatabaseStatusComponentProps } from '../../config/renderer';
declare type UnknownDBStatusComponent = React.FC<DatabaseStatusComponentProps<any, any>>;
interface DatabaseListProps {
    databases: AppConfig["databases"];
    databaseStatusComponents: RendererConfig<any>["databaseStatusComponents"];
}
export declare const DatabaseList: React.FC<DatabaseListProps>;
interface DBStatusProps {
    dbName: string;
    meta: DatabaseInfo;
    backendDetailsComponentResolver: () => Promise<UnknownDBStatusComponent>;
}
export declare const DBStatus: React.FC<DBStatusProps>;
export {};
