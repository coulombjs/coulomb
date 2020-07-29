import { shell } from 'electron';
import * as log from 'electron-log';
import React, { useState } from 'react';
import { Button, FormGroup, InputGroup, ButtonGroup, NonIdealState, Spinner, Callout, } from '@blueprintjs/core';
import { callIPC, useIPCValue } from '../../../ipc/renderer';
import styles from './status.scss';
const BackendDetails = function ({ dbIPCPrefix, status, description }) {
    const ipcPrefix = dbIPCPrefix;
    const numUncommitted = useIPCValue(`${ipcPrefix}-count-uncommitted`, { numUncommitted: 0 }).
        value.numUncommitted;
    // Requests sync with push
    async function handleRequestFullSync() {
        await callIPC(`${ipcPrefix}-git-request-push`);
        await callIPC(`${ipcPrefix}-git-trigger-sync`);
    }
    return (React.createElement(ButtonGroup, { fill: true, vertical: true, alignText: "left" },
        React.createElement(Button, { className: styles.sourceInfo, title: `${description.gitUsername}@${description.gitRepo}`, icon: "git-repo", onClick: () => {
                if (description.gitRepo) {
                    require('electron').shell.openExternal(description.gitRepo);
                }
            } },
            description.gitUsername,
            "@",
            description.gitRepo),
        React.createElement(ActionableStatus, { status: status, uncommittedFileCount: numUncommitted, onRequestFullSync: handleRequestFullSync, onShowSettingsWindow: () => callIPC('open-predefined-window', { id: 'settings' }) })));
};
export default BackendDetails;
const ActionableStatus = function ({ status, uncommittedFileCount, onRequestFullSync, onShowSettingsWindow }) {
    let statusIcon;
    let tooltipText;
    let statusIntent;
    let action;
    if (status.isMisconfigured) {
        statusIcon = "error";
        tooltipText = "Configure";
        statusIntent = "danger";
        action = onShowSettingsWindow;
    }
    else if (status.isOnline !== true) {
        statusIcon = "offline";
        tooltipText = "Sync now";
        statusIntent = "primary";
        action = onRequestFullSync;
    }
    else if (status.hasLocalChanges && uncommittedFileCount > 0) {
        statusIcon = "git-commit";
        tooltipText = "Sync now";
        statusIntent = undefined;
        action = onRequestFullSync;
    }
    else if (status.statusRelativeToLocal === 'diverged') {
        statusIcon = "git-branch";
        tooltipText = "Resolve conflict and sync";
        statusIntent = "warning";
        action = onRequestFullSync;
    }
    else if (status.statusRelativeToLocal === 'behind') {
        statusIcon = "cloud-upload";
        tooltipText = "Sync now";
        statusIntent = "primary";
        action = onRequestFullSync;
    }
    else {
        statusIcon = "updated";
        tooltipText = "Sync now";
        statusIntent = "primary";
        action = onRequestFullSync;
    }
    return (React.createElement(Button, { className: styles.backendStatus, onClick: action || (() => { }), icon: statusIcon, intent: statusIntent, disabled: action === null }, tooltipText));
};
export const PasswordPrompt = function ({ dbIPCPrefix, onConfirm }) {
    const [value, setValue] = useState('');
    async function handlePasswordConfirm() {
        await callIPC(`${dbIPCPrefix}-git-set-password`, { password: value });
        await callIPC(`${dbIPCPrefix}-git-trigger-sync`);
        onConfirm();
    }
    return React.createElement("div", { className: styles.passwordPrompt },
        React.createElement(FormGroup, { label: "Please enter repository password:", helperText: "The password will be kept in memory and not stored to disk." },
            React.createElement(InputGroup, { type: "password", value: value, onChange: (event) => setValue(event.target.value), leftIcon: "key", rightElement: value.trim() === ''
                    ? undefined
                    : React.createElement(Button, { minimal: true, onClick: handlePasswordConfirm, icon: "tick", intent: "primary" }, "Confirm") })));
};
export const DBSyncScreen = function ({ dbName, db, onDismiss }) {
    let dbInitializationScreen;
    if ((db === null || db === void 0 ? void 0 : db.status) === undefined) {
        dbInitializationScreen = React.createElement(NonIdealState, { icon: React.createElement(Spinner, null), title: "Initializing database" });
    }
    else if (db.status.lastSynchronized !== null && db.status.isOnline !== true) {
        dbInitializationScreen = React.createElement(NonIdealState, { icon: "offline", title: "Offline", description: React.createElement(React.Fragment, null,
                React.createElement("p", null, "Unable to reach data repository. There may be connection issues."),
                React.createElement(Button, { onClick: onDismiss, intent: "primary" }, "Synchronize later")) });
    }
    else if (db.status.needsPassword) {
        dbInitializationScreen = React.createElement(NonIdealState, { icon: "key", title: "Password required", description: React.createElement(PasswordPrompt, { dbIPCPrefix: `db-${dbName}`, onConfirm: () => void 0 }) });
    }
    else if (db.status.isPushing || db.status.isPulling) {
        dbInitializationScreen = React.createElement(NonIdealState, { icon: React.createElement(Spinner, null), title: "Synchronizing data", description: db.status.isPushing ? "Sending changes" : "Fetching changes" });
    }
    else if (db.status.lastSynchronized === null && db.status.hasLocalChanges === false) {
        dbInitializationScreen = React.createElement(NonIdealState, { icon: React.createElement(Spinner, null), title: "Connecting" });
    }
    else if (db.status.statusRelativeToLocal === 'diverged') {
        dbInitializationScreen = React.createElement(NonIdealState, { icon: "warning-sign", title: "Diverging changes found", description: React.createElement(React.Fragment, null,
                React.createElement("p", null, "Failed to integrate local and remote changes."),
                React.createElement("p", null, "To resolve, you may want to contact registry manager representative."),
                React.createElement(Button, { onClick: onDismiss, intent: "primary" }, "Dismiss"),
                React.createElement(TechnicalGitNotice, { clonePath: db.localClonePath },
                    React.createElement("p", null, "Unable to perform Git fast-forward merge. It is possible that the same object was modified by multiple users."),
                    React.createElement("p", null,
                        "May be resolvable with ",
                        React.createElement("code", null, "git rebase origin/maste"),
                        "(use at your risk, or get in touch with registry manager)."))) });
    }
    else if (db.status.hasLocalChanges === true) {
        dbInitializationScreen = React.createElement(NonIdealState, { icon: "warning-sign", title: "Cannot synchronize", description: React.createElement(React.Fragment, null,
                React.createElement("p", null, "Uncommitted changes present."),
                React.createElement(Button, { onClick: onDismiss, intent: "primary" }, "Dismiss"),
                React.createElement(TechnicalGitNotice, { clonePath: db.localClonePath },
                    React.createElement("p", null, "Uncommitted or unstaged changes present in local clone."),
                    React.createElement("p", null,
                        "May be resolvable with ",
                        React.createElement("code", null, "git status"),
                        " and manually discarding/staging/committing the changes (use at your risk, or get in touch with registry manager)."))) });
    }
    else if (db.status.lastSynchronized !== null) {
        dbInitializationScreen = React.createElement(NonIdealState, { icon: "tick", title: "Ready", description: React.createElement(React.Fragment, null,
                React.createElement("p", null,
                    "Last synchronized: ",
                    db.status.lastSynchronized.toISOString()),
                React.createElement(Button, { onClick: onDismiss, intent: "primary" }, "Dismiss")) });
    }
    else {
        dbInitializationScreen = React.createElement(NonIdealState, { icon: "warning-sign", title: "Ready", description: React.createElement(React.Fragment, null,
                React.createElement("p", null, "Last synchronized: N/A"),
                React.createElement(Button, { onClick: onDismiss, intent: "primary" }, "Synchronize later")) });
    }
    return dbInitializationScreen;
};
const TechnicalGitNotice = function ({ clonePath, children }) {
    function openLocalClonePath() {
        if (clonePath) {
            log.debug("Revealing local clone folder", clonePath);
            shell.showItemInFolder(clonePath);
        }
        else {
            log.error("Unable to reveal local clone folder: not specified in backend description.");
        }
    }
    return (React.createElement(Callout, { title: "Technical information", icon: "cog", style: { textAlign: 'left', marginTop: '2rem', fontSize: '90%' } },
        children,
        React.createElement("p", null,
            "If you have Git CLI installed, you can attempt to resolve this manually. Local clone path ",
            clonePath ? React.createElement("a", { onClick: openLocalClonePath }, "(reveal)") : null,
            ":",
            " ",
            React.createElement("code", null, clonePath || 'N/A'),
            "."),
        React.createElement("p", null, "Note that the repository was initialized by Git implementation in Node, which is different than the official Git CLI, but most Git CLI commands should work.")));
};
//# sourceMappingURL=status.js.map