import * as path from 'path';
import { format as formatUrl } from 'url';
import { app, protocol, BrowserWindow, Menu } from 'electron';
const isDevelopment = process.env.NODE_ENV !== 'production';
const isMacOS = process.platform === 'darwin';
// Keeps track of windows and ensures (?) they do not get garbage collected
export var windows = [];
// Allows to locate window ID by label
var windowsByTitle = {};
app.whenReady().then(() => {
    protocol.registerFileProtocol('file', (request, cb) => {
        const components = request.url.replace('file:///', '').split('?', 2);
        if (isDevelopment) {
            cb(components.map(decodeURI)[0]);
        }
        else {
            cb(components.map(decodeURI).join('?'));
        }
    });
});
export const openWindow = async ({ title, url, component, componentParams, dimensions, frameless, winParams, menuTemplate, ignoreCache, showWhileLoading, config }) => {
    if ((component || '').trim() === '' && (url || '').trim() === '') {
        throw new Error("openWindow() requires either `component` or `url`");
    }
    const _existingWindow = getWindowByTitle(title);
    if (_existingWindow !== undefined) {
        _existingWindow.show();
        _existingWindow.focus();
        return _existingWindow;
    }
    const _framelessOpts = {
        titleBarStyle: isMacOS ? 'hiddenInset' : undefined,
    };
    const _winParams = Object.assign(Object.assign({ width: (dimensions || {}).width, minWidth: (dimensions || {}).minWidth, height: (dimensions || {}).height, minHeight: (dimensions || {}).minHeight }, (frameless === true ? _framelessOpts : {})), winParams);
    let window;
    if (component) {
        const params = `c=${component}&${componentParams ? componentParams : ''}`;
        window = await createWindowForLocalComponent(title, params, _winParams, showWhileLoading === true, config.forceDevelopmentMode || false);
    }
    else if (url) {
        window = await createWindow(title, url, _winParams, showWhileLoading === true, ignoreCache);
    }
    else {
        throw new Error("Either component or url must be given to openWindow()");
    }
    if (menuTemplate && !isMacOS) {
        window.setMenu(Menu.buildFromTemplate(menuTemplate));
    }
    windows.push(window);
    windowsByTitle[title] = window;
    window.on('closed', () => { delete windowsByTitle[title]; cleanUpWindows(); });
    return window;
};
export function getWindowByTitle(title) {
    return windowsByTitle[title];
}
export function closeWindow(title) {
    const win = getWindowByTitle(title);
    if (win !== undefined) {
        win.close();
    }
}
export function getWindow(func) {
    return windows.find(func);
}
// Iterate over array of windows and try accessing window ID.
// If it throws, window was closed and we remove it from the array.
// Supposed to be run after any window is closed
function cleanUpWindows() {
    var deletedWindows = [];
    for (const [idx, win] of windows.entries()) {
        // When accessing the id attribute of a closed window,
        // it’ll throw. We’ll mark its index for deletion then.
        try {
            win.id;
        }
        catch (e) {
            deletedWindows.push(idx - deletedWindows.length);
        }
    }
    for (const idx of deletedWindows) {
        windows.splice(idx, 1);
    }
}
async function createWindowForLocalComponent(title, params, winParams, showWhileLoading, forceDebug) {
    let url;
    if (isDevelopment) {
        url = `http://localhost:${process.env.ELECTRON_WEBPACK_WDS_PORT}?${params}`;
    }
    else {
        url = `${formatUrl({
            pathname: path.join(__dirname, 'index.html'),
            protocol: 'file',
            slashes: true,
        })}?${params}`;
    }
    const window = await createWindow(title, url, winParams, showWhileLoading, forceDebug || isDevelopment);
    if (forceDebug || isDevelopment) {
        window.webContents.on('devtools-opened', () => {
            window.focus();
            setImmediate(() => {
                window.focus();
            });
        });
        window.webContents.openDevTools();
    }
    return window;
}
async function createWindow(title, url, winParams, showWhileLoading, debug = false) {
    const window = new BrowserWindow(Object.assign({ webPreferences: {
            nodeIntegration: true,
            webSecurity: !debug,
            enableRemoteModule: true,
        }, title: title, show: showWhileLoading === true }, winParams));
    const promise = new Promise((resolve, reject) => {
        window.once('ready-to-show', () => {
            if (showWhileLoading !== true) {
                window.show();
            }
            resolve(window);
        });
    });
    if (debug) {
        window.loadURL(url, { 'extraHeaders': 'pragma: no-cache\n' });
    }
    else {
        window.loadURL(url);
    }
    return promise;
}
export async function notifyAllWindows(eventName, payload) {
    await Promise.all(windows.map(async (window) => {
        if (window) {
            await window.webContents.send(eventName, payload);
        }
        return;
    }));
}
export async function notifyWindow(windowTitle, eventName, payload) {
    const window = getWindowByTitle(windowTitle);
    if (window) {
        await window.webContents.send(eventName, payload);
    }
}
//# sourceMappingURL=window.js.map