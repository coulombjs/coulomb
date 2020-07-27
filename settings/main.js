import * as path from 'path';
import * as fs from 'fs-extra';
import * as log from 'electron-log';
import { ipcMain } from 'electron';
import { listen } from '../ipc/main';
import { default as YAMLWrapper } from '../db/isogit-yaml/main/yaml/file';
export class Setting {
    constructor(paneID, 
    /* ID of the pane to show the setting under. */
    id, 
    /* Setting ID should be unique across all settings. */
    input, 
    /* Determines input widget shown by default. */
    required, 
    /* Indicates whether the setting is required for app operation. */
    label, 
    /* Setting label shown to the user should be unique within given pane,
       to avoid confusion. */
    helpText) {
        this.paneID = paneID;
        this.id = id;
        this.input = input;
        this.required = required;
        this.label = label;
        this.helpText = helpText;
    }
    toUseable(val) { return val; }
    /* Converts stored setting value to useable object. */
    toStoreable(val) { return val; }
}
export class SettingManager {
    constructor(appDataPath, settingsFileName) {
        this.appDataPath = appDataPath;
        this.settingsFileName = settingsFileName;
        this.registry = [];
        this.panes = [];
        this.data = null;
        this.settingsPath = path.join(appDataPath, `${settingsFileName}.yaml`);
        log.debug(`C/settings: Configuring w/path ${this.settingsPath}`);
        this.yaml = new YAMLWrapper(appDataPath);
    }
    async listMissingRequiredSettings() {
        var requiredSettingIDs = [];
        for (const setting of this.registry) {
            if (setting.required == true && (await this.getValue(setting.id)) === undefined) {
                requiredSettingIDs.push(setting.id);
            }
        }
        return requiredSettingIDs;
    }
    async getValue(id) {
        const setting = this.get(id);
        if (setting) {
            if (this.data === null) {
                let settingsFileExists;
                try {
                    settingsFileExists = (await fs.stat(this.settingsPath)).isFile();
                }
                catch (e) {
                    settingsFileExists = false;
                }
                if (settingsFileExists) {
                    this.data = (await this.yaml.read(this.settingsFileName)) || {};
                }
                else {
                    this.data = {};
                }
            }
            const rawVal = this.data[id];
            return rawVal !== undefined ? setting.toUseable(rawVal) : undefined;
        }
        else {
            log.warn(`C/settings: Attempted to get value for non-existent setting ${id}`);
            throw new Error(`Setting to get value for is not found: ${id}`);
        }
    }
    async setValue(id, val) {
        // DANGER: Never log setting’s val in raw form
        log.debug(`C/settings: Set value for setting ${id}`);
        const setting = this.get(id);
        if (setting) {
            const storeable = setting.toStoreable(val);
            this.data[id] = storeable;
            await this.commit();
        }
        else {
            throw new Error(`Setting to set value for is not found: ${id}`);
        }
    }
    async deleteValue(id) {
        log.debug(`C/settings: Delete setting: ${id}`);
        delete this.data[id];
        await this.commit();
    }
    async commit() {
        log.info("C/settings: Commit new settings");
        log.debug("C/settings: Commit: Remove file");
        await fs.remove(this.settingsPath);
        log.debug("C/settings: Commit: Write new file");
        await this.yaml.write(this.settingsFileName, this.data);
    }
    get(id) {
        return this.registry.find(s => s.id === id);
    }
    register(setting) {
        log.debug("C/settings: Register setting");
        if (this.panes.find(p => p.id === setting.paneID)) {
            this.registry.push(setting);
        }
        else {
            log.error("C/settings: Unable to register a setting: Invalid pane ID");
            throw new Error("Invalid pane ID");
        }
    }
    configurePane(pane) {
        this.panes.push(pane);
    }
    setUpIPC() {
        log.verbose("C/settings: Register API endpoints");
        listen('settingPaneList', async () => {
            return { panes: this.panes };
        });
        listen('settingList', async () => {
            return { settings: this.registry };
        });
        listen('settingValue', async ({ name }) => {
            return await this.getValue(name);
        });
        listen('commitSetting', async ({ name, value }) => {
            await this.setValue(name, value);
            return { success: true };
        });
        ipcMain.on('set-setting', async (evt, name, value) => {
            return await this.setValue(name, value);
        });
        ipcMain.on('get-setting', async (evt, name) => {
            const value = await this.getValue(name);
            evt.reply('get-setting', name, value);
        });
        ipcMain.on('clear-setting', async (evt, name) => {
            log.debug(`C/settings: received clear-setting request for ${name}`);
            await this.deleteValue(name);
            evt.reply('clear-setting', 'ok');
        });
    }
}
//# sourceMappingURL=main.js.map