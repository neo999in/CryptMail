// Evaluate a JS expression in the app's first WebView over Chrome DevTools
// Protocol and print the JSON result. The port is forwarded by
// `driver.sh webview`; WebView debugging is on in __DEV__ builds only.
//
//   node cdp.mjs '<expression>'
const [expression] = process.argv.slice(2);
if (!expression) {
  console.error('usage: node cdp.mjs <expression>');
  process.exit(2);
}

// The DevTools socket only exists once the app has created a WebView, so a
// refused or dropped connection means "none yet", not a broken driver.
const targets = await fetch('http://localhost:9222/json')
  .then((r) => r.json())
  .catch(() => []);
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('no WebView page — is a screen with a WebView (Compose with formatting on, a message) open?');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== 1) return;
  const { result, exceptionDetails } = msg.result ?? {};
  if (exceptionDetails) console.error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  else console.log(JSON.stringify(result?.value ?? result, null, 2));
  ws.close();
  process.exit(exceptionDetails ? 1 : 0);
};
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
