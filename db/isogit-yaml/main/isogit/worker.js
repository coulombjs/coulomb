const { exit } = require('process');
const { isMainThread, parentPort } = require('worker_threads');
const log = require('electron-log');
const fs = require('fs-extra');
const AsyncLock = require('async-lock');
const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');
if (isMainThread) {
    console.error("Worker loaded in main thread");
    exit(1);
}
if (!parentPort) {
    console.error("Parent port is null in worker");
    exit(1);
}
const gitLock = new AsyncLock({ timeout: 20000, maxPending: 2 });
function messageParent(msg) {
    if (!parentPort) {
        log.error("Parent port is null: Can’t report success");
        return;
    }
    parentPort.postMessage(msg);
}
parentPort.on('message', (msg) => {
    if (!parentPort) {
        console.error("Parent port is null in worker message handler");
        exit(1);
    }
    if (gitLock.isBusy()) {
        parentPort.postMessage({ success: false, errors: ['Lock is busy'] });
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
            }).catch((err) => {
                log.info(`C/db/isogit/worker: Error cloning repository`, err);
                messageParent({ cloned: false, error: err });
            });
        }
        else if (msg.action === 'pull') {
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
            }).catch((err) => {
                log.info(`C/db/isogit/worker: Error pulling from repository`, err);
                messageParent({ pulled: false, error: err });
            });
        }
        else if (msg.action === 'push') {
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
            }).catch((err) => {
                log.info(`C/db/isogit/worker: Error pushing to repository`, err);
                messageParent({ pushed: false, error: err });
            });
        }
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid29ya2VyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2RiL2lzb2dpdC15YW1sL21haW4vaXNvZ2l0L3dvcmtlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxNQUFNLEVBQUUsSUFBSSxFQUFFLEdBQUcsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBQ3BDLE1BQU0sRUFBRSxZQUFZLEVBQUUsVUFBVSxFQUFFLEdBQUcsT0FBTyxDQUFDLGdCQUFnQixDQUFDLENBQUM7QUFFL0QsTUFBTSxHQUFHLEdBQUcsT0FBTyxDQUFDLGNBQWMsQ0FBQyxDQUFDO0FBRXBDLE1BQU0sRUFBRSxHQUFHLE9BQU8sQ0FBQyxVQUFVLENBQUMsQ0FBQztBQUMvQixNQUFNLFNBQVMsR0FBRyxPQUFPLENBQUMsWUFBWSxDQUFDLENBQUM7QUFFeEMsTUFBTSxHQUFHLEdBQUcsT0FBTyxDQUFDLGdCQUFnQixDQUFDLENBQUM7QUFDdEMsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLDBCQUEwQixDQUFDLENBQUM7QUFLakQsSUFBSSxZQUFZLEVBQUU7SUFDaEIsT0FBTyxDQUFDLEtBQUssQ0FBQyw4QkFBOEIsQ0FBQyxDQUFDO0lBQzlDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztDQUNUO0FBRUQsSUFBSSxDQUFDLFVBQVUsRUFBRTtJQUNmLE9BQU8sQ0FBQyxLQUFLLENBQUMsK0JBQStCLENBQUMsQ0FBQTtJQUM5QyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7Q0FDVDtBQUdELE1BQU0sT0FBTyxHQUFHLElBQUksU0FBUyxDQUFDLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxVQUFVLEVBQUUsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUdqRSxTQUFTLGFBQWEsQ0FBQyxHQUFXO0lBQ2hDLElBQUksQ0FBQyxVQUFVLEVBQUU7UUFDZixHQUFHLENBQUMsS0FBSyxDQUFDLDJDQUEyQyxDQUFDLENBQUM7UUFDdkQsT0FBTztLQUNS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RUFBRSxHQUFHLENBQUMsT0FBTztnQkFDaEIsR0FBRyxFQUFFLEdBQUcsR0FBRyxDQUFDLE9BQU8sTUFBTTtnQkFDekIsWUFBWSxFQUFFLElBQUk7Z0JBQ2xCLGVBQWUsRUFBRSxJQUFJO2dCQUNyQixNQUFNLEVBQUUsR0FBRyxFQUFFLENBQUMsR0FBRyxDQUFDLElBQUk7YUFDdkIsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUU7Z0JBQ1gsR0FBRyxDQUFDLElBQUksQ0FBQywwQ0FBMEMsQ0FBQyxDQUFDO2dCQUNyRCxhQUFhLENBQUMsRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztZQUNsQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxHQUFRLEVBQUUsRUFBRTtnQkFDcEIsR0FBRyxDQUFDLElBQUksQ0FBQyxpREFBaUQsRUFBRSxHQUFHLENBQUMsQ0FBQztnQkFDakUsYUFBYSxDQUFDLEVBQUUsTUFBTSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsR0FBRyxFQUFFLENBQUMsQ0FBQztZQUMvQyxDQUFDLENBQUMsQ0FBQztTQUVKO0lBRUgsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHsgZXhpdCB9ID0gcmVxdWlyZSgncHJvY2VzcycpO1xuY29uc3QgeyBpc01haW5UaHJlYWQsIHBhcmVudFBvcnQgfSA9IHJlcXVpcmUoJ3dvcmtlcl90aHJlYWRzJyk7XG5cbmNvbnN0IGxvZyA9IHJlcXVpcmUoJ2VsZWN0cm9uLWxvZycpO1xuXG5jb25zdCBmcyA9IHJlcXVpcmUoJ2ZzLWV4dHJhJyk7XG5jb25zdCBBc3luY0xvY2sgPSByZXF1aXJlKCdhc3luYy1sb2NrJyk7XG5cbmNvbnN0IGdpdCA9IHJlcXVpcmUoJ2lzb21vcnBoaWMtZ2l0Jyk7XG5jb25zdCBodHRwID0gcmVxdWlyZSgnaXNvbW9ycGhpYy1naXQvaHR0cC9ub2RlJyk7XG5cbmltcG9ydCB7IFdvcmtlck1lc3NhZ2UgfSBmcm9tICcuL3R5cGVzJztcblxuXG5pZiAoaXNNYWluVGhyZWFkKSB7XG4gIGNvbnNvbGUuZXJyb3IoXCJXb3JrZXIgbG9hZGVkIGluIG1haW4gdGhyZWFkXCIpO1xuICBleGl0KDEpO1xufVxuXG5pZiAoIXBhcmVudFBvcnQpIHtcbiAgY29uc29sZS5lcnJvcihcIlBhcmVudCBwb3J0IGlzIG51bGwgaW4gd29ya2VyXCIpXG4gIGV4aXQoMSk7XG59XG5cblxuY29uc3QgZ2l0TG9jayA9IG5ldyBBc3luY0xvY2soeyB0aW1lb3V0OiAyMDAwMCwgbWF4UGVuZGluZzogMiB9KTtcblxuXG5mdW5jdGlvbiBtZXNzYWdlUGFyZW50KG1zZzogb2JqZWN0KSB7XG4gIGlmICghcGFyZW50UG9ydCkge1xuICAgIGxvZy5lcnJvcihcIlBhcmVudCBwb3J0IGlzIG51bGw6IENhbuKAmXQgcmVwb3J0IHN1Y2Nlc3NcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIHBhcmVudFBvcnQucG9zdE1lc3NhZ2UobXNnKTtcbn1cblxuXG5wYXJlbnRQb3J0Lm9uKCdtZXNzYWdlJywgKG1zZzogV29ya2VyTWVzc2FnZSkgPT4ge1xuICBpZiAoIXBhcmVudFBvcnQpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiUGFyZW50IHBvcnQgaXMgbnVsbCBpbiB3b3JrZXIgbWVzc2FnZSBoYW5kbGVyXCIpXG4gICAgZXhpdCgxKTtcbiAgfVxuXG4gIGlmIChnaXRMb2NrLmlzQnVzeSgpKSB7XG4gICAgcGFyZW50UG9ydC5wb3N0TWVzc2FnZSh7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcnM6IFsnTG9jayBpcyBidXN5J10gfSlcbiAgfVxuXG4gIC8vIE9uZSBsb2NrIGZvciBhbGwgR2l0IG9wZXJhdGlvbnMuIFdlIGNvdWxkIGRpdmlkZSBsb2NrcywgYnV0IHRoYXQgbXVzdCBiZSBkb25lIGNhcmVmdWxseVxuICAvLyBhbmQgaXQgaXMgdW5jbGVhciB3aGV0aGVyIHRoZSBlZmZvcnQgd2lsbCBvdXR3ZWlnaCB0aGUgY29zdHMuXG4gIGdpdExvY2suYWNxdWlyZSgnMScsIGFzeW5jICgpID0+IHtcblxuICAgIGlmIChtc2cuYWN0aW9uID09PSAnY2xvbmUnKSB7XG5cbiAgICAgIGdpdC5jbG9uZSh7XG4gICAgICAgIHVybDogYCR7bXNnLnJlcG9VUkx9LmdpdGAsXG4gICAgICAgIC8vIF5eIC5naXQgc3VmZml4IGlzIHJlcXVpcmVkIGhlcmU6XG4gICAgICAgIC8vIGh0dHBzOi8vZ2l0aHViLmNvbS9pc29tb3JwaGljLWdpdC9pc29tb3JwaGljLWdpdC9pc3N1ZXMvMTE0NSNpc3N1ZWNvbW1lbnQtNjUzODE5MTQ3XG4gICAgICAgIC8vIFRPRE86IFN1cHBvcnQgbm9uLUdpdEh1YiByZXBvc2l0b3JpZXMgYnkgcmVtb3ZpbmcgZm9yY2UtYWRkaW5nIHRoaXMgc3VmZml4IGhlcmUsXG4gICAgICAgIC8vIGFuZCBwcm92aWRlIG1pZ3JhdGlvbiBpbnN0cnVjdGlvbnMgZm9yIENvdWxvbWItYmFzZWQgYXBwcyB0aGF0IHdvcmsgd2l0aCBHaXRIdWIuXG4gICAgICAgIGh0dHAsXG4gICAgICAgIGZzLFxuICAgICAgICBkaXI6IG1zZy53b3JrRGlyLFxuICAgICAgICByZWY6ICdtYXN0ZXInLFxuICAgICAgICBzaW5nbGVCcmFuY2g6IHRydWUsXG4gICAgICAgIGRlcHRoOiA1LFxuICAgICAgICBvbkF1dGg6ICgpID0+IG1zZy5hdXRoLFxuICAgICAgfSkudGhlbigoKSA9PiB7XG4gICAgICAgIGxvZy5pbmZvKGBDL2RiL2lzb2dpdC93b3JrZXI6IENsb25lZCByZXBvc2l0b3J5YCk7XG4gICAgICAgIG1lc3NhZ2VQYXJlbnQoeyBjbG9uZWQ6IHRydWUgfSk7XG4gICAgICB9KS5jYXRjaCgoZXJyOiBhbnkpID0+IHtcbiAgICAgICAgbG9nLmluZm8oYEMvZGIvaXNvZ2l0L3dvcmtlcjogRXJyb3IgY2xvbmluZyByZXBvc2l0b3J5YCwgZXJyKTtcbiAgICAgICAgbWVzc2FnZVBhcmVudCh7IGNsb25lZDogZmFsc2UsIGVycm9yOiBlcnIgfSk7XG4gICAgICB9KTtcblxuICAgIH0gZWxzZSBpZiAobXNnLmFjdGlvbiA9PT0gJ3B1bGwnKSB7XG5cbiAgICAgIGdpdC5wdWxsKHtcbiAgICAgICAgaHR0cCxcbiAgICAgICAgZnMsXG4gICAgICAgIGRpcjogbXNnLndvcmtEaXIsXG4gICAgICAgIHVybDogYCR7bXNnLnJlcG9VUkx9LmdpdGAsXG4gICAgICAgIHNpbmdsZUJyYW5jaDogdHJ1ZSxcbiAgICAgICAgZmFzdEZvcndhcmRPbmx5OiB0cnVlLFxuICAgICAgICBhdXRob3I6IG1zZy5hdXRob3IsXG4gICAgICAgIG9uQXV0aDogKCkgPT4gbXNnLmF1dGgsXG4gICAgICB9KS50aGVuKCgpID0+IHtcbiAgICAgICAgbG9nLmluZm8oYEMvZGIvaXNvZ2l0L3dvcmtlcjogUHVsbGVkIGZyb20gcmVwb3NpdG9yeWApO1xuICAgICAgICBtZXNzYWdlUGFyZW50KHsgcHVsbGVkOiB0cnVlIH0pO1xuICAgICAgfSkuY2F0Y2goKGVycjogYW55KSA9PiB7XG4gICAgICAgIGxvZy5pbmZvKGBDL2RiL2lzb2dpdC93b3JrZXI6IEVycm9yIHB1bGxpbmcgZnJvbSByZXBvc2l0b3J5YCwgZXJyKTtcbiAgICAgICAgbWVzc2FnZVBhcmVudCh7IHB1bGxlZDogZmFsc2UsIGVycm9yOiBlcnIgfSk7XG4gICAgICB9KTtcblxuICAgIH0gZWxzZSBpZiAobXNnLmFjdGlvbiA9PT0gJ3B1c2gnKSB7XG5cbiAgICAgIGdpdC5wdXNoKHtcbiAgICAgICAgaHR0cCxcbiAgICAgICAgZnMsXG4gICAgICAgIGRpcjogbXNnLndvcmtEaXIsXG4gICAgICAgIHVybDogYCR7bXNnLnJlcG9VUkx9LmdpdGAsXG4gICAgICAgIHNpbmdsZUJyYW5jaDogdHJ1ZSxcbiAgICAgICAgZmFzdEZvcndhcmRPbmx5OiB0cnVlLFxuICAgICAgICBvbkF1dGg6ICgpID0+IG1zZy5hdXRoLFxuICAgICAgfSkudGhlbigoKSA9PiB7XG4gICAgICAgIGxvZy5pbmZvKGBDL2RiL2lzb2dpdC93b3JrZXI6IFB1c2hlZCB0byByZXBvc2l0b3J5YCk7XG4gICAgICAgIG1lc3NhZ2VQYXJlbnQoeyBwdXNoZWQ6IHRydWUgfSk7XG4gICAgICB9KS5jYXRjaCgoZXJyOiBhbnkpID0+IHtcbiAgICAgICAgbG9nLmluZm8oYEMvZGIvaXNvZ2l0L3dvcmtlcjogRXJyb3IgcHVzaGluZyB0byByZXBvc2l0b3J5YCwgZXJyKTtcbiAgICAgICAgbWVzc2FnZVBhcmVudCh7IHB1c2hlZDogZmFsc2UsIGVycm9yOiBlcnIgfSk7XG4gICAgICB9KTtcblxuICAgIH1cblxuICB9KTtcbn0pO1xuIl19