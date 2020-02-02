import React from 'react';
import { useEffect, useState } from 'react';

import { Button, Label, Tabs, Tab, InputGroup } from '@blueprintjs/core';
import { WindowComponentProps } from '../config/renderer';

import { Pane, Setting } from '../settings/main';
import { useIPCValue, useIPCRequest } from '../ipc/renderer';


interface SettingHook<T> {
  value: T
  remoteValue: T
  commit: () => Promise<void>
  set: (value: T) => void
  changed: () => boolean
}

export function useSetting<T>(name: string, initialValue: T): SettingHook<T> {
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
    await useIPCRequest('commitSetting', { name, value: localValue });
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
    // Saves local value in storage
  };
}


const SettingsScreen: React.FC<WindowComponentProps> = function ({ query }) {
  const panes = useIPCValue('settingPaneList', { panes: [] as Pane[] }).
    value.panes;
  const settings = useIPCValue('settingList', { settings: [] as Setting<any>[] }).
    value.settings;

  // Determine whether user was requested to supply specific settings
  let requiredSettingIDs: string[];
  const maybeRequiredSettings = query.get('requiredSettings')
  if (maybeRequiredSettings) {
    requiredSettingIDs = maybeRequiredSettings.split(',');
  } else {
    requiredSettingIDs = [];
  }

  let settingWidgetGroup: JSX.Element;

  if (requiredSettingIDs.length > 0) {
    settingWidgetGroup = (
      <SettingInputList
        settings={settings.filter(s => requiredSettingIDs.indexOf(s.id) >= 0)}
      />
    );

  } else {
    settingWidgetGroup = (
      <Tabs>
        {panes.map(pane => (
          <Tab
            key={pane.id}
            id={pane.id}
            title={pane.label}
            panel={<SettingInputList settings={settings.filter(s => s.paneID === pane.id)} />}
          />
        ))}
      </Tabs>
    );
  }

  return <div>{settingWidgetGroup}</div>;
};


const SettingInputList: React.FC<{ settings: Setting<any>[] }> = function ({ settings }) {
  const ipcSettings = settings.map((setting) => useSetting<string>(setting.id, ''));
  const hasChangedSettings = ipcSettings.map((setting) => setting.changed()).indexOf(true) >= 0;
  function commitAll() {
    for (const setting of ipcSettings) {
      setting.commit();
    }
  }
  return (
    <>
      {[...ipcSettings.entries()].map(([idx, s]: [number, SettingHook<any>]) =>
        <SettingInput label={settings[idx].label} ipcSetting={s} key={idx} />)}
      {hasChangedSettings
        ? <Button onClick={commitAll}>Save all</Button>
        : null}
    </>
  );
};


const SettingInput: React.FC<{ label: string, ipcSetting: SettingHook<any> }> = function ({ label, ipcSetting }) {
  return (
    <Label>
      {label}

      <InputGroup
        value={ipcSetting.value}
        type="text"
        rightElement={
          <Button
            disabled={!ipcSetting.changed}
            onClick={ipcSetting.commit}
            title="Save setting"
            icon="tick" />
        }
        onChange={(evt: React.FormEvent<HTMLElement>) => {
          ipcSetting.set((evt.target as HTMLInputElement).value as string);
        }} />
    </Label>
  );
};


export default SettingsScreen;