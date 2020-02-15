import React, { useEffect, useState } from 'react';

import { Button, IconName, Tooltip, FormGroup, InputGroup, Intent, Text, Popover, Position } from '@blueprintjs/core';

import { openWindow } from '../../../api_legacy/renderer';
import { callIPC, useIPCValue } from '../../../ipc/renderer';

import { DatabaseStatusComponentProps } from '../../../config/renderer';
import { BackendDescription, BackendStatus } from '../base';

import styles from './status.scss';


const BackendDetails: React.FC<DatabaseStatusComponentProps<BackendDescription, BackendStatus>> =
function ({ dbIPCPrefix, status, description }) {
  const ipcPrefix = dbIPCPrefix;

  useEffect(() => {
    openPasswordPrompt(status.needsPassword);
  }, [status.needsPassword]);

  const [passwordPromptIsOpen, openPasswordPrompt] = useState(false);

  async function setPassword(password: string) {
    await callIPC<{ password: string }, { success: true }>(`${ipcPrefix}-git-set-password`, { password });
  }

  return (
    <div className={styles.base}>
      <Button
          minimal={true}
          small={true}
          className={styles.sourceInfo}
          onClick={() => callIPC('open-arbitrary-window', {
            url: description.gitRepo,
            title: "Git repository"
          })}>
        {description.gitUsername}@{description.gitRepo}
      </Button>

      <Popover minimal={true} content={
          <PasswordPrompt
            onConfirm={async (password) => { await setPassword(password); openPasswordPrompt(false); }} />}
            position={Position.TOP_RIGHT}
            isOpen={passwordPromptIsOpen}>
        <ActionableStatus
          status={status}
          uncommittedFileCount={
            useIPCValue(`${ipcPrefix}-count-uncommitted`, { numUncommitted: 0 }).
            value.numUncommitted}
          onRequestSync={async () => await callIPC(`${ipcPrefix}-git-trigger-sync`)}
          onDiscardUnstaged={async () => await callIPC(`${ipcPrefix}-git-discard-unstaged`)}
          onTogglePasswordPrompt={() => openPasswordPrompt(!passwordPromptIsOpen)}
          onShowCommitWindow={() => openWindow('batch-commit')}
          onShowSettingsWindow={() => openWindow('settings')}
        />
      </Popover>
    </div>
  );
};

export default BackendDetails;


interface ActionableStatusProps {
  status: BackendStatus
  uncommittedFileCount: number
  onRequestSync: () => Promise<void>
  onDiscardUnstaged: () => Promise<void>
  onTogglePasswordPrompt: () => void
  onShowCommitWindow: () => void
  onShowSettingsWindow: () => void
}
const ActionableStatus: React.FC<ActionableStatusProps> = function ({
    status, uncommittedFileCount,
    onRequestSync, onDiscardUnstaged,
    onTogglePasswordPrompt,
    onShowCommitWindow, onShowSettingsWindow }) {

  let statusIcon: IconName;
  let tooltipText: string | undefined;
  let statusIntent: Intent;
  let action: null | (() => void);

  if (status.isMisconfigured) {
    statusIcon = "error";
    tooltipText = "Configuration required; click to resolve";
    statusIntent = "danger";
    action = onShowSettingsWindow;

  } else if (status.isOnline !== true) {
    statusIcon = "offline";
    tooltipText = "Offline"
    statusIntent = "danger";
    action = onRequestSync;

  } else if (status.needsPassword) {
    statusIcon = "lock";
    tooltipText = "Password required";
    statusIntent = "primary";
    action = onTogglePasswordPrompt;

  } else if (status.hasLocalChanges) {
    statusIcon = "git-commit";
    tooltipText = "Uncommitted changes; click to resolve";
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
    tooltipText = "Diverging changes present; click to retry";
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
        small={true}
        minimal={true}
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
