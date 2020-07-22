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
    else if (db.status.lastSynchronized !== null && db.status.isOnline !== true) {
        dbInitializationScreen = React.createElement(NonIdealState, { icon: "offline", title: "Offline", description: React.createElement(React.Fragment, null,
                React.createElement("p", null, "Unable to reach data repository. There may be connection issues."),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhdHVzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2RiL2lzb2dpdC15YW1sL3JlbmRlcmVyL3N0YXR1cy50c3giXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLEtBQUssRUFBRSxNQUFNLFVBQVUsQ0FBQztBQUNqQyxPQUFPLEtBQUssR0FBRyxNQUFNLGNBQWMsQ0FBQztBQUNwQyxPQUFPLEtBQUssRUFBRSxFQUFFLFFBQVEsRUFBRSxNQUFNLE9BQU8sQ0FBQztBQUV4QyxPQUFPLEVBQ0wsTUFBTSxFQUFZLFNBQVMsRUFBRSxVQUFVLEVBQ3ZDLFdBQVcsRUFBRSxhQUFhLEVBQUUsT0FBTyxFQUFFLE9BQU8sR0FDN0MsTUFBTSxtQkFBbUIsQ0FBQztBQUUzQixPQUFPLEVBQUUsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLHVCQUF1QixDQUFDO0FBSzdELE9BQU8sTUFBTSxNQUFNLGVBQWUsQ0FBQztBQUduQyxNQUFNLGNBQWMsR0FDcEIsVUFBVSxFQUFFLFdBQVcsRUFBRSxNQUFNLEVBQUUsV0FBVyxFQUFFO0lBQzVDLE1BQU0sU0FBUyxHQUFHLFdBQVcsQ0FBQztJQUU5QixNQUFNLGNBQWMsR0FDbEIsV0FBVyxDQUFDLEdBQUcsU0FBUyxvQkFBb0IsRUFBRSxFQUFFLGNBQWMsRUFBRSxDQUFDLEVBQUUsQ0FBQztRQUNwRSxLQUFLLENBQUMsY0FBYyxDQUFDO0lBRXZCLDBCQUEwQjtJQUMxQixLQUFLLFVBQVUscUJBQXFCO1FBQ2xDLE1BQU0sT0FBTyxDQUFDLEdBQUcsU0FBUyxtQkFBbUIsQ0FBQyxDQUFDO1FBQy9DLE1BQU0sT0FBTyxDQUFDLEdBQUcsU0FBUyxtQkFBbUIsQ0FBQyxDQUFDO0lBQ2pELENBQUM7SUFFRCxPQUFPLENBQ0wsb0JBQUMsV0FBVyxJQUFDLElBQUksUUFBQyxRQUFRLFFBQUMsU0FBUyxFQUFDLE1BQU07UUFDekMsb0JBQUMsTUFBTSxJQUNILFNBQVMsRUFBRSxNQUFN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QUUsUUFBUSxFQUFFLEtBQUssRUFBRTtRQUVqRSxRQUFRO1FBRVQ7O1lBR29CLFNBQVMsQ0FBQyxDQUFDLENBQUMsMkJBQUcsT0FBTyxFQUFFLGtCQUFrQixlQUFjLENBQUMsQ0FBQyxDQUFDLElBQUk7O1lBQ2hGLEdBQUc7WUFDSixrQ0FBTyxTQUFTLElBQUksS0FBSyxDQUFRO2dCQUMvQjtRQUNKLDhMQUdJLENBQ0ksQ0FDWCxDQUFDO0FBQ0osQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgc2hlbGwgfSBmcm9tICdlbGVjdHJvbic7XG5pbXBvcnQgKiBhcyBsb2cgZnJvbSAnZWxlY3Ryb24tbG9nJztcbmltcG9ydCBSZWFjdCwgeyB1c2VTdGF0ZSB9IGZyb20gJ3JlYWN0JztcblxuaW1wb3J0IHtcbiAgQnV0dG9uLCBJY29uTmFtZSwgRm9ybUdyb3VwLCBJbnB1dEdyb3VwLCBJbnRlbnQsXG4gIEJ1dHRvbkdyb3VwLCBOb25JZGVhbFN0YXRlLCBTcGlubmVyLCBDYWxsb3V0LFxufSBmcm9tICdAYmx1ZXByaW50anMvY29yZSc7XG5cbmltcG9ydCB7IGNhbGxJUEMsIHVzZUlQQ1ZhbHVlIH0gZnJvbSAnLi4vLi4vLi4vaXBjL3JlbmRlcmVyJztcblxuaW1wb3J0IHsgRGF0YWJhc2VTdGF0dXNDb21wb25lbnRQcm9wcyB9IGZyb20gJy4uLy4uLy4uL2NvbmZpZy9yZW5kZXJlcic7XG5pbXBvcnQgeyBCYWNrZW5kRGVzY3JpcHRpb24sIEJhY2tlbmRTdGF0dXMgfSBmcm9tICcuLi9iYXNlJztcblxuaW1wb3J0IHN0eWxlcyBmcm9tICcuL3N0YXR1cy5zY3NzJztcblxuXG5jb25zdCBCYWNrZW5kRGV0YWlsczogUmVhY3QuRkM8RGF0YWJhc2VTdGF0dXNDb21wb25lbnRQcm9wczxCYWNrZW5kRGVzY3JpcHRpb24sIEJhY2tlbmRTdGF0dXM+PiA9XG5mdW5jdGlvbiAoeyBkYklQQ1ByZWZpeCwgc3RhdHVzLCBkZXNjcmlwdGlvbiB9KSB7XG4gIGNvbnN0IGlwY1ByZWZpeCA9IGRiSVBDUHJlZml4O1xuXG4gIGNvbnN0IG51bVVuY29tbWl0dGVkID1cbiAgICB1c2VJUENWYWx1ZShgJHtpcGNQcmVmaXh9LWNvdW50LXVuY29tbWl0dGVkYCwgeyBudW1VbmNvbW1pdHRlZDogMCB9KS5cbiAgICB2YWx1ZS5udW1VbmNvbW1pdHRlZDtcblxuICAvLyBSZXF1ZXN0cyBzeW5jIHdpdGggcHVzaFxuICBhc3luYyBmdW5jdGlvbiBoYW5kbGVSZXF1ZXN0RnVsbFN5bmMoKSB7XG4gICAgYXdhaXQgY2FsbElQQyhgJHtpcGNQcmVmaXh9LWdpdC1yZXF1ZXN0LXB1c2hgKTtcbiAgICBhd2FpdCBjYWxsSVBDKGAke2lwY1ByZWZpeH0tZ2l0LXRyaWdnZXItc3luY2ApO1xuICB9XG5cbiAgcmV0dXJuIChcbiAgICA8QnV0dG9uR3JvdXAgZmlsbCB2ZXJ0aWNhbCBhbGlnblRleHQ9XCJsZWZ0XCI+XG4gICAgICA8QnV0dG9uXG4gICAgICAgICAgY2xhc3NOYW1lPXtzdHlsZXMuc291cmNlSW5mb31cbiAgICAgICAgICB0aXRsZT17YCR7ZGVzY3JpcHRpb24uZ2l0VXNlcm5hbWV9QCR7ZGVzY3JpcHRpb24uZ2l0UmVwb31gfVxuICAgICAgICAgIGljb249XCJnaXQtcmVwb1wiXG4gICAgICAgICAgb25DbGljaz17KCkgPT4ge1xuICAgICAgICAgICAgaWYgKGRlc2NyaXB0aW9uLmdpdFJlcG8pIHtcbiAgICAgICAgICAgICAgcmVxdWlyZSgnZWxlY3Ryb24nKS5zaGVsbC5vcGVuRXh0ZXJuYWwoZGVzY3JpcHRpb24uZ2l0UmVwbyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfX0+XG4gICAgICAgIHtkZXNjcmlwdGlvbi5naXRVc2VybmFtZX1Ae2Rlc2NyaXB0aW9uLmdpdFJlcG99XG4gICAgICA8L0J1dHRvbj5cblxuICAgICAgPEFjdGlvbmFibGVTdGF0dXNcbiAgICAgICAgc3RhdHVzPXtzdGF0dXN9XG4gICAgICAgIHVuY29tbWl0dGVkRmlsZUNvdW50PXtudW1VbmNvbW1pdHRlZH1cbiAgICAgICAgb25SZXF1ZXN0RnVsbFN5bmM9e2hhbmRsZVJlcXVlc3RGdWxsU3luY31cbiAgICAgICAgb25TaG93U2V0dGluZ3NXaW5kb3c9eygpID0+IGNhbGxJUEMoJ29wZW4tcHJlZGVmaW5lZC13aW5kb3cnLCB7IGlkOiAnc2V0dGluZ3MnIH0pfVxuICAgICAgLz5cbiAgICA8L0J1dHRvbkdyb3VwPlxuICApO1xufTtcblxuZXhwb3J0IGRlZmF1bHQgQmFja2VuZERldGFpbHM7XG5cblxuaW50ZXJmYWNlIEFjdGlvbmFibGVTdGF0dXNQcm9wcyB7XG4gIHN0YXR1czogQmFja2VuZFN0YXR1c1xuICB1bmNvbW1pdHRlZEZpbGVDb3VudDogbnVtYmVyXG4gIG9uUmVxdWVzdEZ1bGxTeW5jOiAoKSA9PiBQcm9taXNlPHZvaWQ+XG4gIG9uU2hvd1NldHRpbmdzV2luZG93OiAoKSA9PiB2b2lkXG59XG5jb25zdCBBY3Rpb25hYmxlU3RhdHVzOiBSZWFjdC5GQzxBY3Rpb25hYmxlU3RhdHVzUHJvcHM+ID0gZnVuY3Rpb24gKHtcbiAgICBzdGF0dXMsIHVuY29tbWl0dGVkRmlsZUNvdW50LFxuICAgIG9uUmVxdWVzdEZ1bGxTeW5jLFxuICAgIG9uU2hvd1NldHRpbmdzV2luZG93IH0pIHtcblxuICBsZXQgc3RhdHVzSWNvbjogSWNvbk5hbWU7XG4gIGxldCB0b29sdGlwVGV4dDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBsZXQgc3RhdHVzSW50ZW50OiBJbnRlbnQgfCB1bmRlZmluZWQ7XG4gIGxldCBhY3Rpb246IG51bGwgfCAoKCkgPT4gdm9pZCk7XG5cbiAgaWYgKHN0YXR1cy5pc01pc2NvbmZpZ3VyZWQpIHtcbiAgICBzdGF0dXNJY29uID0gXCJlcnJvclwiO1xuICAgIHRvb2x0aXBUZXh0ID0gXCJDb25maWd1cmVcIjtcbiAgICBzdGF0dXNJbnRlbnQgPSBcImRhbmdlclwiO1xuICAgIGFjdGlvbiA9IG9uU2hvd1NldHRpbmdzV2luZG93O1xuXG4gIH0gZWxzZSBpZiAoc3RhdHVzLmlzT25saW5lICE9PSB0cnVlKSB7XG4gICAgc3RhdHVzSWNvbiA9IFwib2ZmbGluZVwiO1xuICAgIHRvb2x0aXBUZXh0ID0gXCJTeW5jIG5vd1wiXG4gICAgc3RhdHVzSW50ZW50ID0gXCJwcmltYXJ5XCI7XG4gICAgYWN0aW9uID0gb25SZXF1ZXN0RnVsbFN5bmM7XG5cbiAgfSBlbHNlIGlmIChzdGF0dXMuaGFzTG9jYWxDaGFuZ2VzICYmIHVuY29tbWl0dGVkRmlsZUNvdW50ID4gMCkge1xuICAgIHN0YXR1c0ljb24gPSBcImdpdC1jb21taXRcIjtcbiAgICB0b29sdGlwVGV4dCA9IFwiU3luYyBub3dcIjtcbiAgICBzdGF0dXNJbnRlbnQgPSB1bmRlZmluZWQ7XG4gICAgYWN0aW9uID0gb25SZXF1ZXN0RnVsbFN5bmM7XG5cbiAgfSBlbHNlIGlmIChzdGF0dXMuc3RhdHVzUmVsYXRpdmVUb0xvY2FsID09PSAnZGl2ZXJnZWQnKSB7XG4gICAgc3RhdHVzSWNvbiA9IFwiZ2l0LWJyYW5jaFwiXG4gICAgdG9vbHRpcFRleHQgPSBcIlJlc29sdmUgY29uZmxpY3QgYW5kIHN5bmNcIjtcbiAgICBzdGF0dXNJbnRlbnQgPSBcIndhcm5pbmdcIjtcbiAgICBhY3Rpb24gPSBvblJlcXVlc3RGdWxsU3luYztcblxuICB9IGVsc2UgaWYgKHN0YXR1cy5zdGF0dXNSZWxhdGl2ZVRvTG9jYWwgPT09ICdiZWhpbmQnKSB7XG4gICAgc3RhdHVzSWNvbiA9IFwiY2xvdWQtdXBsb2FkXCJcbiAgICB0b29sdGlwVGV4dCA9IFwiU3luYyBub3dcIjtcbiAgICBzdGF0dXNJbnRlbnQgPSBcInByaW1hcnlcIjtcbiAgICBhY3Rpb24gPSBvblJlcXVlc3RGdWxsU3luYztcblxuICB9IGVsc2Uge1xuICAgIHN0YXR1c0ljb24gPSBcInVwZGF0ZWRcIlxuICAgIHRvb2x0aXBUZXh0ID0gXCJTeW5jIG5vd1wiO1xuICAgIHN0YXR1c0ludGVudCA9IFwicHJpbWFyeVwiO1xuICAgIGFjdGlvbiA9IG9uUmVxdWVzdEZ1bGxTeW5jO1xuICB9XG5cbiAgcmV0dXJuIChcbiAgICA8QnV0dG9uXG4gICAgICAgIGNsYXNzTmFtZT17c3R5bGVzLmJhY2tlbmRTdGF0dXN9XG4gICAgICAgIG9uQ2xpY2s9e2FjdGlvbiB8fCAoKCkgPT4ge30pfVxuICAgICAgICBpY29uPXtzdGF0dXNJY29ufVxuICAgICAgICBpbnRlbnQ9e3N0YXR1c0ludGVudH1cbiAgICAgICAgZGlzYWJsZWQ9e2FjdGlvbiA9PT0gbnVsbH0+XG4gICAgICB7dG9vbHRpcFRleHR9XG4gICAgPC9CdXR0b24+XG4gICk7XG59O1xuXG5cbmV4cG9ydCBjb25zdCBQYXNzd29yZFByb21wdDogUmVhY3QuRkM8eyBkYklQQ1ByZWZpeDogc3RyaW5nLCBvbkNvbmZpcm06ICgpID0+IHZvaWQgfT4gPVxuZnVuY3Rpb24gKHsgZGJJUENQcmVmaXgsIG9uQ29uZmlybSB9KSB7XG4gIGNvbnN0IFt2YWx1ZSwgc2V0VmFsdWVdID0gdXNlU3RhdGUoJycpO1xuXG4gIGFzeW5jIGZ1bmN0aW9uIGhhbmRsZVBhc3N3b3JkQ29uZmlybSgpIHtcbiAgICBhd2FpdCBjYWxsSVBDPHsgcGFzc3dvcmQ6IHN0cmluZyB9LCB7IHN1Y2Nlc3M6IHRydWUgfT4oYCR7ZGJJUENQcmVmaXh9LWdpdC1zZXQtcGFzc3dvcmRgLCB7IHBhc3N3b3JkOiB2YWx1ZSB9KTtcbiAgICBhd2FpdCBjYWxsSVBDKGAke2RiSVBDUHJlZml4fS1naXQtdHJpZ2dlci1zeW5jYCk7XG4gICAgb25Db25maXJtKCk7XG4gIH1cblxuICByZXR1cm4gPGRpdiBjbGFzc05hbWU9e3N0eWxlcy5wYXNzd29yZFByb21wdH0+XG4gICAgPEZvcm1Hcm91cFxuICAgICAgICBsYWJlbD1cIlBsZWFzZSBlbnRlciByZXBvc2l0b3J5IHBhc3N3b3JkOlwiXG4gICAgICAgIGhlbHBlclRleHQ9XCJUaGUgcGFzc3dvcmQgd2lsbCBiZSBrZXB0IGluIG1lbW9yeSBhbmQgbm90IHN0b3JlZCB0byBkaXNrLlwiPlxuICAgICAgPElucHV0R3JvdXBcbiAgICAgICAgdHlwZT1cInBhc3N3b3JkXCJcbiAgICAgICAgdmFsdWU9e3ZhbHVlfVxuICAgICAgICBvbkNoYW5nZT17KGV2ZW50OiBSZWFjdC5Gb3JtRXZlbnQ8SFRNTEVsZW1lbnQ+KSA9PiBzZXRWYWx1ZSgoZXZlbnQudGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQpLnZhbHVlKX1cbiAgICAgICAgbGVmdEljb249XCJrZXlcIlxuICAgICAgICByaWdodEVsZW1lbnQ9e1xuICAgICAgICAgIHZhbHVlLnRyaW0oKSA9PT0gJydcbiAgICAgICAgICA/IHVuZGVmaW5lZFxuICAgICAgICAgIDogPEJ1dHRvblxuICAgICAgICAgICAgICAgIG1pbmltYWw9e3RydWV9XG4gICAgICAgICAgICAgICAgb25DbGljaz17aGFuZGxlUGFzc3dvcmRDb25maXJtfVxuICAgICAgICAgICAgICAgIGljb249XCJ0aWNrXCJcbiAgICAgICAgICAgICAgICBpbnRlbnQ9XCJwcmltYXJ5XCI+XG4gICAgICAgICAgICAgIENvbmZpcm1cbiAgICAgICAgICAgIDwvQnV0dG9uPn1cbiAgICAgIC8+XG4gICAgPC9Gb3JtR3JvdXA+XG4gIDwvZGl2Pjtcbn07XG5cblxuaW50ZXJmYWNlIERCU3luY1NjcmVlblByb3BzIHtcbiAgZGJOYW1lOiBzdHJpbmdcbiAgZGI6IEJhY2tlbmREZXNjcmlwdGlvblxuICBvbkRpc21pc3M6ICgpID0+IHZvaWRcbn1cbmV4cG9ydCBjb25zdCBEQlN5bmNTY3JlZW46IFJlYWN0LkZDPERCU3luY1NjcmVlblByb3BzPiA9IGZ1bmN0aW9uICh7IGRiTmFtZSwgZGIsIG9uRGlzbWlzcyB9KSB7XG4gIGxldCBkYkluaXRpYWxpemF0aW9uU2NyZWVuOiBKU1guRWxlbWVudDtcblxuICBpZiAoZGI/LnN0YXR1cyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgZGJJbml0aWFsaXphdGlvblNjcmVlbiA9IDxOb25JZGVhbFN0YXRlXG4gICAgICBpY29uPXs8U3Bpbm5lciAvPn1cbiAgICAgIHRpdGxlPVwiSW5pdGlhbGl6aW5nIGRhdGFiYXNlXCJcbiAgICAvPlxuXG4gIH0gZWxzZSBpZiAoZGIuc3RhdHVzLmxhc3RTeW5jaHJvbml6ZWQgIT09IG51bGwgJiYgZGIuc3RhdHVzLmlzT25saW5lICE9PSB0cnVlKSB7XG4gICAgZGJJbml0aWFsaXphdGlvblNjcmVlbiA9IDxOb25JZGVhbFN0YXRlXG4gICAgICBpY29uPVwib2ZmbGluZVwiXG4gICAgICB0aXRsZT1cIk9mZmxpbmVcIlxuICAgICAgZGVzY3JpcHRpb249ezw+XG4gICAgICAgIDxwPlVuYWJsZSB0byByZWFjaCBkYXRhIHJlcG9zaXRvcnkuIFRoZXJlIG1heSBiZSBjb25uZWN0aW9uIGlzc3Vlcy48L3A+XG4gICAgICAgIDxCdXR0b24gb25DbGljaz17b25EaXNtaXNzfSBpbnRlbnQ9XCJwcmltYXJ5XCI+U3luY2hyb25pemUgbGF0ZXI8L0J1dHRvbj5cbiAgICAgIDwvPn1cbiAgICAvPlxuXG4gIH0gZWxzZSBpZiAoZGIuc3RhdHVzLm5lZWRzUGFzc3dvcmQpIHtcbiAgICBkYkluaXRpYWxpemF0aW9uU2NyZWVuID0gPE5vbklkZWFsU3RhdGVcbiAgICAgIGljb249XCJrZXlcIlxuICAgICAgdGl0bGU9XCJQYXNzd29yZCByZXF1aXJlZFwiXG4gICAgICBkZXNjcmlwdGlvbj17PFBhc3N3b3JkUHJvbXB0IGRiSVBDUHJlZml4PXtgZGItJHtkYk5hbWV9YH0gb25Db25maXJtPXsoKSA9PiB2b2lkIDB9IC8+fVxuICAgIC8+XG5cbiAgfSBlbHNlIGlmIChkYi5zdGF0dXMuaXNQdXNoaW5nIHx8IGRiLnN0YXR1cy5pc1B1bGxpbmcpIHtcbiAgICBkYkluaXRpYWxpemF0aW9uU2NyZWVuID0gPE5vbklkZWFsU3RhdGVcbiAgICAgIGljb249e2RiLnN0YXR1cy5pc1B1c2hpbmcgPyBcImNsb3VkLXVwbG9hZFwiIDogXCJjbG91ZC1kb3dubG9hZFwifVxuICAgICAgdGl0bGU9XCJTeW5jaHJvbml6aW5nIGRhdGFcIlxuICAgICAgZGVzY3JpcHRpb249e2RiLnN0YXR1cy5pc1B1c2hpbmcgPyBcIlNlbmRpbmcgY2hhbmdlc1wiIDogXCJGZXRjaGluZyBjaGFuZ2VzXCJ9XG4gICAgLz5cblxuICB9IGVsc2UgaWYgKGRiLnN0YXR1cy5sYXN0U3luY2hyb25pemVkID09PSBudWxsICYmIGRiLnN0YXR1cy5oYXNMb2NhbENoYW5nZXMgPT09IGZhbHNlKSB7XG4gICAgZGJJbml0aWFsaXphdGlvblNjcmVlbiA9IDxOb25JZGVhbFN0YXRlXG4gICAgICBpY29uPXs8U3Bpbm5lciAvPn1cbiAgICAgIHRpdGxlPVwiQ29ubmVjdGluZ1wiXG4gICAgLz5cblxuICB9IGVsc2UgaWYgKGRiLnN0YXR1cy5zdGF0dXNSZWxhdGl2ZVRvTG9jYWwgPT09ICdkaXZlcmdlZCcpIHtcbiAgICBkYkluaXRpYWxpemF0aW9uU2NyZWVuID0gPE5vbklkZWFsU3RhdGVcbiAgICAgIGljb249XCJ3YXJuaW5nLXNpZ25cIlxuICAgICAgdGl0bGU9XCJEaXZlcmdpbmcgY2hhbmdlcyBmb3VuZFwiXG4gICAgICBkZXNjcmlwdGlvbj17PD5cbiAgICAgICAgPHA+XG4gICAgICAgICAgRmFpbGVkIHRvIGludGVncmF0ZSBsb2NhbCBhbmQgcmVtb3RlIGNoYW5nZXMuXG4gICAgICAgIDwvcD5cbiAgICAgICAgPHA+XG4gICAgICAgICAgVG8gcmVzb2x2ZSwgeW91IG1heSB3YW50IHRvIGNvbnRhY3QgcmVnaXN0cnkgbWFuYWdlciByZXByZXNlbnRhdGl2ZS5cbiAgICAgICAgPC9wPlxuXG4gICAgICAgIDxCdXR0b24gb25DbGljaz17b25EaXNtaXNzfSBpbnRlbnQ9XCJwcmltYXJ5XCI+RGlzbWlzczwvQnV0dG9uPlxuXG4gICAgICAgIDxUZWNobmljYWxHaXROb3RpY2UgY2xvbmVQYXRoPXtkYi5sb2NhbENsb25lUGF0aH0+XG4gICAgICAgICAgPHA+XG4gICAgICAgICAgICBVbmFibGUgdG8gcGVyZm9ybSBHaXQgZmFzdC1mb3J3YXJkIG1lcmdlLlxuICAgICAgICAgICAgSXQgaXMgcG9zc2libGUgdGhhdCB0aGUgc2FtZSBvYmplY3Qgd2FzIG1vZGlmaWVkIGJ5IG11bHRpcGxlIHVzZXJzLlxuICAgICAgICAgIDwvcD5cbiAgICAgICAgICA8cD5cbiAgICAgICAgICAgIE1heSBiZSByZXNvbHZhYmxlIHdpdGggPGNvZGU+Z2l0IHJlYmFzZSBvcmlnaW4vbWFzdGU8L2NvZGU+XG4gICAgICAgICAgICAodXNlIGF0IHlvdXIgcmlzaywgb3IgZ2V0IGluIHRvdWNoIHdpdGggcmVnaXN0cnkgbWFuYWdlcikuXG4gICAgICAgICAgPC9wPlxuICAgICAgICA8L1RlY2huaWNhbEdpdE5vdGljZT5cbiAgICAgIDwvPn1cbiAgICAvPlxuXG4gIH0gZWxzZSBpZiAoZGIuc3RhdHVzLmhhc0xvY2FsQ2hhbmdlcyA9PT0gdHJ1ZSkge1xuICAgIGRiSW5pdGlhbGl6YXRpb25TY3JlZW4gPSA8Tm9uSWRlYWxTdGF0ZVxuICAgICAgaWNvbj1cIndhcm5pbmctc2lnblwiXG4gICAgICB0aXRsZT1cIkNhbm5vdCBzeW5jaHJvbml6ZVwiXG4gICAgICBkZXNjcmlwdGlvbj17PD5cbiAgICAgICAgPHA+VW5jb21taXR0ZWQgY2hhbmdlcyBwcmVzZW50LjwvcD5cblxuICAgICAgICA8QnV0dG9uIG9uQ2xpY2s9e29uRGlzbWlzc30gaW50ZW50PVwicHJpbWFyeVwiPkRpc21pc3M8L0J1dHRvbj5cblxuICAgICAgICA8VGVjaG5pY2FsR2l0Tm90aWNlIGNsb25lUGF0aD17ZGIubG9jYWxDbG9uZVBhdGh9PlxuICAgICAgICAgIDxwPlxuICAgICAgICAgICAgVW5jb21taXR0ZWQgb3IgdW5zdGFnZWQgY2hhbmdlcyBwcmVzZW50IGluIGxvY2FsIGNsb25lLlxuICAgICAgICAgIDwvcD5cbiAgICAgICAgICA8cD5cbiAgICAgICAgICAgIE1heSBiZSByZXNvbHZhYmxlIHdpdGggPGNvZGU+Z2l0IHN0YXR1czwvY29kZT4gYW5kIG1hbnVhbGx5IGRpc2NhcmRpbmcvc3RhZ2luZy9jb21taXR0aW5nIHRoZSBjaGFuZ2VzXG4gICAgICAgICAgICAodXNlIGF0IHlvdXIgcmlzaywgb3IgZ2V0IGluIHRvdWNoIHdpdGggcmVnaXN0cnkgbWFuYWdlcikuXG4gICAgICAgICAgPC9wPlxuICAgICAgICA8L1RlY2huaWNhbEdpdE5vdGljZT5cbiAgICAgIDwvPn1cbiAgICAvPlxuXG4gIH0gZWxzZSBpZiAoZGIuc3RhdHVzLmxhc3RTeW5jaHJvbml6ZWQgIT09IG51bGwpIHtcbiAgICBkYkluaXRpYWxpemF0aW9uU2NyZWVuID0gPE5vbklkZWFsU3RhdGVcbiAgICAgIGljb249XCJ0aWNrXCJcbiAgICAgIHRpdGxlPVwiUmVhZHlcIlxuICAgICAgZGVzY3JpcHRpb249ezw+XG4gICAgICAgIDxwPkxhc3Qgc3luY2hyb25pemVkOiB7ZGIuc3RhdHVzLmxhc3RTeW5jaHJvbml6ZWQudG9JU09TdHJpbmcoKX08L3A+XG4gICAgICAgIDxCdXR0b24gb25DbGljaz17b25EaXNtaXNzfSBpbnRlbnQ9XCJwcmltYXJ5XCI+RGlzbWlzczwvQnV0dG9uPlxuICAgICAgPC8+fVxuICAgIC8+XG5cbiAgfSBlbHNlIHtcbiAgICBkYkluaXRpYWxpemF0aW9uU2NyZWVuID0gPE5vbklkZWFsU3RhdGVcbiAgICAgIGljb249XCJ3YXJuaW5nLXNpZ25cIlxuICAgICAgdGl0bGU9XCJSZWFkeVwiXG4gICAgICBkZXNjcmlwdGlvbj17PD5cbiAgICAgICAgPHA+TGFzdCBzeW5jaHJvbml6ZWQ6IE4vQTwvcD5cbiAgICAgICAgPEJ1dHRvbiBvbkNsaWNrPXtvbkRpc21pc3N9IGludGVudD1cInByaW1hcnlcIj5TeW5jaHJvbml6ZSBsYXRlcjwvQnV0dG9uPlxuICAgICAgPC8+fVxuICAgIC8+XG5cbiAgfVxuICByZXR1cm4gZGJJbml0aWFsaXphdGlvblNjcmVlbjtcbn07XG5cblxuY29uc3QgVGVjaG5pY2FsR2l0Tm90aWNlOiBSZWFjdC5GQzx7IGNsb25lUGF0aDogc3RyaW5nIHwgdW5kZWZpbmVkIH0+ID0gZnVuY3Rpb24gKHsgY2xvbmVQYXRoLCBjaGlsZHJlbiB9KSB7XG4gIGZ1bmN0aW9uIG9wZW5Mb2NhbENsb25lUGF0aCgpIHtcbiAgICBpZiAoY2xvbmVQYXRoKSB7XG4gICAgICBsb2cuZGVidWcoXCJSZXZlYWxpbmcgbG9jYWwgY2xvbmUgZm9sZGVyXCIsIGNsb25lUGF0aCk7XG4gICAgICBzaGVsbC5zaG93SXRlbUluRm9sZGVyKGNsb25lUGF0aCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGxvZy5lcnJvcihcIlVuYWJsZSB0byByZXZlYWwgbG9jYWwgY2xvbmUgZm9sZGVyOiBub3Qgc3BlY2lmaWVkIGluIGJhY2tlbmQgZGVzY3JpcHRpb24uXCIpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiAoXG4gICAgPENhbGxvdXQgdGl0bGU9XCJUZWNobmljYWwgaW5mb3JtYXRpb25cIiBpY29uPVwiY29nXCJcbiAgICAgICAgc3R5bGU9e3sgdGV4dEFsaWduOiAnbGVmdCcsIG1hcmdpblRvcDogJzJyZW0nLCBmb250U2l6ZTogJzkwJScgfX0+XG5cbiAgICAgIHtjaGlsZHJlbn1cblxuICAgICAgPHA+XG4gICAgICAgIElmIHlvdSBoYXZlIEdpdCBDTEkgaW5zdGFsbGVkLFxuICAgICAgICB5b3UgY2FuIGF0dGVtcHQgdG8gcmVzb2x2ZSB0aGlzIG1hbnVhbGx5LlxuICAgICAgICBMb2NhbCBjbG9uZSBwYXRoIHtjbG9uZVBhdGggPyA8YSBvbkNsaWNrPXtvcGVuTG9jYWxDbG9uZVBhdGh9PihyZXZlYWwpPC9hPiA6IG51bGx9OlxuICAgICAgICB7XCIgXCJ9XG4gICAgICAgIDxjb2RlPntjbG9uZVBhdGggfHwgJ04vQSd9PC9jb2RlPi5cbiAgICAgIDwvcD5cbiAgICAgIDxwPlxuICAgICAgICBOb3RlIHRoYXQgdGhlIHJlcG9zaXRvcnkgd2FzIGluaXRpYWxpemVkIGJ5IEdpdCBpbXBsZW1lbnRhdGlvbiBpbiBOb2RlLFxuICAgICAgICB3aGljaCBpcyBkaWZmZXJlbnQgdGhhbiB0aGUgb2ZmaWNpYWwgR2l0IENMSSwgYnV0IG1vc3QgR2l0IENMSSBjb21tYW5kcyBzaG91bGQgd29yay5cbiAgICAgIDwvcD5cbiAgICA8L0NhbGxvdXQ+XG4gICk7XG59O1xuIl19