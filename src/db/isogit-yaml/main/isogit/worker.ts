const { exit } = require('process');
const { isMainThread, parentPort } = require('worker_threads');

const log = require('electron-log');

const fs = require('fs-extra');
const AsyncLock = require('async-lock');

const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');

import { WorkerMessage } from './types';


if (isMainThread) {
  console.error("Worker loaded in main thread");
  exit(1);
}

if (!parentPort) {
  console.error("Parent port is null in worker")
  exit(1);
}


const gitLock = new AsyncLock({ timeout: 20000, maxPending: 2 });


function messageParent(msg: object) {
  if (!parentPort) {
    log.error("Parent port is null: Can’t report success");
    return;
  }
  parentPort.postMessage(msg);
}


parentPort.on('message', (msg: WorkerMessage) => {
  if (!parentPort) {
    console.error("Parent port is null in worker message handler")
    exit(1);
  }

  if (gitLock.isBusy()) {
    parentPort.postMessage({ success: false, errors: ['Lock is busy'] })
  }

  // One lock for all Git operations. We could divide locks, but that must be done carefully
  // and it is unclear whether the effort will outweigh the costs.
  gitLock.acquire('1', async () => {

    if (msg.action === 'clone') {

      git.clone({
        url: `${msg.repoURL}.git`,
        // ^^ .git suffix is required here:
        // https://github.com/isomorphic-git/isomorphic-git/issues/1145#issuecomment-653819147
        // TODO: Support non-GitHub repositories by removing force-adding this suffix here,
        // and provide migration instructions for Coulomb-based apps that work with GitHub.
        http,
        fs,
        dir: msg.workDir,
        ref: 'master',
        singleBranch: true,
        depth: 5,
        onAuth: () => msg.auth,
      }).then(() => {
        log.info(`C/db/isogit/worker: Cloned repository`);
        messageParent({ cloned: true });
      }).catch((err: any) => {
        log.info(`C/db/isogit/worker: Error cloning repository`, err);
        messageParent({ cloned: false, error: err });
      });

    } else if (msg.action === 'pull') {

      git.pull({
        http,
        fs,
        dir: msg.workDir,
        url: `${msg.repoURL}.git`,
        singleBranch: true,
        fastForwardOnly: true,
        author: msg.author,
        onAuth: () => msg.auth,
      }).then(() => {
        log.info(`C/db/isogit/worker: Pulled from repository`);
        messageParent({ pulled: true });
      }).catch((err: any) => {
        log.info(`C/db/isogit/worker: Error pulling from repository`, err);
        messageParent({ pulled: false, error: err });
      });

    } else if (msg.action === 'push') {

      git.push({
        http,
        fs,
        dir: msg.workDir,
        url: `${msg.repoURL}.git`,
        singleBranch: true,
        fastForwardOnly: true,
        onAuth: () => msg.auth,
      }).then(() => {
        log.info(`C/db/isogit/worker: Pushed to repository`);
        messageParent({ pushed: true });
      }).catch((err: any) => {
        log.info(`C/db/isogit/worker: Error pushing to repository`, err);
        messageParent({ pushed: false, error: err });
      });

    }

  });
});
