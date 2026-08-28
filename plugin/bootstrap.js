/* global Zotero, Services */
/**
 * Reference Map Connect — Zotero plugin.
 *
 * Zotero's local server refuses requests from web pages: it sends no CORS headers (except for
 * zotero.org) and drops browser-looking requests. That is the right default — but it also means
 * a web app YOU trust (like a hosted Reference Map) cannot reach your library.
 *
 * This plugin adds an explicit, per-origin consent layer on top of that default:
 *  - responses (including CORS preflights) to origins you have APPROVED get CORS headers;
 *  - the first time an unknown origin identifying itself as a compatible client connects,
 *    Zotero shows an Allow/Deny dialog; approved origins are remembered in a preference.
 *
 * Clients pass Zotero's own browser gate with the stock `Zotero-Allowed-Request` header
 * (or the connector API version header) — this plugin never disables that gate; it only
 * makes the browser's side of the conversation (CORS) possible for approved origins.
 */

const PREF_ALLOWED = 'extensions.reference-map-connect.allowedOrigins';

let origGenerateResponse = null;
const sessionDenied = new Set();
const pendingPrompts = new Set();

function getAllowedOrigins() {
  try {
    return new Set(JSON.parse(Zotero.Prefs.get(PREF_ALLOWED, true) || '[]'));
  } catch (e) {
    return new Set();
  }
}

function saveAllowedOrigins(origins) {
  Zotero.Prefs.set(PREF_ALLOWED, JSON.stringify([...origins]), true);
}

/**
 * Only engage the consent flow for requests that identify as compatible clients: they either
 * carry the Zotero-Allowed-Request header, or their CORS preflight asks permission to send it.
 * Random websites poking the port never trigger a dialog.
 */
function looksLikeClient(handler) {
  if ('zotero-allowed-request' in handler.headers) return true;
  const preflightHeaders = String(handler.headers['access-control-request-headers'] || '').toLowerCase();
  return preflightHeaders.includes('zotero-allowed-request');
}

function promptForOrigin(origin) {
  if (pendingPrompts.has(origin) || sessionDenied.has(origin)) return;
  pendingPrompts.add(origin);
  (async () => {
    try {
      await Zotero.initializationPromise;
      // The dialog is modal on Zotero's window, which is usually behind the browser
      // at this moment — bring Zotero to the front so the prompt can't be missed.
      try {
        Zotero.Utilities.Internal.activate(Zotero.getMainWindow());
      } catch (e) {
        /* best effort */
      }
      const ps = Services.prompt;
      const flags = ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING
        + ps.BUTTON_POS_1 * ps.BUTTON_TITLE_IS_STRING
        + ps.BUTTON_POS_1_DEFAULT;
      const choice = ps.confirmEx(
        Zotero.getMainWindow(),
        'Reference Map Connect',
        'A website is asking to access your Zotero library:\n\n'
          + origin
          + '\n\nAllow it to search this library and save items into it?',
        flags,
        'Allow', 'Deny', null, null, {},
      );
      if (choice === 0) {
        const allowed = getAllowedOrigins();
        allowed.add(origin);
        saveAllowedOrigins(allowed);
      } else {
        sessionDenied.add(origin); // ask again after a restart, not on every request
      }
    } catch (e) {
      Zotero.debug('reference-map-connect: prompt failed: ' + e);
    } finally {
      pendingPrompts.delete(origin);
    }
  })();
}

function corsHeaderBlock(handler, origin) {
  const requested = handler.headers['access-control-request-headers'];
  const allowHeaders = requested
    || 'Content-Type, Zotero-API-Version, Zotero-Allowed-Request, Zotero-Write-Token, X-Metadata, X-Zotero-Connector-API-Version';
  let block = 'Access-Control-Allow-Origin: ' + origin + '\r\n'
    + 'Access-Control-Allow-Methods: GET, POST, HEAD, OPTIONS\r\n'
    + 'Access-Control-Allow-Headers: ' + allowHeaders + '\r\n'
    + 'Access-Control-Expose-Headers: Total-Results, Last-Modified-Version, Retry-After, Backoff, X-Zotero-Version\r\n'
    + 'Access-Control-Max-Age: 86400\r\n';
  if (handler.headers['access-control-request-private-network'] === 'true') {
    block += 'Access-Control-Allow-Private-Network: true\r\n';
  }
  return block;
}

function startup() {
  const proto = Zotero.Server && Zotero.Server.RequestHandler && Zotero.Server.RequestHandler.prototype;
  if (!proto || !proto._generateResponse) {
    Zotero.debug('reference-map-connect: Zotero.Server.RequestHandler not found — plugin inactive');
    return;
  }
  origGenerateResponse = proto._generateResponse;
  proto._generateResponse = function (status, contentTypeOrHeaders, body) {
    let out = origGenerateResponse.call(this, status, contentTypeOrHeaders, body);
    try {
      const origin = this.origin;
      // zotero.org already gets CORS from Zotero itself — never double up.
      if (origin && origin !== 'null' && origin !== 'https://www.zotero.org') {
        if (getAllowedOrigins().has(origin)) {
          const afterStatusLine = out.indexOf('\r\n') + 2;
          out = out.slice(0, afterStatusLine) + corsHeaderBlock(this, origin) + out.slice(afterStatusLine);
        } else if (looksLikeClient(this)) {
          promptForOrigin(origin);
        }
      }
    } catch (e) {
      Zotero.debug('reference-map-connect: ' + e);
    }
    return out;
  };
  Zotero.debug('reference-map-connect: active');
}

function shutdown() {
  const proto = Zotero.Server && Zotero.Server.RequestHandler && Zotero.Server.RequestHandler.prototype;
  if (proto && origGenerateResponse) {
    proto._generateResponse = origGenerateResponse;
    origGenerateResponse = null;
  }
}

function install() {}
function uninstall() {}
