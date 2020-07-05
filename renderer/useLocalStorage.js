import { useState } from 'react';
export function useLocalStorage(key, initialValue) {
    // State to store our value
    // Pass initial state function to useState so logic is only executed once
    const [storedValue, setStoredValue] = useState(() => {
        try {
            // Get from local storage by key
            const item = window.localStorage.getItem(key);
            // Parse stored json or if none return initialValue
            return item ? JSON.parse(item) : initialValue;
        }
        catch (error) {
            // If error also return initialValue
            console.log(error);
            return initialValue;
        }
    });
    // Return a wrapped version of useState's setter function that ...
    // ... persists the new value to localStorage.
    const setValue = (value) => {
        try {
            // Allow value to be a function so we have same API as useState
            const valueToStore = value instanceof Function ? value(storedValue) : value;
            // Save state
            setStoredValue(valueToStore);
            // Save to local storage
            window.localStorage.setItem(key, JSON.stringify(valueToStore));
        }
        catch (error) {
            // A more advanced implementation would handle the error case
            console.log(error);
        }
    };
    return [storedValue, setValue];
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidXNlTG9jYWxTdG9yYWdlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc3JjL3JlbmRlcmVyL3VzZUxvY2FsU3RvcmFnZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQUUsUUFBUSxFQUFFLE1BQU0sT0FBTyxDQUFDO0FBR2pDLE1BQU0sVUFBVSxlQUFlLENBQUMsR0FBVyxFQUFFLFlBQW9CO0lBQy9ELDJCQUEyQjtJQUMzQix5RUFBeUU7SUFDekUsTUFBTSxDQUFDLFdBQVcsRUFBRSxjQUFjLENBQUMsR0FBRyxRQUFRLENBQUMsR0FBRyxFQUFFO1FBQ2xELElBQUk7WUFDRixnQ0FBZ0M7WUFDaEMsTUFBTSxJQUFJLEdBQUcsTUFBTSxDQUFDLFlBQVksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDOUMsbURBQW1EO1lBQ25ELE9BQU8sSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUM7U0FDL0M7UUFBQyxPQUFPLEtBQUssRUFBRTtZQUNkLG9DQUFvQztZQUNwQyxPQUFPLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBQ25CLE9BQU8sWUFBWSxDQUFDO1NBQ3JCO0lBQ0gsQ0FBQyxDQUFDLENBQUM7SUFFSCxrRUFBa0U7SUFDbEUsOENBQThDO0lBQzlDLE1BQU0sUUFBUSxHQUFHLENBQUMsS0FBVSxFQUFFLEVBQUU7UUFDOUIsSUFBSTtZQUNGLCtEQUErRDtZQUMvRCxNQUFNLFlBQVksR0FDaEIsS0FBSyxZQUFZLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUM7WUFDekQsYUFBYTtZQUNiLGNBQWMsQ0FBQyxZQUFZLENBQUMsQ0FBQztZQUM3Qix3QkFBd0I7WUFDeEIsTUFBTSxDQUFDLFlBQVksQ0FBQyxPQUFPLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQztTQUNoRTtRQUFDLE9BQU8sS0FBSyxFQUFFO1lBQ2QsNkRBQTZEO1lBQzdELE9BQU8sQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUM7U0FDcEI7SUFDSCxDQUFDLENBQUM7SUFFRixPQUFPLENBQUMsV0FBVyxFQUFFLFFBQVEsQ0FBQyxDQUFDO0FBQ2pDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyB1c2VTdGF0ZSB9IGZyb20gJ3JlYWN0JztcblxuXG5leHBvcnQgZnVuY3Rpb24gdXNlTG9jYWxTdG9yYWdlKGtleTogc3RyaW5nLCBpbml0aWFsVmFsdWU6IHN0cmluZykge1xuICAvLyBTdGF0ZSB0byBzdG9yZSBvdXIgdmFsdWVcbiAgLy8gUGFzcyBpbml0aWFsIHN0YXRlIGZ1bmN0aW9uIHRvIHVzZVN0YXRlIHNvIGxvZ2ljIGlzIG9ubHkgZXhlY3V0ZWQgb25jZVxuICBjb25zdCBbc3RvcmVkVmFsdWUsIHNldFN0b3JlZFZhbHVlXSA9IHVzZVN0YXRlKCgpID0+IHtcbiAgICB0cnkge1xuICAgICAgLy8gR2V0IGZyb20gbG9jYWwgc3RvcmFnZSBieSBrZXlcbiAgICAgIGNvbnN0IGl0ZW0gPSB3aW5kb3cubG9jYWxTdG9yYWdlLmdldEl0ZW0oa2V5KTtcbiAgICAgIC8vIFBhcnNlIHN0b3JlZCBqc29uIG9yIGlmIG5vbmUgcmV0dXJuIGluaXRpYWxWYWx1ZVxuICAgICAgcmV0dXJuIGl0ZW0gPyBKU09OLnBhcnNlKGl0ZW0pIDogaW5pdGlhbFZhbHVlO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAvLyBJZiBlcnJvciBhbHNvIHJldHVybiBpbml0aWFsVmFsdWVcbiAgICAgIGNvbnNvbGUubG9nKGVycm9yKTtcbiAgICAgIHJldHVybiBpbml0aWFsVmFsdWU7XG4gICAgfVxuICB9KTtcblxuICAvLyBSZXR1cm4gYSB3cmFwcGVkIHZlcnNpb24gb2YgdXNlU3RhdGUncyBzZXR0ZXIgZnVuY3Rpb24gdGhhdCAuLi5cbiAgLy8gLi4uIHBlcnNpc3RzIHRoZSBuZXcgdmFsdWUgdG8gbG9jYWxTdG9yYWdlLlxuICBjb25zdCBzZXRWYWx1ZSA9ICh2YWx1ZTogYW55KSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIC8vIEFsbG93IHZhbHVlIHRvIGJlIGEgZnVuY3Rpb24gc28gd2UgaGF2ZSBzYW1lIEFQSSBhcyB1c2VTdGF0ZVxuICAgICAgY29uc3QgdmFsdWVUb1N0b3JlID1cbiAgICAgICAgdmFsdWUgaW5zdGFuY2VvZiBGdW5jdGlvbiA/IHZhbHVlKHN0b3JlZFZhbHVlKSA6IHZhbHVlO1xuICAgICAgLy8gU2F2ZSBzdGF0ZVxuICAgICAgc2V0U3RvcmVkVmFsdWUodmFsdWVUb1N0b3JlKTtcbiAgICAgIC8vIFNhdmUgdG8gbG9jYWwgc3RvcmFnZVxuICAgICAgd2luZG93LmxvY2FsU3RvcmFnZS5zZXRJdGVtKGtleSwgSlNPTi5zdHJpbmdpZnkodmFsdWVUb1N0b3JlKSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIC8vIEEgbW9yZSBhZHZhbmNlZCBpbXBsZW1lbnRhdGlvbiB3b3VsZCBoYW5kbGUgdGhlIGVycm9yIGNhc2VcbiAgICAgIGNvbnNvbGUubG9nKGVycm9yKTtcbiAgICB9XG4gIH07XG5cbiAgcmV0dXJuIFtzdG9yZWRWYWx1ZSwgc2V0VmFsdWVdO1xufVxuXG4iXX0=