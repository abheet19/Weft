// Notice.tsx — one inline notice strip (03-UI §4.7): opaque, above the editor, never a toast. The
// markup is the prototype's `#notice` — icon in the hue, the text, an optional action button, the
// dismiss cross. A notice is `role="status"` unless it is an alert (divergence, S5), and it stays
// until dismissed or replaced: nothing here times out, because a message about where the user's
// work is must not disappear before it was read.

import { Icon } from './Icons.tsx';

export interface NoticeModel {
  readonly id: string;
  readonly hue: 'ok' | 'sync' | 'warn' | 'bad';
  readonly icon: string;
  readonly text: string;
  readonly role: 'status' | 'alert';
  readonly action?: { readonly label: string; readonly run: () => void };
}

export function Notice({ notice, onDismiss }: { notice: NoticeModel; onDismiss: () => void }): React.JSX.Element {
  return (
    <div className="notice in" role={notice.role} aria-live={notice.role === 'alert' ? 'assertive' : 'polite'} style={{ ['--hue' as string]: `var(--${notice.hue})` }}>
      <Icon name={notice.icon} />
      <span className="grow">{notice.text}</span>
      {notice.action !== undefined && (
        <button type="button" className="btn" onClick={notice.action.run}>
          {notice.action.label}
        </button>
      )}
      <button type="button" className="xbtn" aria-label="Dismiss" onClick={onDismiss}>
        <Icon name="x" />
      </button>
    </div>
  );
}
