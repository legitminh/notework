import { createContext } from 'svelte';

export const [getGitHubRecovery, setGitHubRecovery] = createContext<{
  available: (id: string) => boolean;
  reconnect: (id: string) => Promise<boolean>;
}>();
