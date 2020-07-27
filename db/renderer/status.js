import { ipcRenderer } from 'electron';
import * as log from 'electron-log';
import React, { useEffect, useState, useMemo } from 'react';
import { FormGroup, Classes } from '@blueprintjs/core';
import { useIPCValue } from '../../ipc/renderer';
import styles from './status.scss';
export const DatabaseList = function ({ databases, databaseStatusComponents }) {
    const dbs = useMemo(() => (Object.entries(databases).map(([dbID, meta]) => {
        const backendDetailsComponentResolver = async () => (await databaseStatusComponents[dbID]()).default;
        return { [dbID]: { meta, backendDetailsComponentResolver } };
    }).reduce((prev, curr) => (Object.assign(Object.assign({}, prev), curr)))), Object.keys(databases));
    return (React.createElement(React.Fragment, null, Object.entries(dbs).map(([dbID, dbData]) => React.createElement(DBStatus, { key: dbID, dbName: dbID, meta: dbData.meta, backendDetailsComponentResolver: dbData.backendDetailsComponentResolver }))));
};
export const DBStatus = function ({ dbName, meta, backendDetailsComponentResolver }) {
    var _a;
    const description = useIPCValue(`db-${dbName}-describe`, null);
    const [status, updateStatus] = useState(null);
    const [BackendDetails, setBackendDetailsComponent] = useState(null);
    const ipcPrefix = `db-${dbName}`;
    // TODO: Redo pluggable backend widget? Move most of the presentation here;
    // make backend provide context provider component with actions & info.
    // Listen to status updates
    function handleNewStatus(evt, newStatus) {
        log.debug("Received new status for DB", dbName, newStatus);
        updateStatus(newStatus);
    }
    useEffect(() => {
        // Fetch component configured to display this DB status appropriately
        (async () => {
            const BackendDetails = (await backendDetailsComponentResolver());
            log.debug("Resolved backend details widget", BackendDetails);
            setBackendDetailsComponent(() => BackendDetails);
        })();
        ipcRenderer.on(`${ipcPrefix}-status`, handleNewStatus);
        return function cleanup() {
            ipcRenderer.removeListener(`${ipcPrefix}-status`, handleNewStatus);
        };
    }, []);
    // if (description.value !== null && BackendDetails !== null) {
    //   log.silly("Rendering DB status widget for", dbName, meta.verboseName, description.value, status);
    //   log.silly("Using widget", BackendDetails);
    // }
    const backendData = description.value;
    const backendView = backendData !== null
        ? React.createElement("span", { className: styles.backendType, title: backendData.verboseNameLong }, backendData.verboseName)
        : React.createElement("span", { className: Classes.SKELETON }, "Loading\u2026");
    return (React.createElement(FormGroup, { className: `
          ${styles.base}
          ${BackendDetails === null ? styles.widgetLoading : ''}
          ${description.value === null ? styles.descriptionLoading : ''}`, label: meta.verboseName, labelInfo: backendView },
        React.createElement("div", { className: styles.backendDetails }, description.value !== null && BackendDetails !== null
            ? React.createElement(BackendDetails, { dbIPCPrefix: ipcPrefix, status: status || ((_a = description.value) === null || _a === void 0 ? void 0 : _a.status), description: description.value })
            : React.createElement("div", { className: Classes.SKELETON }, "Loading\u2026"))));
};
//# sourceMappingURL=status.js.map