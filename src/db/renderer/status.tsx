import { ipcRenderer } from 'electron';
import * as log from 'electron-log';

import React, { useEffect, useState, useMemo } from 'react';
import { FormGroup, Classes, NonIdealState, Spinner, InputGroup, Button } from '@blueprintjs/core';

import { AppConfig, DatabaseInfo } from '../../config/app';
import { RendererConfig, DatabaseStatusComponentProps } from '../../config/renderer';
import { useIPCValue, callIPC } from '../../ipc/renderer';
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

  const dbs: Databases = useMemo(() => (Object.entries(databases).map(([dbID, meta]) => {
    const backendDetailsComponentResolver =
      async () => (await databaseStatusComponents[dbID]()).default;
    return { [dbID]: { meta, backendDetailsComponentResolver } };
  }).reduce((prev, curr) => ({ ...prev, ...curr }))), Object.keys(databases));

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

  // TODO: Redo pluggable backend widget? Move most of the presentation here;
  // make backend provide context provider component with actions & info.

  // Listen to status updates
  function handleNewStatus(evt: any, newStatus: any) {
    log.debug("Received new status for DB", dbName, newStatus);
    updateStatus(newStatus);
  }

  useEffect(() => {
    // Fetch component configured to display this DB status appropriately
    (async () => {
      const BackendDetails = (await backendDetailsComponentResolver());
      log.debug("Resolved backend details widget", BackendDetails)
      setBackendDetailsComponent(() => BackendDetails);
    })();

    ipcRenderer.on(`${ipcPrefix}-status`, handleNewStatus);
    return function cleanup() {
      ipcRenderer.removeListener(`${ipcPrefix}-status`, handleNewStatus);
    }
  }, []);

  if (description.value !== null && BackendDetails !== null) {
    log.silly("Rendering DB status widget for", dbName, meta.verboseName, description.value, status);
    log.silly("Using widget", BackendDetails);
  }

  const backendData = description.value;

  const backendView: JSX.Element = backendData !== null
    ? <span className={styles.backendType} title={backendData.verboseNameLong}>
        {backendData.verboseName}
      </span>
    : <span className={Classes.SKELETON}>Loading…</span>;

  return (
    <FormGroup
        className={`
          ${styles.base}
          ${BackendDetails === null ? styles.widgetLoading : ''}
          ${description.value === null ? styles.descriptionLoading : ''}`}
        label={meta.verboseName}
        labelInfo={backendView}>

      <div className={styles.backendDetails}>
        {description.value !== null && BackendDetails !== null
          ? <BackendDetails
              dbIPCPrefix={ipcPrefix}
              status={status || description.value?.status}
              description={description.value} />
          : <div className={Classes.SKELETON}>Loading…</div>}
      </div>
    </FormGroup>
  );
};


export const PasswordPrompt: React.FC<{ onConfirm: () => void }> = function ({ onConfirm }) {
  const [value, setValue] = useState('');

  async function handlePasswordConfirm() {
    await callIPC<{ password: string }, { success: true }>('db-default-git-set-password', { password: value });
    onConfirm();
  }

  return <div className={styles.passwordPrompt}>
    <FormGroup
        label="Please enter repository password:"
        helperText="The password will be kept in memory and not stored to disk.">
      <InputGroup
        type="password"
        value={value}
        onChange={(event: React.FormEvent<HTMLElement>) => setValue((event.target as HTMLInputElement).value)}
        leftIcon="key"
        rightElement={
          value.trim() === ''
          ? undefined
          : <Button
                minimal={true}
                onClick={handlePasswordConfirm}
                icon="tick"
                intent="primary">
              Confirm
            </Button>}
      />
    </FormGroup>
  </div>;
};


interface DBSyncScreenProps {
  dbName: string
  db: BackendDescription<any>
}
export const DBSyncScreen: React.FC<DBSyncScreenProps> = function ({ dbName, db }) {
  useEffect(() => {
    const status = db?.status || {};
    const shouldTriggerSync = (
      !status.hasLocalChanges &&
      !status.isPushing &&
      !status.isPulling &&
      status.lastSynchronized === null &&
      status.needsPassword === false
    )
    if (shouldTriggerSync) {
      callIPC('db-default-git-trigger-sync');
    }
  }, [JSON.stringify(db)]);

  let dbInitializationScreen: JSX.Element | null;

  if (db?.status === undefined) {
    dbInitializationScreen = <NonIdealState
      icon={<Spinner />}
      title="Initializing database"
    />
  } else if (db.status.needsPassword) {
    dbInitializationScreen = <NonIdealState
      icon="key"
      title="Password required"
      description={<PasswordPrompt onConfirm={() => void 0} />}
    />
  } else if (db.status.isPushing || db.status.isPulling) {
    dbInitializationScreen = <NonIdealState
      icon={<Spinner />}
      title="Synchronizing data"
      description={db.status.isPushing ? "Pushing changes" : "Pulling changes"}
    />
  } else if (db.status.lastSynchronized === null && db.status.hasLocalChanges === false) {
    dbInitializationScreen = <NonIdealState
      icon="cloud-download"
      title="Synchronizing data"
    />
  } else {
    dbInitializationScreen = null;
    dbInitializationScreen = <NonIdealState
      icon="tick"
      title="Synchronized"
      description="This message should go away in a second."
    />
  }

  return dbInitializationScreen;
}