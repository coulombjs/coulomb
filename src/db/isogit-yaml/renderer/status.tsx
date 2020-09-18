import os from 'os';
import { shell } from 'electron';
import * as log from 'electron-log';
import React, { useEffect, useState } from 'react';

import {
  Button, IconName, FormGroup, InputGroup, Intent,
  ButtonGroup, NonIdealState, Spinner, Callout,
} from '@blueprintjs/core';

import { callIPC, useIPCValue } from '../../../ipc/renderer';

import { DatabaseStatusComponentProps } from '../../../config/renderer';
import { BackendDescription, BackendStatus } from '../base';

import styles from './status.scss';


let NODE_KEYTAR_PASSWORD_STORAGE_METHOD: string
switch (os.platform()) {
  case 'darwin':
    NODE_KEYTAR_PASSWORD_STORAGE_METHOD = "Keychain";
    break;
  case 'linux':
    NODE_KEYTAR_PASSWORD_STORAGE_METHOD = "Secret Service API/libsecret";
    break;
  case 'win32':
    NODE_KEYTAR_PASSWORD_STORAGE_METHOD = "Credential Vault";
    break;
  default:
    NODE_KEYTAR_PASSWORD_STORAGE_METHOD = "unknown method";
    break;
}


const BackendDetails: React.FC<DatabaseStatusComponentProps<BackendDescription, BackendStatus>> =
function ({ dbIPCPrefix, status, description }) {
  const ipcPrefix = dbIPCPrefix;

  const numUncommitted =
    useIPCValue(`${ipcPrefix}-count-uncommitted`, { numUncommitted: 0 }).
    value.numUncommitted;

  // Requests sync with push
  async function handleRequestFullSync() {
    await callIPC(`${ipcPrefix}-git-request-push`);
    await callIPC(`${ipcPrefix}-git-trigger-sync`);
  }

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
        onRequestFullSync={handleRequestFullSync}
        onShowSettingsWindow={() => callIPC('open-predefined-window', { id: 'settings' })}
      />
    </ButtonGroup>
  );
};

export default BackendDetails;


interface ActionableStatusProps {
  status: BackendStatus
  uncommittedFileCount: number
  onRequestFullSync: () => Promise<void>
  onShowSettingsWindow: () => void
}
const ActionableStatus: React.FC<ActionableStatusProps> = function ({
    status, uncommittedFileCount,
    onRequestFullSync,
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
    action = onRequestFullSync;

  } else if (status.hasLocalChanges && uncommittedFileCount > 0) {
    statusIcon = "git-commit";
    tooltipText = "Sync now";
    statusIntent = undefined;
    action = onRequestFullSync;

  } else if (status.statusRelativeToLocal === 'diverged') {
    statusIcon = "git-branch"
    tooltipText = "Resolve conflict and sync";
    statusIntent = "warning";
    action = onRequestFullSync;

  } else if (status.statusRelativeToLocal === 'behind') {
    statusIcon = "cloud-upload"
    tooltipText = "Sync now";
    statusIntent = "primary";
    action = onRequestFullSync;

  } else {
    statusIcon = "updated"
    tooltipText = "Sync now";
    statusIntent = "primary";
    action = onRequestFullSync;
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
    await callIPC<{ password: string }, { success: true }>(`${dbIPCPrefix}-git-set-password`, { password: value.trim() });
    await callIPC(`${dbIPCPrefix}-git-trigger-sync`);
    onConfirm();
  }

  function handleViewPATInfo() {
    require('electron').shell.openExternal('https://docs.github.com/en/github/authenticating-to-github/creating-a-personal-access-token');
  }

  return <div className={styles.passwordPrompt}>
    <FormGroup
        label="Please enter your Git password to access this repository:"
        helperText={<>
          <p>
            Password will be stored using your operating system’s {NODE_KEYTAR_PASSWORD_STORAGE_METHOD}.
          </p>
          <Callout intent="primary" title="Note for GitHub users" style={{ textAlign: 'left' }}>
            <p>
              If you are using GitHub and this screen does not accept
              your GitHub account password,
              you may need to create a Personal Access Token (PAT)
              and provide it here as a password.
            </p>
            <p>
              Please follow these instructions: <a onClick={handleViewPATInfo}>Creating a personal access token</a>.
              Please make sure to tick the “repo” scope checkbox when creating your PAT.
            </p>
          </Callout>
        </>}>
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
  settingsWindowID?: string
}
export const DBSyncScreen: React.FC<DBSyncScreenProps> = function ({ dbName, db, onDismiss, settingsWindowID }) {
  let dbInitializationScreen: JSX.Element;

  const [canDismiss, setCanDismiss] = useState(false);

  useEffect(() => {
    if (db.status.isOnline !== true || db.status.lastSynchronized !== null) {
      setCanDismiss(false);
      setTimeout((() => setCanDismiss(true)), 2000);
    }
  }, [JSON.stringify(db.status)]);


  function handleOpenSettings() {
    callIPC('open-predefined-window', { id: settingsWindowID });
  }


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

  } else if (db.status.isOnline !== true) {
    dbInitializationScreen = <NonIdealState
      icon="offline"
      title="Offline"
      description={<>
        <p>Please wait a moment…</p>
        {canDismiss
          ? <>
              <Button onClick={onDismiss} intent="primary">Synchronize later</Button>
            </>
          : null}
      </>}
    />

  } else if (db.status.isPushing || db.status.isPulling) {
    dbInitializationScreen = <NonIdealState
      icon={<Spinner />}
      title="Synchronizing data"
      description={db.status.isPushing ? "Sending changes" : "Fetching changes"}
    />

  } else if (db.status.lastSynchronized === null && db.status.hasLocalChanges === false) {
    dbInitializationScreen = <NonIdealState
      icon={<Spinner />}
      title="Connecting"
    />

  } else if (db.status.statusRelativeToLocal === 'diverged') {
    dbInitializationScreen = <NonIdealState
      icon="warning-sign"
      title="Diverging changes found"
      description={<>
        <p>
          Failed to integrate local and remote changes.
        </p>
        <p>
          To resolve, you may want to contact registry manager representative.
        </p>

        <Button onClick={onDismiss} intent="primary">Dismiss</Button>

        <TechnicalGitNotice clonePath={db.localClonePath}>
          <p>
            Unable to perform Git fast-forward merge.
            It is possible that the same object was modified by multiple users.
          </p>
          <p>
            May be resolvable with <code>git rebase origin/maste</code>
            (use at your risk, or get in touch with registry manager).
          </p>
        </TechnicalGitNotice>
      </>}
    />

  } else if (db.status.hasLocalChanges === true) {
    dbInitializationScreen = <NonIdealState
      icon="warning-sign"
      title="Cannot synchronize"
      description={<>
        <p>Uncommitted changes present.</p>

        <Button onClick={onDismiss} intent="primary">Dismiss</Button>

        <TechnicalGitNotice clonePath={db.localClonePath}>
          <p>
            Uncommitted or unstaged changes present in local clone.
          </p>
          <p>
            May be resolvable with <code>git status</code> and manually discarding/staging/committing the changes
            (use at your risk, or get in touch with registry manager).
          </p>
        </TechnicalGitNotice>
      </>}
    />

  } else if (db.status.lastSynchronized !== null) {
    dbInitializationScreen = <NonIdealState
      icon="tick"
      title="Ready"
      description={<>
        <p>Last synchronized: {db.status.lastSynchronized.toISOString()}</p>
        <Button onClick={onDismiss} intent="primary">Dismiss</Button>
      </>}
    />

  } else {
    dbInitializationScreen = <NonIdealState
      icon="warning-sign"
      title="Ready, but something went wrong"
      description={<>
        <p>Last synchronized: N/A</p>
        <Button onClick={onDismiss} intent="primary">Synchronize later</Button>
      </>}
    />

  }
  return (
    <>
      {dbInitializationScreen}

      {settingsWindowID
        ? <Button
              onClick={handleOpenSettings}
              icon="settings"
              style={{ position: 'absolute', top: 20, right: 20 }}>
            Open settings
          </Button>
        : null}
    </>
  );
};


const TechnicalGitNotice: React.FC<{ clonePath: string | undefined }> = function ({ clonePath, children }) {
  function openLocalClonePath() {
    if (clonePath) {
      log.debug("Revealing local clone folder", clonePath);
      shell.showItemInFolder(clonePath);
    } else {
      log.error("Unable to reveal local clone folder: not specified in backend description.");
    }
  }

  return (
    <Callout title="Technical information" icon="cog"
        style={{ textAlign: 'left', marginTop: '2rem', fontSize: '90%' }}>

      {children}

      <p>
        If you have Git CLI installed,
        you can attempt to resolve this manually.
        Local clone path {clonePath ? <a onClick={openLocalClonePath}>(reveal)</a> : null}:
        {" "}
        <code>{clonePath || 'N/A'}</code>.
      </p>
      <p>
        Note that the repository was initialized by Git implementation in Node,
        which is different than the official Git CLI, but most Git CLI commands should work.
      </p>
    </Callout>
  );
};
