<!--
  @component
  The browser's side of ServedMarkup: the same element with nothing in it. Svelte hydrates an
  element with no dynamic content as the server sent it, children included, so the panel's markup
  stays as sent, without the `{@html}` runtime in the browser's build, until PanelLoader replaces
  it with the live panel.
-->
<div data-served style="display: contents"></div>
