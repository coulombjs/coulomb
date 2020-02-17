import React, { useEffect, useState } from 'react';

import { Button, IconName, FormGroup, InputGroup, Intent, Popover, Position, ButtonGroup } from '@blueprintjs/core';

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

  useEffect(() => {
    openPasswordPrompt(status.needsPassword);
  }, [status.needsPassword]);

  const [passwordPromptIsOpen, openPasswordPrompt] = useState(false);

  async function setPassword(password: string) {
    await callIPC<{ password: string }, { success: true }>(`${ipcPrefix}-git-set-password`, { password });
  }

  return (
    <Popover
        boundary="viewport"
        isOpen={passwordPromptIsOpen}
        position={Position.BOTTOM}
        targetTagName="div"
        targetClassName={styles.base}
        content={
          <PasswordPrompt onConfirm={async (password) => {
            setPassword(password);
            openPasswordPrompt(false);
          }} />
        }>
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
          onDiscardUnstaged={async () => await callIPC(`${ipcPrefix}-git-discard-unstaged`)}
          onPromptPassword={() => openPasswordPrompt(true)}
          onShowCommitWindow={() => callIPC('open-predefined-window', { id: 'batchCommit' })}
          onShowSettingsWindow={() => callIPC('open-predefined-window', { id: 'settings' })}
        />
      </ButtonGroup>
    </Popover>
  );
};

export default BackendDetails;


interface ActionableStatusProps {
  status: BackendStatus
  uncommittedFileCount: number
  onRequestSync: () => Promise<void>
  onDiscardUnstaged: () => Promise<void>
  onPromptPassword: () => void
  onShowCommitWindow: () => void
  onShowSettingsWindow: () => void
}
const ActionableStatus: React.FC<ActionableStatusProps> = function ({
    status, uncommittedFileCount,
    onRequestSync, onDiscardUnstaged,
    onPromptPassword,
    onShowCommitWindow, onShowSettingsWindow }) {

  let statusIcon: IconName;
  let tooltipText: string | undefined;
  let statusIntent: Intent;
  let action: null | (() => void);

  if (status.isMisconfigured) {
    statusIcon = "error";
    tooltipText = "Configure";
    statusIntent = "danger";
    action = onShowSettingsWindow;

  } else if (status.isOnline !== true) {
    statusIcon = "offline";
    tooltipText = "Offline"
    statusIntent = "danger";
    action = status.needsPassword ? onPromptPassword : onRequestSync;

  } else if (status.needsPassword) {
    statusIcon = "lock";
    tooltipText = "Provide password";
    statusIntent = "primary";
    action = onPromptPassword;

  } else if (status.hasLocalChanges) {
    statusIcon = "git-commit";
    tooltipText = "Commit outstanding";
    statusIntent = "warning";
    action = async () => {
      if (status.hasLocalChanges && uncommittedFileCount < 1) {
        // NOTE: If hasLocalChanges says yes, but uncommitted file count says no, try to fix it.
        await onDiscardUnstaged();
        await onRequestSync();
      } else {
        onShowCommitWindow();
      }
    }

  } else if (status.isPulling) {
    statusIcon = "cloud-download"
    tooltipText = "Synchronizing";
    statusIntent = "primary";
    action = null;

  } else if (status.isPushing) {
    statusIcon = "cloud-upload"
    tooltipText = "Synchronizing";
    statusIntent = "primary";
    action = null;

  } else if (status.statusRelativeToLocal === 'diverged') {
    statusIcon = "git-branch"
    tooltipText = "Diverging changes";
    statusIntent = "danger";
    action = onRequestSync;

  } else if (status.statusRelativeToLocal === 'behind') {
    statusIcon = "cloud-upload"
    tooltipText = "Online";
    statusIntent = "warning";
    action = onRequestSync;

  } else {
    statusIcon = "updated"
    tooltipText = "Online";
    statusIntent = "success";
    action = onRequestSync;
  }

  return (
    <Button
        className={styles.backendStatus}
        onClick={action || (() => {})}
        icon={statusIcon}
        intent={statusIntent}
        disabled={action === null}
        loading={action === null}>
      {tooltipText}
    </Button>
  );
};


const PasswordPrompt: React.FC<{ onConfirm: (value: string) => Promise<void> }> = function ({ onConfirm }) {
  const [value, setValue] = useState('');

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
                minimal
                onClick={async () => await onConfirm(value)}
                icon="tick"
                intent="primary">
              Confirm
            </Button>}
      />
    </FormGroup>
  </div>;
};
