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
    var _a;
    let dbInitializationScreen;
    if (((_a = db) === null || _a === void 0 ? void 0 : _a.status) === undefined) {
        dbInitializationScreen = React.createElement(NonIdealState, { icon: React.createElement(Spinner, null), title: "Initializing database" });
    }
    else if (db.status.lastSynchronized !== null && db.status.isOnline === false) {
        dbInitializationScreen = React.createElement(NonIdealState, { icon: "offline", title: "No connection", description: React.createElement(React.Fragment, null,
                React.createElement("p", null, "Failed to connect to register data repository."),
                React.createElement(Button, { onClick: onDismiss, intent: "primary" }, "Synchronize later")) });
    }
    else if (db.status.needsPassword) {
        dbInitializationScreen = React.createElement(NonIdealState, { icon: "key", title: "Password required", description: React.createElement(PasswordPrompt, { dbIPCPrefix: `db-${dbName}`, onConfirm: () => void 0 }) });
    }
    else if (db.status.isPushing || db.status.isPulling) {
        dbInitializationScreen = React.createElement(NonIdealState, { icon: db.status.isPushing ? "cloud-upload" : "cloud-download", title: "Synchronizing data", description: db.status.isPushing ? "Sending changes" : "Fetching changes" });
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhdHVzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2RiL2lzb2dpdC15YW1sL3JlbmRlcmVyL3N0YXR1cy50c3giXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLEtBQUssRUFBRSxNQUFNLFVBQVUsQ0FBQztBQUNqQyxPQUFPLEtBQUssR0FBRyxNQUFNLGNBQWMsQ0FBQztBQUNwQyxPQUFPLEtBQUssRUFBRSxFQUFFLFFBQVEsRUFBRSxNQUFNLE9BQU8sQ0FBQztBQUV4QyxPQUFPLEVBQ0wsTUFBTSxFQUFZLFNBQVMsRUFBRSxVQUFVLEVBQ3ZDLFdBQVcsRUFBRSxhQUFhLEVBQUUsT0FBTyxFQUFFLE9BQU8sR0FDN0MsTUFBTSxtQkFBbUIsQ0FBQztBQUUzQixPQUFPLEVBQUUsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLHVCQUF1QixDQUFDO0FBSzdELE9BQU8sTUFBTSxNQUFNLGVBQWUsQ0FBQztBQUduQyxNQUFNLGNBQWMsR0FDcEIsVUFBVSxFQUFFLFdBQVcsRUFBRSxNQUFNLEVBQUUsV0FBVyxFQUFFO0lBQzVDLE1BQU0sU0FBUyxHQUFHLFdBQVcsQ0FBQztJQUU5QixNQUFNLGNBQWMsR0FDbEIsV0FBVyxDQUFDLEdBQUcsU0FBUyxvQkFBb0IsRUFBRSxFQUFFLGNBQWMsRUFBRSxDQUFDLEVBQUUsQ0FBQztRQUNwRSxLQUFLLENBQUMsY0FBYyxDQUFDO0lBRXZCLDBCQUEwQjtJQUMxQixLQUFLLFVBQVUscUJBQXFCO1FBQ2xDLE1BQU0sT0FBTyxDQUFDLEdBQUcsU0FBUyxtQkFBbUIsQ0FBQyxDQUFDO1FBQy9DLE1BQU0sT0FBTyxDQUFDLEdBQUcsU0FBUyxtQkFBbUIsQ0FBQyxDQUFDO0lBQ2pELENBQUM7SUFFRCxPQUFPLENBQ0wsb0JBQUMsV0FBVyxJQUFDLElBQUksUUFBQyxRQUFRLFFBQUMsU0FBUyxFQUFDLE1BQU07UUFDekMsb0JBQUMsTUFBTSxJQUNILFNBQVMsRUFBRSxNQUFN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QUFFLFFBQVEsRUFBRSxLQUFLLEVBQUU7UUFFakUsUUFBUTtRQUVUOztZQUdvQixTQUFTLENBQUMsQ0FBQyxDQUFDLDJCQUFHLE9BQU8sRUFBRSxrQkFBa0IsZUFBYyxDQUFDLENBQUMsQ0FBQyxJQUFJOztZQUNoRixHQUFHO1lBQ0osa0NBQU8sU0FBUyxJQUFJLEtBQUssQ0FBUTtnQkFDL0I7UUFDSiw4TEFHSSxDQUNJLENBQ1gsQ0FBQztBQUNKLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHNoZWxsIH0gZnJvbSAnZWxlY3Ryb24nO1xuaW1wb3J0ICogYXMgbG9nIGZyb20gJ2VsZWN0cm9uLWxvZyc7XG5pbXBvcnQgUmVhY3QsIHsgdXNlU3RhdGUgfSBmcm9tICdyZWFjdCc7XG5cbmltcG9ydCB7XG4gIEJ1dHRvbiwgSWNvbk5hbWUsIEZvcm1Hcm91cCwgSW5wdXRHcm91cCwgSW50ZW50LFxuICBCdXR0b25Hcm91cCwgTm9uSWRlYWxTdGF0ZSwgU3Bpbm5lciwgQ2FsbG91dCxcbn0gZnJvbSAnQGJsdWVwcmludGpzL2NvcmUnO1xuXG5pbXBvcnQgeyBjYWxsSVBDLCB1c2VJUENWYWx1ZSB9IGZyb20gJy4uLy4uLy4uL2lwYy9yZW5kZXJlcic7XG5cbmltcG9ydCB7IERhdGFiYXNlU3RhdHVzQ29tcG9uZW50UHJvcHMgfSBmcm9tICcuLi8uLi8uLi9jb25maWcvcmVuZGVyZXInO1xuaW1wb3J0IHsgQmFja2VuZERlc2NyaXB0aW9uLCBCYWNrZW5kU3RhdHVzIH0gZnJvbSAnLi4vYmFzZSc7XG5cbmltcG9ydCBzdHlsZXMgZnJvbSAnLi9zdGF0dXMuc2Nzcyc7XG5cblxuY29uc3QgQmFja2VuZERldGFpbHM6IFJlYWN0LkZDPERhdGFiYXNlU3RhdHVzQ29tcG9uZW50UHJvcHM8QmFja2VuZERlc2NyaXB0aW9uLCBCYWNrZW5kU3RhdHVzPj4gPVxuZnVuY3Rpb24gKHsgZGJJUENQcmVmaXgsIHN0YXR1cywgZGVzY3JpcHRpb24gfSkge1xuICBjb25zdCBpcGNQcmVmaXggPSBkYklQQ1ByZWZpeDtcblxuICBjb25zdCBudW1VbmNvbW1pdHRlZCA9XG4gICAgdXNlSVBDVmFsdWUoYCR7aXBjUHJlZml4fS1jb3VudC11bmNvbW1pdHRlZGAsIHsgbnVtVW5jb21taXR0ZWQ6IDAgfSkuXG4gICAgdmFsdWUubnVtVW5jb21taXR0ZWQ7XG5cbiAgLy8gUmVxdWVzdHMgc3luYyB3aXRoIHB1c2hcbiAgYXN5bmMgZnVuY3Rpb24gaGFuZGxlUmVxdWVzdEZ1bGxTeW5jKCkge1xuICAgIGF3YWl0IGNhbGxJUEMoYCR7aXBjUHJlZml4fS1naXQtcmVxdWVzdC1wdXNoYCk7XG4gICAgYXdhaXQgY2FsbElQQyhgJHtpcGNQcmVmaXh9LWdpdC10cmlnZ2VyLXN5bmNgKTtcbiAgfVxuXG4gIHJldHVybiAoXG4gICAgPEJ1dHRvbkdyb3VwIGZpbGwgdmVydGljYWwgYWxpZ25UZXh0PVwibGVmdFwiPlxuICAgICAgPEJ1dHRvblxuICAgICAgICAgIGNsYXNzTmFtZT17c3R5bGVzLnNvdXJjZUluZm99XG4gICAgICAgICAgdGl0bGU9e2Ake2Rlc2NyaXB0aW9uLmdpdFVzZXJuYW1lfUAke2Rlc2NyaXB0aW9uLmdpdFJlcG99YH1cbiAgICAgICAgICBpY29uPVwiZ2l0LXJlcG9cIlxuICAgICAgICAgIG9uQ2xpY2s9eygpID0+IHtcbiAgICAgICAgICAgIGlmIChkZXNjcmlwdGlvbi5naXRSZXBvKSB7XG4gICAgICAgICAgICAgIHJlcXVpcmUoJ2VsZWN0cm9uJykuc2hlbGwub3BlbkV4dGVybmFsKGRlc2NyaXB0aW9uLmdpdFJlcG8pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH19PlxuICAgICAgICB7ZGVzY3JpcHRpb24uZ2l0VXNlcm5hbWV9QHtkZXNjcmlwdGlvbi5naXRSZXBvfVxuICAgICAgPC9CdXR0b24+XG5cbiAgICAgIDxBY3Rpb25hYmxlU3RhdHVzXG4gICAgICAgIHN0YXR1cz17c3RhdHVzfVxuICAgICAgICB1bmNvbW1pdHRlZEZpbGVDb3VudD17bnVtVW5jb21taXR0ZWR9XG4gICAgICAgIG9uUmVxdWVzdEZ1bGxTeW5jPXtoYW5kbGVSZXF1ZXN0RnVsbFN5bmN9XG4gICAgICAgIG9uU2hvd1NldHRpbmdzV2luZG93PXsoKSA9PiBjYWxsSVBDKCdvcGVuLXByZWRlZmluZWQtd2luZG93JywgeyBpZDogJ3NldHRpbmdzJyB9KX1cbiAgICAgIC8+XG4gICAgPC9CdXR0b25Hcm91cD5cbiAgKTtcbn07XG5cbmV4cG9ydCBkZWZhdWx0IEJhY2tlbmREZXRhaWxzO1xuXG5cbmludGVyZmFjZSBBY3Rpb25hYmxlU3RhdHVzUHJvcHMge1xuICBzdGF0dXM6IEJhY2tlbmRTdGF0dXNcbiAgdW5jb21taXR0ZWRGaWxlQ291bnQ6IG51bWJlclxuICBvblJlcXVlc3RGdWxsU3luYzogKCkgPT4gUHJvbWlzZTx2b2lkPlxuICBvblNob3dTZXR0aW5nc1dpbmRvdzogKCkgPT4gdm9pZFxufVxuY29uc3QgQWN0aW9uYWJsZVN0YXR1czogUmVhY3QuRkM8QWN0aW9uYWJsZVN0YXR1c1Byb3BzPiA9IGZ1bmN0aW9uICh7XG4gICAgc3RhdHVzLCB1bmNvbW1pdHRlZEZpbGVDb3VudCxcbiAgICBvblJlcXVlc3RGdWxsU3luYyxcbiAgICBvblNob3dTZXR0aW5nc1dpbmRvdyB9KSB7XG5cbiAgbGV0IHN0YXR1c0ljb246IEljb25OYW1lO1xuICBsZXQgdG9vbHRpcFRleHQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgbGV0IHN0YXR1c0ludGVudDogSW50ZW50IHwgdW5kZWZpbmVkO1xuICBsZXQgYWN0aW9uOiBudWxsIHwgKCgpID0+IHZvaWQpO1xuXG4gIGlmIChzdGF0dXMuaXNNaXNjb25maWd1cmVkKSB7XG4gICAgc3RhdHVzSWNvbiA9IFwiZXJyb3JcIjtcbiAgICB0b29sdGlwVGV4dCA9IFwiQ29uZmlndXJlXCI7XG4gICAgc3RhdHVzSW50ZW50ID0gXCJkYW5nZXJcIjtcbiAgICBhY3Rpb24gPSBvblNob3dTZXR0aW5nc1dpbmRvdztcblxuICB9IGVsc2UgaWYgKHN0YXR1cy5pc09ubGluZSAhPT0gdHJ1ZSkge1xuICAgIHN0YXR1c0ljb24gPSBcIm9mZmxpbmVcIjtcbiAgICB0b29sdGlwVGV4dCA9IFwiU3luYyBub3dcIlxuICAgIHN0YXR1c0ludGVudCA9IFwicHJpbWFyeVwiO1xuICAgIGFjdGlvbiA9IG9uUmVxdWVzdEZ1bGxTeW5jO1xuXG4gIH0gZWxzZSBpZiAoc3RhdHVzLmhhc0xvY2FsQ2hhbmdlcyAmJiB1bmNvbW1pdHRlZEZpbGVDb3VudCA+IDApIHtcbiAgICBzdGF0dXNJY29uID0gXCJnaXQtY29tbWl0XCI7XG4gICAgdG9vbHRpcFRleHQgPSBcIlN5bmMgbm93XCI7XG4gICAgc3RhdHVzSW50ZW50ID0gdW5kZWZpbmVkO1xuICAgIGFjdGlvbiA9IG9uUmVxdWVzdEZ1bGxTeW5jO1xuXG4gIH0gZWxzZSBpZiAoc3RhdHVzLnN0YXR1c1JlbGF0aXZlVG9Mb2NhbCA9PT0gJ2RpdmVyZ2VkJykge1xuICAgIHN0YXR1c0ljb24gPSBcImdpdC1icmFuY2hcIlxuICAgIHRvb2x0aXBUZXh0ID0gXCJSZXNvbHZlIGNvbmZsaWN0IGFuZCBzeW5jXCI7XG4gICAgc3RhdHVzSW50ZW50ID0gXCJ3YXJuaW5nXCI7XG4gICAgYWN0aW9uID0gb25SZXF1ZXN0RnVsbFN5bmM7XG5cbiAgfSBlbHNlIGlmIChzdGF0dXMuc3RhdHVzUmVsYXRpdmVUb0xvY2FsID09PSAnYmVoaW5kJykge1xuICAgIHN0YXR1c0ljb24gPSBcImNsb3VkLXVwbG9hZFwiXG4gICAgdG9vbHRpcFRleHQgPSBcIlN5bmMgbm93XCI7XG4gICAgc3RhdHVzSW50ZW50ID0gXCJwcmltYXJ5XCI7XG4gICAgYWN0aW9uID0gb25SZXF1ZXN0RnVsbFN5bmM7XG5cbiAgfSBlbHNlIHtcbiAgICBzdGF0dXNJY29uID0gXCJ1cGRhdGVkXCJcbiAgICB0b29sdGlwVGV4dCA9IFwiU3luYyBub3dcIjtcbiAgICBzdGF0dXNJbnRlbnQgPSBcInByaW1hcnlcIjtcbiAgICBhY3Rpb24gPSBvblJlcXVlc3RGdWxsU3luYztcbiAgfVxuXG4gIHJldHVybiAoXG4gICAgPEJ1dHRvblxuICAgICAgICBjbGFzc05hbWU9e3N0eWxlcy5iYWNrZW5kU3RhdHVzfVxuICAgICAgICBvbkNsaWNrPXthY3Rpb24gfHwgKCgpID0+IHt9KX1cbiAgICAgICAgaWNvbj17c3RhdHVzSWNvbn1cbiAgICAgICAgaW50ZW50PXtzdGF0dXNJbnRlbnR9XG4gICAgICAgIGRpc2FibGVkPXthY3Rpb24gPT09IG51bGx9PlxuICAgICAge3Rvb2x0aXBUZXh0fVxuICAgIDwvQnV0dG9uPlxuICApO1xufTtcblxuXG5leHBvcnQgY29uc3QgUGFzc3dvcmRQcm9tcHQ6IFJlYWN0LkZDPHsgZGJJUENQcmVmaXg6IHN0cmluZywgb25Db25maXJtOiAoKSA9PiB2b2lkIH0+ID1cbmZ1bmN0aW9uICh7IGRiSVBDUHJlZml4LCBvbkNvbmZpcm0gfSkge1xuICBjb25zdCBbdmFsdWUsIHNldFZhbHVlXSA9IHVzZVN0YXRlKCcnKTtcblxuICBhc3luYyBmdW5jdGlvbiBoYW5kbGVQYXNzd29yZENvbmZpcm0oKSB7XG4gICAgYXdhaXQgY2FsbElQQzx7IHBhc3N3b3JkOiBzdHJpbmcgfSwgeyBzdWNjZXNzOiB0cnVlIH0+KGAke2RiSVBDUHJlZml4fS1naXQtc2V0LXBhc3N3b3JkYCwgeyBwYXNzd29yZDogdmFsdWUgfSk7XG4gICAgYXdhaXQgY2FsbElQQyhgJHtkYklQQ1ByZWZpeH0tZ2l0LXRyaWdnZXItc3luY2ApO1xuICAgIG9uQ29uZmlybSgpO1xuICB9XG5cbiAgcmV0dXJuIDxkaXYgY2xhc3NOYW1lPXtzdHlsZXMucGFzc3dvcmRQcm9tcHR9PlxuICAgIDxGb3JtR3JvdXBcbiAgICAgICAgbGFiZWw9XCJQbGVhc2UgZW50ZXIgcmVwb3NpdG9yeSBwYXNzd29yZDpcIlxuICAgICAgICBoZWxwZXJUZXh0PVwiVGhlIHBhc3N3b3JkIHdpbGwgYmUga2VwdCBpbiBtZW1vcnkgYW5kIG5vdCBzdG9yZWQgdG8gZGlzay5cIj5cbiAgICAgIDxJbnB1dEdyb3VwXG4gICAgICAgIHR5cGU9XCJwYXNzd29yZFwiXG4gICAgICAgIHZhbHVlPXt2YWx1ZX1cbiAgICAgICAgb25DaGFuZ2U9eyhldmVudDogUmVhY3QuRm9ybUV2ZW50PEhUTUxFbGVtZW50PikgPT4gc2V0VmFsdWUoKGV2ZW50LnRhcmdldCBhcyBIVE1MSW5wdXRFbGVtZW50KS52YWx1ZSl9XG4gICAgICAgIGxlZnRJY29uPVwia2V5XCJcbiAgICAgICAgcmlnaHRFbGVtZW50PXtcbiAgICAgICAgICB2YWx1ZS50cmltKCkgPT09ICcnXG4gICAgICAgICAgPyB1bmRlZmluZWRcbiAgICAgICAgICA6IDxCdXR0b25cbiAgICAgICAgICAgICAgICBtaW5pbWFsPXt0cnVlfVxuICAgICAgICAgICAgICAgIG9uQ2xpY2s9e2hhbmRsZVBhc3N3b3JkQ29uZmlybX1cbiAgICAgICAgICAgICAgICBpY29uPVwidGlja1wiXG4gICAgICAgICAgICAgICAgaW50ZW50PVwicHJpbWFyeVwiPlxuICAgICAgICAgICAgICBDb25maXJtXG4gICAgICAgICAgICA8L0J1dHRvbj59XG4gICAgICAvPlxuICAgIDwvRm9ybUdyb3VwPlxuICA8L2Rpdj47XG59O1xuXG5cbmludGVyZmFjZSBEQlN5bmNTY3JlZW5Qcm9wcyB7XG4gIGRiTmFtZTogc3RyaW5nXG4gIGRiOiBCYWNrZW5kRGVzY3JpcHRpb25cbiAgb25EaXNtaXNzOiAoKSA9PiB2b2lkXG59XG5leHBvcnQgY29uc3QgREJTeW5jU2NyZWVuOiBSZWFjdC5GQzxEQlN5bmNTY3JlZW5Qcm9wcz4gPSBmdW5jdGlvbiAoeyBkYk5hbWUsIGRiLCBvbkRpc21pc3MgfSkge1xuICBsZXQgZGJJbml0aWFsaXphdGlvblNjcmVlbjogSlNYLkVsZW1lbnQ7XG5cbiAgaWYgKGRiPy5zdGF0dXMgPT09IHVuZGVmaW5lZCkge1xuICAgIGRiSW5pdGlhbGl6YXRpb25TY3JlZW4gPSA8Tm9uSWRlYWxTdGF0ZVxuICAgICAgaWNvbj17PFNwaW5uZXIgLz59XG4gICAgICB0aXRsZT1cIkluaXRpYWxpemluZyBkYXRhYmFzZVwiXG4gICAgLz5cblxuICB9IGVsc2UgaWYgKGRiLnN0YXR1cy5sYXN0U3luY2hyb25pemVkICE9PSBudWxsICYmIGRiLnN0YXR1cy5pc09ubGluZSA9PT0gZmFsc2UpIHtcbiAgICBkYkluaXRpYWxpemF0aW9uU2NyZWVuID0gPE5vbklkZWFsU3RhdGVcbiAgICAgIGljb249XCJvZmZsaW5lXCJcbiAgICAgIHRpdGxlPVwiTm8gY29ubmVjdGlvblwiXG4gICAgICBkZXNjcmlwdGlvbj17PD5cbiAgICAgICAgPHA+RmFpbGVkIHRvIGNvbm5lY3QgdG8gcmVnaXN0ZXIgZGF0YSByZXBvc2l0b3J5LjwvcD5cbiAgICAgICAgPEJ1dHRvbiBvbkNsaWNrPXtvbkRpc21pc3N9IGludGVudD1cInByaW1hcnlcIj5TeW5jaHJvbml6ZSBsYXRlcjwvQnV0dG9uPlxuICAgICAgPC8+fVxuICAgIC8+XG5cbiAgfSBlbHNlIGlmIChkYi5zdGF0dXMubmVlZHNQYXNzd29yZCkge1xuICAgIGRiSW5pdGlhbGl6YXRpb25TY3JlZW4gPSA8Tm9uSWRlYWxTdGF0ZVxuICAgICAgaWNvbj1cImtleVwiXG4gICAgICB0aXRsZT1cIlBhc3N3b3JkIHJlcXVpcmVkXCJcbiAgICAgIGRlc2NyaXB0aW9uPXs8UGFzc3dvcmRQcm9tcHQgZGJJUENQcmVmaXg9e2BkYi0ke2RiTmFtZX1gfSBvbkNvbmZpcm09eygpID0+IHZvaWQgMH0gLz59XG4gICAgLz5cblxuICB9IGVsc2UgaWYgKGRiLnN0YXR1cy5pc1B1c2hpbmcgfHwgZGIuc3RhdHVzLmlzUHVsbGluZykge1xuICAgIGRiSW5pdGlhbGl6YXRpb25TY3JlZW4gPSA8Tm9uSWRlYWxTdGF0ZVxuICAgICAgaWNvbj17ZGIuc3RhdHVzLmlzUHVzaGluZyA/IFwiY2xvdWQtdXBsb2FkXCIgOiBcImNsb3VkLWRvd25sb2FkXCJ9XG4gICAgICB0aXRsZT1cIlN5bmNocm9uaXppbmcgZGF0YVwiXG4gICAgICBkZXNjcmlwdGlvbj17ZGIuc3RhdHVzLmlzUHVzaGluZyA/IFwiU2VuZGluZyBjaGFuZ2VzXCIgOiBcIkZldGNoaW5nIGNoYW5nZXNcIn1cbiAgICAvPlxuXG4gIH0gZWxzZSBpZiAoZGIuc3RhdHVzLmxhc3RTeW5jaHJvbml6ZWQgPT09IG51bGwgJiYgZGIuc3RhdHVzLmhhc0xvY2FsQ2hhbmdlcyA9PT0gZmFsc2UpIHtcbiAgICBkYkluaXRpYWxpemF0aW9uU2NyZWVuID0gPE5vbklkZWFsU3RhdGVcbiAgICAgIGljb249ezxTcGlubmVyIC8+fVxuICAgICAgdGl0bGU9XCJDb25uZWN0aW5nXCJcbiAgICAvPlxuXG4gIH0gZWxzZSBpZiAoZGIuc3RhdHVzLnN0YXR1c1JlbGF0aXZlVG9Mb2NhbCA9PT0gJ2RpdmVyZ2VkJykge1xuICAgIGRiSW5pdGlhbGl6YXRpb25TY3JlZW4gPSA8Tm9uSWRlYWxTdGF0ZVxuICAgICAgaWNvbj1cIndhcm5pbmctc2lnblwiXG4gICAgICB0aXRsZT1cIkRpdmVyZ2luZyBjaGFuZ2VzIGZvdW5kXCJcbiAgICAgIGRlc2NyaXB0aW9uPXs8PlxuICAgICAgICA8cD5cbiAgICAgICAgICBGYWlsZWQgdG8gaW50ZWdyYXRlIGxvY2FsIGFuZCByZW1vdGUgY2hhbmdlcy5cbiAgICAgICAgPC9wPlxuICAgICAgICA8cD5cbiAgICAgICAgICBUbyByZXNvbHZlLCB5b3UgbWF5IHdhbnQgdG8gY29udGFjdCByZWdpc3RyeSBtYW5hZ2VyIHJlcHJlc2VudGF0aXZlLlxuICAgICAgICA8L3A+XG5cbiAgICAgICAgPEJ1dHRvbiBvbkNsaWNrPXtvbkRpc21pc3N9IGludGVudD1cInByaW1hcnlcIj5EaXNtaXNzPC9CdXR0b24+XG5cbiAgICAgICAgPFRlY2huaWNhbEdpdE5vdGljZSBjbG9uZVBhdGg9e2RiLmxvY2FsQ2xvbmVQYXRofT5cbiAgICAgICAgICA8cD5cbiAgICAgICAgICAgIFVuYWJsZSB0byBwZXJmb3JtIEdpdCBmYXN0LWZvcndhcmQgbWVyZ2UuXG4gICAgICAgICAgICBJdCBpcyBwb3NzaWJsZSB0aGF0IHRoZSBzYW1lIG9iamVjdCB3YXMgbW9kaWZpZWQgYnkgbXVsdGlwbGUgdXNlcnMuXG4gICAgICAgICAgPC9wPlxuICAgICAgICAgIDxwPlxuICAgICAgICAgICAgTWF5IGJlIHJlc29sdmFibGUgd2l0aCA8Y29kZT5naXQgcmViYXNlIG9yaWdpbi9tYXN0ZTwvY29kZT5cbiAgICAgICAgICAgICh1c2UgYXQgeW91ciByaXNrLCBvciBnZXQgaW4gdG91Y2ggd2l0aCByZWdpc3RyeSBtYW5hZ2VyKS5cbiAgICAgICAgICA8L3A+XG4gICAgICAgIDwvVGVjaG5pY2FsR2l0Tm90aWNlPlxuICAgICAgPC8+fVxuICAgIC8+XG5cbiAgfSBlbHNlIGlmIChkYi5zdGF0dXMuaGFzTG9jYWxDaGFuZ2VzID09PSB0cnVlKSB7XG4gICAgZGJJbml0aWFsaXphdGlvblNjcmVlbiA9IDxOb25JZGVhbFN0YXRlXG4gICAgICBpY29uPVwid2FybmluZy1zaWduXCJcbiAgICAgIHRpdGxlPVwiQ2Fubm90IHN5bmNocm9uaXplXCJcbiAgICAgIGRlc2NyaXB0aW9uPXs8PlxuICAgICAgICA8cD5VbmNvbW1pdHRlZCBjaGFuZ2VzIHByZXNlbnQuPC9wPlxuXG4gICAgICAgIDxCdXR0b24gb25DbGljaz17b25EaXNtaXNzfSBpbnRlbnQ9XCJwcmltYXJ5XCI+RGlzbWlzczwvQnV0dG9uPlxuXG4gICAgICAgIDxUZWNobmljYWxHaXROb3RpY2UgY2xvbmVQYXRoPXtkYi5sb2NhbENsb25lUGF0aH0+XG4gICAgICAgICAgPHA+XG4gICAgICAgICAgICBVbmNvbW1pdHRlZCBvciB1bnN0YWdlZCBjaGFuZ2VzIHByZXNlbnQgaW4gbG9jYWwgY2xvbmUuXG4gICAgICAgICAgPC9wPlxuICAgICAgICAgIDxwPlxuICAgICAgICAgICAgTWF5IGJlIHJlc29sdmFibGUgd2l0aCA8Y29kZT5naXQgc3RhdHVzPC9jb2RlPiBhbmQgbWFudWFsbHkgZGlzY2FyZGluZy9zdGFnaW5nL2NvbW1pdHRpbmcgdGhlIGNoYW5nZXNcbiAgICAgICAgICAgICh1c2UgYXQgeW91ciByaXNrLCBvciBnZXQgaW4gdG91Y2ggd2l0aCByZWdpc3RyeSBtYW5hZ2VyKS5cbiAgICAgICAgICA8L3A+XG4gICAgICAgIDwvVGVjaG5pY2FsR2l0Tm90aWNlPlxuICAgICAgPC8+fVxuICAgIC8+XG5cbiAgfSBlbHNlIGlmIChkYi5zdGF0dXMubGFzdFN5bmNocm9uaXplZCAhPT0gbnVsbCkge1xuICAgIGRiSW5pdGlhbGl6YXRpb25TY3JlZW4gPSA8Tm9uSWRlYWxTdGF0ZVxuICAgICAgaWNvbj1cInRpY2tcIlxuICAgICAgdGl0bGU9XCJSZWFkeVwiXG4gICAgICBkZXNjcmlwdGlvbj17PD5cbiAgICAgICAgPHA+TGFzdCBzeW5jaHJvbml6ZWQ6IHtkYi5zdGF0dXMubGFzdFN5bmNocm9uaXplZC50b0lTT1N0cmluZygpfTwvcD5cbiAgICAgICAgPEJ1dHRvbiBvbkNsaWNrPXtvbkRpc21pc3N9IGludGVudD1cInByaW1hcnlcIj5EaXNtaXNzPC9CdXR0b24+XG4gICAgICA8Lz59XG4gICAgLz5cblxuICB9IGVsc2Uge1xuICAgIGRiSW5pdGlhbGl6YXRpb25TY3JlZW4gPSA8Tm9uSWRlYWxTdGF0ZVxuICAgICAgaWNvbj1cIndhcm5pbmctc2lnblwiXG4gICAgICB0aXRsZT1cIlJlYWR5XCJcbiAgICAgIGRlc2NyaXB0aW9uPXs8PlxuICAgICAgICA8cD5MYXN0IHN5bmNocm9uaXplZDogTi9BPC9wPlxuICAgICAgICA8QnV0dG9uIG9uQ2xpY2s9e29uRGlzbWlzc30gaW50ZW50PVwicHJpbWFyeVwiPlN5bmNocm9uaXplIGxhdGVyPC9CdXR0b24+XG4gICAgICA8Lz59XG4gICAgLz5cblxuICB9XG4gIHJldHVybiBkYkluaXRpYWxpemF0aW9uU2NyZWVuO1xufTtcblxuXG5jb25zdCBUZWNobmljYWxHaXROb3RpY2U6IFJlYWN0LkZDPHsgY2xvbmVQYXRoOiBzdHJpbmcgfCB1bmRlZmluZWQgfT4gPSBmdW5jdGlvbiAoeyBjbG9uZVBhdGgsIGNoaWxkcmVuIH0pIHtcbiAgZnVuY3Rpb24gb3BlbkxvY2FsQ2xvbmVQYXRoKCkge1xuICAgIGlmIChjbG9uZVBhdGgpIHtcbiAgICAgIGxvZy5kZWJ1ZyhcIlJldmVhbGluZyBsb2NhbCBjbG9uZSBmb2xkZXJcIiwgY2xvbmVQYXRoKTtcbiAgICAgIHNoZWxsLnNob3dJdGVtSW5Gb2xkZXIoY2xvbmVQYXRoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbG9nLmVycm9yKFwiVW5hYmxlIHRvIHJldmVhbCBsb2NhbCBjbG9uZSBmb2xkZXI6IG5vdCBzcGVjaWZpZWQgaW4gYmFja2VuZCBkZXNjcmlwdGlvbi5cIik7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIChcbiAgICA8Q2FsbG91dCB0aXRsZT1cIlRlY2huaWNhbCBpbmZvcm1hdGlvblwiIGljb249XCJjb2dcIlxuICAgICAgICBzdHlsZT17eyB0ZXh0QWxpZ246ICdsZWZ0JywgbWFyZ2luVG9wOiAnMnJlbScsIGZvbnRTaXplOiAnOTAlJyB9fT5cblxuICAgICAge2NoaWxkcmVufVxuXG4gICAgICA8cD5cbiAgICAgICAgSWYgeW91IGhhdmUgR2l0IENMSSBpbnN0YWxsZWQsXG4gICAgICAgIHlvdSBjYW4gYXR0ZW1wdCB0byByZXNvbHZlIHRoaXMgbWFudWFsbHkuXG4gICAgICAgIExvY2FsIGNsb25lIHBhdGgge2Nsb25lUGF0aCA/IDxhIG9uQ2xpY2s9e29wZW5Mb2NhbENsb25lUGF0aH0+KHJldmVhbCk8L2E+IDogbnVsbH06XG4gICAgICAgIHtcIiBcIn1cbiAgICAgICAgPGNvZGU+e2Nsb25lUGF0aCB8fCAnTi9BJ308L2NvZGU+LlxuICAgICAgPC9wPlxuICAgICAgPHA+XG4gICAgICAgIE5vdGUgdGhhdCB0aGUgcmVwb3NpdG9yeSB3YXMgaW5pdGlhbGl6ZWQgYnkgR2l0IGltcGxlbWVudGF0aW9uIGluIE5vZGUsXG4gICAgICAgIHdoaWNoIGlzIGRpZmZlcmVudCB0aGFuIHRoZSBvZmZpY2lhbCBHaXQgQ0xJLCBidXQgbW9zdCBHaXQgQ0xJIGNvbW1hbmRzIHNob3VsZCB3b3JrLlxuICAgICAgPC9wPlxuICAgIDwvQ2FsbG91dD5cbiAgKTtcbn07XG4iXX0=