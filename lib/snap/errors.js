// Turning browser errors into messages a person can act on.

// Chromium network error codes, in the words a person can act on.
const NET_ERRORS = {
  ERR_NAME_NOT_RESOLVED: 'The server name was not found. Check the URL.',
  ERR_NAME_RESOLUTION_FAILED: 'The server name was not found. Check the URL.',
  ERR_CONNECTION_REFUSED: 'The server refused the connection. Make sure that the server is running.',
  ERR_CONNECTION_RESET: 'The server closed the connection.',
  ERR_CONNECTION_CLOSED: 'The server closed the connection.',
  ERR_CONNECTION_TIMED_OUT: 'The server did not reply in time.',
  ERR_TIMED_OUT: 'The server did not reply in time.',
  ERR_ADDRESS_UNREACHABLE: 'The server address cannot be reached.',
  ERR_INTERNET_DISCONNECTED: 'This computer is not connected to the internet.',
  ERR_FILE_NOT_FOUND: 'The file was not found.',
  ERR_TOO_MANY_REDIRECTS: 'The page redirects too many times.',
  ERR_BLOCKED_BY_CLIENT: 'The browser blocked the request.',
  ERR_UNSAFE_PORT: 'The browser does not allow connections to this port. Use a different port.',
};

// The error to throw when page.goto() fails.
export function loadError(e, o) {
  const net = e.message.match(/net::(ERR_[A-Z_]+)/)?.[1];
  if (net) return new Error(`The page did not load. ${NET_ERRORS[net] ?? `The browser reported ${net}.`}`);
  if (/Timeout/i.test(e.name)) return new Error(`The page did not load in ${o.timeout / 1000} s. Increase the timeout or try again.`);
  return e;
}

// The error to throw when waiting for o.waitFor fails.
export function waitForError(e, o) {
  return new Error(/Timeout/i.test(e.name)
    ? `The element "${o.waitFor}" did not appear in ${o.timeout / 1000} s. Check the selector or increase the timeout.`
    : `The selector "${o.waitFor}" is not valid CSS.`);
}
