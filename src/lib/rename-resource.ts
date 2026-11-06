import type { Workspace, StateNode } from './workspace';
import { transferResource } from './transfer-resource';

export function renameResource(workspace: Workspace, source: StateNode, name: string) {
  return transferResource(workspace, source, name);
}
