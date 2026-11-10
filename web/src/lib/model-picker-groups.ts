export type GroupedModelOption = {
    key: string;
    channelId?: string;
    channelName: string;
    groupId?: number;
    groupName?: string;
    model: string;
    protocol?: string;
    workflowRef?: unknown;
};

// Group by the actual billing group, not a customer's arbitrary API key name.
// Keep the active key when removing duplicate models from the same group.
export function modelPickerGroups<T extends GroupedModelOption>(options: T[], currentKey?: string) {
    const groups = new Map<string, { key: string; name: string; options: T[] }>();
    for (const option of options) {
        const key = option.groupId ? `group:${option.groupId}` : `channel:${option.channelId || "default"}`;
        let group = groups.get(key);
        if (!group) {
            group = { key, name: option.groupName || option.channelName || "默认分组", options: [] };
            groups.set(key, group);
        }
        const index = group.options.findIndex(item => option.workflowRef ? item.key === option.key : !item.workflowRef && item.model === option.model && item.protocol === option.protocol);
        if (index < 0) group.options.push(option);
        else if (option.key === currentKey) group.options[index] = option;
    }
    return [...groups.values()];
}

export function modelForPickerGroup<T extends GroupedModelOption>(options: T[], current?: T) {
    return options.find(option => current?.workflowRef ? option.key === current.key : !option.workflowRef && option.model === current?.model && option.protocol === current?.protocol) || options[0];
}
