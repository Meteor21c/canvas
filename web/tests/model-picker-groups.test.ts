import { expect, test } from "bun:test";
import { modelForPickerGroup, modelPickerGroups, type GroupedModelOption } from "../src/lib/model-picker-groups";

const options: GroupedModelOption[] = [
    { key: "key-a::image", channelId: "key-a", channelName: "我的密钥", groupId: 23, groupName: "绘图专用分组", model: "gpt-image-2.6", protocol: "openai" },
    { key: "key-b::image", channelId: "key-b", channelName: "另一把密钥", groupId: 23, groupName: "绘图专用分组", model: "gpt-image-2.6", protocol: "openai" },
    { key: "key-a::flare", channelId: "key-a", channelName: "我的密钥", groupId: 23, groupName: "绘图专用分组", model: "gpt-image-2.6-flare", protocol: "openai" },
    { key: "key-c::image", channelId: "key-c", channelName: "我的密钥", groupId: 51, groupName: "绘图特价分组", model: "gpt-image-2.6", protocol: "openai" },
];

test("actual groups stay separate even when keys share a name; duplicate keys do not repeat models", () => {
    const groups = modelPickerGroups(options, "key-b::image");
    expect(groups.map(group => group.name)).toEqual(["绘图专用分组", "绘图特价分组"]);
    expect(groups[0].options.map(option => option.model)).toEqual(["gpt-image-2.6", "gpt-image-2.6-flare"]);
    expect(groups[0].options[0].channelId).toBe("key-b");
    expect(groups[1].options[0].channelId).toBe("key-c");
});

test("group switching preserves an available model but always uses the destination billing key", () => {
    const groups = modelPickerGroups(options);
    const next = modelForPickerGroup(groups[1].options, options[1]);
    expect(next?.model).toBe("gpt-image-2.6");
    expect(next?.channelId).toBe("key-c");
    expect(modelForPickerGroup(groups[1].options, options[2])?.channelId).toBe("key-c");
    expect(modelForPickerGroup([], options[0])).toBeUndefined();
});

test("workflow and protocol variants are not erased by model deduplication", () => {
    const first = options[0];
    const variants = [first, { ...first, key: "gemini", protocol: "gemini" }, { ...first, key: "workflow:a", model: "", workflowRef: { workflowId: "a" } }, { ...first, key: "workflow:b", model: "", workflowRef: { workflowId: "b" } }];
    const group = modelPickerGroups(variants)[0];
    expect(group.options).toHaveLength(4);
    expect(modelForPickerGroup(group.options, variants[3])?.key).toBe("workflow:b");
});
