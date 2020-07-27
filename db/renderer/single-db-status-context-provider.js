import { ipcRenderer } from 'electron';
import * as log from 'electron-log';
import React, { useState, useEffect } from 'react';
import { useIPCValue } from '../../ipc/renderer';
export const SingleDBStatusContext = React.createContext({
    verboseName: '',
    status: {},
});
const SingleDBStatusContextProvider = function (props) {
    const ipcPrefix = `db-${props.dbName}`;
    const [backendStatus, updateBackendStatus] = useState(undefined);
    const description = useIPCValue(`${ipcPrefix}-describe`, null);
    useEffect(() => {
        ipcRenderer.on(`${ipcPrefix}-status`, handleNewStatus);
        return function cleanup() {
            ipcRenderer.removeListener(`${ipcPrefix}-status`, handleNewStatus);
        };
    }, []);
    // Listen to status updates
    function handleNewStatus(evt, newStatus) {
        log.debug("Received new status for DB", props.dbName, newStatus);
        updateBackendStatus(newStatus);
    }
    return (React.createElement(SingleDBStatusContext.Provider, { value: description.value !== null
            ? Object.assign(Object.assign({}, description.value), { status: backendStatus || description.value.status }) : null }, props.children));
};
export default SingleDBStatusContextProvider;
//# sourceMappingURL=single-db-status-context-provider.js.map