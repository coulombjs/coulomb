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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVuZGVyZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvc2V0dGluZ3MvcmVuZGVyZXIudHN4Il0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sS0FBSyxNQUFNLE9BQU8sQ0FBQztBQUMxQixPQUFPLEVBQUUsU0FBUyxFQUFFLFFBQVEsRUFBRSxNQUFNLE9BQU8sQ0FBQztBQUM1QyxPQUFPLEVBQUUsTUFBTSxFQUFFLE1BQU0sVUFBVSxDQUFDO0FBRWxDLE9BQU8sRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLEdBQUcsRUFBRSxVQUFVLEVBQUUsU0FBUyxFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFJN0UsT0FBTyxFQUFFLFdBQVcsRUFBRSxPQUFPLEVBQUUsTUFBTSxpQkFBaUIsQ0FBQztBQUV2RCxPQUFPLE1BQU0sTUFBTSxlQUFlLENBQUM7QUFXbkMsTUFBTSxVQUFVLFVBQVUsQ0FBSSxJQUFZLEVBQUUsWUFBZTtJQUN6RCw0RUFBNEU7SUFDNUUsNkVBQTZFO0lBQzdFLDhEQUE4RDtJQUM5RCw0QkFBNEI7SUFFNUIsTUFBTSxDQUFDLFVBQVUsRUFBRSxhQUFhLENBQUMsR0FBRyxRQUFRLENBQUMsWUFBWSxDQUFDLENBQUM7SUFFM0QsTUFBTSxRQUFRLEdBQUcsV0FBVyxDQUFDLGNBQWMsRUFBRSxZQUFZLEVBQUUsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBRXJFLFNBQVMsQ0FBQyxHQUFHLEVBQUU7UUFDYixhQUFhLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ2hDLENBQUMsRUFBRSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBRXJCLEtBQUssVUFBVSxNQUFNO1FBQ25CLE1BQU0sT0FBTyxDQUFDLGVBQWUsRUFBRSxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsVUFBVSxFQUFFLENBQUMsQ0FBQztRQUM1RCxRQUFRLENBQUMsT0FBTyxFQUFFLENBQUM7SUFDckIsQ0FBQztJ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QVEsRUFBRTtJQUMxRixPQUFPLENBQ0wsb0JBQUMsU0FBUyxJQUFDLEtBQUssRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFDLE9BQU8sRUFBQyxVQUFVLEVBQUUsUUFBUTtRQUM1RCxvQkFBQyxVQUFVLElBQ1QsRUFBRSxFQUFDLE9BQU8sRUFDVixLQUFLLFFBQ0wsSUFBSSxFQUFDLE1BQU0sRUFDWCxLQUFLLEVBQUUsVUFBVSxDQUFDLEtBQUssRUFDdkIsUUFBUSxFQUFFLENBQUMsR0FBaUMsRUFBRSxFQUFFO2dCQUM5QyxVQUFVLENBQUMsR0FBRyxDQUFFLEdBQUcsQ0FBQyxNQUEyQixDQUFDLEtBQWUsQ0FBQyxDQUFDO1lBQ25FLENBQUMsR0FDRCxDQUNRLENBQ2IsQ0FBQztBQUNKLENBQUMsQ0FBQztBQUdGLGVBQWUsY0FBYyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFJlYWN0IGZyb20gJ3JlYWN0JztcbmltcG9ydCB7IHVzZUVmZmVjdCwgdXNlU3RhdGUgfSBmcm9tICdyZWFjdCc7XG5pbXBvcnQgeyByZW1vdGUgfSBmcm9tICdlbGVjdHJvbic7XG5cbmltcG9ydCB7IEJ1dHRvbiwgVGFicywgVGFiLCBJbnB1dEdyb3VwLCBGb3JtR3JvdXAgfSBmcm9tICdAYmx1ZXByaW50anMvY29yZSc7XG5pbXBvcnQgeyBXaW5kb3dDb21wb25lbnRQcm9wcyB9IGZyb20gJy4uL2NvbmZpZy9yZW5kZXJlcic7XG5cbmltcG9ydCB7IFBhbmUsIFNldHRpbmcgfSBmcm9tICcuLi9zZXR0aW5ncy9tYWluJztcbmltcG9ydCB7IHVzZUlQQ1ZhbHVlLCBjYWxsSVBDIH0gZnJvbSAnLi4vaXBjL3JlbmRlcmVyJztcblxuaW1wb3J0IHN0eWxlcyBmcm9tICcuL3N0eWxlcy5zY3NzJztcblxuXG5pbnRlcmZhY2UgU2V0dGluZ0hvb2s8VD4ge1xuICB2YWx1ZTogVFxuICByZW1vdGVWYWx1ZTogVFxuICBjb21taXQ6ICgpID0+IFByb21pc2U8dm9pZD5cbiAgc2V0OiAodmFsdWU6IFQpID0+IHZvaWRcbiAgY2hhbmdlZDogKCkgPT4gYm9vbGVhblxufVxuXG5leHBvcnQgZnVuY3Rpb24gdXNlU2V0dGluZzxUPihuYW1lOiBzdHJpbmcsIGluaXRpYWxWYWx1ZTogVCk6IFNldHRpbmdIb29rPFQ+IHtcbiAgLy8gVE9ETzogTWFrZSBzZXR0aW5nIG1hbmFnZXIgc2VuZCBJUEMgZXZlbnQgdG8gcmVuZGVyZXIgd2hlbiB2YWx1ZSBjaGFuZ2VkO1xuICAvLyBsaXN0ZW4gdG8gdGhhdCBldmVudCBoZXJlIGFuZCByZWxheSBuZXcgdmFsdWUgc28gdGhhdCB3aWRnZXRzIGFyZSB1cGRhdGVkLlxuICAvLyBJbXBvcnRhbnQgaWYgbXVsdGlwbGUgd2lkZ2V0cyBkZXBlbmRpbmcgb24gdGhlIHNhbWUgc2V0dGluZ1xuICAvLyBhcmUgc2hvd24gc2ltdWx0YW5lb3VzbHkuXG5cbiAgY29uc3QgW2xvY2FsVmFsdWUsIHNldExvY2FsVmFsdWVdID0gdXNlU3RhdGUoaW5pdGlhbFZhbHVlKTtcblxuICBjb25zdCBpcGNWYWx1ZSA9IHVzZUlQQ1ZhbHVlKCdzZXR0aW5nVmFsdWUnLCBpbml0aWFsVmFsdWUsIHsgbmFtZSB9KTtcblxuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIHNldExvY2FsVmFsdWUoaXBjVmFsdWUudmFsdWUpO1xuICB9LCBbaXBjVmFsdWUudmFsdWVdKTtcblxuICBhc3luYyBmdW5jdGlvbiBjb21taXQoKSB7XG4gICAgYXdhaXQgY2FsbElQQygnY29tbWl0U2V0dGluZycsIHsgbmFtZSwgdmFsdWU6IGxvY2FsVmFsdWUgfSk7XG4gICAgaXBjVmFsdWUucmVmcmVzaCgpO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICB2YWx1ZTogbG9jYWxWYWx1ZSxcbiAgICAvLyBTZXR0aW5nIHZhbHVlIHNob3duIGluIHRoZSB3aWRnZXRcblxuICAgIHJlbW90ZVZhbHVlOiBpcGNWYWx1ZS52YWx1ZSxcbiAgICAvLyBTZXR0aW5nIHZhbHVlIGluIHN0b3JhZ2VcblxuICAgIGNoYW5nZWQ6ICgpID0+IGxvY2FsVmFsdWUgIT09IGlwY1ZhbHVlLnZhbHVlLFxuICAgIC8vIFRydWUgaWYgdXNlciBtYW5pcHVsYXRlZCB3aWRnZXTigJlzIGxvY2FsIHZhbHVlXG4gICAgLy8gYW5kIHRoZSByZXN1bHQgaXMgZGlmZmVyZW50IGZyb20gdmFsdWUgaW4gc3RvcmFnZVxuXG4gICAgc2V0OiBzZXRMb2NhbFZhbHVlLFxuICAgIC8vIFVwZGF0ZXMgbG9jYWwgdmFsdWVcblxuICAgIGNvbW1pdDogY29tbWl0LFxuICAgIC8vIFNhdmVzIGxvY2FsIHZhbHVlIGluIHN0b3JhZ2VcbiAgfTtcbn1cblxuXG5jb25zdCBTZXR0aW5nc1NjcmVlbjogUmVhY3QuRkM8V2luZG93Q29tcG9uZW50UHJvcHM+ID0gZnVuY3Rpb24gKHsgcXVlcnkgfSkge1xuICBjb25zdCBwYW5lcyA9IHVzZUlQQ1ZhbHVlKCdzZXR0aW5nUGFuZUxpc3QnLCB7IHBhbmVzOiBbXSBhcyBQYW5lW10gfSkuXG4gICAgdmFsdWUucGFuZXM7XG4gIGNvbnN0IHNldHRpbmdzID0gdXNlSVBDVmFsdWUoJ3NldHRpbmdMaXN0JywgeyBzZXR0aW5nczogW10gYXMgU2V0dGluZzxhbnk+W10gfSkuXG4gICAgdmFsdWUuc2V0dGluZ3M7XG5cbiAgY29uc3QgW3NlbGVjdGVkVGFiSUQsIHNlbGVjdFRhYklEXSA9IHVzZVN0YXRlPFBhbmVbXCJpZFwiXSB8IHVuZGVmaW5lZD4odW5kZWZpbmVkKTtcblxuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIGlmIChwYW5lcy5sZW5ndGggPiAwICYmIHNlbGVjdGVkVGFiSUQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgc2VsZWN0VGFiSUQocGFuZXNbMF0uaWQpO1xuICAgIH1cbiAgfSwgW3BhbmVzLmxlbmd0aF0pO1xuXG4gIC8vIERldGVybWluZSB3aGV0aGVyIHVzZXIgd2FzIHJlcXVlc3RlZCB0byBzdXBwbHkgc3BlY2lmaWMgc2V0dGluZ3NcbiAgbGV0IHJlcXVpcmVkU2V0dGluZ0lEczogc3RyaW5nW107XG4gIGNvbnN0IG1heWJlUmVxdWlyZWRTZXR0aW5ncyA9IHF1ZXJ5LmdldCgncmVxdWlyZWRTZXR0aW5ncycpXG4gIGlmIChtYXliZVJlcXVpcmVkU2V0dGluZ3MpIHtcbiAgICByZXF1aXJlZFNldHRpbmdJRHMgPSBtYXliZVJlcXVpcmVkU2V0dGluZ3Muc3BsaXQoJywnKTtcbiAgfSBlbHNlIHtcbiAgICByZXF1aXJlZFNldHRpbmdJRHMgPSBbXTtcbiAgfVxuXG4gIGxldCBzZXR0aW5nV2lkZ2V0R3JvdXA6IEpTWC5FbGVtZW50O1xuXG4gIGlmIChyZXF1aXJlZFNldHRpbmdJRHMubGVuZ3RoID4gMCkge1xuICAgIHNldHRpbmdXaWRnZXRHcm91cCA9IChcbiAgICAgIDxTZXR0aW5nSW5wdXRMaXN0XG4gICAgICAgIHNldHRpbmdzPXtzZXR0aW5ncy5maWx0ZXIocyA9PiByZXF1aXJlZFNldHRpbmdJRHMuaW5kZXhPZihzLmlkKSA+PSAwKX1cbiAgICAgIC8+XG4gICAgKTtcblxuICB9IGVsc2Uge1xuICAgIHNldHRpbmdXaWRnZXRHcm91cCA9IChcbiAgICAgIDxUYWJzXG4gICAgICAgICAgdmVydGljYWxcbiAgICAgICAgICBjbGFzc05hbWU9e3N0eWxlcy50YWJzfVxuICAgICAgICAgIHNlbGVjdGVkVGFiSWQ9e3NlbGVjdGVkVGFiSUR9XG4gICAgICAgICAgb25DaGFuZ2U9eyhuZXdUYWJJRCkgPT4gc2VsZWN0VGFiSUQoYCR7bmV3VGFiSUR9YCl9PlxuICAgICAgICB7cGFuZXMubWFwKHBhbmUgPT4gKFxuICAgICAgICAgIDxUYWJcbiAgICAgICAgICAgIGtleT17cGFuZS5pZH1cbiAgICAgICAgICAgIGlkPXtgJHtwYW5lLmlkfWB9XG4gICAgICAgICAgICB0aXRsZT17cGFuZS5sYWJlbH1cbiAgICAgICAgICAgIHBhbmVsPXs8U2V0dGluZ0lucHV0TGlzdCBzZXR0aW5ncz17c2V0dGluZ3MuZmlsdGVyKHMgPT4gcy5wYW5lSUQgPT09IHBhbmUuaWQpfSAvPn1cbiAgICAgICAgICAvPlxuICAgICAgICApKX1cbiAgICAgIDwvVGFicz5cbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIDxkaXYgY2xhc3NOYW1lPXtzdHlsZXMuYmFzZX0+e3NldHRpbmdXaWRnZXRHcm91cH08L2Rpdj47XG59O1xuXG5cbmNvbnN0IFNldHRpbmdJbnB1dExpc3Q6IFJlYWN0LkZDPHsgc2V0dGluZ3M6IFNldHRpbmc8YW55PltdIH0+ID0gZnVuY3Rpb24gKHsgc2V0dGluZ3MgfSkge1xuICBjb25zdCBpcGNTZXR0aW5ncyA9IHNldHRpbmdzLm1hcCgoc2V0dGluZykgPT4gdXNlU2V0dGluZzxzdHJpbmc+KHNldHRpbmcuaWQsICcnKSk7XG4gIGNvbnN0IGhhc0NoYW5nZWRTZXR0aW5ncyA9IGlwY1NldHRpbmdzLm1hcCgoc2V0dGluZykgPT4gc2V0dGluZy5jaGFuZ2VkKCkpLmluZGV4T2YodHJ1ZSkgPj0gMDtcblxuICBhc3luYyBmdW5jdGlvbiBjb21taXRBbGxBbmRDbG9zZSgpIHtcbiAgICBmb3IgKGNvbnN0IHNldHRpbmcgb2YgaXBjU2V0dGluZ3MpIHtcbiAgICAgIGF3YWl0IHNldHRpbmcuY29tbWl0KCk7XG4gICAgfVxuICAgIHJlbW90ZS5nZXRDdXJyZW50V2luZG93KCkuY2xvc2UoKTtcbiAgfVxuXG4gIHJldHVybiAoXG4gICAgPD5cbiAgICAgIHtbLi4uaXBjU2V0dGluZ3MuZW50cmllcygpXS5tYXAoKFtpZHgsIHNdOiBbbnVtYmVyLCBTZXR0aW5nSG9vazxhbnk+XSkgPT5cbiAgICAgICAgPFNldHRpbmdJbnB1dFxuICAgICAgICAgIGxhYmVsPXtzZXR0aW5nc1tpZHhdLmxhYmVsfVxuICAgICAgICAgIGhlbHBUZXh0PXtzZXR0aW5nc1tpZHhdLmhlbHBUZXh0fVxuICAgICAgICAgIGlwY1NldHRpbmc9e3N9XG4gICAgICAgICAga2V5PXtpZHh9XG4gICAgICAgIC8+KX1cbiAgICAgIHtoYXNDaGFuZ2VkU2V0dGluZ3NcbiAgICAgICAgPyA8QnV0dG9uIGxhcmdlIGludGVudD1cInByaW1hcnlcIiBvbkNsaWNrPXtjb21taXRBbGxBbmRDbG9zZX0+U2F2ZSBhbGwgYW5kIGNsb3NlPC9CdXR0b24+XG4gICAgICAgIDogbnVsbH1cbiAgICA8Lz5cbiAgKTtcbn07XG5cblxuaW50ZXJmYWNlIFNldHRpbmdzSW5wdXRQcm9wcyB7XG4gIGxhYmVsOiBzdHJpbmdcbiAgaXBjU2V0dGluZzogU2V0dGluZ0hvb2s8YW55PiBcbiAgaGVscFRleHQ/OiBzdHJpbmdcbn1cbmNvbnN0IFNldHRpbmdJbnB1dDogUmVhY3QuRkM8U2V0dGluZ3NJbnB1dFByb3BzPiA9IGZ1bmN0aW9uICh7IGxhYmVsLCBpcGNTZXR0aW5nLCBoZWxwVGV4dCB9KSB7XG4gIHJldHVybiAoXG4gICAgPEZvcm1Hcm91cCBsYWJlbD17bGFiZWx9IGxhYmVsRm9yPVwiaW5wdXRcIiBoZWxwZXJUZXh0PXtoZWxwVGV4dH0+XG4gICAgICA8SW5wdXRHcm91cFxuICAgICAgICBpZD1cImlucHV0XCJcbiAgICAgICAgbGFyZ2VcbiAgICAgICAgdHlwZT1cInRleHRcIlxuICAgICAgICB2YWx1ZT17aXBjU2V0dGluZy52YWx1ZX1cbiAgICAgICAgb25DaGFuZ2U9eyhldnQ6IFJlYWN0LkZvcm1FdmVudDxIVE1MRWxlbWVudD4pID0+IHtcbiAgICAgICAgICBpcGNTZXR0aW5nLnNldCgoZXZ0LnRhcmdldCBhcyBIVE1MSW5wdXRFbGVtZW50KS52YWx1ZSBhcyBzdHJpbmcpO1xuICAgICAgICB9fVxuICAgICAgLz5cbiAgICA8L0Zvcm1Hcm91cD5cbiAgKTtcbn07XG5cblxuZXhwb3J0IGRlZmF1bHQgU2V0dGluZ3NTY3JlZW47Il19