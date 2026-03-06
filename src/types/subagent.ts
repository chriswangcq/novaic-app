export interface SubAgentMeta {
  subagent_id: string
  parent_subagent_id: string | null
  type: 'main' | 'sub'
  status: 'sleeping' | 'awake' | 'running' | 'completed' | 'failed' | 'cancelled'
  task: string | null
  progress: string | null
  error: string | null
  created_at: string
  log_count: number
}

export interface SubAgentNode extends SubAgentMeta {
  children: SubAgentNode[]
  depth: number
}

export function buildSubAgentTree(subagents: SubAgentMeta[]): SubAgentNode[] {
  const map = new Map<string, SubAgentNode>()
  const roots: SubAgentNode[] = []

  subagents.forEach(s => map.set(s.subagent_id, { ...s, children: [], depth: 0 }))

  map.forEach(node => {
    if (node.parent_subagent_id && map.has(node.parent_subagent_id)) {
      const parent = map.get(node.parent_subagent_id)!
      node.depth = parent.depth + 1
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  })

  // Sort children by created_at
  const sortChildren = (nodes: SubAgentNode[]) => {
    nodes.sort((a, b) => a.created_at.localeCompare(b.created_at))
    nodes.forEach(n => sortChildren(n.children))
  }
  sortChildren(roots)

  return roots
}
