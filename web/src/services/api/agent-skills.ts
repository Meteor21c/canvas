import { apiDelete, apiGet, apiPost } from "@/services/api/request";

export const AGENT_SKILL_CONTENT_MAX_LENGTH = 20_000;

export type AgentSkillFile = {
    path: string;
    kind: "folder" | "file";
    content: string;
    sort: number;
    createdAt?: string;
    updatedAt?: string;
};

export type AgentSkill = {
    id: string;
    ownerUserId: string;
    source: "system" | "user";
    name: string;
    description: string;
    coverUrl: string;
    coverStorageKey: string;
    content: string;
    enabled: boolean;
    sort: number;
    createdAt: string;
    updatedAt: string;
    hasFiles?: boolean;
    files?: AgentSkillFile[];
};

export function fetchSystemAgentSkills() {
    return apiGet<AgentSkill[]>("/studio/api/agent-skills");
}

export function fetchSystemAgentSkillFile(id: string, path: string) {
    return apiGet<AgentSkillFile>(`/studio/api/agent-skills/${encodeURIComponent(id)}/file`, { path });
}

export function fetchUserAgentSkills(token: string) {
    return apiGet<AgentSkill[]>("/studio/api/v1/agent-skills", undefined, token);
}

export function saveUserAgentSkill(token: string, skill: Partial<AgentSkill>) {
    return apiPost<AgentSkill>("/studio/api/v1/agent-skills", skill, token);
}

export function deleteUserAgentSkill(token: string, id: string) {
    return apiDelete<boolean>(`/studio/api/v1/agent-skills/${encodeURIComponent(id)}`, token);
}
