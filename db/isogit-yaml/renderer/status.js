import React, { useState } from 'react';
import { Button, FormGroup, InputGroup, ButtonGroup, NonIdealState, Spinner, } from '@blueprintjs/core';
import { callIPC, useIPCValue } from '../../../ipc/renderer';
import styles from './status.scss';
const BackendDetails = function ({ dbIPCPrefix, status, description }) {
    const ipcPrefix = dbIPCPrefix;
    const numUncommitted = useIPCValue(`${ipcPrefix}-count-uncommitted`, { numUncommitted: 0 }).
        value.numUncommitted;
    return (React.createElement(ButtonGroup, { fill: true, vertical: true, alignText: "left" },
        React.createElement(Button, { className: styles.sourceInfo, title: `${description.gitUsername}@${description.gitRepo}`, icon: "git-repo", onClick: () => {
                if (description.gitRepo) {
                    require('electron').shell.openExternal(description.gitRepo);
                }
            } },
            description.gitUsername,
            "@",
            description.gitRepo),
        React.createElement(ActionableStatus, { status: status, uncommittedFileCount: numUncommitted, onRequestSync: async () => await callIPC(`${ipcPrefix}-git-trigger-sync`), onShowSettingsWindow: () => callIPC('open-predefined-window', { id: 'settings' }) })));
};
export default BackendDetails;
const ActionableStatus = function ({ status, uncommittedFileCount, onRequestSync, onShowSettingsWindow }) {
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
        action = onRequestSync;
    }
    else if (status.hasLocalChanges && uncommittedFileCount > 0) {
        statusIcon = "git-commit";
        tooltipText = "Sync now";
        statusIntent = undefined;
        action = onRequestSync;
    }
    else if (status.statusRelativeToLocal === 'diverged') {
        statusIcon = "git-branch";
        tooltipText = "Resolve conflict and sync";
        statusIntent = "warning";
        action = onRequestSync;
    }
    else if (status.statusRelativeToLocal === 'behind') {
        statusIcon = "cloud-upload";
        tooltipText = "Sync now";
        statusIntent = "primary";
        action = onRequestSync;
    }
    else {
        statusIcon = "updated";
        tooltipText = "Sync now";
        statusIntent = "primary";
        action = onRequestSync;
    }
    return (React.createElement(Button, { className: styles.backendStatus, onClick: action || (() => { }), icon: statusIcon, intent: statusIntent, disabled: action === null }, tooltipText));
};
export const PasswordPrompt = function ({ dbIPCPrefix, onConfirm }) {
    const [value, setValue] = useState('');
    async function handlePasswordConfirm() {
        await callIPC(`${dbIPCPrefix}-git-set-password`, { password: value });
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
    else if (db.status.needsPassword) {
        dbInitializationScreen = React.createElement(NonIdealState, { icon: "key", title: "Password required", description: React.createElement(PasswordPrompt, { dbIPCPrefix: `db-${dbName}`, onConfirm: () => void 0 }) });
    }
    else if (db.status.isPushing || db.status.isPulling) {
        dbInitializationScreen = React.createElement(NonIdealState, { icon: db.status.isPushing ? "cloud-upload" : "cloud-download", title: "Synchronizing data", description: db.status.isPushing ? "Pushing changes" : "Pulling changes" });
    }
    else if (db.status.lastSynchronized === null && db.status.hasLocalChanges === false) {
        dbInitializationScreen = React.createElement(NonIdealState, { icon: React.createElement(Spinner, null), title: "Synchronizing data" });
    }
    else if (db.status.lastSynchronized !== null) {
        dbInitializationScreen = React.createElement(NonIdealState, { icon: "tick", title: "Ready", description: React.createElement(Button, { onClick: onDismiss, intent: "primary" }, "Dismiss") });
    }
    else {
        dbInitializationScreen = React.createElement(NonIdealState, { icon: "tick", title: "Ready", description: React.createElement(Button, { onClick: onDismiss, intent: "primary" }, "Dismiss") });
    }
    return dbInitializationScreen;
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhdHVzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2RiL2lzb2dpdC15YW1sL3JlbmRlcmVyL3N0YXR1cy50c3giXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxLQUFLLEVBQUUsRUFBRSxRQUFRLEVBQUUsTUFBTSxPQUFPLENBQUM7QUFFeEMsT0FBTyxFQUNMLE1BQU0sRUFBWSxTQUFTLEVBQUUsVUFBVSxFQUN2QyxXQUFXLEVBQUUsYUFBYSxFQUFFLE9BQU8sR0FDcEMsTUFBTSxtQkFBbUIsQ0FBQztBQUUzQixPQUFPLEVBQUUsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLHVCQUF1QixDQUFDO0FBSzdELE9BQU8sTUFBTSxNQUFNLGVBQWUsQ0FBQztBQUduQyxNQUFNLGNBQWMsR0FDcEIsVUFBVSxFQUFFLFdBQVcsRUFBRSxNQUFNLEVBQUUsV0FBVyxFQUFFO0lBQzVDLE1BQU0sU0FBUyxHQUFHLFdBQVcsQ0FBQztJQUU5QixNQUFNLGNBQWMsR0FDbEIsV0FBVyxDQUFDLEdBQUcsU0FBUyxvQkFBb0IsRUFBRSxFQUFFLGNBQWMsRUFBRSxDQUFDLEVBQUUsQ0FBQztRQUNwRSxLQUFLLENBQUMsY0FBYyxDQUFDO0lBRXZCLE9BQU8sQ0FDTCxvQkFBQyxXQUFXLElBQUMsSUFBSSxRQUFDLFFBQVEsUUFBQyxTQUFTLEVBQUMsTUFBTTtRQUN6QyxvQkFBQyxNQUFNLElBQ0gsU0FBUyxFQUFFLE1BQU0sQ0FBQyxVQUFVLEVBQzVCLEtBQUssRUFBRSxHQUFHLFdBQVcsQ0FBQyxXQUFXLElBQUksV0FBVyxDQUFDLE9BQU8sRUFBRSxFQUMxRCxJQUFJLEVBQUMsVUFBVSxFQUNmLE9BQU8sRUFBRSxHQUFHLEVBQUU7Z0JBQ1osSUFBSSxXQUFXLENBQUMsT0FBTyxFQUFFO29CQUN2QixPQUFPLENBQUMsVUFBVSxDQUFDLENBQUMsS0FBSyxDQUFDLFlBQVksQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLENBQUM7aUJB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Q2IsV0FBVyxFQUFFLG9CQUFDLE1BQU0sSUFBQyxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0sRUFBQyxTQUFTLGNBQWlCLEdBQzFFLENBQUE7S0FDSDtJQUVELE9BQU8sc0JBQXNCLENBQUM7QUFDaEMsQ0FBQyxDQUFBIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFJlYWN0LCB7IHVzZVN0YXRlIH0gZnJvbSAncmVhY3QnO1xuXG5pbXBvcnQge1xuICBCdXR0b24sIEljb25OYW1lLCBGb3JtR3JvdXAsIElucHV0R3JvdXAsIEludGVudCxcbiAgQnV0dG9uR3JvdXAsIE5vbklkZWFsU3RhdGUsIFNwaW5uZXIsXG59IGZyb20gJ0BibHVlcHJpbnRqcy9jb3JlJztcblxuaW1wb3J0IHsgY2FsbElQQywgdXNlSVBDVmFsdWUgfSBmcm9tICcuLi8uLi8uLi9pcGMvcmVuZGVyZXInO1xuXG5pbXBvcnQgeyBEYXRhYmFzZVN0YXR1c0NvbXBvbmVudFByb3BzIH0gZnJvbSAnLi4vLi4vLi4vY29uZmlnL3JlbmRlcmVyJztcbmltcG9ydCB7IEJhY2tlbmREZXNjcmlwdGlvbiwgQmFja2VuZFN0YXR1cyB9IGZyb20gJy4uL2Jhc2UnO1xuXG5pbXBvcnQgc3R5bGVzIGZyb20gJy4vc3RhdHVzLnNjc3MnO1xuXG5cbmNvbnN0IEJhY2tlbmREZXRhaWxzOiBSZWFjdC5GQzxEYXRhYmFzZVN0YXR1c0NvbXBvbmVudFByb3BzPEJhY2tlbmREZXNjcmlwdGlvbiwgQmFja2VuZFN0YXR1cz4+ID1cbmZ1bmN0aW9uICh7IGRiSVBDUHJlZml4LCBzdGF0dXMsIGRlc2NyaXB0aW9uIH0pIHtcbiAgY29uc3QgaXBjUHJlZml4ID0gZGJJUENQcmVmaXg7XG5cbiAgY29uc3QgbnVtVW5jb21taXR0ZWQgPSBcbiAgICB1c2VJUENWYWx1ZShgJHtpcGNQcmVmaXh9LWNvdW50LXVuY29tbWl0dGVkYCwgeyBudW1VbmNvbW1pdHRlZDogMCB9KS5cbiAgICB2YWx1ZS5udW1VbmNvbW1pdHRlZDtcblxuICByZXR1cm4gKFxuICAgIDxCdXR0b25Hcm91cCBmaWxsIHZlcnRpY2FsIGFsaWduVGV4dD1cImxlZnRcIj5cbiAgICAgIDxCdXR0b25cbiAgICAgICAgICBjbGFzc05hbWU9e3N0eWxlcy5zb3VyY2VJbmZvfVxuICAgICAgICAgIHRpdGxlPXtgJHtkZXNjcmlwdGlvbi5naXRVc2VybmFtZX1AJHtkZXNjcmlwdGlvbi5naXRSZXBvfWB9XG4gICAgICAgICAgaWNvbj1cImdpdC1yZXBvXCJcbiAgICAgICAgICBvbkNsaWNrPXsoKSA9PiB7XG4gICAgICAgICAgICBpZiAoZGVzY3JpcHRpb24uZ2l0UmVwbykge1xuICAgICAgICAgICAgICByZXF1aXJlKCdlbGVjdHJvbicpLnNoZWxsLm9wZW5FeHRlcm5hbChkZXNjcmlwdGlvbi5naXRSZXBvKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9fT5cbiAgICAgICAge2Rlc2NyaXB0aW9uLmdpdFVzZXJuYW1lfUB7ZGVzY3JpcHRpb24uZ2l0UmVwb31cbiAgICAgIDwvQnV0dG9uPlxuXG4gICAgICA8QWN0aW9uYWJsZVN0YXR1c1xuICAgICAgICBzdGF0dXM9e3N0YXR1c31cbiAgICAgICAgdW5jb21taXR0ZWRGaWxlQ291bnQ9e251bVVuY29tbWl0dGVkfVxuICAgICAgICBvblJlcXVlc3RTeW5jPXthc3luYyAoKSA9PiBhd2FpdCBjYWxsSVBDKGAke2lwY1ByZWZpeH0tZ2l0LXRyaWdnZXItc3luY2ApfVxuICAgICAgICBvblNob3dTZXR0aW5nc1dpbmRvdz17KCkgPT4gY2FsbElQQygnb3Blbi1wcmVkZWZpbmVkLXdpbmRvdycsIHsgaWQ6ICdzZXR0aW5ncycgfSl9XG4gICAgICAvPlxuICAgIDwvQnV0dG9uR3JvdXA+XG4gICk7XG59O1xuXG5leHBvcnQgZGVmYXVsdCBCYWNrZW5kRGV0YWlscztcblxuXG5pbnRlcmZhY2UgQWN0aW9uYWJsZVN0YXR1c1Byb3BzIHtcbiAgc3RhdHVzOiBCYWNrZW5kU3RhdHVzXG4gIHVuY29tbWl0dGVkRmlsZUNvdW50OiBudW1iZXJcbiAgb25SZXF1ZXN0U3luYzogKCkgPT4gUHJvbWlzZTx2b2lkPlxuICBvblNob3dTZXR0aW5nc1dpbmRvdzogKCkgPT4gdm9pZFxufVxuY29uc3QgQWN0aW9uYWJsZVN0YXR1czogUmVhY3QuRkM8QWN0aW9uYWJsZVN0YXR1c1Byb3BzPiA9IGZ1bmN0aW9uICh7XG4gICAgc3RhdHVzLCB1bmNvbW1pdHRlZEZpbGVDb3VudCxcbiAgICBvblJlcXVlc3RTeW5jLFxuICAgIG9uU2hvd1NldHRpbmdzV2luZG93IH0pIHtcblxuICBsZXQgc3RhdHVzSWNvbjogSWNvbk5hbWU7XG4gIGxldCB0b29sdGlwVGV4dDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBsZXQgc3RhdHVzSW50ZW50OiBJbnRlbnQgfCB1bmRlZmluZWQ7XG4gIGxldCBhY3Rpb246IG51bGwgfCAoKCkgPT4gdm9pZCk7XG5cbiAgaWYgKHN0YXR1cy5pc01pc2NvbmZpZ3VyZWQpIHtcbiAgICBzdGF0dXNJY29uID0gXCJlcnJvclwiO1xuICAgIHRvb2x0aXBUZXh0ID0gXCJDb25maWd1cmVcIjtcbiAgICBzdGF0dXNJbnRlbnQgPSBcImRhbmdlclwiO1xuICAgIGFjdGlvbiA9IG9uU2hvd1NldHRpbmdzV2luZG93O1xuXG4gIH0gZWxzZSBpZiAoc3RhdHVzLmlzT25saW5lICE9PSB0cnVlKSB7XG4gICAgc3RhdHVzSWNvbiA9IFwib2ZmbGluZVwiO1xuICAgIHRvb2x0aXBUZXh0ID0gXCJTeW5jIG5vd1wiXG4gICAgc3RhdHVzSW50ZW50ID0gXCJwcmltYXJ5XCI7XG4gICAgYWN0aW9uID0gb25SZXF1ZXN0U3luYztcblxuICB9IGVsc2UgaWYgKHN0YXR1cy5oYXNMb2NhbENoYW5nZXMgJiYgdW5jb21taXR0ZWRGaWxlQ291bnQgPiAwKSB7XG4gICAgc3RhdHVzSWNvbiA9IFwiZ2l0LWNvbW1pdFwiO1xuICAgIHRvb2x0aXBUZXh0ID0gXCJTeW5jIG5vd1wiO1xuICAgIHN0YXR1c0ludGVudCA9IHVuZGVmaW5lZDtcbiAgICBhY3Rpb24gPSBvblJlcXVlc3RTeW5jO1xuXG4gIH0gZWxzZSBpZiAoc3RhdHVzLnN0YXR1c1JlbGF0aXZlVG9Mb2NhbCA9PT0gJ2RpdmVyZ2VkJykge1xuICAgIHN0YXR1c0ljb24gPSBcImdpdC1icmFuY2hcIlxuICAgIHRvb2x0aXBUZXh0ID0gXCJSZXNvbHZlIGNvbmZsaWN0IGFuZCBzeW5jXCI7XG4gICAgc3RhdHVzSW50ZW50ID0gXCJ3YXJuaW5nXCI7XG4gICAgYWN0aW9uID0gb25SZXF1ZXN0U3luYztcblxuICB9IGVsc2UgaWYgKHN0YXR1cy5zdGF0dXNSZWxhdGl2ZVRvTG9jYWwgPT09ICdiZWhpbmQnKSB7XG4gICAgc3RhdHVzSWNvbiA9IFwiY2xvdWQtdXBsb2FkXCJcbiAgICB0b29sdGlwVGV4dCA9IFwiU3luYyBub3dcIjtcbiAgICBzdGF0dXNJbnRlbnQgPSBcInByaW1hcnlcIjtcbiAgICBhY3Rpb24gPSBvblJlcXVlc3RTeW5jO1xuXG4gIH0gZWxzZSB7XG4gICAgc3RhdHVzSWNvbiA9IFwidXBkYXRlZFwiXG4gICAgdG9vbHRpcFRleHQgPSBcIlN5bmMgbm93XCI7XG4gICAgc3RhdHVzSW50ZW50ID0gXCJwcmltYXJ5XCI7XG4gICAgYWN0aW9uID0gb25SZXF1ZXN0U3luYztcbiAgfVxuXG4gIHJldHVybiAoXG4gICAgPEJ1dHRvblxuICAgICAgICBjbGFzc05hbWU9e3N0eWxlcy5iYWNrZW5kU3RhdHVzfVxuICAgICAgICBvbkNsaWNrPXthY3Rpb24gfHwgKCgpID0+IHt9KX1cbiAgICAgICAgaWNvbj17c3RhdHVzSWNvbn1cbiAgICAgICAgaW50ZW50PXtzdGF0dXNJbnRlbnR9XG4gICAgICAgIGRpc2FibGVkPXthY3Rpb24gPT09IG51bGx9PlxuICAgICAge3Rvb2x0aXBUZXh0fVxuICAgIDwvQnV0dG9uPlxuICApO1xufTtcblxuXG5leHBvcnQgY29uc3QgUGFzc3dvcmRQcm9tcHQ6IFJlYWN0LkZDPHsgZGJJUENQcmVmaXg6IHN0cmluZywgb25Db25maXJtOiAoKSA9PiB2b2lkIH0+ID1cbmZ1bmN0aW9uICh7IGRiSVBDUHJlZml4LCBvbkNvbmZpcm0gfSkge1xuICBjb25zdCBbdmFsdWUsIHNldFZhbHVlXSA9IHVzZVN0YXRlKCcnKTtcblxuICBhc3luYyBmdW5jdGlvbiBoYW5kbGVQYXNzd29yZENvbmZpcm0oKSB7XG4gICAgYXdhaXQgY2FsbElQQzx7IHBhc3N3b3JkOiBzdHJpbmcgfSwgeyBzdWNjZXNzOiB0cnVlIH0+KGAke2RiSVBDUHJlZml4fS1naXQtc2V0LXBhc3N3b3JkYCwgeyBwYXNzd29yZDogdmFsdWUgfSk7XG4gICAgb25Db25maXJtKCk7XG4gIH1cblxuICByZXR1cm4gPGRpdiBjbGFzc05hbWU9e3N0eWxlcy5wYXNzd29yZFByb21wdH0+XG4gICAgPEZvcm1Hcm91cFxuICAgICAgICBsYWJlbD1cIlBsZWFzZSBlbnRlciByZXBvc2l0b3J5IHBhc3N3b3JkOlwiXG4gICAgICAgIGhlbHBlclRleHQ9XCJUaGUgcGFzc3dvcmQgd2lsbCBiZSBrZXB0IGluIG1lbW9yeSBhbmQgbm90IHN0b3JlZCB0byBkaXNrLlwiPlxuICAgICAgPElucHV0R3JvdXBcbiAgICAgICAgdHlwZT1cInBhc3N3b3JkXCJcbiAgICAgICAgdmFsdWU9e3ZhbHVlfVxuICAgICAgICBvbkNoYW5nZT17KGV2ZW50OiBSZWFjdC5Gb3JtRXZlbnQ8SFRNTEVsZW1lbnQ+KSA9PiBzZXRWYWx1ZSgoZXZlbnQudGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQpLnZhbHVlKX1cbiAgICAgICAgbGVmdEljb249XCJrZXlcIlxuICAgICAgICByaWdodEVsZW1lbnQ9e1xuICAgICAgICAgIHZhbHVlLnRyaW0oKSA9PT0gJydcbiAgICAgICAgICA/IHVuZGVmaW5lZFxuICAgICAgICAgIDogPEJ1dHRvblxuICAgICAgICAgICAgICAgIG1pbmltYWw9e3RydWV9XG4gICAgICAgICAgICAgICAgb25DbGljaz17aGFuZGxlUGFzc3dvcmRDb25maXJtfVxuICAgICAgICAgICAgICAgIGljb249XCJ0aWNrXCJcbiAgICAgICAgICAgICAgICBpbnRlbnQ9XCJwcmltYXJ5XCI+XG4gICAgICAgICAgICAgIENvbmZpcm1cbiAgICAgICAgICAgIDwvQnV0dG9uPn1cbiAgICAgIC8+XG4gICAgPC9Gb3JtR3JvdXA+XG4gIDwvZGl2Pjtcbn07XG5cblxuaW50ZXJmYWNlIERCU3luY1NjcmVlblByb3BzIHtcbiAgZGJOYW1lOiBzdHJpbmdcbiAgZGI6IEJhY2tlbmREZXNjcmlwdGlvblxuICBvbkRpc21pc3M6ICgpID0+IHZvaWRcbn1cbmV4cG9ydCBjb25zdCBEQlN5bmNTY3JlZW46IFJlYWN0LkZDPERCU3luY1NjcmVlblByb3BzPiA9IGZ1bmN0aW9uICh7IGRiTmFtZSwgZGIsIG9uRGlzbWlzcyB9KSB7XG4gIGxldCBkYkluaXRpYWxpemF0aW9uU2NyZWVuOiBKU1guRWxlbWVudCB8IG51bGw7XG5cbiAgaWYgKGRiPy5zdGF0dXMgPT09IHVuZGVmaW5lZCkge1xuICAgIGRiSW5pdGlhbGl6YXRpb25TY3JlZW4gPSA8Tm9uSWRlYWxTdGF0ZVxuICAgICAgaWNvbj17PFNwaW5uZXIgLz59XG4gICAgICB0aXRsZT1cIkluaXRpYWxpemluZyBkYXRhYmFzZVwiXG4gICAgLz5cblxuICB9IGVsc2UgaWYgKGRiLnN0YXR1cy5uZWVkc1Bhc3N3b3JkKSB7XG4gICAgZGJJbml0aWFsaXphdGlvblNjcmVlbiA9IDxOb25JZGVhbFN0YXRlXG4gICAgICBpY29uPVwia2V5XCJcbiAgICAgIHRpdGxlPVwiUGFzc3dvcmQgcmVxdWlyZWRcIlxuICAgICAgZGVzY3JpcHRpb249ezxQYXNzd29yZFByb21wdCBkYklQQ1ByZWZpeD17YGRiLSR7ZGJOYW1lfWB9IG9uQ29uZmlybT17KCkgPT4gdm9pZCAwfSAvPn1cbiAgICAvPlxuXG4gIH0gZWxzZSBpZiAoZGIuc3RhdHVzLmlzUHVzaGluZyB8fCBkYi5zdGF0dXMuaXNQdWxsaW5nKSB7XG4gICAgZGJJbml0aWFsaXphdGlvblNjcmVlbiA9IDxOb25JZGVhbFN0YXRlXG4gICAgICBpY29uPXtkYi5zdGF0dXMuaXNQdXNoaW5nID8gXCJjbG91ZC11cGxvYWRcIiA6IFwiY2xvdWQtZG93bmxvYWRcIn1cbiAgICAgIHRpdGxlPVwiU3luY2hyb25pemluZyBkYXRhXCJcbiAgICAgIGRlc2NyaXB0aW9uPXtkYi5zdGF0dXMuaXNQdXNoaW5nID8gXCJQdXNoaW5nIGNoYW5nZXNcIiA6IFwiUHVsbGluZyBjaGFuZ2VzXCJ9XG4gICAgLz5cblxuICB9IGVsc2UgaWYgKGRiLnN0YXR1cy5sYXN0U3luY2hyb25pemVkID09PSBudWxsICYmIGRiLnN0YXR1cy5oYXNMb2NhbENoYW5nZXMgPT09IGZhbHNlKSB7XG4gICAgZGJJbml0aWFsaXphdGlvblNjcmVlbiA9IDxOb25JZGVhbFN0YXRlXG4gICAgICBpY29uPXs8U3Bpbm5lciAvPn1cbiAgICAgIHRpdGxlPVwiU3luY2hyb25pemluZyBkYXRhXCJcbiAgICAvPlxuXG4gIH0gZWxzZSBpZiAoZGIuc3RhdHVzLmxhc3RTeW5jaHJvbml6ZWQgIT09IG51bGwpIHtcbiAgICBkYkluaXRpYWxpemF0aW9uU2NyZWVuID0gPE5vbklkZWFsU3RhdGVcbiAgICAgIGljb249XCJ0aWNrXCJcbiAgICAgIHRpdGxlPVwiUmVhZHlcIlxuICAgICAgZGVzY3JpcHRpb249ezxCdXR0b24gb25DbGljaz17b25EaXNtaXNzfSBpbnRlbnQ9XCJwcmltYXJ5XCI+RGlzbWlzczwvQnV0dG9uPn1cbiAgICAvPlxuICB9IGVsc2Uge1xuICAgIGRiSW5pdGlhbGl6YXRpb25TY3JlZW4gPSA8Tm9uSWRlYWxTdGF0ZVxuICAgICAgaWNvbj1cInRpY2tcIlxuICAgICAgdGl0bGU9XCJSZWFkeVwiXG4gICAgICBkZXNjcmlwdGlvbj17PEJ1dHRvbiBvbkNsaWNrPXtvbkRpc21pc3N9IGludGVudD1cInByaW1hcnlcIj5EaXNtaXNzPC9CdXR0b24+fVxuICAgIC8+XG4gIH1cblxuICByZXR1cm4gZGJJbml0aWFsaXphdGlvblNjcmVlbjtcbn0iXX0=