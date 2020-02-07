import { ipcRenderer } from 'electron';
import * as log from 'electron-log';

import React, { useEffect, useState } from 'react';
import { Spinner } from '@blueprintjs/core';

import { AppConfig, DatabaseInfo } from '../../config/app';
import { RendererConfig, DatabaseStatusComponentProps } from '../../config/renderer';
import { useIPCValue } from '../../ipc/renderer';
import { BackendDescription } from '../base';

import styles from './status.scss';


type UnknownDBStatusComponent = React.FC<DatabaseStatusComponentProps<any, any>>;

interface DatabaseListProps {
  databases: AppConfig["databases"]
  databaseStatusComponents: RendererConfig<any>["databaseStatusComponents"]
}
export const DatabaseList: React.FC<DatabaseListProps> =
function ({ databases, databaseStatusComponents }) {
  type Databases = {
    [dbName in keyof typeof databases]: {
      meta: DatabaseInfo
      backendDetailsComponentResolver:
        () => Promise<UnknownDBStatusComponent>
    }
  };
  const [dbs, updateDBs] = useState({} as Databases);

  useEffect(() => {
    (async () => {
      for (const [dbID, meta] of Object.entries(databases)) {
        const backendDetailsComponentResolver =
          async () => (await databaseStatusComponents[dbID]()).default;
        updateDBs({ ...dbs, [dbID]: { meta, backendDetailsComponentResolver }})
      }
    })();
  }, []);

  return (
    <>
      {Object.entries(dbs).map(([dbID, dbData]) =>
        <DBStatus
          key={dbID}
          dbName={dbID}
          meta={dbData.meta}
          backendDetailsComponentResolver={dbData.backendDetailsComponentResolver}
        />)}
    </>
  );
};


interface DBStatusProps {
  dbName: string
  meta: DatabaseInfo
  backendDetailsComponentResolver: () => Promise<UnknownDBStatusComponent>
}
export const DBStatus: React.FC<DBStatusProps> = function ({ dbName, meta, backendDetailsComponentResolver }) {
  const description = useIPCValue(`db-${dbName}-describe`, null as null | BackendDescription<any>);
  const [status, updateStatus] = useState(null as null | object);
  const [BackendDetails, setBackendDetailsComponent] = useState(null as (null | (() => UnknownDBStatusComponent)));
  const ipcPrefix = `db-${dbName}`;

  useEffect(() => {
    // Fetch component configured to display this DB status appropriately
    (async () => {
      const BackendDetails = (await backendDetailsComponentResolver());
      log.debug("Resolved backend details widget", BackendDetails)
      setBackendDetailsComponent(() => BackendDetails);
    })();

    // Listen to status updates
    function handleNewStatus(evt: any, newStatus: any) {
      log.debug("Received new status for DB", dbName, newStatus);
      updateStatus(newStatus);
    }
    ipcRenderer.on(`${ipcPrefix}-status`, handleNewStatus);
    return function cleanup() {
      ipcRenderer.removeListener(`${ipcPrefix}-status`, handleNewStatus);
    }
  }, []);

  if (description.value !== null && BackendDetails !== null) {
    log.silly("Rendering DB status widget for", dbName, meta.verboseName, description.value, status);
    log.silly("Using widget", BackendDetails);
  }

  const backendType = description.value?.verboseName;

  return (
    <div className={`
        ${styles.base}
        ${BackendDetails === null ? styles.widgetLoading : ''}
        ${description.value === null ? styles.descriptionLoading : ''}`}>

      <div className={styles.dbLabel}>
        <span className={styles.dbName}>{meta.verboseName}</span>

        {backendType
          ? <span className={styles.backendType}>{backendType}</span>
          : null}
      </div>

      <div className={styles.backendDetails}>
        {description.value !== null && BackendDetails !== null
          ? <BackendDetails
              dbIPCPrefix={ipcPrefix}
              status={status || description.value?.status}
              description={description.value} />
          : <Spinner />}
      </div>
    </div>
  );
};
