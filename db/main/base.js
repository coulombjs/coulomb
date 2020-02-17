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
    }
}
// Versioned backend & compatible manager.
export class VersionedBackend extends Backend {
}
export class ModelManager {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFzZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9kYi9tYWluL2Jhc2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBSUEsT0FBTyxFQUFFLE1BQU0sRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBR3hDLG1CQUFtQjtBQUVuQixNQUFNLE9BQWdCLE9BQU87SUE0QjNCLFFBQVEsQ0FBQyxJQUFZO1FBQ25CO3lEQUNpRDtRQUVqRCxNQUFNLE1BQU0sR0FBRyxNQUFNLElBQUksRUFBRSxDQUFDO1FBRTVCLE1BQU0sQ0FDTCxHQUFHLE1BQU0sV0FBVyxFQUFFLEtBQUssSUFBSSxFQUFFO1lBQ2hDLE9BQU8sTUFBTSxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7UUFDL0IsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUEwREQsMENBQTBDO0FBRTFDLE1BQU0sT0FBZ0IsZ0JBQXFDLFNBQVEsT0FBZTtDQVlqRjtBQUdELE1BQU0sT0FBZ0IsWUFBWTtJQW9CaEMsUUFBUSxDQUFDLFNBQWlCO1FBQ3hCLGdFQUFnRTtRQUVoRSxNQUFNLE1BQU0sR0FBRyxTQUFTLFNBQVMsRUFBRSxDQUFDO1FBRXBDLE1BQU0sQ0FDTCxHQUFHLE1BQU0sV0FBVyxFQUFFLEtBQUssRUFBRSxFQUFFLEtBQUssRUFBRSxFQUFFLEVBQUUsQ0FBQyxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsTUFBTSxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFFcEYsTUFBTSxDQUNMLEdBQUcsTUFBTSxRQUFRLEVBQUUsS0FBSyxFQUFFLEVBQUUsS0FBSyxFQUFFLEVBQUUsRUFBRSxDQUFDLENBQUMsRUFBRSxLQUFLLEVBQUUsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBRS9FLE1BQU0sQ0FDTCxHQUFHLE1BQU0sV0FBVyxFQUFFLEtBQUssRUFBRSxFQUFFLEtBQUssRUFBRSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7UUFFakUsTUFBTSxDQUNMLEdBQUcsTUFBTSxXQUFXLEVBQUUsS0FBSyxFQUFFLEVBQUUsUUFBUSxFQUFFLEVBQUUsRUFBRTtZQUM1QyxJQUFJLFFBQVEsS0FBSyxJQUFJLEVBQUU7Z0JBQ3JCLE9BQU8sRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLENBQUM7YUFDekI7aUJBQU07Z0JBQ0wsT0FBTyxFQUFFLE1BQU0sRUFBRSxNQUFNLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQzthQUM5QztRQUNILENBQUMsQ0FBQyxDQUFDO1FBRUgsTUFBTSxDQUNMLEdBQUcsTUFBTSxhQUFhLEVBQUUsS0FBSyxFQUFFLEVBQUUsUUFBUSxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsRUFBRSxFQUFFO1lBQzlELE1BQU0sSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLEVBQUUsTUFBTSxFQUFFLE1BQU0sQ0FBQyxDQUFDO1lBQzVDLE9BQU8sRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLENBQUM7UUFDM0IsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUFHRCxNQUFNLE9BQU8sV0FBWSxTQUFRLEtBQUs7SUFDcEMsWUFBbUIsSUFBWSxFQUFFLEdBQVc7UUFDMUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBRE0sU0FBSSxHQUFKLElBQUksQ0FBUTtRQUU3QixNQUFNLENBQUMsY0FBYyxDQUFDLElBQUksRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQ3BELENBQUM7Q0FDRjtBQUdELDREQUE0RDtBQUM1RCxrQ0FBa0M7QUFFbEMsTUFBTSxPQUFnQiwwQkFBMkIsU0FBUSxnQkFBd0I7Q0FvQmhGIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQW55SURUeXBlLCBNb2RlbCB9IGZyb20gJy4uL21vZGVscyc7XG5pbXBvcnQgeyBTZXR0aW5nTWFuYWdlciB9IGZyb20gJy4uLy4uL3NldHRpbmdzL21haW4nO1xuaW1wb3J0IHsgSW5kZXggfSBmcm9tICcuLi9xdWVyeSc7XG5pbXBvcnQgeyBCYWNrZW5kRGVzY3JpcHRpb24gfSBmcm9tICcuLi9iYXNlJztcbmltcG9ydCB7IGxpc3RlbiB9IGZyb20gJy4uLy4uL2lwYy9tYWluJztcblxuXG4vLyBHZW5lcmljIGJhY2tlbmQuXG5cbmV4cG9ydCBhYnN0cmFjdCBjbGFzcyBCYWNrZW5kPElEVHlwZSA9IEFueUlEVHlwZT4ge1xuICBhYnN0cmFjdCBpbml0KCk6IFByb21pc2U8dm9pZD5cbiAgLyogSW5pdGlhbGl6ZXMgdGhlIGJhY2tlbmQuXG4gICAgIFRoaXMgbWF5IGludm9sdmUgbG9hZGluZyBkYXRhIGZyb20gcmVtb3RlIHN0b3JhZ2UsXG4gICAgIHRodXMgaW5pdGlhbCBhdXRoZW50aWNhdGlvbiwgZXRjLiAqL1xuXG4gIGFic3RyYWN0IGRlc2NyaWJlKCk6IFByb21pc2U8QmFja2VuZERlc2NyaXB0aW9uPGFueT4+XG5cbiAgLy8gRm9sbG93aW5nIGFyZSBkYXRhIHF1ZXJ5ICYgdXBkYXRlIG1ldGhvZHMuXG4gIC8vIE9uZSBEQiBtYXkgb3BlcmF0ZSBhIGhldGVyb2dlbmVvdXMgY29sbGVjdGlvbiBvZiBvYmplY3RzLlxuICAvLyBSZWNvZ25pemluZyB0aGVpciB0eXBlcyBpcyBub3Qgd2l0aGluIERCIGJhY2tlbmTigJlzIHNjb3BlLlxuICAvLyBUaGVzZSBtZXRob2RzIHJhdGhlciBvcGVyYXRlIGxvd2VyLWxldmVsXG4gIC8vIGdlbmVyaWMgb2JqZWN0IHBheWxvYWRzIGFuZCBvYmplY3QgSURzLlxuICAvL1xuICAvLyBSZWNvZ25pemluZyBwYXJ0aWN1bGFyIGRhdGEgdHlwZXMgaXMgTWFuYWdlcuKAmXMgam9iOlxuICAvLyB0aGUgYXBwIHdvdWxkIHF1ZXJ5IGRhdGEgb2JqZWN0cyB2aWEgY29ycmVzcG9uZGluZyBtYW5hZ2VyLFxuICAvLyB3aGljaCBpbiB0dXJuIHdvdWxkIGNhbGwgdGhlc2UgbWV0aG9kc1xuICAvLyBmaWxsaW5nIGluIGFwcHJvcHJpYXRlIGFyZ3VtZW50cy5cblxuICBhYnN0cmFjdCBnZXRJbmRleChpZEZpZWxkOiBzdHJpbmcsIC4uLmFyZ3M6IGFueVtdKTogUHJvbWlzZTxJbmRleDxhbnk+PlxuICAvLyBERVBSRUNBVEVEOiBSZWFkaW5nIGFsbCBEQiBvYmplY3RzIHdpdGhvdXQgYW55IGZpbHRlcmluZyBxdWVyeSB3aWxsIGJlIHRvbyBzbG93LlxuXG4gIGFic3RyYWN0IGxpc3RJRHMocXVlcnk6IG9iamVjdCk6IFByb21pc2U8SURUeXBlW10+XG4gIGFic3RyYWN0IHJlYWQob2JqSUQ6IElEVHlwZSwgLi4uYXJnczogYW55W10pOiBQcm9taXNlPG9iamVjdD5cbiAgYWJzdHJhY3QgY3JlYXRlKG9iajogb2JqZWN0LCAuLi5hcmdzOiBhbnlbXSk6IFByb21pc2U8dm9pZD5cbiAgYWJzdHJhY3QgdXBkYXRlKG9iaklEOiBJRFR5cGUsIG9iajogb2JqZWN0LCAuLi5hcmdzOiBhbnlbXSk6IFByb21pc2U8dm9pZD5cbiAgYWJzdHJhY3QgZGVsZXRlKG9iaklEOiBJRFR5cGUsIC4uLmFyZ3M6IGFueVtdKTogUHJvbWlzZTx2b2lkPlxuXG4gIHNldFVwSVBDKGRiSUQ6IHN0cmluZyk6IHZvaWQge1xuICAgIC8qIEluaXRpYWxpemVzIElQQyBlbmRwb2ludHMgdG8gZW5hYmxlIHRoZSB1c2VyIHRvIGUuZy4gY29uZmlndXJlIHRoZSBkYXRhIHN0b3JlXG4gICAgICAgb3IgaW52b2tlIGhvdXNla2VlcGluZyBvciB1dGlsaXR5IHJvdXRpbmVzLiAqL1xuXG4gICAgY29uc3QgcHJlZml4ID0gYGRiLSR7ZGJJRH1gO1xuXG4gICAgbGlzdGVuPHt9LCBCYWNrZW5kRGVzY3JpcHRpb248YW55Pj5cbiAgICAoYCR7cHJlZml4fS1kZXNjcmliZWAsIGFzeW5jICgpID0+IHtcbiAgICAgIHJldHVybiBhd2FpdCB0aGlzLmRlc2NyaWJlKCk7XG4gICAgfSk7XG4gIH1cbn1cblxuXG5leHBvcnQgdHlwZSBNYW5hZ2VkRGF0YUNoYW5nZVJlcG9ydGVyPElEVHlwZT4gPVxuKGNoYW5nZWRJRHM/OiBJRFR5cGVbXSkgPT4gUHJvbWlzZTx2b2lkPjtcbi8qIEZ1bmN0aW9uIG9mIHRoaXMgc2lnbmF0dXJlIHdpbGwgYmUgcGFzc2VkIHRvIG1hbmFnZXIgY29uc3RydWN0b3IsXG4gICB0byBiZSBjYWxsZWQgd2hlbiBtYW5hZ2VyIHJlcG9ydHMgZGF0YSB1cGRhdGVzIHRvIGFwcCB3aW5kb3dzLFxuICAgbGV0dGluZyBhbnkgb2JqZWN0IGxpc3RzIHJlLXF1ZXJ5IHRoZSBkYXRhLlxuXG4gICBgY2hhbmdlZElEc2AgaXMgaW50ZW5kZWQgdG8gYXZvaWQgdW5uZWNlc3NhcnkgcmUtcXVlcnlpbmcuXG4gICBBbiBvYmplY3QgcmVmZXJlbmNlZCBpbiBpdCBtYXkgaGF2ZSBiZWVuIGNyZWF0ZWQsXG4gICBtb2RpZmllZCBvciBkZWxldGVkLlxuICAgXG4gICBNYW5hZ2VyIG11c3Qgb21pdCBgY2hhbmdlZElEc2AgaWYgaXQgaXMgbm90IHN1cmVcbiAgIHdoaWNoIGV4YWN0bHkgb2JqZWN0cyBkaWQgY2hhbmdlLiAqL1xuXG5cbmV4cG9ydCB0eXBlIEJhY2tlbmRTdGF0dXNSZXBvcnRlcjxTdGF0dXM+ID1cbihwYXlsb2FkOiBQYXJ0aWFsPFN0YXR1cz4pID0+IFByb21pc2U8dm9pZD47XG4vKiBGdW5jdGlvbiBvZiB0aGlzIHNpZ25hdHVyZSB3aWxsIGJlIHBhc3NlZCB0byBiYWNrZW5kIGNvbnN0cnVjdG9yLFxuICAgdG8gYmUgY2FsbGVkIHdoZW4gYmFja2VuZCBuZWVkcyB0byByZXBvcnQgc3RhdHVzIHRvIGFwcCB3aW5kb3dzLiAqL1xuXG5cbmV4cG9ydCBpbnRlcmZhY2UgQmFja2VuZENsYXNzPFxuICAgIEluaXRpYWxPcHRpb25zIGV4dGVuZHMgb2JqZWN0LFxuICAgIE9wdGlvbnMgZXh0ZW5kcyBJbml0aWFsT3B0aW9ucyxcbiAgICBTdGF0dXMgZXh0ZW5kcyBvYmplY3Q+IHtcbiAgLyogSW5pdGlhbCBvcHRpb25zIGFyZSBzdXBwbGllZCBieSB0aGUgZGV2ZWxvcGVyLlxuICAgICBGdWxsIG9wdGlvbnMgaW5jbHVkZSBvcHRpb25zIGNvbmZpZ3VyYWJsZSBieSB0aGUgdXNlciwgc29tZSBvZiB3aGljaCBtYXkgYmUgcmVxdWlyZWQuXG5cbiAgICAgTk9URTogQnkg4oCcT3B0aW9u4oCdLCBiYWNrZW5kIGNvbnN0cnVjdG9yIHBhcmFtZXRlciBpcyBtZWFudC5cbiAgICAgVE9ETzogVGhpcyBpcyBhIG1pc25vbWVyIHNpbmNlIHNvbWUgb2YgdGhvc2UgYXJlIG5vbi1vcHRpb25hbC4gKi9cblxuICBuZXcgKFxuICAgIG9wdGlvbnM6IE9wdGlvbnMsXG4gICAgcmVwb3J0QmFja2VuZFN0YXR1czogQmFja2VuZFN0YXR1c1JlcG9ydGVyPFN0YXR1cz4sXG4gICk6IEJhY2tlbmRcbiAgLy8gQmFja2VuZCBjbGFzc2VzIGFyZSBpbnN0YW50aWF0ZWQgYnkgdGhlIGZyYW1ld29yayBkdXJpbmcgYXBwIGluaXRpYWxpemF0aW9uLlxuXG4gIHJlZ2lzdGVyU2V0dGluZ3NGb3JDb25maWd1cmFibGVPcHRpb25zPyhcbiAgICBzZXR0aW5nczogU2V0dGluZ01hbmFnZXIsXG4gICAgaW5pdGlhbE9wdGlvbnM6IFBhcnRpYWw8SW5pdGlhbE9wdGlvbnM+LFxuICAgIGRiSUQ6IHN0cmluZyk6IHZvaWRcbiAgLyogR2l2ZW4gaW5pdGlhbCBvcHRpb25zIGFuZCBhIHNldHRpbmdzIG1hbmFnZXIsXG4gICAgIHJlZ2lzdGVyIHVzZXItY29uZmlndXJhYmxlIHNldHRpbmdzIHRoYXQgY29udHJvbCB0aGlzIERC4oCZcyBiZWhhdmlvci5cbiAgICAgVGhpcyBtZXRob2QgY2FuIG1ha2UgYSBzZXR0aW5nIHJlcXVpcmVkIGlmIGNvcnJlc3BvbmRpbmcgb3B0aW9uXG4gICAgIGlzIG5vdCBwcm92aWRlZCBieSB0aGUgZGV2ZWxvcGVyIGluIHRoZSBpbml0aWFsIG9wdGlvbnMuICovXG5cbiAgY29tcGxldGVPcHRpb25zRnJvbVNldHRpbmdzPyhcbiAgICBzZXR0aW5nczogU2V0dGluZ01hbmFnZXIsXG4gICAgaW5pdGlhbE9wdGlvbnM6IFBhcnRpYWw8SW5pdGlhbE9wdGlvbnM+LFxuICAgIGRiSUQ6IHN0cmluZyk6IFByb21pc2U8T3B0aW9ucz5cbiAgLyogR2l2ZW4gaW5pdGlhbCBvcHRpb25zIGFuZCBhIHNldHRpbmdzIG1hbmFnZXIsXG4gICAgIHJldHJpZXZlIGFueSB1c2VyLWNvbmZpZ3VyZWQgb3B0aW9ucyBpZiBuZWVkZWRcbiAgICAgYW5kIHJldHVybiBmdWxsIG9wdGlvbnMgb2JqZWN0IHJlcXVpcmVkIGJ5IHRoaXMgYmFja2VuZC4gKi9cbn1cblxuXG4vLyBWZXJzaW9uZWQgYmFja2VuZCAmIGNvbXBhdGlibGUgbWFuYWdlci5cblxuZXhwb3J0IGFic3RyYWN0IGNsYXNzIFZlcnNpb25lZEJhY2tlbmQ8SURUeXBlID0gQW55SURUeXBlPiBleHRlbmRzIEJhY2tlbmQ8SURUeXBlPiB7XG5cbiAgYWJzdHJhY3QgZGlzY2FyZChvYmpJRHM6IElEVHlwZVtdKTogUHJvbWlzZTx2b2lkPlxuICAvKiBEaXNjYXJkIGFueSB1bmNvbW1pdHRlZCBjaGFuZ2VzIG1hZGUgdG8gb2JqZWN0cyB3aXRoIHNwZWNpZmllZCBJRHMuICovXG5cbiAgYWJzdHJhY3QgY29tbWl0KG9iaklEczogSURUeXBlW10sIGNvbW1pdE1lc3NhZ2U6IHN0cmluZyk6IFByb21pc2U8dm9pZD5cbiAgLyogQ29tbWl0IGFueSB1bmNvbW1pdHRlZCBjaGFuZ2VzIG1hZGUgdG8gb2JqZWN0cyB3aXRoIHNwZWNpZmllZCBJRHMsXG4gICAgIHdpdGggc3BlY2lmaWVkIGNvbW1pdCBtZXNzYWdlLiAqL1xuXG4gIGFic3RyYWN0IGxpc3RVbmNvbW1pdHRlZD8oKTogUHJvbWlzZTxJRFR5cGVbXT5cbiAgLyogTGlzdCBJRHMgb2Ygb2JqZWN0cyB3aXRoIHVuY29tbWl0dGVkIGNoYW5nZXMuICovXG5cbn1cblxuXG5leHBvcnQgYWJzdHJhY3QgY2xhc3MgTW9kZWxNYW5hZ2VyPE0gZXh0ZW5kcyBNb2RlbCwgSURUeXBlIGV4dGVuZHMgQW55SURUeXBlLCBRIGV4dGVuZHMgb2JqZWN0ID0gb2JqZWN0PiB7XG4gIC8qIFBhc3NlcyBjYWxscyBvbiB0byBjb3JyZXNwb25kaW5nIEJhY2tlbmQgKG9yIHN1YmNsYXNzKSBtZXRob2RzLFxuICAgICBidXQgbGltaXRzIHRoZWlyIHNjb3BlIG9ubHkgdG8gb2JqZWN0cyBtYW5pcHVsYXRlZCBieSB0aGlzIG1hbmFnZXIuICovXG5cbiAgYWJzdHJhY3QgY291bnQocXVlcnk/OiBRKTogUHJvbWlzZTxudW1iZXI+XG4gIGFic3RyYWN0IHJlcG9ydFVwZGF0ZWREYXRhOiBNYW5hZ2VkRGF0YUNoYW5nZVJlcG9ydGVyPElEVHlwZT5cblxuICBhYnN0cmFjdCBsaXN0SURzKHF1ZXJ5PzogUSk6IFByb21pc2U8SURUeXBlW10+XG4gIC8vIFRPRE86IFJldHVybmVkIElEcyBjYW5ub3QgYXV0b21hdGljYWxseSBiZSBjYXN0IHRvIElEVHlwZTtcbiAgLy8gZ2V0IHJpZCBvZiBJRFR5cGUgZ2VuZXJpYyBhbmQgbWFuYWdlIHR5cGVzIGluIHN1YmNsYXNzZXM/XG5cbiAgYWJzdHJhY3QgcmVhZEFsbChxdWVyeT86IFEpOiBQcm9taXNlPEluZGV4PE0+PlxuICBhYnN0cmFjdCByZWFkKGlkOiBJRFR5cGUpOiBQcm9taXNlPE0+XG4gIGFic3RyYWN0IGNyZWF0ZShvYmo6IE0sIC4uLmFyZ3M6IGFueVtdKTogUHJvbWlzZTx2b2lkPlxuICBhYnN0cmFjdCB1cGRhdGUob2JqSUQ6IElEVHlwZSwgb2JqOiBNLCAuLi5hcmdzOiBhbnlbXSk6IFByb21pc2U8dm9pZD5cbiAgYWJzdHJhY3QgZGVsZXRlKG9iaklEOiBJRFR5cGUsIC4uLmFyZ3M6IHVua25vd25bXSk6IFByb21pc2U8dm9pZD5cblxuICBwcm90ZWN0ZWQgYWJzdHJhY3QgZ2V0REJSZWYob2JqSUQ6IElEVHlwZSB8IHN0cmluZyk6IHN0cmluZ1xuICBwcm90ZWN0ZWQgYWJzdHJhY3QgZ2V0T2JqSUQoZGJSZWY6IHN0cmluZyk6IElEVHlwZVxuXG4gIHNldFVwSVBDKG1vZGVsTmFtZTogc3RyaW5nKSB7XG4gICAgLyogSW5pdGlhbGl6ZXMgSVBDIGVuZHBvaW50cyB0byBxdWVyeSBvciB1cGRhdGUgZGF0YSBvYmplY3RzLiAqL1xuXG4gICAgY29uc3QgcHJlZml4ID0gYG1vZGVsLSR7bW9kZWxOYW1lfWA7XG5cbiAgICBsaXN0ZW48eyBxdWVyeT86IFEgfSwgeyBpZHM6IElEVHlwZVtdIH0+XG4gICAgKGAke3ByZWZpeH0tbGlzdC1pZHNgLCBhc3luYyAoeyBxdWVyeSB9KSA9PiAoeyBpZHM6IChhd2FpdCB0aGlzLmxpc3RJRHMocXVlcnkpKSB9KSk7XG5cbiAgICBsaXN0ZW48eyBxdWVyeT86IFEgfSwgeyBjb3VudDogbnVtYmVyIH0+XG4gICAgKGAke3ByZWZpeH0tY291bnRgLCBhc3luYyAoeyBxdWVyeSB9KSA9PiAoeyBjb3VudDogYXdhaXQgdGhpcy5jb3VudChxdWVyeSkgfSkpO1xuXG4gICAgbGlzdGVuPHsgcXVlcnk/OiBRIH0sIEluZGV4PE0+PlxuICAgIChgJHtwcmVmaXh9LXJlYWQtYWxsYCwgYXN5bmMgKHsgcXVlcnkgfSkgPT4gdGhpcy5yZWFkQWxsKHF1ZXJ5KSk7XG5cbiAgICBsaXN0ZW48eyBvYmplY3RJRDogSURUeXBlIHwgbnVsbCB9LCB7IG9iamVjdDogTSB8IG51bGwgfT5cbiAgICAoYCR7cHJlZml4fS1yZWFkLW9uZWAsIGFzeW5jICh7IG9iamVjdElEIH0pID0+IHtcbiAgICAgIGlmIChvYmplY3RJRCA9PT0gbnVsbCkge1xuICAgICAgICByZXR1cm4geyBvYmplY3Q6IG51bGwgfTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiB7IG9iamVjdDogYXdhaXQgdGhpcy5yZWFkKG9iamVjdElEKSB9O1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgbGlzdGVuPHsgb2JqZWN0SUQ6IElEVHlwZSwgb2JqZWN0OiBNLCBjb21taXQ6IGJvb2xlYW4gfSwgeyBzdWNjZXNzOiB0cnVlIH0+XG4gICAgKGAke3ByZWZpeH0tdXBkYXRlLW9uZWAsIGFzeW5jICh7IG9iamVjdElELCBvYmplY3QsIGNvbW1pdCB9KSA9PiB7XG4gICAgICBhd2FpdCB0aGlzLnVwZGF0ZShvYmplY3RJRCwgb2JqZWN0LCBjb21taXQpO1xuICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSB9O1xuICAgIH0pO1xuICB9XG59XG5cblxuZXhwb3J0IGNsYXNzIENvbW1pdEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihwdWJsaWMgY29kZTogc3RyaW5nLCBtc2c6IHN0cmluZykge1xuICAgIHN1cGVyKG1zZyk7XG4gICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHRoaXMsIG5ldy50YXJnZXQucHJvdG90eXBlKTtcbiAgfVxufVxuXG5cbi8vIFZlcnNpb25lZCBiYWNrZW5kIHNwZWNpZmljYWxseSBiYXNlZCBvbiBsb2NhbCBmaWxlc3lzdGVtLFxuLy8gYW5kIHJlcXVpc2l0ZSBtYW5hZ2VyIGludGVyZmFjZVxuXG5leHBvcnQgYWJzdHJhY3QgY2xhc3MgVmVyc2lvbmVkRmlsZXN5c3RlbUJhY2tlbmQgZXh0ZW5kcyBWZXJzaW9uZWRCYWNrZW5kPHN0cmluZz4ge1xuXG4gIGFic3RyYWN0IGdldEluZGV4KGlkRmllbGQ6IHN0cmluZywgc3ViZGlyOiBzdHJpbmcsIG9ubHlJRHM/OiBzdHJpbmdbXSk6IFByb21pc2U8SW5kZXg8YW55Pj5cblxuICBhYnN0cmFjdCByZWdpc3Rlck1hbmFnZXIobWFuYWdlcjogRmlsZXN5c3RlbU1hbmFnZXIpOiB2b2lkXG4gIC8qIEVuYWJsZXMgaW5zdGFuY2VzIG9mIHRoaXMgYmFja2VuZCB0byBrZWVwIHRyYWNrIG9mIG1hbmFnZXJzLFxuICAgICB3aGljaCBpcyByZXF1aXJlZCBmb3IgdGhlIHB1cnBvc2Ugb2YgZXhjbHVkaW5nIGZpbGVzXG4gICAgIGNyZWF0ZWQgYXJiaXRyYXJpbHkgYnkgT1Mgb3Igb3RoZXIgc29mdHdhcmVcbiAgICAgZnJvbSB2ZXJzaW9uIGNvbnRyb2wgKHNlZSBgcmVzZXRPcnBoYW5lZEZpbGVDaGFuZ2VzKClgKS5cblxuICAgICBOT1RFOiBTbyBmYXIgdGhpcyBpcyB0aGUgb25seSByZWFzb24gREIgYmFja2VuZCBuZWVkcyB0byBrZWVwIHRyYWNrXG4gICAgIG9mIGFzc29jaWF0ZWQgbWFuYWdlcnMuXG4gICAgIENvdWxkIERCIGJhY2tlbmQgYmUgbWFkZSBhd2FyZSBvZiB3aGljaCBmaWxlc1xuICAgICBpdOKAmXMgcmVzcG9uc2libGUgZm9yP1xuICAgICBBdm9pZGluZyB0aGlzIGRlcGVuZGVuY3kgb24gbWFuYWdlcnNcbiAgICAgd291bGQgYmUgYmVuZWZpY2lhbCwgaWYgdGhlcmXigJlzIGFuIGVsZWdhbnQgd2F5IG9mIGRvaW5nIGl0LiAqL1xuXG4gIGFic3RyYWN0IHJlc2V0T3JwaGFuZWRGaWxlQ2hhbmdlcygpOiBQcm9taXNlPHZvaWQ+XG4gIC8qIEhvdXNla2VlcGluZyBtZXRob2QgZm9yIGZpbGUtYmFzZWQgREIgYmFja2VuZC4gKi9cblxufVxuXG5cbmV4cG9ydCBpbnRlcmZhY2UgRmlsZXN5c3RlbU1hbmFnZXIge1xuICBtYW5hZ2VzRmlsZUF0UGF0aChmaWxlUGF0aDogc3RyaW5nKTogYm9vbGVhblxuICAvKiBEZXRlcm1pbmVzIHdoZXRoZXIgdGhlIG1hbmFnZXIgaW5zdGFuY2UgaXMgcmVzcG9uc2libGUgZm9yIHRoZSBmaWxlXG4gICAgIHVuZGVyIGdpdmVuIHBhdGguICovXG59XG4iXX0=