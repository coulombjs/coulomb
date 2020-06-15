import React, { useState } from 'react';

import {
  Button, IconName, FormGroup, InputGroup, Intent,
  ButtonGroup, NonIdealState, Spinner,
} from '@blueprintjs/core';

import { callIPC, useIPCValue } from '../../../ipc/renderer';

import { DatabaseStatusComponentProps } from '../../../config/renderer';
import { BackendDescription, BackendStatus } from '../base';

import styles from './status.scss';


const BackendDetails: React.FC<DatabaseStatusComponentProps<BackendDescription, BackendStatus>> =
function ({ dbIPCPrefix, status, description }) {
  const ipcPrefix = dbIPCPrefix;

  const numUncommitted = 
    useIPCValue(`${ipcPrefix}-count-uncommitted`, { numUncommitted: 0 }).
    value.numUncommitted;

  return (
    <ButtonGroup fill vertical alignText="left">
      <Button
          className={styles.sourceInfo}
          title={`${description.gitUsername}@${description.gitRepo}`}
          icon="git-repo"
          onClick={() => {
            if (description.gitRepo) {
              require('electron').shell.openExternal(description.gitRepo);
            }
          }}>
        {description.gitUsername}@{description.gitRepo}
      </Button>

      <ActionableStatus
        status={status}
        uncommittedFileCount={numUncommitted}
        onRequestSync={async () => await callIPC(`${ipcPrefix}-git-trigger-sync`)}
        onShowSettingsWindow={() => callIPC('open-predefined-window', { id: 'settings' })}
      />
    </ButtonGroup>
  );
};

export default BackendDetails;


interface ActionableStatusProps {
  status: BackendStatus
  uncommittedFileCount: number
  onRequestSync: () => Promise<void>
  onShowSettingsWindow: () => void
}
const ActionableStatus: React.FC<ActionableStatusProps> = function ({
    status, uncommittedFileCount,
    onRequestSync,
    onShowSettingsWindow }) {

  let statusIcon: IconName;
  let tooltipText: string | undefined;
  let statusIntent: Intent | undefined;
  let action: null | (() => void);

  if (status.isMisconfigured) {
    statusIcon = "error";
    tooltipText = "Configure";
    statusIntent = "danger";
    action = onShowSettingsWindow;

  } else if (status.isOnline !== true) {
    statusIcon = "offline";
    tooltipText = "Sync now"
    statusIntent = "primary";
    action = onRequestSync;

  } else if (status.hasLocalChanges && uncommittedFileCount > 0) {
    statusIcon = "git-commit";
    tooltipText = "Sync now";
    statusIntent = undefined;
    action = onRequestSync;

  } else if (status.statusRelativeToLocal === 'diverged') {
    statusIcon = "git-branch"
    tooltipText = "Resolve conflict and sync";
    statusIntent = "warning";
    action = onRequestSync;

  } else if (status.statusRelativeToLocal === 'behind') {
    statusIcon = "cloud-upload"
    tooltipText = "Sync now";
    statusIntent = "primary";
    action = onRequestSync;

  } else {
    statusIcon = "updated"
    tooltipText = "Sync now";
    statusIntent = "primary";
    action = onRequestSync;
  }

  return (
    <Button
        className={styles.backendStatus}
        onClick={action || (() => {})}
        icon={statusIcon}
        intent={statusIntent}
        disabled={action === null}>
      {tooltipText}
    </Button>
  );
};


export const PasswordPrompt: React.FC<{ dbIPCPrefix: string, onConfirm: () => void }> =
function ({ dbIPCPrefix, onConfirm }) {
  const [value, setValue] = useState('');

  async function handlePasswordConfirm() {
    await callIPC<{ password: string }, { success: true }>(`${dbIPCPrefix}-git-set-password`, { password: value });
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
  db: BackendDescription
  onDismiss: () => void
}
export const DBSyncScreen: React.FC<DBSyncScreenProps> = function ({ dbName, db, onDismiss }) {
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
      description={<PasswordPrompt dbIPCPrefix={`db-${dbName}`} onConfirm={() => void 0} />}
    />

  } else if (db.status.isPushing || db.status.isPulling) {
    dbInitializationScreen = <NonIdealState
      icon={db.status.isPushing ? "cloud-upload" : "cloud-download"}
      title="Synchronizing data"
      description={db.status.isPushing ? "Pushing changes" : "Pulling changes"}
    />

  } else if (db.status.lastSynchronized === null && db.status.hasLocalChanges === false) {
    dbInitializationScreen = <NonIdealState
      icon={<Spinner />}
      title="Synchronizing data"
    />

  } else if (db.status.lastSynchronized !== null) {
    dbInitializationScreen = <NonIdealState
      icon="tick"
      title="Ready"
      description={<Button onClick={onDismiss} intent="primary">Dismiss</Button>}
    />
  } else {
    dbInitializationScreen = <NonIdealState
      icon="tick"
      title="Ready"
      description={<Button onClick={onDismiss} intent="primary">Dismiss</Button>}
    />
  }

  return dbInitializationScreen;
}