import { ipcRenderer } from 'electron';
import * as log from 'electron-log';
import React, { useState, useEffect } from 'react';
import { useIPCValue } from '../../ipc/renderer';
export const SingleDBStatusContext = React.createContext({
    verboseName: '',
    status: {},
});
const SingleDBStatusContextProvider = function (props) {
    const ipcPrefix = `db-${props.dbName}`;
    const [backendStatus, updateBackendStatus] = useState(undefined);
    const description = useIPCValue(`${ipcPrefix}-describe`, null);
    useEffect(() => {
        ipcRenderer.on(`${ipcPrefix}-status`, handleNewStatus);
        return function cleanup() {
            ipcRenderer.removeListener(`${ipcPrefix}-status`, handleNewStatus);
        };
    }, []);
    // Listen to status updates
    function handleNewStatus(evt, newStatus) {
        log.debug("Received new status for DB", props.dbName, newStatus);
        updateBackendStatus(newStatus);
    }
    return (React.createElement(SingleDBStatusContext.Provider, { value: description.value !== null
            ? Object.assign(Object.assign({}, description.value), { status: backendStatus || description.value.status }) : null }, props.children));
};
export default SingleDBStatusContextProvider;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2luZ2xlLWRiLXN0YXR1cy1jb250ZXh0LXByb3ZpZGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vc3JjL2RiL3JlbmRlcmVyL3NpbmdsZS1kYi1zdGF0dXMtY29udGV4dC1wcm92aWRlci50c3giXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLFVBQVUsQ0FBQztBQUN2QyxPQUFPLEtBQUssR0FBRyxNQUFNLGNBQWMsQ0FBQztBQUNwQyxPQUFPLEtBQUssRUFBRSxFQUFFLFFBQVEsRUFBRSxTQUFTLEVBQUUsTUFBTSxPQUFPLENBQUM7QUFDbkQsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLG9CQUFvQixDQUFDO0FBT2pELE1BQU0sQ0FBQyxNQUFNLHFCQUFxQixHQUFHLEtBQUssQ0FBQyxhQUFhLENBQWlDO0lBQ3ZGLFdBQVcsRUFBRSxFQUFFO0lBQ2YsTUFBTSxFQUFFLEVBQUU7Q0FDWCxDQUFDLENBQUM7QUFDSCxNQUFNLDZCQUE2QixHQUF5QyxVQUFVLEtBQUs7SUFFekYsTUFBTSxTQUFTLEdBQUcsTUFBTSxLQUFLLENBQUMsTUFBTSxFQUFFLENBQUM7SUFFdkMsTUFBTSxDQUFDLGFBQWEsRUFBRSxtQkFBbUIsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxTQUErQixDQUFDLENBQUM7SUFDdkYsTUFBTSxXQUFXLEdBQUcsV0FBVyxDQUFDLEdBQUcsU0FBUyxXQUFXLEVBQUUsSUFBc0MsQ0FBQyxDQUFDO0lBRWpHLFNBQVMsQ0FBQyxHQUFHLEVBQUU7UUFDYixXQUFXLENBQUMsRUFBRSxDQUFDLEdBQUcsU0FBUyxTQUFTLEVBQUUsZUFBZSxDQUFDLENBQUM7UUFDdkQsT0FBTyxTQUFTLE9BQU87WUFDckIsV0FBVyxDQUFDLGNBQWMsQ0FBQyxHQUFHLFNBQVMsU0FBUyxFQUFFLGVBQWUsQ0FBQyxDQUFDO1FBQ3JFLENBQUMsQ0FBQTtJQUNILENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQztJQUVQLDJCQUEyQjtJQUMzQixTQUFTLGVBQWUsQ0FBQyxHQUFRLEVBQUUsU0FBYztRQUMvQyxHQUFHLENBQUMsS0FBSyxDQUFDLDRCQUE0QixFQUFFLEtBQUssQ0FBQyxNQUFNLEVBQUUsU0FBUyxDQUFDLENBQUM7UUFDakUsbUJBQW1CLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDakMsQ0FBQztJQUVELE9BQU8sQ0FDTCxvQkFBQyxxQkFBcUIsQ0FBQyxRQUFRLElBQzNCLEtBQUssRUFBRSxXQUFXLENBQUMsS0FBSyxLQUFLLElBQUk7WUFDL0IsQ0FBQyxpQ0FBTSxXQUFXLENBQUMsS0FBSyxLQUFFLE1BQU0sRUFBRSxhQUFhLElBQUksV0FBVyxDQUFDLEtBQUssQ0FBQyxNQUFNLElBQzNFLENBQUMsQ0FBQyxJQUFJLElBQ1QsS0FBSyxDQUFDLFFBQVEsQ0FDZ0IsQ0FDbEMsQ0FBQztBQUNKLENBQUMsQ0FBQztBQUVGLGVBQWUsNkJBQTZCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gJ2VsZWN0cm9uJztcbmltcG9ydCAqIGFzIGxvZyBmcm9tICdlbGVjdHJvbi1sb2cnO1xuaW1wb3J0IFJlYWN0LCB7IHVzZVN0YXRlLCB1c2VFZmZlY3QgfSBmcm9tICdyZWFjdCc7XG5pbXBvcnQgeyB1c2VJUENWYWx1ZSB9IGZyb20gJy4uLy4uL2lwYy9yZW5kZXJlcic7XG5pbXBvcnQgeyBCYWNrZW5kRGVzY3JpcHRpb24gfSBmcm9tICcuLi9iYXNlJztcblxuXG5leHBvcnQgdHlwZSBTaW5nbGVEQlN0YXR1c0NvbnRleHRQcm9wcyA9IHtcbiAgZGJOYW1lOiBzdHJpbmdcbn07XG5leHBvcnQgY29uc3QgU2luZ2xlREJTdGF0dXNDb250ZXh0ID0gUmVhY3QuY3JlYXRlQ29udGV4dDxudWxsIHwgQmFja2VuZERlc2NyaXB0aW9uPGFueT4+KHtcbiAgdmVyYm9zZU5hbWU6ICcnLFxuICBzdGF0dXM6IHt9LFxufSk7XG5jb25zdCBTaW5nbGVEQlN0YXR1c0NvbnRleHRQcm92aWRlcjogUmVhY3QuRkM8U2luZ2xlREJTdGF0dXNDb250ZXh0UHJvcHM+ID0gZnVuY3Rpb24gKHByb3BzKSB7XG5cbiAgY29uc3QgaXBjUHJlZml4ID0gYGRiLSR7cHJvcHMuZGJOYW1lfWA7XG5cbiAgY29uc3QgW2JhY2tlbmRTdGF0dXMsIHVwZGF0ZUJhY2tlbmRTdGF0dXNdID0gdXNlU3RhdGUodW5kZWZpbmVkIGFzIHVuZGVmaW5lZCB8IG9iamVjdCk7XG4gIGNvbnN0IGRlc2NyaXB0aW9uID0gdXNlSVBDVmFsdWUoYCR7aXBjUHJlZml4fS1kZXNjcmliZWAsIG51bGwgYXMgbnVsbCB8IEJhY2tlbmREZXNjcmlwdGlvbjxhbnk+KTtcblxuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIGlwY1JlbmRlcmVyLm9uKGAke2lwY1ByZWZpeH0tc3RhdHVzYCwgaGFuZGxlTmV3U3RhdHVzKTtcbiAgICByZXR1cm4gZnVuY3Rpb24gY2xlYW51cCgpIHtcbiAgICAgIGlwY1JlbmRlcmVyLnJlbW92ZUxpc3RlbmVyKGAke2lwY1ByZWZpeH0tc3RhdHVzYCwgaGFuZGxlTmV3U3RhdHVzKTtcbiAgICB9XG4gIH0sIFtdKTtcblxuICAvLyBMaXN0ZW4gdG8gc3RhdHVzIHVwZGF0ZXNcbiAgZnVuY3Rpb24gaGFuZGxlTmV3U3RhdHVzKGV2dDogYW55LCBuZXdTdGF0dXM6IGFueSkge1xuICAgIGxvZy5kZWJ1ZyhcIlJlY2VpdmVkIG5ldyBzdGF0dXMgZm9yIERCXCIsIHByb3BzLmRiTmFtZSwgbmV3U3RhdHVzKTtcbiAgICB1cGRhdGVCYWNrZW5kU3RhdHVzKG5ld1N0YXR1cyk7XG4gIH1cblxuICByZXR1cm4gKFxuICAgIDxTaW5nbGVEQlN0YXR1c0NvbnRleHQuUHJvdmlkZXJcbiAgICAgICAgdmFsdWU9e2Rlc2NyaXB0aW9uLnZhbHVlICE9PSBudWxsXG4gICAgICAgICAgPyB7IC4uLmRlc2NyaXB0aW9uLnZhbHVlLCBzdGF0dXM6IGJhY2tlbmRTdGF0dXMgfHwgZGVzY3JpcHRpb24udmFsdWUuc3RhdHVzIH1cbiAgICAgICAgICA6IG51bGx9PlxuICAgICAge3Byb3BzLmNoaWxkcmVufVxuICAgIDwvU2luZ2xlREJTdGF0dXNDb250ZXh0LlByb3ZpZGVyPlxuICApO1xufTtcblxuZXhwb3J0IGRlZmF1bHQgU2luZ2xlREJTdGF0dXNDb250ZXh0UHJvdmlkZXI7XG4iXX0=