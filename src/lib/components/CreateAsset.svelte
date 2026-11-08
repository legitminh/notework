<script lang="ts">
  import { onMount } from 'svelte';
  import Action from './Action.svelte';
  import { assetTypes, assetName, validAssetName, type AssetType } from '../asset-types';

  let { path, machineFolder, githubFolder = false, busy, supported, error, onCreate, onCancel }: {
    path: string;
    machineFolder: boolean;
    githubFolder?: boolean;
    busy: boolean;
    supported: boolean;
    error: string;
    onCreate: (name: string, type: AssetType) => void;
    onCancel: () => void;
  } = $props();
  let name = $state('');
  let input: HTMLInputElement;
  onMount(() => input.focus());
</script>

<section aria-labelledby="create-heading">
  <Action label="cancel creation" onSelect={onCancel} disabled={busy} />
  <h1 id="create-heading">create new file/folder</h1>
  <label class="field"><span>name</span><input bind:this={input} bind:value={name} maxlength="255" autocomplete="off" disabled={busy} /></label>
  <p class="muted">{githubFolder ? 'New assets are saved in this folder on GitHub.' : machineFolder ? 'New assets are saved in this folder on your computer. Creating an item may ask for write access.' : 'New assets are saved inside this folder in browser storage.'}</p>
  {#if !supported}<p class="notice" role="alert">{machineFolder ? 'Local creation needs browser filesystem support.' : 'Browser storage is unavailable. Use HTTPS and allow site storage.'}</p>{/if}
  {#if error}<p class="notice" role="alert">{error}</p>{/if}
  {#each assetTypes as type (type.id)}
    <div class="creation-option">
      <Action label={`create ${type.label}`} disabled={busy || !supported || !validAssetName(name.trim()) || !validAssetName(assetName(name, type))}
        onSelect={() => onCreate(name, type)} />
      <p class="path" aria-label={`Path for ${type.label}`}>{path}/{assetName(name, type) || '…'}{type.kind === 'directory' ? '/' : ''}</p>
    </div>
  {/each}
  {#if name && !validAssetName(name.trim())}<p class="notice">Choose a name without slashes or control characters. “.”, “..”, and “.git” are reserved.</p>{/if}
</section>
