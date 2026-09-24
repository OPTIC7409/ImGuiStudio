// Studio server API + event stream.

export async function op(name, args = {}) {
  const res = await fetch(`/api/op/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-studio-client': 'ui' },
    body: JSON.stringify(args),
  });
  const body = await res.json();
  if (!body.ok) {
    const e = new Error(body.error?.message || `${name} failed`);
    e.code = body.error?.code;
    e.details = body.error?.details;
    throw e;
  }
  return body.result;
}

export async function getState() {
  const res = await fetch('/api/state');
  return res.json();
}

export async function getText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

// Reconnecting WebSocket for server events.
export function connectEvents(onEvent, onStatus) {
  let ws;
  let retry = 500;
  const open = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?kind=ui`);
    ws.onopen = () => {
      retry = 500;
      onStatus?.(true);
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        onEvent(msg.type, msg.data);
      } catch (e) {
        console.error(e);
      }
    };
    ws.onclose = () => {
      onStatus?.(false);
      setTimeout(open, retry);
      retry = Math.min(5000, retry * 2);
    };
  };
  open();
}
