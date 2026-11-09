import { mkdir } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { BrowserError } from './errors.mjs';
import { compactWhitespace, truncateText } from './text-budget.mjs';

const DEFAULT_TIMEOUT = 15_000;
const MAX_TEXT = 8_000;
const MAX_ITEMS = 80;
const SESSION_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const HOST_CACHE = new Map();

export class BrowserManager {
  #browser = null;
  #launchPromise = null;
  #sessions = new Map();
  #closed = false;

  constructor({ artifactRoot, headed = false, timeoutMs = DEFAULT_TIMEOUT } = {}) {
    this.artifactRoot = resolve(artifactRoot ?? join(process.cwd(), '.forgeflow', 'browser'));
    this.headed = headed;
    this.timeoutMs = timeoutMs;
  }

  get sessionCount() { return this.#sessions.size; }

  async open({ sessionId, url, waitUntil = 'domcontentloaded' }) {
    const id = this.#validateSession(sessionId);
    const safeUrl = validateUrl(url);
    const session = await this.#getSession(id);
    try {
      const response = await session.page.goto(safeUrl, {
        waitUntil: normalizeWaitUntil(waitUntil),
        timeout: this.timeoutMs,
      });
      validateUrl(session.page.url());
      return {
        sessionId: id,
        url: session.page.url(),
        title: truncateText(await session.page.title(), 180),
        status: response?.status() ?? null,
        snapshot: await this.snapshot({ sessionId: id, maxItems: 50, maxChars: 4_000 }),
      };
    } catch (error) {
      throw this.#wrap(error, `Could not open ${safeUrl}`);
    }
  }

  async snapshot({ sessionId, maxItems = MAX_ITEMS, maxChars = MAX_TEXT } = {}) {
    const session = this.#requireSession(sessionId);
    try {
      const details = await session.page.evaluate(({ itemLimit }) => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
        };
        const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim();
        const labelFor = (element) => {
          const aria = element.getAttribute('aria-label');
          const labelledBy = element.getAttribute('aria-labelledby');
          const labelledText = labelledBy ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? '').join(' ') : '';
          const label = element.labels ? [...element.labels].map((node) => node.innerText).join(' ') : '';
          return normalize(aria || labelledText || label || element.getAttribute('title') || element.innerText || element.value || element.getAttribute('placeholder') || element.getAttribute('alt') || '');
        };
        const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="radio"],h1,h2,h3,[contenteditable="true"]')];
        const items = [];
        let ref = 0;
        for (const element of nodes) {
          if (!visible(element) || items.length >= itemLimit) continue;
          const tag = element.tagName.toLowerCase();
          const role = element.getAttribute('role') || ({ a: 'link', button: 'button', input: 'input', textarea: 'textbox', select: 'combobox', h1: 'heading', h2: 'heading', h3: 'heading' })[tag] || tag;
          const name = labelFor(element).slice(0, 180);
          if (!name && !['input', 'textarea', 'select'].includes(tag)) continue;
          if (['input', 'textarea', 'select'].includes(tag) && ['password', 'hidden', 'file'].includes((element.type || '').toLowerCase())) continue;
          const reference = `e${++ref}`;
          element.setAttribute('data-forgeflow-ref', reference);
          const type = element.getAttribute('type');
          const href = tag === 'a' ? element.getAttribute('href') : null;
          const state = element.disabled ? ' disabled' : '';
          const value = ['input', 'textarea'].includes(tag) && type !== 'password' ? normalize(element.value).slice(0, 80) : '';
          items.push({ ref: reference, role, name, type, href, state, value });
        }
        const title = normalize(document.title);
        const bodyText = normalize(document.body?.innerText ?? '').slice(0, 1800);
        return { title, url: location.href, items, bodyText, totalElements: nodes.length };
      }, { itemLimit: Math.min(MAX_ITEMS, Math.max(1, Number(maxItems) || MAX_ITEMS)) });
      session.lastSnapshot = details;
      return formatSnapshot(details, Math.min(MAX_TEXT, Math.max(400, Number(maxChars) || MAX_TEXT)));
    } catch (error) {
      throw this.#wrap(error, 'Could not inspect the current page');
    }
  }

  async click({ sessionId, ref }) {
    const session = this.#requireSession(sessionId);
    const selector = this.#refSelector(ref);
    try {
      const target = session.page.locator(selector);
      await target.waitFor({ state: 'visible', timeout: this.timeoutMs });
      const before = session.page.url();
      await target.click({ timeout: this.timeoutMs });
      await session.page.waitForLoadState('domcontentloaded', { timeout: Math.min(this.timeoutMs, 5_000) }).catch(() => {});
      validateUrl(session.page.url());
      return { clicked: ref, url: session.page.url(), navigated: before !== session.page.url(), snapshot: await this.snapshot({ sessionId, maxItems: 35, maxChars: 3_000 }) };
    } catch (error) {
      throw this.#wrap(error, `Could not click ${ref}`);
    }
  }

  async fill({ sessionId, ref, value }) {
    const session = this.#requireSession(sessionId);
    const selector = this.#refSelector(ref);
    const safeValue = String(value ?? '');
    if (safeValue.length > 20_000) throw new BrowserError('Form value exceeds the 20,000 character limit.');
    try {
      const target = session.page.locator(selector);
      await target.waitFor({ state: 'visible', timeout: this.timeoutMs });
      const type = await target.getAttribute('type');
      if (type?.toLowerCase() === 'password') throw new BrowserError('Password fields are not available to the browser agent.');
      await target.fill(safeValue, { timeout: this.timeoutMs });
      return { filled: ref, characters: safeValue.length, snapshot: await this.snapshot({ sessionId, maxItems: 35, maxChars: 3_000 }) };
    } catch (error) {
      throw this.#wrap(error, `Could not fill ${ref}`);
    }
  }

  async press({ sessionId, ref, key }) {
    const session = this.#requireSession(sessionId);
    const selector = ref ? this.#refSelector(ref) : 'body';
    const safeKey = normalizeKey(key);
    try {
      await session.page.locator(selector).press(safeKey, { timeout: this.timeoutMs });
      validateUrl(session.page.url());
      return { pressed: safeKey, url: session.page.url(), snapshot: await this.snapshot({ sessionId, maxItems: 35, maxChars: 3_000 }) };
    } catch (error) {
      throw this.#wrap(error, `Could not press ${safeKey}`);
    }
  }

  async screenshot({ sessionId, name = 'page', fullPage = false }) {
    const session = this.#requireSession(sessionId);
    const safeName = String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'page';
    const extension = `${Date.now()}-${safeName}.jpg`;
    await mkdir(this.artifactRoot, { recursive: true, mode: 0o700 });
    const path = join(this.artifactRoot, extension);
    try {
      await session.page.screenshot({ path, type: 'jpeg', quality: 55, fullPage: Boolean(fullPage), animations: 'disabled', timeout: this.timeoutMs });
      const stat = await import('node:fs/promises').then((fs) => fs.stat(path));
      return { path, bytes: stat.size, width: session.page.viewportSize()?.width ?? null, note: 'Image saved locally; image bytes are not sent into model context.' };
    } catch (error) {
      throw this.#wrap(error, 'Could not capture a screenshot');
    }
  }

  async closeSession({ sessionId }) {
    const id = this.#validateSession(sessionId);
    const session = this.#sessions.get(id);
    if (!session) return { closed: false, sessionId: id };
    this.#sessions.delete(id);
    await session.context.close().catch(() => {});
    return { closed: true, sessionId: id };
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const contexts = [...this.#sessions.values()].map((session) => session.context.close().catch(() => {}));
    this.#sessions.clear();
    await Promise.all(contexts);
    await this.#launchPromise?.catch(() => {});
    await this.#browser?.close().catch(() => {});
    this.#browser = null;
  }

  async #getSession(id) {
    if (this.#closed) throw new BrowserError('Browser manager is already closed.');
    const existing = this.#sessions.get(id);
    if (existing) return existing;
    await this.#launch();
    if (this.#closed) throw new BrowserError('Browser manager was closed while starting a session.');
    const context = await this.#browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
    context.setDefaultTimeout(this.timeoutMs);
    await context.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      try {
        const parsed = new URL(requestUrl);
        if (['http:', 'https:'].includes(parsed.protocol)) await validatePublicHost(parsed.hostname);
        await route.continue();
      } catch {
        await route.abort('blockedbyclient').catch(() => {});
      }
    });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(this.timeoutMs);
    const session = { context, page, lastSnapshot: null, createdAt: Date.now() };
    this.#sessions.set(id, session);
    return session;
  }

  async #launch() {
    if (this.#browser) return;
    if (!this.#launchPromise) {
      this.#launchPromise = (async () => {
        try {
          const imported = await import('playwright');
          this.#browser = await imported.chromium.launch({ headless: !this.headed });
        } catch (error) {
          if (error.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find package 'playwright'/.test(error.message)) {
            throw new BrowserError('Browser tools require Playwright. Install it with: npm install playwright && npx playwright install chromium.');
          }
          throw this.#wrap(error, 'Could not start Chromium');
        }
      })();
    }
    try { await this.#launchPromise; }
    catch (error) { this.#launchPromise = null; throw error; }
  }

  #requireSession(sessionId) {
    const id = this.#validateSession(sessionId);
    const session = this.#sessions.get(id);
    if (!session) throw new BrowserError(`Browser session ${id} is not open. Call browser_open first.`);
    return session;
  }

  #validateSession(sessionId) {
    const id = String(sessionId ?? 'default');
    if (!SESSION_RE.test(id)) throw new BrowserError('Session ID must be 1-64 letters, digits, underscores, or hyphens.');
    return id;
  }

  #refSelector(ref) {
    const id = String(ref ?? '');
    if (!/^e[1-9]\d{0,3}$/.test(id)) throw new BrowserError('Element reference is invalid. Use a ref from browser_snapshot.');
    return `[data-forgeflow-ref="${id}"]`;
  }

  #wrap(error, context) {
    if (error instanceof BrowserError) return error;
    return new BrowserError(`${context}: ${error.message}`, { details: { code: error.code ?? null } });
  }
}

function validateUrl(input) {
  let parsed;
  try { parsed = new URL(String(input)); }
  catch { throw new BrowserError('Browser URL must be a valid absolute URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new BrowserError('Only http and https URLs are supported.');
  if (parsed.username || parsed.password) throw new BrowserError('URLs containing embedded credentials are blocked.');
  // Initial URL host checks happen before launch; route interception checks every redirect and subresource too.
  if (parsed.href.length > 4_000) throw new BrowserError('URL exceeds the 4,000 character limit.');
  return parsed.href;
}

async function validatePublicHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return;
  let addresses = HOST_CACHE.get(host);
  if (!addresses) {
    try {
      addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
      HOST_CACHE.set(host, addresses);
    } catch {
      throw new BrowserError(`Could not resolve browser host ${host}.`);
    }
  }
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new BrowserError('Browser navigation to private or link-local addresses is blocked.');
  }
}

function isPrivateAddress(address) {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  if (normalized.includes('.')) return isPrivateAddressV4(normalized);
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  return false;
}

function isPrivateAddressV4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = parts;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19));
}

function normalizeWaitUntil(value) {
  return ['commit', 'domcontentloaded', 'load', 'networkidle'].includes(value) ? value : 'domcontentloaded';
}

function normalizeKey(value) {
  const key = String(value ?? '');
  if (!/^[A-Za-z0-9+_-]{1,40}$/.test(key)) throw new BrowserError('Key name contains unsupported characters.');
  return key;
}

function formatSnapshot(page, maxChars) {
  const lines = [`URL: ${page.url}`, `Title: ${page.title || '(no title)'}`];
  if (page.bodyText) lines.push(`Text: ${compactWhitespace(page.bodyText).slice(0, 900)}`);
  lines.push('Elements:');
  for (const item of page.items) {
    const details = [item.ref, item.role, item.name || '(unnamed)', item.type ? `type=${item.type}` : '', item.value ? `value=${item.value}` : '', item.href ? `href=${item.href}` : '', item.state].filter(Boolean).join(' | ');
    lines.push(`- ${details}`);
  }
  if (page.totalElements > page.items.length) lines.push(`… ${page.totalElements - page.items.length} additional DOM elements omitted`);
  return truncateText(lines.join('\n'), maxChars, '\n…[snapshot truncated]');
}

export function browserToolDefinitions() {
  return [
    { type: 'function', function: { name: 'browser_open', description: 'Open an http(s) page in an isolated headless Chromium session and return a compact snapshot.', parameters: { type: 'object', properties: { sessionId: { type: 'string' }, url: { type: 'string' }, waitUntil: { type: 'string', enum: ['commit', 'domcontentloaded', 'load', 'networkidle'] } }, required: ['sessionId', 'url'], additionalProperties: false } } },
    { type: 'function', function: { name: 'browser_snapshot', description: 'Read a compact semantic view of the current page; element refs can be used by click/fill. Avoid screenshots unless visual information is needed.', parameters: { type: 'object', properties: { sessionId: { type: 'string' }, maxItems: { type: 'integer' }, maxChars: { type: 'integer' } }, required: ['sessionId'], additionalProperties: false } } },
    { type: 'function', function: { name: 'browser_click', description: 'Click a visible element ref from the latest page snapshot.', parameters: { type: 'object', properties: { sessionId: { type: 'string' }, ref: { type: 'string' } }, required: ['sessionId', 'ref'], additionalProperties: false } } },
    { type: 'function', function: { name: 'browser_fill', description: 'Fill a visible non-password field ref from the latest page snapshot.', parameters: { type: 'object', properties: { sessionId: { type: 'string' }, ref: { type: 'string' }, value: { type: 'string' } }, required: ['sessionId', 'ref', 'value'], additionalProperties: false } } },
    { type: 'function', function: { name: 'browser_press', description: 'Press a keyboard key on a page or visible element ref.', parameters: { type: 'object', properties: { sessionId: { type: 'string' }, ref: { type: 'string' }, key: { type: 'string' } }, required: ['sessionId', 'key'], additionalProperties: false } } },
    { type: 'function', function: { name: 'browser_screenshot', description: 'Save a compressed JPEG screenshot locally. The image is not included in model context; use only when visual detail is necessary.', parameters: { type: 'object', properties: { sessionId: { type: 'string' }, name: { type: 'string' }, fullPage: { type: 'boolean' } }, required: ['sessionId'], additionalProperties: false } } },
    { type: 'function', function: { name: 'browser_close', description: 'Close an isolated browser session and release its resources.', parameters: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'], additionalProperties: false } } },
  ];
}

export async function executeBrowserTool(manager, name, args) {
  if (!manager) throw new BrowserError('Browser tools are not enabled for this run.');
  switch (name) {
    case 'browser_open': return manager.open(args);
    case 'browser_snapshot': return manager.snapshot(args);
    case 'browser_click': return manager.click(args);
    case 'browser_fill': return manager.fill(args);
    case 'browser_press': return manager.press(args);
    case 'browser_screenshot': return manager.screenshot(args);
    case 'browser_close': return manager.closeSession(args);
    default: throw new BrowserError(`Unknown browser action: ${name}`);
  }
}
