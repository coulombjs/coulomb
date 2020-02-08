import React, { useEffect, useState } from 'react';

import { Button, IconName, Tooltip, FormGroup, InputGroup, Intent, Icon, Popover, Position } from '@blueprintjs/core';

import { openWindow } from '../../../api_legacy/renderer';
import { callIPC, useIPCValue } from '../../../ipc/renderer';

import { DatabaseStatusComponentProps } from '../../../config/renderer';
import { BackendDescription, BackendStatus } from '../base';

import styles from './status.scss';


const BackendDetails: React.FC<DatabaseStatusComponentProps<BackendDescription, BackendStatus>> =
function ({ dbIPCPrefix, status, description }) {
  return (
    <div className={styles.base}>
      <div className={styles.sourceInfo}>
        {description.gitUsername}@{description.gitRepo}
      </div>
      <Status ipcPrefix={dbIPCPrefix} status={status} />
    </div>
  );
};


export default BackendDetails;


const Status: React.FC<{ ipcPrefix: string, status: BackendStatus }> = function ({ ipcPrefix, status }) {
  const numUncommitted = useIPCValue(`${ipcPrefix}-count-uncommitted`, { numUncommitted: 0 }).
  value.numUncommitted;

  const [passwordPromptIsOpen, openPasswordPrompt] = useState(false);

  useEffect(() => {
    openPasswordPrompt(status.needsPassword);
  }, [status.needsPassword]);

  async function triggerSync() {
    await callIPC(`${ipcPrefix}-git-trigger-sync`);
  }

  async function discardUnstaged() {
    await callIPC(`${ipcPrefix}-git-discard-unstaged`);
  }

  async function setPassword(password: string) {
    await callIPC<{ password: string }, { success: true }>(`${ipcPrefix}-git-set-password`, { password });
  }

  let statusIcon: IconName;
  let tooltipText: string | undefined;
  let statusIntent: Intent;
  let action: null | (() => void);

  if (status.isMisconfigured) {
    statusIcon = "error";
    tooltipText = "Remote storage is missing configuration";
    statusIntent = "danger";
    action = () => openWindow('settings');

  } else if (status.needsPassword) {
    statusIcon = "lock";
    tooltipText = "Remote storage is pending authentication";
    statusIntent = "primary";
    action = null;

  } else if (status.isOnline !== true) {
    statusIcon = "offline";
    tooltipText = "No connection to remote storage";
    statusIntent = "danger";
    action = triggerSync;

  } else if (status.hasLocalChanges) {
    statusIcon = "git-commit";
    tooltipText = "Uncommitted local changes present—click to resolve";
    statusIntent = "warning";
    action = async () => {
      // If hasLocalChanges says yes, but uncommitted file count says no,
      // try to fix it.
      if (status.hasLocalChanges && numUncommitted < 1) {
        await discardUnstaged();
        await triggerSync();
      } else {
        openWindow('batch-commit');
      }
    }

  } else if (status.isPulling) {
    statusIcon = "cloud-download"
    tooltipText = "Synchronizing remote storage…";
    statusIntent = "primary";
    action = null;

  } else if (status.isPushing) {
    statusIcon = "cloud-upload"
    tooltipText = "Synchronizing remote storage…";
    statusIntent = "primary";
    action = null;

  } else if (status.statusRelativeToLocal === 'diverged') {
    statusIcon = "git-branch"
    tooltipText = "Local and remote storage have diverging changes—click to retry";
    statusIntent = "danger";
    action = triggerSync;

  } else if (status.statusRelativeToLocal === 'behind') {
    statusIcon = "cloud-upload"
    tooltipText = "Pending changes to upload";
    statusIntent = "warning";
    action = null;

  } else {
    statusIcon = "updated"
    tooltipText = "Click to trigger remote storage sync";
    statusIntent = "success";
    action = triggerSync;
  }

  return <>
    <Popover minimal={true} content={
        <PasswordPrompt
          onConfirm={async (password) => { await setPassword(password); openPasswordPrompt(false); }} />}
          position={Position.BOTTOM_LEFT}
          isOpen={passwordPromptIsOpen}>
      <div className={styles.backendStatus}>
        {action !== null
          ? <Button
              className={styles.statusIcon}
              icon={statusIcon}
              large={true}
              onClick={action}
              intent={statusIntent} />
          : <Icon
              icon={statusIcon}
              intent={statusIntent}
              className={styles.statusIcon}
              iconSize={Icon.SIZE_LARGE} />}
        <div className={styles.statusText}>
          {tooltipText}
        </div>
      </div>
    </Popover>
  </>;
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
                minimal={true}
                onClick={async () => await onConfirm(value)}
                icon="tick"
                intent="primary">
              Confirm
            </Button>}
      />
    </FormGroup>
  </div>;
};
