import React from 'react';
import { useEffect, useState } from 'react';
import { remote } from 'electron';
import { Button, Tabs, Tab, InputGroup, FormGroup } from '@blueprintjs/core';
import { useIPCValue, callIPC } from '../ipc/renderer';
import styles from './styles.scss';
export function useSetting(name, initialValue) {
    // TODO: Make setting manager send IPC event to renderer when value changed;
    // listen to that event here and relay new value so that widgets are updated.
    // Important if multiple widgets depending on the same setting
    // are shown simultaneously.
    const [localValue, setLocalValue] = useState(initialValue);
    const ipcValue = useIPCValue('settingValue', initialValue, { name });
    useEffect(() => {
        setLocalValue(ipcValue.value);
    }, [ipcValue.value]);
    async function commit() {
        await callIPC('commitSetting', { name, value: localValue });
        ipcValue.refresh();
    }
    return {
        value: localValue,
        // Setting value shown in the widget
        remoteValue: ipcValue.value,
        // Setting value in storage
        changed: () => localValue !== ipcValue.value,
        // True if user manipulated widget’s local value
        // and the result is different from value in storage
        set: setLocalValue,
        // Updates local value
        commit: commit,
    };
}
const SettingsScreen = function ({ query }) {
    const panes = useIPCValue('settingPaneList', { panes: [] }).
        value.panes;
    const settings = useIPCValue('settingList', { settings: [] }).
        value.settings;
    const [selectedTabID, selectTabID] = useState(undefined);
    useEffect(() => {
        if (panes.length > 0 && selectedTabID === undefined) {
            selectTabID(panes[0].id);
        }
    }, [panes.length]);
    // Determine whether user was requested to supply specific settings
    let requiredSettingIDs;
    const maybeRequiredSettings = query.get('requiredSettings');
    if (maybeRequiredSettings) {
        requiredSettingIDs = maybeRequiredSettings.split(',');
    }
    else {
        requiredSettingIDs = [];
    }
    let settingWidgetGroup;
    if (requiredSettingIDs.length > 0) {
        settingWidgetGroup = (React.createElement(SettingInputList, { settings: settings.filter(s => requiredSettingIDs.indexOf(s.id) >= 0) }));
    }
    else {
        settingWidgetGroup = (React.createElement(Tabs, { vertical: true, className: styles.tabs, selectedTabId: selectedTabID, onChange: (newTabID) => selectTabID(`${newTabID}`) }, panes.map(pane => (React.createElement(Tab, { key: pane.id, id: `${pane.id}`, title: pane.label, panel: React.createElement(SettingInputList, { settings: settings.filter(s => s.paneID === pane.id) }) })))));
    }
    return React.createElement("div", { className: styles.base }, settingWidgetGroup);
};
const SettingInputList = function ({ settings }) {
    const ipcSettings = settings.map((setting) => useSetting(setting.id, ''));
    const hasChangedSettings = ipcSettings.map((setting) => setting.changed()).indexOf(true) >= 0;
    async function commitAllAndClose() {
        for (const setting of ipcSettings) {
            await setting.commit();
        }
        remote.getCurrentWindow().close();
    }
    return (React.createElement(React.Fragment, null,
        [...ipcSettings.entries()].map(([idx, s]) => React.createElement(SettingInput, { label: settings[idx].label, helpText: settings[idx].helpText, ipcSetting: s, key: idx })),
        hasChangedSettings
            ? React.createElement(Button, { large: true, intent: "primary", onClick: commitAllAndClose }, "Save all and close")
            : null));
};
const SettingInput = function ({ label, ipcSetting, helpText }) {
    return (React.createElement(FormGroup, { label: label, labelFor: "input", helperText: helpText },
        React.createElement(InputGroup, { id: "input", large: true, type: "text", value: ipcSetting.value, onChange: (evt) => {
                ipcSetting.set(evt.target.value);
            } })));
};
export default SettingsScreen;
//# sourceMappingURL=renderer.js.map