<script lang="ts">
  import { imageLoadingIndicator } from '../image-loading';
  function indicator(host: HTMLElement) { host.append(imageLoadingIndicator()); }
</script>

<div class="image-loading-surface" use:indicator></div>
