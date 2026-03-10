/**
 * 判别是否主 agent：
 * 1. 空/undefined -> 主 agent
 * 2. 'main' -> 主 agent（legacy）
 * 3. 'main-{agent_id[:8]}' -> 主 agent（新格式，HANDOVER）
 * 4. subagent_id 后 8 位与 agent_id 后 8 位一致 -> 主 agent
 */
export function isMainAgent(
  subagentId: string | undefined | null,
  agentId: string | undefined | null
): boolean {
  const s = typeof subagentId === 'string' ? subagentId.trim() : '';
  if (!s) return true;
  if (!agentId) return false;
  // 完全一致
  if (s === agentId) return true;
  // legacy
  if (s === 'main') return true;
  // 新格式：main-{agent_id[:8]}（HANDOVER）
  if (s.startsWith('main-') && agentId.length >= 8) {
    const prefix = agentId.slice(0, 8);
    if (s === `main-${prefix}`) return true;
  }
  // subagent_id 后 8 位与 agent_id 后 8 位一致
  const a8 = agentId.length >= 8 ? agentId.slice(-8) : agentId;
  const s8 = s.length >= 8 ? s.slice(-8) : s;
  return a8 === s8;
}

/**
 * 根据 log 的 subagent_id 和 agentId 得到分组 key，主 agent 归为 'main'
 */
export function getLogGroupKey(
  subagentId: string | undefined | null,
  agentId: string | undefined | null
): string {
  const raw = subagentId;
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return 'main';
  if (isMainAgent(s, agentId)) return 'main';
  return s;
}
