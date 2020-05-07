import { listen } from '../../ipc/main';
// Generic backend.
export class Backend {
    setUpIPC(dbID) {
        /* Initializes IPC endpoints to enable the user to e.g. configure the data store
           or invoke housekeeping or utility routines. */
        const prefix = `db-${dbID}`;
        listen(`${prefix}-describe`, async () => {
            return await this.describe();
        });
        listen(`${prefix}-read`, async ({ objectID }) => {
            if (objectID === null) {
                return { object: null };
            }
            else {
                return { object: await this.read(objectID) };
            }
        });
    }
}
// Versioned backend & compatible manager.
export class VersionedBackend extends Backend {
}
export class ModelManager {
    async init() { }
    setUpIPC(modelName) {
        /* Initializes IPC endpoints to query or update data objects. */
        const prefix = `model-${modelName}`;
        listen(`${prefix}-list-ids`, async ({ query }) => ({ ids: (await this.listIDs(query)) }));
        listen(`${prefix}-count`, async ({ query }) => ({ count: await this.count(query) }));
        listen(`${prefix}-read-all`, async ({ query }) => this.readAll(query));
        listen(`${prefix}-read-one`, async ({ objectID }) => {
            if (objectID === null) {
                return { object: null };
            }
            else {
                return { object: await this.read(objectID) };
            }
        });
        listen(`${prefix}-update-one`, async ({ objectID, object, commit }) => {
            await this.update(objectID, object, commit);
            return { success: true };
        });
        listen(`${prefix}-create-one`, async ({ object, commit }) => {
            await this.create(object, commit);
            return { success: true };
        });
    }
}
export class CommitError extends Error {
    constructor(code, msg) {
        super(msg);
        this.code = code;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
// Versioned backend specifically based on local filesystem,
// and requisite manager interface
export class VersionedFilesystemBackend extends VersionedBackend {
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFzZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kYi9tYWluL2Jhc2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBSUEsT0FBTyxFQUFFLE1BQU0sRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBR3hDLG1CQUFtQjtBQUVuQixNQUFNLE9BQWdCLE9BQU87SUE0QjNCLFFBQVEsQ0FBQyxJQUFZO1FBQ25CO3lEQUNpRDtRQUVqRCxNQUFNLE1BQU0sR0FBRyxNQUFNLElBQUksRUFBRSxDQUFDO1FBRTVCLE1BQU0sQ0FDTCxHQUFHLE1BQU0sV0FBVyxFQUFFLEtBQUssSUFBSSxFQUFFO1lBQ2hDLE9BQU8sTUFBTSxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7UUFDL0IsQ0FBQyxDQUFDLENBQUM7UUFFSCxNQUFNLENBQ0wsR0FBRyxNQUFNLE9BQU8sRUFBRSxLQUFLLEVBQUUsRUFBRSxRQUFRLEVBQUUsRUFBRSxFQUFFO1lBQ3hDLElBQUksUUFBUSxLQUFLLElBQUksRUFBRTtnQkFDckIsT0FBTyxFQUFFLE1BQU0sRUFBRSxJQUFJLEVBQUUsQ0FBQzthQUN6QjtpQkFBTTtnQkFDTCxPQUFPLEVBQUUsTUFBTSxFQUFFLE1BQU0sSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDO2FBQzlDO1FBQ0gsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUEwREQsMENBQTBDO0FBRTFDLE1BQU0sT0FBZ0IsZ0JBQXFDLFNBQVEsT0FBZTtDQVlqRjtBQUdELE1BQU0sT0FBZ0IsWUFBWTtJQW9CaEMsS0FBSyxDQUFDLElBQUksS0FBSSxDQUFDO0lBRWYsUUFBUSxDQUFDLFNBQWlCO1FBQ3hCLGdFQUFnRTtRQUVoRSxNQUFNLE1BQU0sR0FBRyxTQUFTLFNBQVMsRUFBRSxDQUFDO1FBRXBDLE1BQU0sQ0FDTCxHQUFHLE1BQU0sV0FBVyxFQUFFLEtBQUssRUFBRSxFQUFFLEtBQUssRUFBRSxFQUFFLEVBQUUsQ0FBQyxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsTUFBTSxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFFcEYsTUFBTSxDQUNMLEdBQUcsTUFBTSxRQUFRLEVBQUUsS0FBSyxFQUFFLEVBQUUsS0FBSyxFQUFFLEVBQUUsRUFBRSxDQUFDLENBQUMsRUFBRSxLQUFLLEVBQUUsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBRS9FLE1BQU0sQ0FDTCxHQUFHLE1BQU0sV0FBVyxFQUFFLEtBQUssRUFBRSxFQUFFLEtBQUssRUFBRSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7UUFFakUsTUFBTSxDQUNMLEdBQUcsTUFBTSxXQUFXLEVBQUUsS0FBSyxFQUFFLEVBQUUsUUFBUSxFQUFFLEVBQUUsRUFBRTtZQUM1QyxJQUFJLFFBQVEsS0FBSyxJQUFJLEVBQUU7Z0JBQ3JCLE9BQU8sRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLENBQUM7YUFDekI7aUJBQU07Z0JBQ0wsT0FBTyxFQUFFLE1BQU0sRUFBRSxNQUFNLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQzthQUM5QztRQUNILENBQUMsQ0FBQyxDQUFDO1FBRUgsTUFBTSxDQUNMLEdBQUcsTUFBTSxhQUFhLEVBQUUsS0FBSyxFQUFFLEVBQUUsUUFBUSxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsRUFBRSxFQUFFO1lBQzlELE1BQU0sSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLEVBQUUsTUFBTSxFQUFFLE1BQU0sQ0FBQyxDQUFDO1lBQzVDLE9BQU8sRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLENBQUM7UUFDM0IsQ0FBQyxDQUFDLENBQUM7UUFFSCxNQUFNLENBQ0wsR0FBRyxNQUFNLGFBQWEsRUFBRSxLQUFLLEVBQUUsRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLEVBQUUsRUFBRTtZQUNwRCxNQUFNLElBQUksQ0FBQyxNQUFNLENBQUMsTUFBTSxFQUFFLE1BQU0sQ0FBQyxDQUFDO1lBQ2xDLE9BQU8sRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLENBQUM7UUFDM0IsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUFHRCxNQUFNLE9BQU8sV0FBWSxTQUFRLEtBQUs7SUFDcEMsWUFBbUIsSUFBWSxFQUFFLEdBQVc7UUFDMUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBRE0sU0FBSSxHQUFKLElBQUksQ0FBUTtRQUU3QixNQUFNLENBQUMsY0FBYyxDQUFDLElBQUksRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQ3BELENBQUM7Q0FDRjtBQUdELDREQUE0RDtBQUM1RCxrQ0FBa0M7QUFFbEMsTUFBTSxPQUFnQiwwQkFBMkIsU0FBUSxnQkFBd0I7Q0FvQmhGIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQW55SURUeXBlLCBNb2RlbCB9IGZyb20gJy4uL21vZGVscyc7XG5pbXBvcnQgeyBTZXR0aW5nTWFuYWdlciB9IGZyb20gJy4uLy4uL3NldHRpbmdzL21haW4nO1xuaW1wb3J0IHsgSW5kZXggfSBmcm9tICcuLi9xdWVyeSc7XG5pbXBvcnQgeyBCYWNrZW5kRGVzY3JpcHRpb24gfSBmcm9tICcuLi9iYXNlJztcbmltcG9ydCB7IGxpc3RlbiB9IGZyb20gJy4uLy4uL2lwYy9tYWluJztcblxuXG4vLyBHZW5lcmljIGJhY2tlbmQuXG5cbmV4cG9ydCBhYnN0cmFjdCBjbGFzcyBCYWNrZW5kPElEVHlwZSA9IEFueUlEVHlwZT4ge1xuICBhYnN0cmFjdCBpbml0KCk6IFByb21pc2U8dm9pZD5cbiAgLyogSW5pdGlhbGl6ZXMgdGhlIGJhY2tlbmQuXG4gICAgIFRoaXMgbWF5IGludm9sdmUgbG9hZGluZyBkYXRhIGZyb20gcmVtb3RlIHN0b3JhZ2UsXG4gICAgIHRodXMgaW5pdGlhbCBhdXRoZW50aWNhdGlvbiwgZXRjLiAqL1xuXG4gIGFic3RyYWN0IGRlc2NyaWJlKCk6IFByb21pc2U8QmFja2VuZERlc2NyaXB0aW9uPGFueT4+XG5cbiAgLy8gRm9sbG93aW5nIGFyZSBkYXRhIHF1ZXJ5ICYgdXBkYXRlIG1ldGhvZHMuXG4gIC8vIE9uZSBEQiBtYXkgb3BlcmF0ZSBhIGhldGVyb2dlbmVvdXMgY29sbGVjdGlvbiBvZiBvYmplY3RzLlxuICAvLyBSZWNvZ25pemluZyB0aGVpciB0eXBlcyBpcyBub3Qgd2l0aGluIERCIGJhY2tlbmTigJlzIHNjb3BlLlxuICAvLyBUaGVzZSBtZXRob2RzIHJhdGhlciBvcGVyYXRlIGxvd2VyLWxldmVsXG4gIC8vIGdlbmVyaWMgb2JqZWN0IHBheWxvYWRzIGFuZCBvYmplY3QgSURzLlxuICAvL1xuICAvLyBSZWNvZ25pemluZyBwYXJ0aWN1bGFyIGRhdGEgdHlwZXMgaXMgTWFuYWdlcuKAmXMgam9iOlxuICAvLyB0aGUgYXBwIHdvdWxkIHF1ZXJ5IGRhdGEgb2JqZWN0cyB2aWEgY29ycmVzcG9uZGluZyBtYW5hZ2VyLFxuICAvLyB3aGljaCBpbiB0dXJuIHdvdWxkIGNhbGwgdGhlc2UgbWV0aG9kc1xuICAvLyBmaWxsaW5nIGluIGFwcHJvcHJpYXRlIGFyZ3VtZW50cy5cblxuICBhYnN0cmFjdCBnZXRJbmRleChpZEZpZWxkOiBzdHJpbmcsIC4uLmFyZ3M6IGFueVtdKTogUHJvbWlzZTxJbmRleDxhbnk+PlxuICAvLyBERVBSRUNBVEVEOiBSZWFkaW5nIGFsbCBEQiBvYmplY3RzIHdpdGhvdXQgYW55IGZpbHRlcmluZyBxdWVyeSB3aWxsIGJlIHRvbyBzbG93LlxuXG4gIGFic3RyYWN0IGxpc3RJRHMocXVlcnk6IG9iamVjdCk6IFByb21pc2U8SURUeXBlW10+XG4gIGFic3RyYWN0IHJlYWQob2JqSUQ6IElEVHlwZSwgLi4uYXJnczogYW55W10pOiBQcm9taXNlPG9iamVjdD5cbiAgYWJzdHJhY3QgY3JlYXRlKG9iajogb2JqZWN0LCAuLi5hcmdzOiBhbnlbXSk6IFByb21pc2U8dm9pZD5cbiAgYWJzdHJhY3QgdXBkYXRlKG9iaklEOiBJRFR5cGUsIG9iajogb2JqZWN0LCAuLi5hcmdzOiBhbnlbXSk6IFByb21pc2U8dm9pZD5cbiAgYWJzdHJhY3QgZGVsZXRlKG9iaklEOiBJRFR5cGUsIC4uLmFyZ3M6IGFueVtdKTogUHJvbWlzZTx2b2lkPlxuXG4gIHNldFVwSVBDKGRiSUQ6IHN0cmluZyk6IHZvaWQge1xuICAgIC8qIEluaXRpYWxpemVzIElQQyBlbmRwb2ludHMgdG8gZW5hYmxlIHRoZSB1c2VyIHRvIGUuZy4gY29uZmlndXJlIHRoZSBkYXRhIHN0b3JlXG4gICAgICAgb3IgaW52b2tlIGhvdXNla2VlcGluZyBvciB1dGlsaXR5IHJvdXRpbmVzLiAqL1xuXG4gICAgY29uc3QgcHJlZml4ID0gYGRiLSR7ZGJJRH1gO1xuXG4gICAgbGlzdGVuPHt9LCBCYWNrZW5kRGVzY3JpcHRpb248YW55Pj5cbiAgICAoYCR7cHJlZml4fS1kZXNjcmliZWAsIGFzeW5jICgpID0+IHtcbiAgICAgIHJldHVybiBhd2FpdCB0aGlzLmRlc2NyaWJlKCk7XG4gICAgfSk7XG5cbiAgICBsaXN0ZW48eyBvYmplY3RJRDogSURUeXBlIHwgbnVsbCB9LCB7IG9iamVjdDogb2JqZWN0IHwgbnVsbCB9PlxuICAgIChgJHtwcmVmaXh9LXJlYWRgLCBhc3luYyAoeyBvYmplY3RJRCB9KSA9PiB7XG4gICAgICBpZiAob2JqZWN0SUQgPT09IG51bGwpIHtcbiAgICAgICAgcmV0dXJuIHsgb2JqZWN0OiBudWxsIH07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4geyBvYmplY3Q6IGF3YWl0IHRoaXMucmVhZChvYmplY3RJRCkgfTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxufVxuXG5cbmV4cG9ydCB0eXBlIE1hbmFnZWREYXRhQ2hhbmdlUmVwb3J0ZXI8SURUeXBlPiA9XG4oY2hhbmdlZElEcz86IElEVHlwZVtdKSA9PiBQcm9taXNlPHZvaWQ+O1xuLyogRnVuY3Rpb24gb2YgdGhpcyBzaWduYXR1cmUgd2lsbCBiZSBwYXNzZWQgdG8gbWFuYWdlciBjb25zdHJ1Y3RvcixcbiAgIHRvIGJlIGNhbGxlZCB3aGVuIG1hbmFnZXIgcmVwb3J0cyBkYXRhIHVwZGF0ZXMgdG8gYXBwIHdpbmRvd3MsXG4gICBsZXR0aW5nIGFueSBvYmplY3QgbGlzdHMgcmUtcXVlcnkgdGhlIGRhdGEuXG5cbiAgIGBjaGFuZ2VkSURzYCBpcyBpbnRlbmRlZCB0byBhdm9pZCB1bm5lY2Vzc2FyeSByZS1xdWVyeWluZy5cbiAgIEFuIG9iamVjdCByZWZlcmVuY2VkIGluIGl0IG1heSBoYXZlIGJlZW4gY3JlYXRlZCxcbiAgIG1vZGlmaWVkIG9yIGRlbGV0ZWQuXG4gICBcbiAgIE1hbmFnZXIgbXVzdCBvbWl0IGBjaGFuZ2VkSURzYCBpZiBpdCBpcyBub3Qgc3VyZVxuICAgd2hpY2ggZXhhY3RseSBvYmplY3RzIGRpZCBjaGFuZ2UuICovXG5cblxuZXhwb3J0IHR5cGUgQmFja2VuZFN0YXR1c1JlcG9ydGVyPFN0YXR1cz4gPVxuKHBheWxvYWQ6IFBhcnRpYWw8U3RhdHVzPikgPT4gUHJvbWlzZTx2b2lkPjtcbi8qIEZ1bmN0aW9uIG9mIHRoaXMgc2lnbmF0dXJlIHdpbGwgYmUgcGFzc2VkIHRvIGJhY2tlbmQgY29uc3RydWN0b3IsXG4gICB0byBiZSBjYWxsZWQgd2hlbiBiYWNrZW5kIG5lZWRzIHRvIHJlcG9ydCBzdGF0dXMgdG8gYXBwIHdpbmRvd3MuICovXG5cblxuZXhwb3J0IGludGVyZmFjZSBCYWNrZW5kQ2xhc3M8XG4gICAgSW5pdGlhbE9wdGlvbnMgZXh0ZW5kcyBvYmplY3QsXG4gICAgT3B0aW9ucyBleHRlbmRzIEluaXRpYWxPcHRpb25zLFxuICAgIFN0YXR1cyBleHRlbmRzIG9iamVjdD4ge1xuICAvKiBJbml0aWFsIG9wdGlvbnMgYXJlIHN1cHBsaWVkIGJ5IHRoZSBkZXZlbG9wZXIuXG4gICAgIEZ1bGwgb3B0aW9ucyBpbmNsdWRlIG9wdGlvbnMgY29uZmlndXJhYmxlIGJ5IHRoZSB1c2VyLCBzb21lIG9mIHdoaWNoIG1heSBiZSByZXF1aXJlZC5cblxuICAgICBOT1RFOiBCeSDigJxPcHRpb27igJ0sIGJhY2tlbmQgY29uc3RydWN0b3IgcGFyYW1ldGVyIGlzIG1lYW50LlxuICAgICBUT0RPOiBUaGlzIGlzIGEgbWlzbm9tZXIgc2luY2Ugc29tZSBvZiB0aG9zZSBhcmUgbm9uLW9wdGlvbmFsLiAqL1xuXG4gIG5ldyAoXG4gICAgb3B0aW9uczogT3B0aW9ucyxcbiAgICByZXBvcnRCYWNrZW5kU3RhdHVzOiBCYWNrZW5kU3RhdHVzUmVwb3J0ZXI8U3RhdHVzPixcbiAgKTogQmFja2VuZFxuICAvLyBCYWNrZW5kIGNsYXNzZXMgYXJlIGluc3RhbnRpYXRlZCBieSB0aGUgZnJhbWV3b3JrIGR1cmluZyBhcHAgaW5pdGlhbGl6YXRpb24uXG5cbiAgcmVnaXN0ZXJTZXR0aW5nc0ZvckNvbmZpZ3VyYWJsZU9wdGlvbnM/KFxuICAgIHNldHRpbmdzOiBTZXR0aW5nTWFuYWdlcixcbiAgICBpbml0aWFsT3B0aW9uczogUGFydGlhbDxJbml0aWFsT3B0aW9ucz4sXG4gICAgZGJJRDogc3RyaW5nKTogdm9pZFxuICAvKiBHaXZlbiBpbml0aWFsIG9wdGlvbnMgYW5kIGEgc2V0dGluZ3MgbWFuYWdlcixcbiAgICAgcmVnaXN0ZXIgdXNlci1jb25maWd1cmFibGUgc2V0dGluZ3MgdGhhdCBjb250cm9sIHRoaXMgRELigJlzIGJlaGF2aW9yLlxuICAgICBUaGlzIG1ldGhvZCBjYW4gbWFrZSBhIHNldHRpbmcgcmVxdWlyZWQgaWYgY29ycmVzcG9uZGluZyBvcHRpb25cbiAgICAgaXMgbm90IHByb3ZpZGVkIGJ5IHRoZSBkZXZlbG9wZXIgaW4gdGhlIGluaXRpYWwgb3B0aW9ucy4gKi9cblxuICBjb21wbGV0ZU9wdGlvbnNGcm9tU2V0dGluZ3M/KFxuICAgIHNldHRpbmdzOiBTZXR0aW5nTWFuYWdlcixcbiAgICBpbml0aWFsT3B0aW9uczogUGFydGlhbDxJbml0aWFsT3B0aW9ucz4sXG4gICAgZGJJRDogc3RyaW5nKTogUHJvbWlzZTxPcHRpb25zPlxuICAvKiBHaXZlbiBpbml0aWFsIG9wdGlvbnMgYW5kIGEgc2V0dGluZ3MgbWFuYWdlcixcbiAgICAgcmV0cmlldmUgYW55IHVzZXItY29uZmlndXJlZCBvcHRpb25zIGlmIG5lZWRlZFxuICAgICBhbmQgcmV0dXJuIGZ1bGwgb3B0aW9ucyBvYmplY3QgcmVxdWlyZWQgYnkgdGhpcyBiYWNrZW5kLiAqL1xufVxuXG5cbi8vIFZlcnNpb25lZCBiYWNrZW5kICYgY29tcGF0aWJsZSBtYW5hZ2VyLlxuXG5leHBvcnQgYWJzdHJhY3QgY2xhc3MgVmVyc2lvbmVkQmFja2VuZDxJRFR5cGUgPSBBbnlJRFR5cGU+IGV4dGVuZHMgQmFja2VuZDxJRFR5cGU+IHtcblxuICBhYnN0cmFjdCBkaXNjYXJkKG9iaklEczogSURUeXBlW10pOiBQcm9taXNlPHZvaWQ+XG4gIC8qIERpc2NhcmQgYW55IHVuY29tbWl0dGVkIGNoYW5nZXMgbWFkZSB0byBvYmplY3RzIHdpdGggc3BlY2lmaWVkIElEcy4gKi9cblxuICBhYnN0cmFjdCBjb21taXQob2JqSURzOiBJRFR5cGVbXSwgY29tbWl0TWVzc2FnZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPlxuICAvKiBDb21taXQgYW55IHVuY29tbWl0dGVkIGNoYW5nZXMgbWFkZSB0byBvYmplY3RzIHdpdGggc3BlY2lmaWVkIElEcyxcbiAgICAgd2l0aCBzcGVjaWZpZWQgY29tbWl0IG1lc3NhZ2UuICovXG5cbiAgYWJzdHJhY3QgbGlzdFVuY29tbWl0dGVkPygpOiBQcm9taXNlPElEVHlwZVtdPlxuICAvKiBMaXN0IElEcyBvZiBvYmplY3RzIHdpdGggdW5jb21taXR0ZWQgY2hhbmdlcy4gKi9cblxufVxuXG5cbmV4cG9ydCBhYnN0cmFjdCBjbGFzcyBNb2RlbE1hbmFnZXI8TSBleHRlbmRzIE1vZGVsLCBJRFR5cGUgZXh0ZW5kcyBBbnlJRFR5cGUsIFEgZXh0ZW5kcyBvYmplY3QgPSBvYmplY3Q+IHtcbiAgLyogUGFzc2VzIGNhbGxzIG9uIHRvIGNvcnJlc3BvbmRpbmcgQmFja2VuZCAob3Igc3ViY2xhc3MpIG1ldGhvZHMsXG4gICAgIGJ1dCBsaW1pdHMgdGhlaXIgc2NvcGUgb25seSB0byBvYmplY3RzIG1hbmlwdWxhdGVkIGJ5IHRoaXMgbWFuYWdlci4gKi9cblxuICBhYnN0cmFjdCBjb3VudChxdWVyeT86IFEpOiBQcm9taXNlPG51bWJlcj5cbiAgYWJzdHJhY3QgcmVwb3J0VXBkYXRlZERhdGE6IE1hbmFnZWREYXRhQ2hhbmdlUmVwb3J0ZXI8SURUeXBlPlxuXG4gIGFic3RyYWN0IGxpc3RJRHMocXVlcnk/OiBRKTogUHJvbWlzZTxJRFR5cGVbXT5cbiAgLy8gVE9ETzogUmV0dXJuZWQgSURzIGNhbm5vdCBhdXRvbWF0aWNhbGx5IGJlIGNhc3QgdG8gSURUeXBlO1xuICAvLyBnZXQgcmlkIG9mIElEVHlwZSBnZW5lcmljIGFuZCBtYW5hZ2UgdHlwZXMgaW4gc3ViY2xhc3Nlcz9cblxuICBhYnN0cmFjdCByZWFkQWxsKHF1ZXJ5PzogUSk6IFByb21pc2U8SW5kZXg8TT4+XG4gIGFic3RyYWN0IHJlYWQoaWQ6IElEVHlwZSk6IFByb21pc2U8TT5cbiAgYWJzdHJhY3QgY3JlYXRlKG9iajogTSwgLi4uYXJnczogYW55W10pOiBQcm9taXNlPHZvaWQ+XG4gIGFic3RyYWN0IHVwZGF0ZShvYmpJRDogSURUeXBlLCBvYmo6IE0sIC4uLmFyZ3M6IGFueVtdKTogUHJvbWlzZTx2b2lkPlxuICBhYnN0cmFjdCBkZWxldGUob2JqSUQ6IElEVHlwZSwgLi4uYXJnczogdW5rbm93bltdKTogUHJvbWlzZTx2b2lkPlxuXG4gIHByb3RlY3RlZCBhYnN0cmFjdCBnZXREQlJlZihvYmpJRDogSURUeXBlIHwgc3RyaW5nKTogc3RyaW5nXG4gIHByb3RlY3RlZCBhYnN0cmFjdCBnZXRPYmpJRChkYlJlZjogc3RyaW5nKTogSURUeXBlXG5cbiAgYXN5bmMgaW5pdCgpIHt9XG5cbiAgc2V0VXBJUEMobW9kZWxOYW1lOiBzdHJpbmcpIHtcbiAgICAvKiBJbml0aWFsaXplcyBJUEMgZW5kcG9pbnRzIHRvIHF1ZXJ5IG9yIHVwZGF0ZSBkYXRhIG9iamVjdHMuICovXG5cbiAgICBjb25zdCBwcmVmaXggPSBgbW9kZWwtJHttb2RlbE5hbWV9YDtcblxuICAgIGxpc3Rlbjx7IHF1ZXJ5PzogUSB9LCB7IGlkczogSURUeXBlW10gfT5cbiAgICAoYCR7cHJlZml4fS1saXN0LWlkc2AsIGFzeW5jICh7IHF1ZXJ5IH0pID0+ICh7IGlkczogKGF3YWl0IHRoaXMubGlzdElEcyhxdWVyeSkpIH0pKTtcblxuICAgIGxpc3Rlbjx7IHF1ZXJ5PzogUSB9LCB7IGNvdW50OiBudW1iZXIgfT5cbiAgICAoYCR7cHJlZml4fS1jb3VudGAsIGFzeW5jICh7IHF1ZXJ5IH0pID0+ICh7IGNvdW50OiBhd2FpdCB0aGlzLmNvdW50KHF1ZXJ5KSB9KSk7XG5cbiAgICBsaXN0ZW48eyBxdWVyeT86IFEgfSwgSW5kZXg8TT4+XG4gICAgKGAke3ByZWZpeH0tcmVhZC1hbGxgLCBhc3luYyAoeyBxdWVyeSB9KSA9PiB0aGlzLnJlYWRBbGwocXVlcnkpKTtcblxuICAgIGxpc3Rlbjx7IG9iamVjdElEOiBJRFR5cGUgfCBudWxsIH0sIHsgb2JqZWN0OiBNIHwgbnVsbCB9PlxuICAgIChgJHtwcmVmaXh9LXJlYWQtb25lYCwgYXN5bmMgKHsgb2JqZWN0SUQgfSkgPT4ge1xuICAgICAgaWYgKG9iamVjdElEID09PSBudWxsKSB7XG4gICAgICAgIHJldHVybiB7IG9iamVjdDogbnVsbCB9O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIHsgb2JqZWN0OiBhd2FpdCB0aGlzLnJlYWQob2JqZWN0SUQpIH07XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBsaXN0ZW48eyBvYmplY3RJRDogSURUeXBlLCBvYmplY3Q6IE0sIGNvbW1pdDogYm9vbGVhbiB9LCB7IHN1Y2Nlc3M6IHRydWUgfT5cbiAgICAoYCR7cHJlZml4fS11cGRhdGUtb25lYCwgYXN5bmMgKHsgb2JqZWN0SUQsIG9iamVjdCwgY29tbWl0IH0pID0+IHtcbiAgICAgIGF3YWl0IHRoaXMudXBkYXRlKG9iamVjdElELCBvYmplY3QsIGNvbW1pdCk7XG4gICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlIH07XG4gICAgfSk7XG5cbiAgICBsaXN0ZW48eyBvYmplY3Q6IE0sIGNvbW1pdDogYm9vbGVhbiB9LCB7IHN1Y2Nlc3M6IHRydWUgfT5cbiAgICAoYCR7cHJlZml4fS1jcmVhdGUtb25lYCwgYXN5bmMgKHsgb2JqZWN0LCBjb21taXQgfSkgPT4ge1xuICAgICAgYXdhaXQgdGhpcy5jcmVhdGUob2JqZWN0LCBjb21taXQpO1xuICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSB9O1xuICAgIH0pO1xuICB9XG59XG5cblxuZXhwb3J0IGNsYXNzIENvbW1pdEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihwdWJsaWMgY29kZTogc3RyaW5nLCBtc2c6IHN0cmluZykge1xuICAgIHN1cGVyKG1zZyk7XG4gICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHRoaXMsIG5ldy50YXJnZXQucHJvdG90eXBlKTtcbiAgfVxufVxuXG5cbi8vIFZlcnNpb25lZCBiYWNrZW5kIHNwZWNpZmljYWxseSBiYXNlZCBvbiBsb2NhbCBmaWxlc3lzdGVtLFxuLy8gYW5kIHJlcXVpc2l0ZSBtYW5hZ2VyIGludGVyZmFjZVxuXG5leHBvcnQgYWJzdHJhY3QgY2xhc3MgVmVyc2lvbmVkRmlsZXN5c3RlbUJhY2tlbmQgZXh0ZW5kcyBWZXJzaW9uZWRCYWNrZW5kPHN0cmluZz4ge1xuXG4gIGFic3RyYWN0IGdldEluZGV4KGlkRmllbGQ6IHN0cmluZywgc3ViZGlyOiBzdHJpbmcsIG9ubHlJRHM/OiBzdHJpbmdbXSk6IFByb21pc2U8SW5kZXg8YW55Pj5cblxuICBhYnN0cmFjdCByZWdpc3Rlck1hbmFnZXIobWFuYWdlcjogRmlsZXN5c3RlbU1hbmFnZXIpOiB2b2lkXG4gIC8qIEVuYWJsZXMgaW5zdGFuY2VzIG9mIHRoaXMgYmFja2VuZCB0byBrZWVwIHRyYWNrIG9mIG1hbmFnZXJzLFxuICAgICB3aGljaCBpcyByZXF1aXJlZCBmb3IgdGhlIHB1cnBvc2Ugb2YgZXhjbHVkaW5nIGZpbGVzXG4gICAgIGNyZWF0ZWQgYXJiaXRyYXJpbHkgYnkgT1Mgb3Igb3RoZXIgc29mdHdhcmVcbiAgICAgZnJvbSB2ZXJzaW9uIGNvbnRyb2wgKHNlZSBgcmVzZXRPcnBoYW5lZEZpbGVDaGFuZ2VzKClgKS5cblxuICAgICBOT1RFOiBTbyBmYXIgdGhpcyBpcyB0aGUgb25seSByZWFzb24gREIgYmFja2VuZCBuZWVkcyB0byBrZWVwIHRyYWNrXG4gICAgIG9mIGFzc29jaWF0ZWQgbWFuYWdlcnMuXG4gICAgIENvdWxkIERCIGJhY2tlbmQgYmUgbWFkZSBhd2FyZSBvZiB3aGljaCBmaWxlc1xuICAgICBpdOKAmXMgcmVzcG9uc2libGUgZm9yP1xuICAgICBBdm9pZGluZyB0aGlzIGRlcGVuZGVuY3kgb24gbWFuYWdlcnNcbiAgICAgd291bGQgYmUgYmVuZWZpY2lhbCwgaWYgdGhlcmXigJlzIGFuIGVsZWdhbnQgd2F5IG9mIGRvaW5nIGl0LiAqL1xuXG4gIGFic3RyYWN0IHJlc2V0T3JwaGFuZWRGaWxlQ2hhbmdlcygpOiBQcm9taXNlPHZvaWQ+XG4gIC8qIEhvdXNla2VlcGluZyBtZXRob2QgZm9yIGZpbGUtYmFzZWQgREIgYmFja2VuZC4gKi9cblxufVxuXG5cbmV4cG9ydCBpbnRlcmZhY2UgRmlsZXN5c3RlbU1hbmFnZXIge1xuICBtYW5hZ2VzRmlsZUF0UGF0aChmaWxlUGF0aDogc3RyaW5nKTogYm9vbGVhblxuICAvKiBEZXRlcm1pbmVzIHdoZXRoZXIgdGhlIG1hbmFnZXIgaW5zdGFuY2UgaXMgcmVzcG9uc2libGUgZm9yIHRoZSBmaWxlXG4gICAgIHVuZGVyIGdpdmVuIHBhdGguICovXG59XG4iXX0=