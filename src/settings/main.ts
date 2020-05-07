import * as path from 'path';
import * as fs from 'fs-extra';
import * as log from 'electron-log';

import { ipcMain } from 'electron';
import { listen } from '../ipc/main';

import { default as YAMLWrapper } from '../db/isogit-yaml/main/yaml/file';


export interface Pane {
  id: string;
  label: string;
  icon?: string;
  helpText?: string;
}


export class Setting<T> {
  constructor(

    public paneID: string,
    /* ID of the pane to show the setting under. */

    public id: string,
    /* Setting ID should be unique across all settings. */

    public input: 'text' | 'number',
    /* Determines input widget shown by default. */

    public required: boolean,
    /* Indicates whether the setting is required for app operation. */

    public label: string,
    /* Setting label shown to the user should be unique within given pane,
       to avoid confusion. */

    public helpText?: string,

  ) {}

  toUseable(val: unknown): T { return val as T }
  /* Converts stored setting value to useable object. */

  toStoreable(val: T): any { return val as any }
  /* Converts JS/TS object to storeable version of the setting. */

}


export class SettingManager {
  private registry: Setting<any>[] = [];
  private panes: Pane[] = [];
  private data: any | null = null;
  private yaml: YAMLWrapper;
  private settingsPath: string;

  constructor(public appDataPath: string, public settingsFileName: string) {
    this.settingsPath = path.join(appDataPath, `${settingsFileName}.yaml`);
    log.debug(`C/settings: Configuring w/path ${this.settingsPath}`);

    this.yaml = new YAMLWrapper(appDataPath);
  }

  public async listMissingRequiredSettings(): Promise<string[]> {
    var requiredSettingIDs: string[] = [];
    for (const setting of this.registry) {
      if (setting.required == true && (await this.getValue(setting.id)) === undefined) {
        requiredSettingIDs.push(setting.id);
      }
    }
    return requiredSettingIDs;
  }

  public async getValue(id: string): Promise<unknown> {
    const setting = this.get(id);

    if (setting) {
      if (this.data === null) {
        let settingsFileExists: boolean;
        try {
          settingsFileExists = (await fs.stat(this.settingsPath)).isFile();
        } catch (e) {
          settingsFileExists = false;
        }
        if (settingsFileExists) {
          this.data = (await this.yaml.read(this.settingsFileName)) || {};
        } else {
          this.data = {};
        }
      }
      const rawVal = this.data[id];
      return rawVal !== undefined ? setting.toUseable(rawVal) : undefined;
    } else {
      log.warn(`C/settings: Attempted to get value for non-existent setting ${id}`);
      throw new Error(`Setting to get value for is not found: ${id}`);
    }
  }

  public async setValue(id: string, val: unknown) {
    // DANGER: Never log setting’s val in raw form

    log.debug(`C/settings: Set value for setting ${id}`);

    const setting = this.get(id);
    if (setting) {
      const storeable = setting.toStoreable(val);
      this.data[id] = storeable;
      await this.commit();
    } else {
      throw new Error(`Setting to set value for is not found: ${id}`);
    }
  }

  public async deleteValue(id: string) {
    log.debug(`C/settings: Delete setting: ${id}`);
    delete this.data[id];
    await this.commit();
  }

  private async commit() {
    log.info("C/settings: Commit new settings");
    log.debug("C/settings: Commit: Remove file");
    await fs.remove(this.settingsPath);
    log.debug("C/settings: Commit: Write new file");
    await this.yaml.write(this.settingsFileName, this.data);
  }

  private get(id: string): Setting<any> | undefined {
    return this.registry.find(s => s.id === id);
  }

  public register(setting: Setting<any>) {
    log.debug("C/settings: Register setting");
    if (this.panes.find(p => p.id === setting.paneID)) {
      this.registry.push(setting);

    } else {
      log.error("C/settings: Unable to register a setting: Invalid pane ID");
      throw new Error("Invalid pane ID");
    }
  }

  public configurePane(pane: Pane) {
    this.panes.push(pane);
  }

  public setUpIPC() {
    log.verbose("C/settings: Register API endpoints");

    listen<{}, { panes: Pane[] }>
    ('settingPaneList', async () => {
      return { panes: this.panes };
    });

    listen<{}, { settings: Setting<any>[] }>
    ('settingList', async () => {
      return { settings: this.registry };
    });

    listen<{ name: string }, { value: any }>
    ('settingValue', async ({ name }) => {
      return await this.getValue(name) as any;
    });

    listen<{ name: string, value: any }, { success: true }>
    ('commitSetting', async({ name, value }) => {
      await this.setValue(name, value);
      return { success: true };
    })

    ipcMain.on('set-setting', async (evt: any, name: string, value: any) => {
      return await this.setValue(name, value);
    });

    ipcMain.on('get-setting', async (evt: any, name: string) => {
      const value = await this.getValue(name);
      evt.reply('get-setting', name, value);
    });

    ipcMain.on('clear-setting', async (evt: any, name: string) => {
      log.debug(`C/settings: received clear-setting request for ${name}`);

      await this.deleteValue(name);
      evt.reply('clear-setting', 'ok');
    });
  }
}
