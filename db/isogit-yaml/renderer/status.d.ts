import React from 'react';
import { DatabaseStatusComponentProps } from '../../../config/renderer';
import { BackendDescription, BackendStatus } from '../base';
declare const BackendDetails: React.FC<DatabaseStatusComponentProps<BackendDescription, BackendStatus>>;
export default BackendDetails;
export declare const PasswordPrompt: React.FC<{
    dbIPCPrefix: string;
    onConfirm: () => void;
}>;
interface DBSyncScreenProps {
    dbName: string;
    db: BackendDescription;
    onDismiss: () => void;
}
export declare const DBSyncScreen: React.FC<DBSyncScreenProps>;
