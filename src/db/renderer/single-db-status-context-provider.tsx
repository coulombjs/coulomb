import { ipcRenderer } from 'electron';
import * as log from 'electron-log';
import React, { useState, useEffect } from 'react';
import { useIPCValue } from '../../ipc/renderer';
import { BackendDescription } from '../base';


export type SingleDBStatusContextProps = {
  dbName: string
};
export const SingleDBStatusContext = React.createContext<null | BackendDescription<any>>({
  verboseName: '',
  status: {},
});
const SingleDBStatusContextProvider: React.FC<SingleDBStatusContextProps> = function (props) {

  const ipcPrefix = `db-${props.dbName}`;

  const [backendStatus, updateBackendStatus] = useState(undefined as undefined | object);
  const description = useIPCValue(`${ipcPrefix}-describe`, null as null | BackendDescription<any>);

  useEffect(() => {
    ipcRenderer.on(`${ipcPrefix}-status`, handleNewStatus);
    return function cleanup() {
      ipcRenderer.removeListener(`${ipcPrefix}-status`, handleNewStatus);
    }
  }, []);

  // Listen to status updates
  function handleNewStatus(evt: any, newStatus: any) {
    log.debug("Received new status for DB", props.dbName, newStatus);
    updateBackendStatus(newStatus);
  }

  return (
    <SingleDBStatusContext.Provider
        value={description.value !== null
          ? { ...description.value, status: backendStatus || description.value.status }
          : null}>
      {props.children}
    </SingleDBStatusContext.Provider>
  );
};

export default SingleDBStatusContextProvider;
