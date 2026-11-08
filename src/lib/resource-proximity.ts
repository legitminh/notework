import { ROOT, nodeId, parentId, type StateNode, type Workspace } from './workspace';
import { parentUri } from './wiki';

export function resourceProximity(workspace: Workspace, source: StateNode) {
  // Group files by their containing folder so siblings are zero hops apart.
  // Individually connected files may share a storage bucket, but root itself
  // is virtual and does not make unrelated storage locations siblings.
  const location = (node: StateNode) => node.kind === 'directory' ? node.id
    : node.path.length ? parentId(node) : parentUri(node);
  const edges = new Map<string, Map<string, number>>();
  function edge(from: string, to: string, upstream: number) {
    if (from === to) return;
    let neighbors = edges.get(from);
    if (!neighbors) edges.set(from, neighbors = new Map());
    neighbors.set(to, Math.min(neighbors.get(to) ?? Infinity, upstream));
  }
  function connect(from: string, to: string) {
    edge(from, to, 0);
    edge(to, from, 1);
  }
  const folders = new Set<string>();
  for (const node of workspace.known.values()) {
    for (let depth = node.path.length - Number(node.kind === 'file'); depth > 0; depth--) {
      const folder = nodeId(node.sourceId, node.path.slice(0, depth));
      if (folders.has(folder)) break;
      folders.add(folder);
      connect(nodeId(node.sourceId, node.path.slice(0, depth - 1)), folder);
    }
  }
  for (const id of workspace.data.rootIds) {
    const target = workspace.known.get(id);
    if (target) connect(ROOT, location(target));
  }
  for (const [id, links] of Object.entries(workspace.data.links)) {
    const from = workspace.known.get(id);
    if (!from) continue;
    for (const id of links) {
      const target = workspace.known.get(id);
      if (target) connect(location(from), location(target));
    }
  }

  // Finish each layer before expanding it so equally short paths can prefer
  // the route with fewer upward folder steps or reversed directed links.
  const distances = new Map([[location(source), { hops: 0, upstream: 0 }]]);
  const queue = [location(source)];
  for (const from of queue) {
    const distance = distances.get(from)!;
    const hops = distance.hops + 1;
    for (const [to, step] of edges.get(from) ?? []) {
      const upstream = distance.upstream + step;
      const previous = distances.get(to);
      if (!previous) queue.push(to);
      if (!previous || (previous.hops === hops && upstream < previous.upstream)) {
        distances.set(to, { hops, upstream });
      }
    }
  }
  return (node: StateNode) => distances.get(location(node));
}
