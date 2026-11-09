<script lang="ts">
  function warnBeforeLeaving(event: BeforeUnloadEvent) {
    event.preventDefault();
    event.returnValue = '';
  }
</script>

<svelte:window onbeforeunload={warnBeforeLeaving} />

<div class="sync-progress">
  <p role="status">Syncing to GitHub… Keep Notework open.</p>
  <progress aria-label="Syncing to GitHub"></progress>
</div>

<style>
  .sync-progress {
    position: fixed;
    inset: auto 0 0;
    z-index: 10;
    padding: 6px 10px calc(6px + env(safe-area-inset-bottom));
    color: var(--primary);
    background: var(--background);
    border-top: 1px solid var(--tertiary);
    font-size: .5em;
    pointer-events: none;
  }
  progress { display: block; width: 100%; height: 4px; margin-top: 4px; accent-color: var(--primary); }
</style>
