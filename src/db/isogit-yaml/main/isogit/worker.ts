// NOTE: This module cannot use electron-log, since it for some reason
// fails to obtain the paths required for file transport to work
// when in Node worker context.

// TODO: Make electron-log work somehow

import { expose } from 'threads';

import fs from 'fs-extra';
import AsyncLock from 'async-lock';

import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';

import { CloneRequestMessage, PullRequestMessage, PushRequestMessage } from './types';
import { ModuleMethods } from 'threads/dist/types/master';


const gitLock = new AsyncLock({ timeout: 20000, maxPending: 4 });


export interface GitMethods {
  clone: (msg: CloneRequestMessage) => Promise<{ success: true }>
  pull: (msg: PullRequestMessage) => Promise<{ success: true }>
  push: (msg: PushRequestMessage) => Promise<{ success: true }>
}


export type GitWorkerSpec = ModuleMethods & GitMethods;


const gitWorkerMethods: GitWorkerSpec = {

  async clone(msg: CloneRequestMessage): Promise<{ success: true }> {
    if (gitLock.isBusy()) {
      throw new Error("Lock is busy");
    }
    await gitLock.acquire('1', async () => {
      try {
        await git.clone({
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
        });
      } catch (e) {
        //log.error(`C/db/isogit/worker: Error cloning repository`, e);
        throw e;
      }
    });
    return { success: true };
  },

  async pull(msg: PullRequestMessage): Promise<{ success: true }> {
    await gitLock.acquire('1', async () => {
      try {
        await git.pull({
          http,
          fs,
          dir: msg.workDir,
          url: `${msg.repoURL}.git`,
          singleBranch: true,
          fastForwardOnly: true,
          author: msg.author,
          onAuth: () => msg.auth,
        });
      } catch (e) {
        //log.error(`C/db/isogit/worker: Error pulling from repository`, e);
        throw e;
      }
    });
    return { success: true };
  },

  async push(msg: PushRequestMessage): Promise<{ success: true }> {
    await gitLock.acquire('1', async () => {
      try {
        await git.push({
          http,
          fs,
          dir: msg.workDir,
          url: `${msg.repoURL}.git`,
          onAuth: () => msg.auth,
        });
      } catch (e) {
        //log.error(`C/db/isogit/worker: Error pushing to repository`, e);
        throw e;
      }
    });
    return { success: true };
  },

}

expose(gitWorkerMethods);
