import type { Workspace, StateNode } from './workspace';
import { transferResource } from './transfer-resource';

export function relocateResource(workspace: Workspace, source: StateNode, target: StateNode | null) {
  return transferResource(workspace, source, source.name, target);
}
