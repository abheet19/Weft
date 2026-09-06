// Icons.tsx — the prototype's SVG sprite (24-unit grid, 1.5px stroke, drawn at 16px), trimmed to
// the symbols the shell renders: the brand mark, the five pill states, the notice's dismiss cross
// and the storage notices' database (S4). One sprite so every icon is `<use href>` and inherits
// `currentColor` from the token it sits in.

export function IconSprite(): React.JSX.Element {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <symbol id="i-weft" viewBox="0 0 24 24">
        <path d="M3 8c3 0 3 4 6 4s3-4 6-4 3 4 6 4M3 16c3 0 3-4 6-4s3 4 6 4 3-4 6-4" />
      </symbol>
      <symbol id="i-check" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12.2 2.4 2.4 4.6-5" />
      </symbol>
      <symbol id="i-sync" viewBox="0 0 24 24">
        <path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v4h-4" />
      </symbol>
      <symbol id="i-wifioff" viewBox="0 0 24 24">
        <path d="m3 3 18 18M8.5 16.5a5 5 0 0 1 7 0M5.3 13.3a9 9 0 0 1 4-2.4M2 9.5A14 14 0 0 1 6.4 6.6M22 9.5A14 14 0 0 0 11 5.1M18.7 13.3a9 9 0 0 0-3.3-2.2M12 20h.01" />
      </symbol>
      <symbol id="i-clock" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </symbol>
      <symbol id="i-alert" viewBox="0 0 24 24">
        <path d="M7.9 3h8.2L21 7.9v8.2L16.1 21H7.9L3 16.1V7.9L7.9 3z" />
        <path d="M12 8v4.5M12 16h.01" />
      </symbol>
      <symbol id="i-x" viewBox="0 0 24 24">
        <path d="M18 6 6 18M6 6l12 12" />
      </symbol>
      <symbol id="i-db" viewBox="0 0 24 24">
        <ellipse cx="12" cy="5.5" rx="8" ry="3" />
        <path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
      </symbol>
      {/* Presence + Inspector (03-UI §4.2, §4.5, S5): the disconnected ghost avatar's slashed user, the rail toggle, and the follow eye. */}
      <symbol id="i-userslash" viewBox="0 0 24 24">
        <path d="M4 20a7 7 0 0 1 10.5-6M15.5 9.5A3.5 3.5 0 1 0 9 8M3 3l18 18" />
      </symbol>
      <symbol id="i-panel" viewBox="0 0 24 24">
        <path d="M4 5h16v14H4zM14 5v14" />
      </symbol>
      <symbol id="i-eye" viewBox="0 0 24 24">
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" />
        <circle cx="12" cy="12" r="2.5" />
      </symbol>
      {/* Format bar (03-UI §4.4): the prototype's code / link / bullet-list / quote glyphs, ported verbatim. */}
      <symbol id="i-code" viewBox="0 0 24 24">
        <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
      </symbol>
      <symbol id="i-link" viewBox="0 0 24 24">
        <path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" />
      </symbol>
      <symbol id="i-list" viewBox="0 0 24 24">
        <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
      </symbol>
      <symbol id="i-quote" viewBox="0 0 24 24">
        <path d="M10 7H7a3 3 0 0 0-3 3v3a3 3 0 0 0 3 3h1a2 2 0 0 0 2-2v-4a3 3 0 0 0-3-3M20 7h-3a3 3 0 0 0-3 3v3a3 3 0 0 0 3 3h1a2 2 0 0 0 2-2v-4a3 3 0 0 0-3-3" />
      </symbol>
      {/* ⌘K command palette (03-UI §4.8, S8): the trigger glyph, the search field, and one icon per command group's items, ported verbatim from the prototype sprite. */}
      <symbol id="i-cmd" viewBox="0 0 24 24">
        <path d="M9 9h6v6H9zM9 9H7a2 2 0 1 1 2-2v2M15 9h2a2 2 0 1 0-2-2v2M9 15H7a2 2 0 1 0 2 2v-2M15 15h2a2 2 0 1 1-2 2v-2" />
      </symbol>
      <symbol id="i-search" viewBox="0 0 24 24">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </symbol>
      <symbol id="i-plus" viewBox="0 0 24 24">
        <path d="M12 5v14M5 12h14" />
      </symbol>
      <symbol id="i-sun" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2.5V5M12 19v2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2.5 12H5M19 12h2.5M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
      </symbol>
      <symbol id="i-layers" viewBox="0 0 24 24">
        <path d="m12 3 9 5-9 5-9-5 9-5zM3 13l9 5 9-5" />
      </symbol>
      <symbol id="i-user" viewBox="0 0 24 24">
        <circle cx="12" cy="8" r="3.5" />
        <path d="M4.5 20v-1a4.5 4.5 0 0 1 4.5-4.5h6A4.5 4.5 0 0 1 19.5 19v1" />
      </symbol>
      <symbol id="i-brush" viewBox="0 0 24 24">
        <path d="m18 3 3 3-9.5 9.5-3-3L18 3zM8.5 14.5C6 14.5 4 16.5 4 20c3.5 0 5.5-2 5.5-4.5" />
      </symbol>
      <symbol id="i-drop" viewBox="0 0 24 24">
        <path d="M4 8v8l8 4 8-4V8l-8-4-8 4zM4 8l8 4 8-4M12 12v8" />
      </symbol>
      <symbol id="i-copy" viewBox="0 0 24 24">
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15V6a2 2 0 0 1 2-2h9" />
      </symbol>
      <symbol id="i-h1" viewBox="0 0 24 24">
        <path d="M4 6v12M12 6v12M4 12h8M17 10.5 19.5 9V18" />
      </symbol>
      {/* Persistent toolbar + link popover + right sidebar (03-UI §4.4/§4.5, S6): ported verbatim from the redesign prototype's sprite. */}
      <symbol id="i-undo" viewBox="0 0 24 24">
        <path d="M9 7 4 12l5 5" />
        <path d="M4 12h11a5 5 0 0 1 0 10h-1" />
      </symbol>
      <symbol id="i-redo" viewBox="0 0 24 24">
        <path d="m15 7 5 5-5 5" />
        <path d="M20 12H9a5 5 0 0 0 0 10h1" />
      </symbol>
      <symbol id="i-chevd" viewBox="0 0 24 24">
        <path d="m6 9 6 6 6-6" />
      </symbol>
      <symbol id="i-chevr" viewBox="0 0 24 24">
        <path d="m9 6 6 6-6 6" />
      </symbol>
      <symbol id="i-mark" viewBox="0 0 24 24">
        <path d="M4 20h16" />
        <path d="M6 16 15 7l3 3-9 9H6z" />
      </symbol>
      <symbol id="i-pen" viewBox="0 0 24 24">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
      </symbol>
      <symbol id="i-ol" viewBox="0 0 24 24">
        <path d="M10 6h11M10 12h11M10 18h11" />
        <path d="M4 4v4M3 8h2M3 14h2l-2 2.5h2" />
      </symbol>
      <symbol id="i-checksq" viewBox="0 0 24 24">
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <path d="m8 12 3 3 5-6" />
      </symbol>
      <symbol id="i-braces" viewBox="0 0 24 24">
        <path d="M8 4C6 4 6 6 6 8s0 3-2 4c2 1 2 2 2 4s0 2 2 2M16 4c2 0 2 2 2 4s0 3 2 4c-2 1-2 2-2 4s0 2-2 2" />
      </symbol>
      <symbol id="i-minus" viewBox="0 0 24 24">
        <path d="M5 12h14" />
      </symbol>
      <symbol id="i-ext" viewBox="0 0 24 24">
        <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
      </symbol>
      <symbol id="i-trash" viewBox="0 0 24 24">
        <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
      </symbol>
      <symbol id="i-outline" viewBox="0 0 24 24">
        <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
      </symbol>
      <symbol id="i-users" viewBox="0 0 24 24">
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3 20a6 6 0 0 1 12 0M16 5.5a3.2 3.2 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6" />
      </symbol>
      <symbol id="i-pulse" viewBox="0 0 24 24">
        <path d="M3 12h4l2-6 4 12 2-6h6" />
      </symbol>
    </svg>
  );
}

export function Icon({ name }: { name: string }): React.JSX.Element {
  return (
    <svg className="i" aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  );
}
